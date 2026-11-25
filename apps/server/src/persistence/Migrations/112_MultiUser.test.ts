import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const tables = [
  "principals",
  "principal_credentials",
  "project_memberships",
  "invitations",
  "session_principals",
  "api_tokens",
  "audit_events",
  "member_limits",
  "project_quotas",
  "project_secrets",
];

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `;
  return rows.map((row) => row.name);
});

const projectColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
  return rows.map((row) => row.name);
});

const seedLegacy = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at,
      updated_at)
    VALUES ('web', 'Web', '/srv/web', '[]', '2026-01-01', '2026-01-01')
  `;
  yield* sql`
    INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
    VALUES ('live', 'desktop', '["orchestration:read"]', 'browser-session-cookie', '2026-01-01',
      '2027-01-01')
  `;
  yield* sql`
    INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, revoked_at)
    VALUES ('gone', 'desktop', '[]', 'browser-session-cookie', '2026-01-01', '2027-01-01',
      '2026-02-01')
  `;
});

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("112_MultiUser", (it) => {
  it.effect("adds the tables and keeps a migrated project and its sessions readable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 111 });
      yield* seedLegacy;

      yield* runMigrations();

      const names = yield* tableNames;
      for (const table of tables) assert.include(names, table);
      assert.include(yield* projectColumns, "owner_id");
      assert.include(yield* projectColumns, "visibility");

      const projects = yield* sql<{ readonly title: string; readonly visibility: string }>`
        SELECT title, visibility FROM projection_projects WHERE project_id = 'web'
      `;
      assert.deepStrictEqual(projects, [{ title: "Web", visibility: "shared" }]);

      const owners = yield* sql<{ readonly id: string; readonly kind: string }>`
        SELECT id, kind FROM principals
      `;
      assert.strictEqual(owners.length, 1);
      assert.strictEqual(owners[0]!.kind, "owner");

      const sessions = yield* sql<{ readonly sessionId: string; readonly bindingKind: string }>`
        SELECT session_id AS "sessionId", binding_kind AS "bindingKind" FROM session_principals
      `;
      assert.deepStrictEqual(sessions, [{ sessionId: "live", bindingKind: "environment" }]);
    }),
  );

  it.effect("is a no-op on a second run and keeps one owner", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 112`;
      const before = yield* sql`SELECT id FROM principals`;

      yield* runMigrations();

      assert.deepStrictEqual(yield* sql`SELECT id FROM principals`, before);
    }),
  );

  it.effect("enforces roles, binding shape and outcomes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO project_memberships (project_id, principal_id, role, state, created_at,
          updated_at)
        VALUES ('web', 'owner', 'developer', 'active', 1, 1)
      `;
      assert.isTrue(
        (yield* Effect.result(sql`
          INSERT INTO project_memberships (project_id, principal_id, role, state, created_at,
            updated_at)
          VALUES ('web', 'owner', 'owner', 'active', 1, 1)
        `))._tag === "Failure",
      );
      assert.isTrue(
        (yield* Effect.result(sql`
          INSERT INTO session_principals (session_id, principal_id, binding_kind, binding_json)
          VALUES ('other', 'owner', 'environment', '[]')
        `))._tag === "Failure",
      );
      assert.isTrue(
        (yield* Effect.result(sql`
          INSERT INTO session_principals (session_id, principal_id, binding_kind)
          VALUES ('other', 'owner', 'projects')
        `))._tag === "Failure",
      );
      assert.isTrue(
        (yield* Effect.result(sql`
          INSERT INTO audit_events (at, action, outcome) VALUES (1, 'login.succeeded', 'maybe')
        `))._tag === "Failure",
      );
      yield* sql`
        INSERT INTO audit_events (at, action, outcome) VALUES (1, 'login.succeeded', 'allow')
      `;
    }),
  );
});
