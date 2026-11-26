import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { AUDIT_CHAIN_GENESIS_HASH, computeAuditEventHash } from "../auditHashChain.ts";

interface LegacyAuditRow {
  readonly id: number;
  readonly at: number;
  readonly actorPrincipalId: string | null;
  readonly actorSessionId: string | null;
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly projectId: string | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly outcome: string;
  readonly metadataJson: string | null;
  readonly prevHash: string | null;
  readonly eventHash: string | null;
}

// Strictly additive hash chain columns on audit_events, backfilled in id order so upgraded
// databases start with a verifiable chain.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(audit_events)
  `;
  if (!columns.some((column) => column.name === "prev_hash")) {
    yield* sql`ALTER TABLE audit_events ADD COLUMN prev_hash TEXT`;
  }
  if (!columns.some((column) => column.name === "event_hash")) {
    yield* sql`ALTER TABLE audit_events ADD COLUMN event_hash TEXT`;
  }

  const rows = yield* sql<LegacyAuditRow>`
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
  `;

  let prevHash = AUDIT_CHAIN_GENESIS_HASH;
  for (const row of rows) {
    if (row.prevHash !== null && row.eventHash !== null) {
      prevHash = row.eventHash;
      continue;
    }
    const eventHash = computeAuditEventHash(prevHash, row);
    yield* sql`
      UPDATE audit_events
      SET prev_hash = ${prevHash}, event_hash = ${eventHash}
      WHERE id = ${row.id}
    `;
    prevHash = eventHash;
  }
});
