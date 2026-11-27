import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Dedicated recovery_codes table keeps invitations' CHECK constraint intact and strictly additive,
// and the partial unique index enforces at most one owner principal at the SQLite layer.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS recovery_codes (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      principal_id TEXT NOT NULL REFERENCES principals (id),
      created_by TEXT NOT NULL REFERENCES principals (id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER,
      revoked_at INTEGER
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS recovery_codes_principal
    ON recovery_codes (principal_id, expires_at)
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS principals_single_owner
    ON principals (kind)
    WHERE kind = 'owner'
  `;
});
