import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import {
  ApiToken,
  ApiTokenId,
  BoundProject,
  PrincipalId,
  SessionBinding,
  SessionBindingKind,
} from "@t3tools/contracts";

import { EpochMillis, NullableEpochMillis } from "./epochMillis.ts";
import {
  type ApiTokenRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

const ApiTokenRow = Schema.Struct({
  id: ApiTokenId,
  principalId: PrincipalId,
  scopes: Schema.fromJsonString(Schema.Array(Schema.String)),
  bindingKind: SessionBindingKind,
  projects: Schema.NullOr(Schema.fromJsonString(Schema.Array(BoundProject))),
  expiresAt: NullableEpochMillis,
  lastUsedAt: NullableEpochMillis,
  revokedAt: NullableEpochMillis,
  createdAt: EpochMillis,
});
type ApiTokenRow = typeof ApiTokenRow.Type;

function toToken(row: ApiTokenRow): ApiToken {
  const { bindingKind, projects, ...token } = row;
  return {
    ...token,
    binding:
      bindingKind === "projects"
        ? { _tag: "projects", projects: projects ?? [] }
        : { _tag: bindingKind },
  };
}

export const CreateApiTokenInput = Schema.Struct({
  id: ApiTokenId,
  principalId: PrincipalId,
  /** HMAC of the token; the raw token is shown once. */
  tokenHmac: Schema.String,
  scopes: Schema.Array(Schema.String),
  binding: SessionBinding,
  expiresAt: Schema.NullOr(EpochMillis),
  createdAt: EpochMillis,
});
export type CreateApiTokenInput = typeof CreateApiTokenInput.Type;

export class ApiTokenRepository extends Context.Service<
  ApiTokenRepository,
  {
    readonly create: (input: CreateApiTokenInput) => Effect.Effect<void, ApiTokenRepositoryError>;
    readonly getByHmac: (
      tokenHmac: string,
    ) => Effect.Effect<Option.Option<ApiToken>, ApiTokenRepositoryError>;
    readonly listForPrincipal: (
      principalId: PrincipalId,
    ) => Effect.Effect<ReadonlyArray<ApiToken>, ApiTokenRepositoryError>;
    readonly touchLastUsed: (
      id: ApiTokenId,
      at: EpochMillis,
    ) => Effect.Effect<boolean, ApiTokenRepositoryError>;
    readonly revoke: (
      id: ApiTokenId,
      revokedAt: EpochMillis,
    ) => Effect.Effect<boolean, ApiTokenRepositoryError>;
    readonly revokeAllForPrincipal: (
      principalId: PrincipalId,
      revokedAt: EpochMillis,
    ) => Effect.Effect<number, ApiTokenRepositoryError>;
  }
>()("v3code/persistence/ApiTokens/ApiTokenRepository") {}

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ApiTokenRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectRow = sql`
    SELECT id AS "id", principal_id AS "principalId", scopes_json AS "scopes",
      binding_kind AS "bindingKind", binding_json AS "projects", expires_at AS "expiresAt",
      last_used_at AS "lastUsedAt", revoked_at AS "revokedAt", created_at AS "createdAt"
    FROM api_tokens
  `;

  const createRow = SqlSchema.void({
    Request: CreateApiTokenInput,
    execute: (input) =>
      sql`
        INSERT INTO api_tokens (id, principal_id, token_hmac, scopes_json, binding_kind,
          binding_json, expires_at, created_at)
        VALUES (${input.id}, ${input.principalId}, ${input.tokenHmac},
          ${JSON.stringify(input.scopes)}, ${input.binding._tag},
          ${input.binding._tag === "projects" ? JSON.stringify(input.binding.projects) : null},
          ${input.expiresAt}, ${input.createdAt})
      `,
  });

  const getRowByHmac = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ApiTokenRow,
    execute: (tokenHmac) => sql`${selectRow} WHERE token_hmac = ${tokenHmac}`,
  });

  const listRowsForPrincipal = SqlSchema.findAll({
    Request: PrincipalId,
    Result: ApiTokenRow,
    execute: (principalId) =>
      sql`${selectRow} WHERE principal_id = ${principalId} ORDER BY created_at DESC, id DESC`,
  });

  const touchRow = SqlSchema.findAll({
    Request: Schema.Struct({ id: ApiTokenId, at: EpochMillis }),
    Result: Schema.Struct({ id: ApiTokenId }),
    execute: ({ id, at }) =>
      sql`
        UPDATE api_tokens SET last_used_at = ${at}
        WHERE id = ${id} AND revoked_at IS NULL
        RETURNING id AS "id"
      `,
  });

  const revokeRow = SqlSchema.findAll({
    Request: Schema.Struct({ id: ApiTokenId, revokedAt: EpochMillis }),
    Result: Schema.Struct({ id: ApiTokenId }),
    execute: ({ id, revokedAt }) =>
      sql`
        UPDATE api_tokens SET revoked_at = ${revokedAt}
        WHERE id = ${id} AND revoked_at IS NULL
        RETURNING id AS "id"
      `,
  });

  const revokeRowsForPrincipal = SqlSchema.findAll({
    Request: Schema.Struct({ principalId: PrincipalId, revokedAt: EpochMillis }),
    Result: Schema.Struct({ id: ApiTokenId }),
    execute: ({ principalId, revokedAt }) =>
      sql`
        UPDATE api_tokens SET revoked_at = ${revokedAt}
        WHERE principal_id = ${principalId} AND revoked_at IS NULL
        RETURNING id AS "id"
      `,
  });

  return ApiTokenRepository.of({
    create: Effect.fn("ApiTokenRepository.create")((input) =>
      createRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("createApiToken", "CreateApiTokenInput")),
      ),
    ),
    getByHmac: Effect.fn("ApiTokenRepository.getByHmac")((tokenHmac) =>
      getRowByHmac(tokenHmac).pipe(
        Effect.mapError(toSqlOrDecodeError("getApiTokenByHmac", "ApiToken")),
        Effect.map(Option.map(toToken)),
      ),
    ),
    listForPrincipal: Effect.fn("ApiTokenRepository.listForPrincipal")((principalId) =>
      listRowsForPrincipal(principalId).pipe(
        Effect.mapError(toSqlOrDecodeError("listPrincipalApiTokens", "ApiToken")),
        Effect.map((rows) => rows.map(toToken)),
      ),
    ),
    touchLastUsed: Effect.fn("ApiTokenRepository.touchLastUsed")((id, at) =>
      touchRow({ id, at }).pipe(
        Effect.mapError(toSqlOrDecodeError("touchApiToken", "ApiTokenId")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
    revoke: Effect.fn("ApiTokenRepository.revoke")((id, revokedAt) =>
      revokeRow({ id, revokedAt }).pipe(
        Effect.mapError(toSqlOrDecodeError("revokeApiToken", "ApiTokenId")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
    revokeAllForPrincipal: Effect.fn("ApiTokenRepository.revokeAllForPrincipal")(
      (principalId, revokedAt) =>
        revokeRowsForPrincipal({ principalId, revokedAt }).pipe(
          Effect.mapError(toSqlOrDecodeError("revokePrincipalApiTokens", "ApiToken")),
          Effect.map((rows) => rows.length),
        ),
    ),
  } satisfies ApiTokenRepository["Service"]);
});

export const layer = Layer.effect(ApiTokenRepository, make);
