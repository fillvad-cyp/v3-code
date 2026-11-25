import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { MemberLimits, PrincipalId } from "@t3tools/contracts";

import {
  type MemberLimitsRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

const LimitsRow = Schema.Struct({
  principalId: PrincipalId,
  maxSessions: Schema.NullOr(Schema.Number),
  maxTerminals: Schema.NullOr(Schema.Number),
  invitesPerHour: Schema.NullOr(Schema.Number),
  maxApiTokens: Schema.NullOr(Schema.Number),
});

export const SetMemberLimitsInput = Schema.Struct({
  principalId: PrincipalId,
  maxSessions: Schema.NullOr(Schema.Number),
  maxTerminals: Schema.NullOr(Schema.Number),
  invitesPerHour: Schema.NullOr(Schema.Number),
  maxApiTokens: Schema.NullOr(Schema.Number),
});
export type SetMemberLimitsInput = typeof SetMemberLimitsInput.Type;

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): MemberLimitsRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

/** A null column is the built-in default; a missing row means every default. */
export class MemberLimitsRepository extends Context.Service<
  MemberLimitsRepository,
  {
    readonly get: (
      principalId: PrincipalId,
    ) => Effect.Effect<MemberLimits | undefined, MemberLimitsRepositoryError>;
    readonly list: Effect.Effect<ReadonlyArray<MemberLimits>, MemberLimitsRepositoryError>;
    readonly set: (input: SetMemberLimitsInput) => Effect.Effect<void, MemberLimitsRepositoryError>;
    readonly remove: (
      principalId: PrincipalId,
    ) => Effect.Effect<boolean, MemberLimitsRepositoryError>;
  }
>()("v3code/persistence/MemberLimits/MemberLimitsRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectRow = sql`
    SELECT principal_id AS "principalId", max_sessions AS "maxSessions",
      max_terminals AS "maxTerminals", invites_per_hour AS "invitesPerHour",
      max_api_tokens AS "maxApiTokens"
    FROM member_limits
  `;

  const getRow = SqlSchema.findOneOption({
    Request: PrincipalId,
    Result: LimitsRow,
    execute: (principalId) => sql`${selectRow} WHERE principal_id = ${principalId}`,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: LimitsRow,
    execute: () => sql`${selectRow} ORDER BY principal_id`,
  });

  const setRow = SqlSchema.void({
    Request: SetMemberLimitsInput,
    execute: (input) =>
      sql`
        INSERT INTO member_limits (principal_id, max_sessions, max_terminals, invites_per_hour,
          max_api_tokens)
        VALUES (${input.principalId}, ${input.maxSessions}, ${input.maxTerminals},
          ${input.invitesPerHour}, ${input.maxApiTokens})
        ON CONFLICT (principal_id)
        DO UPDATE SET max_sessions = excluded.max_sessions,
          max_terminals = excluded.max_terminals, invites_per_hour = excluded.invites_per_hour,
          max_api_tokens = excluded.max_api_tokens
      `,
  });

  const removeRow = SqlSchema.findAll({
    Request: PrincipalId,
    Result: Schema.Struct({ principalId: PrincipalId }),
    execute: (principalId) =>
      sql`
        DELETE FROM member_limits WHERE principal_id = ${principalId}
        RETURNING principal_id AS "principalId"
      `,
  });

  return MemberLimitsRepository.of({
    get: Effect.fn("MemberLimitsRepository.get")((principalId) =>
      getRow(principalId).pipe(
        Effect.mapError(toSqlOrDecodeError("getMemberLimits", "MemberLimits")),
        Effect.map(Option.getOrUndefined),
      ),
    ),
    list: listRows(undefined).pipe(
      Effect.mapError(toSqlOrDecodeError("listMemberLimits", "MemberLimits")),
    ),
    set: Effect.fn("MemberLimitsRepository.set")((input) =>
      setRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("setMemberLimits", "SetMemberLimitsInput")),
      ),
    ),
    remove: Effect.fn("MemberLimitsRepository.remove")((principalId) =>
      removeRow(principalId).pipe(
        Effect.mapError(toSqlOrDecodeError("removeMemberLimits", "PrincipalId")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
  } satisfies MemberLimitsRepository["Service"]);
});

export const layer = Layer.effect(MemberLimitsRepository, make);
