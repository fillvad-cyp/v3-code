import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Strictly additive: adds per-principal preview tab override column and a small table for periodic
// project disk usage samples so shell reads and quota checks never scan the filesystem inline.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(member_limits)
  `;
  if (!columns.some((column) => column.name === "max_preview_tabs")) {
    yield* sql`ALTER TABLE member_limits ADD COLUMN max_preview_tabs INTEGER`;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_usage_samples (
      project_id TEXT PRIMARY KEY,
      disk_bytes INTEGER NOT NULL DEFAULT 0,
      sampled_at INTEGER NOT NULL
    )
  `;
});
