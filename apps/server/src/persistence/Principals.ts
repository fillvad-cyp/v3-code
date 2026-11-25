import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import {
  Principal,
  PrincipalId,
  PrincipalKind,
  PrincipalStatus,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";

import { EpochMillis } from "./epochMillis.ts";
import {
  type PrincipalRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

const PrincipalRow = Schema.Struct({
  id: PrincipalId,
  kind: PrincipalKind,
  displayName: TrimmedNonEmptyString,
  email: Schema.NullOr(Schema.String),
  status: PrincipalStatus,
  ceiling: Schema.fromJsonString(Schema.Array(Schema.String)),
  accessRevision: Schema.Number,
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
  removedAt: Schema.NullOr(EpochMillis),
});
type PrincipalRow = typeof PrincipalRow.Type;

const PrincipalAccessStatusRow = Schema.Struct({
  status: PrincipalStatus,
  accessRevision: Schema.Number,
});
type PrincipalAccessStatus = typeof PrincipalAccessStatusRow.Type;

export const CredentialRecord = Schema.Struct({
  algo: Schema.String,
  salt: Schema.String,
  hash: Schema.String,
  updatedAt: EpochMillis,
});
export type CredentialRecord = typeof CredentialRecord.Type;

export const CreatePrincipalInput = Schema.Struct({
  id: PrincipalId,
  kind: PrincipalKind,
  displayName: TrimmedNonEmptyString,
  email: Schema.NullOr(Schema.String),
  status: PrincipalStatus,
  ceiling: Schema.Array(Schema.String),
  createdAt: EpochMillis,
});
export type CreatePrincipalInput = typeof CreatePrincipalInput.Type;

export const UpdatePrincipalInput = Schema.Struct({
  id: PrincipalId,
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.optionalKey(PrincipalStatus),
  ceiling: Schema.optionalKey(Schema.Array(Schema.String)),
  removedAt: Schema.optionalKey(Schema.NullOr(EpochMillis)),
  updatedAt: EpochMillis,
  /** Bumped on every membership, ceiling or status change, so live sessions see it. */
  bumpAccessRevision: Schema.optionalKey(Schema.Boolean),
});
export type UpdatePrincipalInput = typeof UpdatePrincipalInput.Type;

export const SetCredentialInput = Schema.Struct({
  principalId: PrincipalId,
  salt: Schema.String,
  hash: Schema.String,
  updatedAt: EpochMillis,
});
export type SetCredentialInput = typeof SetCredentialInput.Type;

export class PrincipalRepository extends Context.Service<
  PrincipalRepository,
  {
    readonly get: (
      id: PrincipalId,
    ) => Effect.Effect<Option.Option<Principal>, PrincipalRepositoryError>;
    readonly getAccessStatus: (
      id: PrincipalId,
    ) => Effect.Effect<Option.Option<PrincipalAccessStatus>, PrincipalRepositoryError>;
    readonly getByEmail: (
      email: string,
    ) => Effect.Effect<Option.Option<Principal>, PrincipalRepositoryError>;
    readonly list: Effect.Effect<ReadonlyArray<Principal>, PrincipalRepositoryError>;
    readonly create: (input: CreatePrincipalInput) => Effect.Effect<void, PrincipalRepositoryError>;
    readonly update: (
      input: UpdatePrincipalInput,
    ) => Effect.Effect<boolean, PrincipalRepositoryError>;
    readonly bumpAccessRevision: (
      id: PrincipalId,
      updatedAt: EpochMillis,
    ) => Effect.Effect<number, PrincipalRepositoryError>;
    readonly getCredential: (
      principalId: PrincipalId,
    ) => Effect.Effect<Option.Option<CredentialRecord>, PrincipalRepositoryError>;
    readonly setCredential: (
      input: SetCredentialInput,
    ) => Effect.Effect<void, PrincipalRepositoryError>;
    readonly deleteCredential: (
      principalId: PrincipalId,
    ) => Effect.Effect<boolean, PrincipalRepositoryError>;
  }
>()("v3code/persistence/Principals/PrincipalRepository") {}

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): PrincipalRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectRow = sql`
    SELECT id AS "id", kind AS "kind", display_name AS "displayName", email AS "email",
      status AS "status", ceiling_json AS "ceiling", access_revision AS "accessRevision",
      created_at AS "createdAt", updated_at AS "updatedAt", removed_at AS "removedAt"
    FROM principals
  `;

  const getRow = SqlSchema.findOneOption({
    Request: PrincipalId,
    Result: PrincipalRow,
    execute: (id) => sql`${selectRow} WHERE id = ${id}`,
  });

  const getAccessStatusRow = SqlSchema.findOneOption({
    Request: PrincipalId,
    Result: PrincipalAccessStatusRow,
    execute: (id) =>
      sql`
        SELECT status AS "status", access_revision AS "accessRevision"
        FROM principals
        WHERE id = ${id}
      `,
  });

  const getRowByEmail = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: PrincipalRow,
    execute: (email) => sql`${selectRow} WHERE email = ${email} COLLATE NOCASE`,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PrincipalRow,
    execute: () => sql`${selectRow} ORDER BY created_at, id`,
  });

  const createRow = SqlSchema.void({
    Request: CreatePrincipalInput,
    execute: (input) =>
      sql`
        INSERT INTO principals (id, kind, display_name, email, status, ceiling_json, created_at,
          updated_at)
        VALUES (${input.id}, ${input.kind}, ${input.displayName}, ${input.email}, ${input.status},
          ${JSON.stringify(input.ceiling)}, ${input.createdAt}, ${input.createdAt})
      `,
  });

  const updateRow = SqlSchema.findAll({
    Request: UpdatePrincipalInput,
    Result: Schema.Struct({ id: PrincipalId }),
    execute: (input) =>
      sql`
        UPDATE principals
        SET display_name = COALESCE(${input.displayName ?? null}, display_name),
          email = CASE WHEN ${input.email === undefined ? 0 : 1} = 1
            THEN ${input.email ?? null} ELSE email END,
          status = COALESCE(${input.status ?? null}, status),
          ceiling_json = CASE WHEN ${input.ceiling === undefined ? 0 : 1} = 1
            THEN ${input.ceiling === undefined ? null : JSON.stringify(input.ceiling)}
            ELSE ceiling_json END,
          removed_at = CASE WHEN ${input.removedAt === undefined ? 0 : 1} = 1
            THEN ${input.removedAt ?? null}
            ELSE removed_at END,
          updated_at = ${input.updatedAt},
          access_revision = access_revision + ${input.bumpAccessRevision === true ? 1 : 0}
        WHERE id = ${input.id}
        RETURNING id AS "id"
      `,
  });

  const bumpRow = SqlSchema.findAll({
    Request: Schema.Struct({ id: PrincipalId, updatedAt: EpochMillis }),
    Result: Schema.Struct({ accessRevision: Schema.Number }),
    execute: ({ id, updatedAt }) =>
      sql`
        UPDATE principals
        SET access_revision = access_revision + 1, updated_at = ${updatedAt}
        WHERE id = ${id}
        RETURNING access_revision AS "accessRevision"
      `,
  });

  const getCredentialRow = SqlSchema.findOneOption({
    Request: PrincipalId,
    Result: CredentialRecord,
    execute: (principalId) =>
      sql`
        SELECT algo AS "algo", salt AS "salt", hash AS "hash", updated_at AS "updatedAt"
        FROM principal_credentials
        WHERE principal_id = ${principalId}
      `,
  });

  const setCredentialRow = SqlSchema.void({
    Request: SetCredentialInput,
    execute: (input) =>
      sql`
        INSERT INTO principal_credentials (principal_id, salt, hash, updated_at)
        VALUES (${input.principalId}, ${input.salt}, ${input.hash}, ${input.updatedAt})
        ON CONFLICT (principal_id)
        DO UPDATE SET salt = excluded.salt, hash = excluded.hash, updated_at = excluded.updated_at
      `,
  });

  const deleteCredentialRow = SqlSchema.findAll({
    Request: PrincipalId,
    Result: Schema.Struct({ principalId: PrincipalId }),
    execute: (principalId) =>
      sql`
        DELETE FROM principal_credentials WHERE principal_id = ${principalId}
        RETURNING principal_id AS "principalId"
      `,
  });

  return PrincipalRepository.of({
    get: Effect.fn("PrincipalRepository.get")((id) =>
      getRow(id).pipe(Effect.mapError(toSqlOrDecodeError("getPrincipal", "Principal"))),
    ),
    getAccessStatus: Effect.fn("PrincipalRepository.getAccessStatus")((id) =>
      getAccessStatusRow(id).pipe(
        Effect.mapError(toSqlOrDecodeError("getPrincipalAccessStatus", "PrincipalAccessStatus")),
      ),
    ),
    getByEmail: Effect.fn("PrincipalRepository.getByEmail")((email) =>
      getRowByEmail(email).pipe(
        Effect.mapError(toSqlOrDecodeError("getPrincipalByEmail", "Principal")),
      ),
    ),
    list: listRows(undefined).pipe(
      Effect.mapError(toSqlOrDecodeError("listPrincipals", "Principal")),
    ),
    create: Effect.fn("PrincipalRepository.create")((input) =>
      createRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("createPrincipal", "CreatePrincipalInput")),
      ),
    ),
    update: Effect.fn("PrincipalRepository.update")((input) =>
      updateRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("updatePrincipal", "UpdatePrincipalInput")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
    bumpAccessRevision: Effect.fn("PrincipalRepository.bumpAccessRevision")((id, updatedAt) =>
      bumpRow({ id, updatedAt }).pipe(
        Effect.mapError(
          toSqlOrDecodeError("bumpPrincipalAccessRevision", "PrincipalAccessRevision"),
        ),
        Effect.map((rows) => rows[0]?.accessRevision ?? 0),
      ),
    ),
    getCredential: Effect.fn("PrincipalRepository.getCredential")((principalId) =>
      getCredentialRow(principalId).pipe(
        Effect.mapError(toSqlOrDecodeError("getPrincipalCredential", "PrincipalCredential")),
      ),
    ),
    setCredential: Effect.fn("PrincipalRepository.setCredential")((input) =>
      setCredentialRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("setPrincipalCredential", "SetCredentialInput")),
      ),
    ),
    deleteCredential: Effect.fn("PrincipalRepository.deleteCredential")((principalId) =>
      deleteCredentialRow(principalId).pipe(
        Effect.mapError(toSqlOrDecodeError("deletePrincipalCredential", "PrincipalId")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
  } satisfies PrincipalRepository["Service"]);
});

export const layer = Layer.effect(PrincipalRepository, make);
