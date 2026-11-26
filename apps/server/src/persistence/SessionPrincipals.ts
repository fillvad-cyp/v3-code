import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { AuthSessionId, PrincipalId, SessionBinding, SessionBindingKind } from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  type SessionPrincipalRepositoryError,
} from "./Errors.ts";

const SessionBindingJson = Schema.fromJsonString(SessionBinding);

const SessionPrincipalRow = Schema.Struct({
  principalId: PrincipalId,
  bindingKind: SessionBindingKind,
  binding: Schema.NullOr(SessionBindingJson),
});

export interface SessionPrincipalRecord {
  readonly principalId: PrincipalId;
  readonly bindingKind: SessionBindingKind;
  readonly binding: SessionBinding | undefined;
}

export const PutSessionPrincipalInput = Schema.Struct({
  sessionId: AuthSessionId,
  principalId: PrincipalId,
  bindingKind: SessionBindingKind,
  binding: Schema.optional(SessionBinding),
});
export type PutSessionPrincipalInput = typeof PutSessionPrincipalInput.Type;

const PutSessionPrincipalRow = Schema.Struct({
  sessionId: AuthSessionId,
  principalId: PrincipalId,
  bindingKind: SessionBindingKind,
  bindingJson: Schema.NullOr(SessionBindingJson),
});

const SessionIdRow = Schema.Struct({
  sessionId: AuthSessionId,
});

export class SessionPrincipalRepository extends Context.Service<
  SessionPrincipalRepository,
  {
    readonly get: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<Option.Option<SessionPrincipalRecord>, SessionPrincipalRepositoryError>;
    readonly put: (
      input: PutSessionPrincipalInput,
    ) => Effect.Effect<void, SessionPrincipalRepositoryError>;
    readonly remove: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, SessionPrincipalRepositoryError>;
    readonly removeAllForPrincipal: (
      principalId: PrincipalId,
    ) => Effect.Effect<number, SessionPrincipalRepositoryError>;
    readonly listForPrincipal: (
      principalId: PrincipalId,
    ) => Effect.Effect<ReadonlyArray<AuthSessionId>, SessionPrincipalRepositoryError>;
    readonly downgradeEnvironmentBindingsForPrincipal: (
      principalId: PrincipalId,
    ) => Effect.Effect<number, SessionPrincipalRepositoryError>;
  }
>()("v3code/persistence/SessionPrincipals/SessionPrincipalRepository") {}

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): SessionPrincipalRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findOneOption({
    Request: AuthSessionId,
    Result: SessionPrincipalRow,
    execute: (sessionId) =>
      sql`
        SELECT principal_id AS "principalId", binding_kind AS "bindingKind",
          binding_json AS "binding"
        FROM session_principals
        WHERE session_id = ${sessionId}
      `,
  });

  const putRow = SqlSchema.void({
    Request: PutSessionPrincipalRow,
    execute: (input) =>
      sql`
        INSERT INTO session_principals (session_id, principal_id, binding_kind, binding_json)
        VALUES (${input.sessionId}, ${input.principalId}, ${input.bindingKind}, ${input.bindingJson})
        ON CONFLICT (session_id)
        DO UPDATE SET principal_id = excluded.principal_id,
          binding_kind = excluded.binding_kind,
          binding_json = excluded.binding_json
      `,
  });

  const removeRow = SqlSchema.findAll({
    Request: AuthSessionId,
    Result: SessionIdRow,
    execute: (sessionId) =>
      sql`
        DELETE FROM session_principals
        WHERE session_id = ${sessionId}
        RETURNING session_id AS "sessionId"
      `,
  });

  const removeRowsForPrincipal = SqlSchema.findAll({
    Request: PrincipalId,
    Result: SessionIdRow,
    execute: (principalId) =>
      sql`
        DELETE FROM session_principals
        WHERE principal_id = ${principalId}
        RETURNING session_id AS "sessionId"
      `,
  });

  const listRowsForPrincipal = SqlSchema.findAll({
    Request: PrincipalId,
    Result: SessionIdRow,
    execute: (principalId) =>
      sql`
        SELECT session_id AS "sessionId"
        FROM session_principals
        WHERE principal_id = ${principalId}
        ORDER BY session_id
      `,
  });

  const downgradeEnvironmentRowsForPrincipal = SqlSchema.findAll({
    Request: PrincipalId,
    Result: SessionIdRow,
    execute: (principalId) =>
      sql`
        UPDATE session_principals
        SET binding_kind = 'principal', binding_json = NULL
        WHERE principal_id = ${principalId} AND binding_kind = 'environment'
        RETURNING session_id AS "sessionId"
      `,
  });

  return SessionPrincipalRepository.of({
    get: Effect.fn("SessionPrincipalRepository.get")((sessionId) =>
      getRow(sessionId).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toSqlOrDecodeError("getSessionPrincipal", "SessionPrincipal")),
        Effect.map(
          Option.map((row) => ({
            principalId: row.principalId,
            bindingKind: row.bindingKind,
            binding: row.binding ?? undefined,
          })),
        ),
      ),
    ),
    put: Effect.fn("SessionPrincipalRepository.put")((input) =>
      putRow({
        sessionId: input.sessionId,
        principalId: input.principalId,
        bindingKind: input.bindingKind,
        // Table CHECK requires binding_json to be non-null iff binding_kind = 'projects'.
        bindingJson: input.binding?._tag === "projects" ? input.binding : null,
      }).pipe(
        Effect.mapError(toSqlOrDecodeError("putSessionPrincipal", "PutSessionPrincipalInput")),
      ),
    ),
    remove: Effect.fn("SessionPrincipalRepository.remove")((sessionId) =>
      removeRow(sessionId).pipe(
        Effect.mapError(toSqlOrDecodeError("removeSessionPrincipal", "AuthSessionId")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
    removeAllForPrincipal: Effect.fn("SessionPrincipalRepository.removeAllForPrincipal")(
      (principalId) =>
        removeRowsForPrincipal(principalId).pipe(
          Effect.mapError(toSqlOrDecodeError("removePrincipalSessions", "AuthSessionId")),
          Effect.map((rows) => rows.length),
        ),
    ),
    listForPrincipal: Effect.fn("SessionPrincipalRepository.listForPrincipal")((principalId) =>
      listRowsForPrincipal(principalId).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError(toSqlOrDecodeError("listPrincipalSessions", "AuthSessionId")),
        Effect.map((rows) => rows.map((row) => row.sessionId)),
      ),
    ),
    downgradeEnvironmentBindingsForPrincipal: Effect.fn(
      "SessionPrincipalRepository.downgradeEnvironmentBindingsForPrincipal",
    )((principalId) =>
      downgradeEnvironmentRowsForPrincipal(principalId).pipe(
        Effect.mapError(toSqlOrDecodeError("downgradeEnvironmentBindings", "AuthSessionId")),
        Effect.map((rows) => rows.length),
      ),
    ),
  } satisfies SessionPrincipalRepository["Service"]);
});

export const layer = Layer.effect(SessionPrincipalRepository, make);
