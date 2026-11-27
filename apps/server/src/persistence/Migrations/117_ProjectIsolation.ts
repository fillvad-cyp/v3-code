import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Strictly additive: stores per-project L1 OS-user isolation state, allocated port ranges,
// and upgrade adoption status while leaving existing projects on L0 by default.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_isolation (
      project_id TEXT PRIMARY KEY,
      level INTEGER NOT NULL DEFAULT 0 CHECK (level IN (0, 1)),
      service_user TEXT,
      service_group TEXT,
      ports_from INTEGER,
      ports_to INTEGER,
      adoption_state TEXT NOT NULL DEFAULT 'none' CHECK (adoption_state IN ('none', 'pending', 'adopted', 'fallback', 'disabled')),
      fallback_reason TEXT,
      adopted_at INTEGER,
      updated_at INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_isolation_service_user
    ON project_isolation (service_user)
    WHERE service_user IS NOT NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_isolation_ports
    ON project_isolation (ports_from, ports_to)
    WHERE ports_from IS NOT NULL AND ports_to IS NOT NULL
  `;
});
