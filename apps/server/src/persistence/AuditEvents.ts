import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import {
  AUDIT_LIST_DEFAULT_LIMIT,
  AppendAuditEventInput,
  AuditAction,
  type AuditChainVerificationResult,
  AuditEvent,
  AuditOutcome,
  AuditResourceType,
  AuthSessionId,
  ListAuditEventsInput,
  NonNegativeInt,
  PrincipalId,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";

import {
  AUDIT_CHAIN_GENESIS_HASH,
  type AuditHashChainRow,
  canonicalizeAuditMetadata,
  computeAuditEventHash,
  verifyAuditHashChainRows,
} from "./auditHashChain.ts";
import { EpochMillis } from "./epochMillis.ts";
import {
  type AuditEventRepositoryError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

/** Repository list input: contract filters plus an internal project allowlist for project admins. */
export const ListAuditEventsRepositoryInput = Schema.Struct({
  ...ListAuditEventsInput.fields,
  projectIds: Schema.optionalKey(Schema.Array(ProjectId)),
  limit: Schema.optionalKey(NonNegativeInt),
});
export type ListAuditEventsRepositoryInput = typeof ListAuditEventsRepositoryInput.Type;

// Contract inputs carry ISO strings; the columns hold epoch milliseconds.
const AppendRow = Schema.Struct({ ...AppendAuditEventInput.fields, at: EpochMillis });
const ListRows = Schema.Struct({
  ...ListAuditEventsRepositoryInput.fields,
  from: Schema.optionalKey(EpochMillis),
  to: Schema.optionalKey(EpochMillis),
});

const AuditEventRow = Schema.Struct({
  id: Schema.Number,
  at: EpochMillis,
  actorPrincipalId: Schema.NullOr(PrincipalId),
  actorSessionId: Schema.NullOr(AuthSessionId),
  action: AuditAction,
  resourceType: Schema.NullOr(AuditResourceType),
  resourceId: Schema.NullOr(TrimmedNonEmptyString),
  projectId: Schema.NullOr(ProjectId),
  ip: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  outcome: AuditOutcome,
  metadata: Schema.NullOr(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))),
});

/**
 * Append-only. Nothing updates a row; retention deletes old ones by cutting at a timestamp.
 */
export class AuditEventRepository extends Context.Service<
  AuditEventRepository,
  {
    readonly append: (
      input: AppendAuditEventInput,
    ) => Effect.Effect<number, AuditEventRepositoryError>;
    readonly list: (
      input: ListAuditEventsRepositoryInput,
    ) => Effect.Effect<ReadonlyArray<AuditEvent>, AuditEventRepositoryError>;
    readonly pruneBefore: (before: EpochMillis) => Effect.Effect<number, AuditEventRepositoryError>;
    readonly verifyChain: Effect.Effect<AuditChainVerificationResult, AuditEventRepositoryError>;
  }
>()("v3code/persistence/AuditEvents/AuditEventRepository") {}

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): AuditEventRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

const encodeAppendRow = Schema.encodeEffect(AppendRow);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listRows = SqlSchema.findAll({
    Request: ListRows,
    Result: AuditEventRow,
    execute: (input) => {
      const projectIdsClause =
        input.projectIds === undefined
          ? sql`1 = 1`
          : sql`project_id IN ${sql.in(input.projectIds)}`;
      return sql`
        SELECT id AS "id", at AS "at", actor_principal_id AS "actorPrincipalId",
          actor_session_id AS "actorSessionId", action AS "action",
          resource_type AS "resourceType", resource_id AS "resourceId",
          project_id AS "projectId", ip AS "ip", user_agent AS "userAgent",
          outcome AS "outcome", metadata_json AS "metadata"
        FROM audit_events
        WHERE (${input.projectId === undefined ? 1 : 0} = 1 OR project_id = ${input.projectId ?? null})
          AND ${projectIdsClause}
          AND (${input.actorPrincipalId === undefined ? 1 : 0} = 1
            OR actor_principal_id = ${input.actorPrincipalId ?? null})
          AND (${input.action === undefined ? 1 : 0} = 1 OR action = ${input.action ?? null})
          AND (${input.from === undefined ? 1 : 0} = 1 OR at >= ${input.from ?? null})
          AND (${input.to === undefined ? 1 : 0} = 1 OR at <= ${input.to ?? null})
          AND (${input.cursor === undefined ? 1 : 0} = 1 OR id < ${input.cursor ?? null})
        ORDER BY id DESC
        LIMIT ${input.limit ?? AUDIT_LIST_DEFAULT_LIMIT}
      `;
    },
  });

  const pruneRows = SqlSchema.findAll({
    Request: EpochMillis,
    Result: Schema.Struct({ id: Schema.Number }),
    execute: (before) => sql`DELETE FROM audit_events WHERE at < ${before} RETURNING id AS "id"`,
  });

  const verifyChain = Effect.fn("AuditEventRepository.verifyChain")(function* () {
    const rows = yield* sql<AuditHashChainRow>`
      SELECT
        id AS "id",
        at AS "at",
        actor_principal_id AS "actorPrincipalId",
        actor_session_id AS "actorSessionId",
        action AS "action",
        resource_type AS "resourceType",
        resource_id AS "resourceId",
        project_id AS "projectId",
        ip AS "ip",
        user_agent AS "userAgent",
        outcome AS "outcome",
        metadata_json AS "metadataJson",
        prev_hash AS "prevHash",
        event_hash AS "eventHash"
      FROM audit_events
      ORDER BY id ASC
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(toSqlOrDecodeError("verifyAuditChain", "AuditHashChainRow")),
    );
    return verifyAuditHashChainRows(rows);
  });

  return AuditEventRepository.of({
    append: Effect.fn("AuditEventRepository.append")((input) =>
      encodeAppendRow(input).pipe(
        Effect.flatMap((encoded) => {
          const metadataJson = canonicalizeAuditMetadata(encoded.metadata);
          return sql.withTransaction(
            Effect.gen(function* () {
              const previous = yield* sql<{ readonly eventHash: string | null }>`
                SELECT event_hash AS "eventHash"
                FROM audit_events
                ORDER BY id DESC
                LIMIT 1
              `;
              const prevHash = previous[0]?.eventHash ?? AUDIT_CHAIN_GENESIS_HASH;
              const eventHash = computeAuditEventHash(prevHash, {
                at: encoded.at,
                actorPrincipalId: encoded.actorPrincipalId,
                actorSessionId: encoded.actorSessionId,
                action: encoded.action,
                resourceType: encoded.resourceType,
                resourceId: encoded.resourceId,
                projectId: encoded.projectId,
                ip: encoded.ip,
                userAgent: encoded.userAgent,
                outcome: encoded.outcome,
                metadataJson,
              });
              const inserted = yield* sql<{ readonly id: number }>`
                INSERT INTO audit_events (at, actor_principal_id, actor_session_id, action,
                  resource_type, resource_id, project_id, ip, user_agent, outcome, metadata_json,
                  prev_hash, event_hash)
                VALUES (${encoded.at}, ${encoded.actorPrincipalId}, ${encoded.actorSessionId},
                  ${encoded.action}, ${encoded.resourceType}, ${encoded.resourceId},
                  ${encoded.projectId}, ${encoded.ip}, ${encoded.userAgent}, ${encoded.outcome},
                  ${metadataJson}, ${prevHash}, ${eventHash})
                RETURNING id AS "id"
              `;
              return inserted[0]?.id ?? 0;
            }),
          );
        }),
        Effect.mapError(toSqlOrDecodeError("appendAuditEvent", "AppendAuditEventInput")),
      ),
    ),
    list: Effect.fn("AuditEventRepository.list")((input) => {
      if (input.projectIds !== undefined && input.projectIds.length === 0) {
        return Effect.succeed([]);
      }
      if (input.limit === 0) {
        return Effect.succeed([]);
      }
      return listRows(input).pipe(
        Effect.mapError(toSqlOrDecodeError("listAuditEvents", "AuditEvent")),
      );
    }),
    pruneBefore: Effect.fn("AuditEventRepository.pruneBefore")((before) =>
      pruneRows(before).pipe(
        Effect.mapError(toSqlOrDecodeError("pruneAuditEvents", "AuditEvent")),
        Effect.map((rows) => rows.length),
      ),
    ),
    verifyChain: verifyChain(),
  } satisfies AuditEventRepository["Service"]);
});

export const layer = Layer.effect(AuditEventRepository, make);
