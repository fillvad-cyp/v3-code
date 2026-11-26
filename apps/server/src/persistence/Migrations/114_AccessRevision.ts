import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_access_revision (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL DEFAULT 0
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO auth_access_revision (id, revision)
    VALUES (1, COALESCE((SELECT SUM(access_revision) FROM principals), 0))
  `;
});
