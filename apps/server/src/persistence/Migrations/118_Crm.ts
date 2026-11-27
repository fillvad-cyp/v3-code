import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Strictly additive CRM schema: project-scoped clients, contacts, notes, and client-thread links
// with encrypted email/phone PII columns, fingerprints, DSR redaction timestamps, and optional
// external-principal binding on invitations.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS crm_clients (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      principal_id TEXT REFERENCES principals (id),
      name TEXT NOT NULL,
      company TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('lead', 'active', 'inactive', 'archived')),
      email_ciphertext BLOB,
      email_fingerprint TEXT,
      phone_ciphertext BLOB,
      phone_fingerprint TEXT,
      redacted_at INTEGER,
      created_by TEXT REFERENCES principals (id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS crm_clients_project
    ON crm_clients (project_id, created_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS crm_clients_principal
    ON crm_clients (principal_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS crm_clients_email_fp
    ON crm_clients (project_id, email_fingerprint)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS crm_contacts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      client_id TEXT NOT NULL REFERENCES crm_clients (id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role_title TEXT,
      email_ciphertext BLOB,
      email_fingerprint TEXT,
      phone_ciphertext BLOB,
      phone_fingerprint TEXT,
      redacted_at INTEGER,
      created_by TEXT REFERENCES principals (id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS crm_contacts_project_client
    ON crm_contacts (project_id, client_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS crm_notes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      client_id TEXT NOT NULL REFERENCES crm_clients (id) ON DELETE CASCADE,
      contact_id TEXT REFERENCES crm_contacts (id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      redacted_at INTEGER,
      created_by TEXT REFERENCES principals (id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS crm_notes_project_client
    ON crm_notes (project_id, client_id, created_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS crm_client_threads (
      project_id TEXT NOT NULL,
      client_id TEXT NOT NULL REFERENCES crm_clients (id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      redacted_at INTEGER,
      created_by TEXT REFERENCES principals (id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, client_id, thread_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS crm_client_threads_thread
    ON crm_client_threads (thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS crm_client_threads_client
    ON crm_client_threads (project_id, client_id)
  `;

  const invitationColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(invitations)
  `;
  if (!invitationColumns.some((column) => column.name === "crm_client_id")) {
    yield* sql`
      ALTER TABLE invitations
      ADD COLUMN crm_client_id TEXT REFERENCES crm_clients (id)
    `;
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS invitations_crm_client
    ON invitations (crm_client_id)
  `;
});
