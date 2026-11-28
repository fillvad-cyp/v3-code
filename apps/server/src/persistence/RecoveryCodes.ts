import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { IsoDateTime, PrincipalId, TrimmedNonEmptyString } from "@t3tools/contracts";

import { EpochMillis, NullableEpochMillis } from "./epochMillis.ts";
import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type RecoveryCodeRepositoryError,
} from "./Errors.ts";

export const RecoveryCodeRecord = Schema.Struct({
  id: TrimmedNonEmptyString,
  principalId: PrincipalId,
  createdBy: PrincipalId,
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  consumedAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
});
export type RecoveryCodeRecord = typeof RecoveryCodeRecord.Type;

const RecoveryCodeRow = Schema.Struct({
  id: TrimmedNonEmptyString,
  principalId: PrincipalId,
  createdBy: PrincipalId,
  createdAt: EpochMillis,
  expiresAt: EpochMillis,
  consumedAt: NullableEpochMillis,
  revokedAt: NullableEpochMillis,
});

export const CreateRecoveryCodeInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** HMAC of the code; the raw code only ever leaves in the issuance response. */
  tokenHash: Schema.String,
  principalId: PrincipalId,
  createdBy: PrincipalId,
  createdAt: EpochMillis,
  expiresAt: EpochMillis,
});
export type CreateRecoveryCodeInput = typeof CreateRecoveryCodeInput.Type;

export const ConsumeRecoveryCodeInput = Schema.Struct({
  tokenHash: Schema.String,
  now: EpochMillis,
});
export type ConsumeRecoveryCodeInput = typeof ConsumeRecoveryCodeInput.Type;

/**
 * Single-use recovery codes stored as HMAC hashes and consumed with one atomic UPDATE so
 * concurrent confirmations cannot both succeed.
 */
export class RecoveryCodeRepository extends Context.Service<
  RecoveryCodeRepository,
  {
    readonly create: (
      input: CreateRecoveryCodeInput,
    ) => Effect.Effect<void, RecoveryCodeRepositoryError>;
    readonly consume: (
      input: ConsumeRecoveryCodeInput,
    ) => Effect.Effect<Option.Option<RecoveryCodeRecord>, RecoveryCodeRepositoryError>;
    readonly getByTokenHash: (
      tokenHash: string,
    ) => Effect.Effect<Option.Option<RecoveryCodeRecord>, RecoveryCodeRepositoryError>;
    readonly revokePendingForPrincipal: (
      principalId: PrincipalId,
      revokedAt: EpochMillis,
    ) => Effect.Effect<number, RecoveryCodeRepositoryError>;
  }
>()("v3code/persistence/RecoveryCodes/RecoveryCodeRepository") {}

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): RecoveryCodeRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectRow = sql`
    SELECT id AS "id", principal_id AS "principalId", created_by AS "createdBy",
      created_at AS "createdAt", expires_at AS "expiresAt",
      consumed_at AS "consumedAt", revoked_at AS "revokedAt"
    FROM recovery_codes
  `;

  const createRow = SqlSchema.void({
    Request: CreateRecoveryCodeInput,
    execute: (input) =>
      sql`
        INSERT INTO recovery_codes (id, token_hash, principal_id, created_by, created_at,
          expires_at)
        VALUES (${input.id}, ${input.tokenHash}, ${input.principalId}, ${input.createdBy},
          ${input.createdAt}, ${input.expiresAt})
      `,
  });

  const consumeRow = SqlSchema.findOneOption({
    Request: ConsumeRecoveryCodeInput,
    Result: RecoveryCodeRow,
    execute: ({ tokenHash, now }) =>
      sql`
        UPDATE recovery_codes
        SET consumed_at = ${now}
        WHERE token_hash = ${tokenHash}
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > ${now}
        RETURNING id AS "id", principal_id AS "principalId", created_by AS "createdBy",
          created_at AS "createdAt", expires_at AS "expiresAt",
          consumed_at AS "consumedAt", revoked_at AS "revokedAt"
      `,
  });

  const getRowByTokenHash = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: RecoveryCodeRow,
    execute: (tokenHash) => sql`${selectRow} WHERE token_hash = ${tokenHash}`,
  });

  const revokePendingRowsForPrincipal = SqlSchema.findAll({
    Request: Schema.Struct({ principalId: PrincipalId, revokedAt: EpochMillis }),
    Result: Schema.Struct({ id: TrimmedNonEmptyString }),
    execute: ({ principalId, revokedAt }) =>
      sql`
        UPDATE recovery_codes
        SET revoked_at = ${revokedAt}
        WHERE principal_id = ${principalId}
          AND consumed_at IS NULL
          AND revoked_at IS NULL
        RETURNING id AS "id"
      `,
  });

  return RecoveryCodeRepository.of({
    create: Effect.fn("RecoveryCodeRepository.create")((input) =>
      createRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("createRecoveryCode", "CreateRecoveryCodeInput")),
      ),
    ),
    consume: Effect.fn("RecoveryCodeRepository.consume")((input) =>
      consumeRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("consumeRecoveryCode", "RecoveryCodeRecord")),
      ),
    ),
    getByTokenHash: Effect.fn("RecoveryCodeRepository.getByTokenHash")((tokenHash) =>
      getRowByTokenHash(tokenHash).pipe(
        Effect.mapError(toSqlOrDecodeError("getRecoveryCodeByToken", "RecoveryCodeRecord")),
      ),
    ),
    revokePendingForPrincipal: Effect.fn("RecoveryCodeRepository.revokePendingForPrincipal")(
      (principalId, revokedAt) =>
        revokePendingRowsForPrincipal({ principalId, revokedAt }).pipe(
          Effect.mapError(toSqlOrDecodeError("revokeRecoveryCodes", "RecoveryCodeRecord")),
          Effect.map((rows) => rows.length),
        ),
    ),
  } satisfies RecoveryCodeRepository["Service"]);
});

export const layer = Layer.effect(RecoveryCodeRepository, make);
