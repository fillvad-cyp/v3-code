import * as NodeOS from "node:os";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Identity, membership and the records that follow from them. Everything here is additive and
// unread by the single-owner code, so an older build keeps working on a migrated database.
//
// Exactly one owner exists per environment. It is seeded once from the machine, so sessions from
// before this table existed have something to point at; later steps replace it with a real login.
const OWNER_ID = "owner";

function ownerDisplayName(): string {
  try {
    return NodeOS.userInfo().username || "Owner";
  } catch {
    return "Owner";
  }
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS principals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('owner', 'member', 'external', 'service')),
      display_name TEXT NOT NULL,
      email TEXT UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'suspended', 'removed')),
      ceiling_json TEXT NOT NULL DEFAULT '[]',
      access_revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      removed_at INTEGER
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS principal_credentials (
      principal_id TEXT PRIMARY KEY REFERENCES principals (id),
      algo TEXT NOT NULL DEFAULT 'scrypt',
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_memberships (
      project_id TEXT NOT NULL,
      principal_id TEXT NOT NULL REFERENCES principals (id),
      role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'developer', 'manager', 'admin')),
      state TEXT NOT NULL CHECK (state IN ('invited', 'active', 'suspended', 'removed')),
      invited_by TEXT REFERENCES principals (id),
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, principal_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS project_memberships_principal
    ON project_memberships (principal_id, state)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS project_memberships_project
    ON project_memberships (project_id, role)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      email TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('staff', 'client')),
      role TEXT NOT NULL,
      project_id TEXT,
      ceiling_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL REFERENCES principals (id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      accepted_at INTEGER,
      revoked_at INTEGER
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS invitations_pending
    ON invitations (expires_at, accepted_at, revoked_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS session_principals (
      session_id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES principals (id),
      binding_kind TEXT NOT NULL CHECK (binding_kind IN ('environment', 'principal', 'projects')),
      binding_json TEXT,
      -- Only a projects binding carries projects, and it always does.
      CHECK ((binding_kind = 'projects') = (binding_json IS NOT NULL))
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL REFERENCES principals (id),
      token_hmac TEXT NOT NULL UNIQUE,
      scopes_json TEXT NOT NULL,
      binding_kind TEXT NOT NULL CHECK (binding_kind IN ('environment', 'principal', 'projects')),
      binding_json TEXT,
      expires_at INTEGER,
      last_used_at INTEGER,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      CHECK ((binding_kind = 'projects') = (binding_json IS NOT NULL))
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS api_tokens_principal ON api_tokens (principal_id)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      actor_principal_id TEXT,
      actor_session_id TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      project_id TEXT,
      ip TEXT,
      user_agent TEXT,
      outcome TEXT NOT NULL CHECK (outcome IN ('allow', 'deny', 'error')),
      metadata_json TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS audit_events_at ON audit_events (at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS audit_events_project ON audit_events (project_id, at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS audit_events_actor ON audit_events (actor_principal_id, at)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS member_limits (
      principal_id TEXT PRIMARY KEY REFERENCES principals (id),
      max_sessions INTEGER,
      max_terminals INTEGER,
      invites_per_hour INTEGER,
      max_api_tokens INTEGER
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_quotas (
      project_id TEXT PRIMARY KEY,
      max_active_threads INTEGER,
      max_worktrees INTEGER,
      disk_bytes INTEGER,
      attachment_bytes INTEGER
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_secrets (
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      ciphertext BLOB NOT NULL,
      fingerprint TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, name)
    )
  `;

  // Earlier builds of this change may have shipped one column already.
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!columns.some((column) => column.name === "owner_id")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN owner_id TEXT`;
  }
  if (!columns.some((column) => column.name === "visibility")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared'
    `;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS projection_projects_owner
    ON projection_projects (owner_id)
  `;

  const now = yield* Clock.currentTimeMillis;
  yield* sql`
    INSERT INTO principals (id, kind, display_name, email, status, ceiling_json, access_revision,
      created_at, updated_at)
    SELECT ${OWNER_ID}, 'owner', ${ownerDisplayName()}, NULL, 'active', '[]', 0, ${now}, ${now}
    WHERE NOT EXISTS (SELECT 1 FROM principals WHERE kind = 'owner')
  `;
  // Live sessions from before this table keep working as environment-wide ones.
  yield* sql`
    INSERT OR IGNORE INTO session_principals (session_id, principal_id, binding_kind)
    SELECT session_id, ${OWNER_ID}, 'environment'
    FROM auth_sessions
    WHERE revoked_at IS NULL
  `;
});
