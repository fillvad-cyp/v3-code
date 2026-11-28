import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import {
  CrmClientId,
  CrmClientStatus,
  CrmClientThread,
  CrmContactId,
  CrmNote,
  CrmNoteId,
  PrincipalId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import { EpochMillis, NullableEpochMillis } from "./epochMillis.ts";
import { type CrmRepositoryError, PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

const CrmClientEncryptedRow = Schema.Struct({
  id: CrmClientId,
  projectId: ProjectId,
  principalId: Schema.NullOr(PrincipalId),
  name: Schema.String,
  company: Schema.NullOr(Schema.String),
  status: CrmClientStatus,
  emailCiphertext: Schema.NullOr(Schema.Uint8Array),
  emailFingerprint: Schema.NullOr(Schema.String),
  phoneCiphertext: Schema.NullOr(Schema.Uint8Array),
  phoneFingerprint: Schema.NullOr(Schema.String),
  redactedAt: NullableEpochMillis,
  createdBy: Schema.NullOr(PrincipalId),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
});
export type EncryptedCrmClientRecord = typeof CrmClientEncryptedRow.Type;

const CrmContactEncryptedRow = Schema.Struct({
  id: CrmContactId,
  projectId: ProjectId,
  clientId: CrmClientId,
  name: Schema.String,
  roleTitle: Schema.NullOr(Schema.String),
  emailCiphertext: Schema.NullOr(Schema.Uint8Array),
  emailFingerprint: Schema.NullOr(Schema.String),
  phoneCiphertext: Schema.NullOr(Schema.Uint8Array),
  phoneFingerprint: Schema.NullOr(Schema.String),
  redactedAt: NullableEpochMillis,
  createdBy: Schema.NullOr(PrincipalId),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
});
export type EncryptedCrmContactRecord = typeof CrmContactEncryptedRow.Type;

const CrmNoteRow = Schema.Struct({
  id: CrmNoteId,
  projectId: ProjectId,
  clientId: CrmClientId,
  contactId: Schema.NullOr(CrmContactId),
  body: Schema.String,
  redactedAt: NullableEpochMillis,
  createdBy: Schema.NullOr(PrincipalId),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
});

const CrmClientThreadRow = Schema.Struct({
  projectId: ProjectId,
  clientId: CrmClientId,
  threadId: ThreadId,
  redactedAt: NullableEpochMillis,
  createdBy: Schema.NullOr(PrincipalId),
  createdAt: EpochMillis,
});

const CreateCrmClientRow = Schema.Struct({
  id: CrmClientId,
  projectId: ProjectId,
  principalId: Schema.NullOr(PrincipalId),
  name: Schema.String,
  company: Schema.NullOr(Schema.String),
  status: CrmClientStatus,
  emailCiphertext: Schema.NullOr(Schema.Uint8Array),
  emailFingerprint: Schema.NullOr(Schema.String),
  phoneCiphertext: Schema.NullOr(Schema.Uint8Array),
  phoneFingerprint: Schema.NullOr(Schema.String),
  createdBy: Schema.NullOr(PrincipalId),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
});
export type CreateCrmClientRecordInput = typeof CreateCrmClientRow.Type;

const UpdateCrmClientRow = Schema.Struct({
  id: CrmClientId,
  projectId: ProjectId,
  name: Schema.String,
  company: Schema.NullOr(Schema.String),
  status: CrmClientStatus,
  emailCiphertext: Schema.NullOr(Schema.Uint8Array),
  emailFingerprint: Schema.NullOr(Schema.String),
  phoneCiphertext: Schema.NullOr(Schema.Uint8Array),
  phoneFingerprint: Schema.NullOr(Schema.String),
  updatedAt: EpochMillis,
});
export type UpdateCrmClientRecordInput = typeof UpdateCrmClientRow.Type;

const PurgeCrmClientRow = Schema.Struct({
  id: CrmClientId,
  projectId: ProjectId,
  redactedName: Schema.String,
  redactedAt: EpochMillis,
});

const CreateCrmContactRow = Schema.Struct({
  id: CrmContactId,
  projectId: ProjectId,
  clientId: CrmClientId,
  name: Schema.String,
  roleTitle: Schema.NullOr(Schema.String),
  emailCiphertext: Schema.NullOr(Schema.Uint8Array),
  emailFingerprint: Schema.NullOr(Schema.String),
  phoneCiphertext: Schema.NullOr(Schema.Uint8Array),
  phoneFingerprint: Schema.NullOr(Schema.String),
  createdBy: Schema.NullOr(PrincipalId),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
});
export type CreateCrmContactRecordInput = typeof CreateCrmContactRow.Type;

const UpdateCrmContactRow = Schema.Struct({
  id: CrmContactId,
  projectId: ProjectId,
  clientId: CrmClientId,
  name: Schema.String,
  roleTitle: Schema.NullOr(Schema.String),
  emailCiphertext: Schema.NullOr(Schema.Uint8Array),
  emailFingerprint: Schema.NullOr(Schema.String),
  phoneCiphertext: Schema.NullOr(Schema.Uint8Array),
  phoneFingerprint: Schema.NullOr(Schema.String),
  updatedAt: EpochMillis,
});
export type UpdateCrmContactRecordInput = typeof UpdateCrmContactRow.Type;

const CreateCrmNoteRow = Schema.Struct({
  id: CrmNoteId,
  projectId: ProjectId,
  clientId: CrmClientId,
  contactId: Schema.NullOr(CrmContactId),
  body: Schema.String,
  createdBy: Schema.NullOr(PrincipalId),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
});
export type CreateCrmNoteRecordInput = typeof CreateCrmNoteRow.Type;

const UpdateCrmNoteRow = Schema.Struct({
  id: CrmNoteId,
  projectId: ProjectId,
  clientId: CrmClientId,
  contactId: Schema.NullOr(CrmContactId),
  body: Schema.String,
  updatedAt: EpochMillis,
});
export type UpdateCrmNoteRecordInput = typeof UpdateCrmNoteRow.Type;

const LinkCrmClientThreadRow = Schema.Struct({
  projectId: ProjectId,
  clientId: CrmClientId,
  threadId: ThreadId,
  createdBy: Schema.NullOr(PrincipalId),
  createdAt: EpochMillis,
});
export type LinkCrmClientThreadRecordInput = typeof LinkCrmClientThreadRow.Type;

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): CrmRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause)
      : new PersistenceSqlError({ operation: sqlOperation, cause });
}

export class CrmRepository extends Context.Service<
  CrmRepository,
  {
    readonly listClientsForProject: (
      projectId: ProjectId,
      principalId?: PrincipalId,
    ) => Effect.Effect<ReadonlyArray<EncryptedCrmClientRecord>, CrmRepositoryError>;
    readonly getClient: (
      projectId: ProjectId,
      clientId: CrmClientId,
    ) => Effect.Effect<Option.Option<EncryptedCrmClientRecord>, CrmRepositoryError>;
    readonly getClientById: (
      clientId: CrmClientId,
    ) => Effect.Effect<Option.Option<EncryptedCrmClientRecord>, CrmRepositoryError>;
    readonly createClient: (
      input: CreateCrmClientRecordInput,
    ) => Effect.Effect<void, CrmRepositoryError>;
    readonly updateClient: (
      input: UpdateCrmClientRecordInput,
    ) => Effect.Effect<boolean, CrmRepositoryError>;
    readonly bindClientPrincipal: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly principalId: PrincipalId;
      readonly updatedAt: string;
    }) => Effect.Effect<boolean, CrmRepositoryError>;
    readonly deleteClient: (
      projectId: ProjectId,
      clientId: CrmClientId,
    ) => Effect.Effect<boolean, CrmRepositoryError>;
    readonly purgeClientPii: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly redactedName: string;
      readonly redactedAt: string;
    }) => Effect.Effect<boolean, CrmRepositoryError>;
    readonly listContactsForClient: (
      projectId: ProjectId,
      clientId: CrmClientId,
    ) => Effect.Effect<ReadonlyArray<EncryptedCrmContactRecord>, CrmRepositoryError>;
    readonly getContact: (
      projectId: ProjectId,
      clientId: CrmClientId,
      contactId: CrmContactId,
    ) => Effect.Effect<Option.Option<EncryptedCrmContactRecord>, CrmRepositoryError>;
    readonly createContact: (
      input: CreateCrmContactRecordInput,
    ) => Effect.Effect<void, CrmRepositoryError>;
    readonly updateContact: (
      input: UpdateCrmContactRecordInput,
    ) => Effect.Effect<boolean, CrmRepositoryError>;
    readonly deleteContact: (
      projectId: ProjectId,
      clientId: CrmClientId,
      contactId: CrmContactId,
    ) => Effect.Effect<boolean, CrmRepositoryError>;
    readonly listNotesForClient: (
      projectId: ProjectId,
      clientId: CrmClientId,
    ) => Effect.Effect<ReadonlyArray<CrmNote>, CrmRepositoryError>;
    readonly getNote: (
      projectId: ProjectId,
      clientId: CrmClientId,
      noteId: CrmNoteId,
    ) => Effect.Effect<Option.Option<CrmNote>, CrmRepositoryError>;
    readonly createNote: (
      input: CreateCrmNoteRecordInput,
    ) => Effect.Effect<void, CrmRepositoryError>;
    readonly updateNote: (
      input: UpdateCrmNoteRecordInput,
    ) => Effect.Effect<boolean, CrmRepositoryError>;
    readonly deleteNote: (
      projectId: ProjectId,
      clientId: CrmClientId,
      noteId: CrmNoteId,
    ) => Effect.Effect<boolean, CrmRepositoryError>;
    readonly listThreadsForClient: (
      projectId: ProjectId,
      clientId: CrmClientId,
    ) => Effect.Effect<ReadonlyArray<CrmClientThread>, CrmRepositoryError>;
    readonly linkThread: (
      input: LinkCrmClientThreadRecordInput,
    ) => Effect.Effect<void, CrmRepositoryError>;
    readonly unlinkThread: (
      projectId: ProjectId,
      clientId: CrmClientId,
      threadId: ThreadId,
    ) => Effect.Effect<boolean, CrmRepositoryError>;
    readonly listThreadIdsForPrincipal: (
      principalId: PrincipalId,
    ) => Effect.Effect<ReadonlyArray<ThreadId>, CrmRepositoryError>;
    readonly listClientIdsForPrincipal: (
      principalId: PrincipalId,
      projectId?: ProjectId,
    ) => Effect.Effect<ReadonlyArray<CrmClientId>, CrmRepositoryError>;
  }
>()("v3code/persistence/Crm/CrmRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectClient = sql`
    SELECT
      id AS "id",
      project_id AS "projectId",
      principal_id AS "principalId",
      name AS "name",
      company AS "company",
      status AS "status",
      email_ciphertext AS "emailCiphertext",
      email_fingerprint AS "emailFingerprint",
      phone_ciphertext AS "phoneCiphertext",
      phone_fingerprint AS "phoneFingerprint",
      redacted_at AS "redactedAt",
      created_by AS "createdBy",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM crm_clients
  `;

  const selectContact = sql`
    SELECT
      id AS "id",
      project_id AS "projectId",
      client_id AS "clientId",
      name AS "name",
      role_title AS "roleTitle",
      email_ciphertext AS "emailCiphertext",
      email_fingerprint AS "emailFingerprint",
      phone_ciphertext AS "phoneCiphertext",
      phone_fingerprint AS "phoneFingerprint",
      redacted_at AS "redactedAt",
      created_by AS "createdBy",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM crm_contacts
  `;

  const selectNote = sql`
    SELECT
      id AS "id",
      project_id AS "projectId",
      client_id AS "clientId",
      contact_id AS "contactId",
      body AS "body",
      redacted_at AS "redactedAt",
      created_by AS "createdBy",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM crm_notes
  `;

  const selectClientThread = sql`
    SELECT
      project_id AS "projectId",
      client_id AS "clientId",
      thread_id AS "threadId",
      redacted_at AS "redactedAt",
      created_by AS "createdBy",
      created_at AS "createdAt"
    FROM crm_client_threads
  `;

  const listClientsRows = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: ProjectId,
      principalId: Schema.optionalKey(PrincipalId),
    }),
    Result: CrmClientEncryptedRow,
    execute: ({ projectId, principalId }) =>
      principalId === undefined
        ? sql`${selectClient} WHERE project_id = ${projectId} ORDER BY created_at DESC, id ASC`
        : sql`${selectClient} WHERE project_id = ${projectId} AND principal_id = ${principalId} ORDER BY created_at DESC, id ASC`,
  });

  const getClientRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ projectId: ProjectId, clientId: CrmClientId }),
    Result: CrmClientEncryptedRow,
    execute: ({ projectId, clientId }) =>
      sql`${selectClient} WHERE project_id = ${projectId} AND id = ${clientId} LIMIT 1`,
  });

  const getClientRowById = SqlSchema.findOneOption({
    Request: CrmClientId,
    Result: CrmClientEncryptedRow,
    execute: (clientId) => sql`${selectClient} WHERE id = ${clientId} LIMIT 1`,
  });

  const createClientRow = SqlSchema.void({
    Request: CreateCrmClientRow,
    execute: (input) => sql`
      INSERT INTO crm_clients (
        id, project_id, principal_id, name, company, status,
        email_ciphertext, email_fingerprint, phone_ciphertext, phone_fingerprint,
        redacted_at, created_by, created_at, updated_at
      ) VALUES (
        ${input.id}, ${input.projectId}, ${input.principalId}, ${input.name}, ${input.company}, ${input.status},
        ${input.emailCiphertext}, ${input.emailFingerprint}, ${input.phoneCiphertext}, ${input.phoneFingerprint},
        NULL, ${input.createdBy}, ${input.createdAt}, ${input.updatedAt}
      )
    `,
  });

  const updateClientRow = SqlSchema.findAll({
    Request: UpdateCrmClientRow,
    Result: Schema.Struct({ id: CrmClientId }),
    execute: (input) => sql`
      UPDATE crm_clients
      SET
        name = ${input.name},
        company = ${input.company},
        status = ${input.status},
        email_ciphertext = ${input.emailCiphertext},
        email_fingerprint = ${input.emailFingerprint},
        phone_ciphertext = ${input.phoneCiphertext},
        phone_fingerprint = ${input.phoneFingerprint},
        updated_at = ${input.updatedAt}
      WHERE project_id = ${input.projectId} AND id = ${input.id}
      RETURNING id AS "id"
    `,
  });

  const bindClientPrincipalRow = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: ProjectId,
      clientId: CrmClientId,
      principalId: PrincipalId,
      updatedAt: EpochMillis,
    }),
    Result: Schema.Struct({ id: CrmClientId }),
    execute: (input) => sql`
      UPDATE crm_clients
      SET principal_id = ${input.principalId}, updated_at = ${input.updatedAt}
      WHERE project_id = ${input.projectId} AND id = ${input.clientId}
      RETURNING id AS "id"
    `,
  });

  const deleteClientRow = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, clientId: CrmClientId }),
    Result: Schema.Struct({ id: CrmClientId }),
    execute: ({ projectId, clientId }) => sql`
      DELETE FROM crm_clients
      WHERE project_id = ${projectId} AND id = ${clientId}
      RETURNING id AS "id"
    `,
  });

  const purgeClientRow = SqlSchema.findAll({
    Request: PurgeCrmClientRow,
    Result: Schema.Struct({ id: CrmClientId }),
    execute: (input) => sql`
      UPDATE crm_clients
      SET
        name = ${input.redactedName},
        company = NULL,
        email_ciphertext = NULL,
        email_fingerprint = NULL,
        phone_ciphertext = NULL,
        phone_fingerprint = NULL,
        redacted_at = ${input.redactedAt},
        updated_at = ${input.redactedAt}
      WHERE project_id = ${input.projectId} AND id = ${input.id}
      RETURNING id AS "id"
    `,
  });

  const purgeClientContactsRow = SqlSchema.void({
    Request: PurgeCrmClientRow,
    execute: (input) => sql`
      UPDATE crm_contacts
      SET
        name = ${input.redactedName},
        role_title = NULL,
        email_ciphertext = NULL,
        email_fingerprint = NULL,
        phone_ciphertext = NULL,
        phone_fingerprint = NULL,
        redacted_at = ${input.redactedAt},
        updated_at = ${input.redactedAt}
      WHERE project_id = ${input.projectId} AND client_id = ${input.id}
    `,
  });

  const purgeClientNotesRow = SqlSchema.void({
    Request: Schema.Struct({
      projectId: ProjectId,
      clientId: CrmClientId,
      redactedAt: EpochMillis,
    }),
    execute: (input) => sql`
      UPDATE crm_notes
      SET
        body = '',
        redacted_at = ${input.redactedAt},
        updated_at = ${input.redactedAt}
      WHERE project_id = ${input.projectId} AND client_id = ${input.clientId}
    `,
  });

  const listContactsRows = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, clientId: CrmClientId }),
    Result: CrmContactEncryptedRow,
    execute: ({ projectId, clientId }) => sql`
      ${selectContact}
      WHERE project_id = ${projectId} AND client_id = ${clientId}
      ORDER BY created_at ASC, id ASC
    `,
  });

  const getContactRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      projectId: ProjectId,
      clientId: CrmClientId,
      contactId: CrmContactId,
    }),
    Result: CrmContactEncryptedRow,
    execute: ({ projectId, clientId, contactId }) => sql`
      ${selectContact}
      WHERE project_id = ${projectId} AND client_id = ${clientId} AND id = ${contactId}
      LIMIT 1
    `,
  });

  const createContactRow = SqlSchema.void({
    Request: CreateCrmContactRow,
    execute: (input) => sql`
      INSERT INTO crm_contacts (
        id, project_id, client_id, name, role_title,
        email_ciphertext, email_fingerprint, phone_ciphertext, phone_fingerprint,
        redacted_at, created_by, created_at, updated_at
      ) VALUES (
        ${input.id}, ${input.projectId}, ${input.clientId}, ${input.name}, ${input.roleTitle},
        ${input.emailCiphertext}, ${input.emailFingerprint}, ${input.phoneCiphertext}, ${input.phoneFingerprint},
        NULL, ${input.createdBy}, ${input.createdAt}, ${input.updatedAt}
      )
    `,
  });

  const updateContactRow = SqlSchema.findAll({
    Request: UpdateCrmContactRow,
    Result: Schema.Struct({ id: CrmContactId }),
    execute: (input) => sql`
      UPDATE crm_contacts
      SET
        name = ${input.name},
        role_title = ${input.roleTitle},
        email_ciphertext = ${input.emailCiphertext},
        email_fingerprint = ${input.emailFingerprint},
        phone_ciphertext = ${input.phoneCiphertext},
        phone_fingerprint = ${input.phoneFingerprint},
        updated_at = ${input.updatedAt}
      WHERE project_id = ${input.projectId} AND client_id = ${input.clientId} AND id = ${input.id}
      RETURNING id AS "id"
    `,
  });

  const deleteContactRow = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: ProjectId,
      clientId: CrmClientId,
      contactId: CrmContactId,
    }),
    Result: Schema.Struct({ id: CrmContactId }),
    execute: ({ projectId, clientId, contactId }) => sql`
      DELETE FROM crm_contacts
      WHERE project_id = ${projectId} AND client_id = ${clientId} AND id = ${contactId}
      RETURNING id AS "id"
    `,
  });

  const listNotesRows = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, clientId: CrmClientId }),
    Result: CrmNoteRow,
    execute: ({ projectId, clientId }) => sql`
      ${selectNote}
      WHERE project_id = ${projectId} AND client_id = ${clientId}
      ORDER BY created_at DESC, id ASC
    `,
  });

  const getNoteRow = SqlSchema.findOneOption({
    Request: Schema.Struct({
      projectId: ProjectId,
      clientId: CrmClientId,
      noteId: CrmNoteId,
    }),
    Result: CrmNoteRow,
    execute: ({ projectId, clientId, noteId }) => sql`
      ${selectNote}
      WHERE project_id = ${projectId} AND client_id = ${clientId} AND id = ${noteId}
      LIMIT 1
    `,
  });

  const createNoteRow = SqlSchema.void({
    Request: CreateCrmNoteRow,
    execute: (input) => sql`
      INSERT INTO crm_notes (
        id, project_id, client_id, contact_id, body,
        redacted_at, created_by, created_at, updated_at
      ) VALUES (
        ${input.id}, ${input.projectId}, ${input.clientId}, ${input.contactId}, ${input.body},
        NULL, ${input.createdBy}, ${input.createdAt}, ${input.updatedAt}
      )
    `,
  });

  const updateNoteRow = SqlSchema.findAll({
    Request: UpdateCrmNoteRow,
    Result: Schema.Struct({ id: CrmNoteId }),
    execute: (input) => sql`
      UPDATE crm_notes
      SET
        contact_id = ${input.contactId},
        body = ${input.body},
        updated_at = ${input.updatedAt}
      WHERE project_id = ${input.projectId} AND client_id = ${input.clientId} AND id = ${input.id}
      RETURNING id AS "id"
    `,
  });

  const deleteNoteRow = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: ProjectId,
      clientId: CrmClientId,
      noteId: CrmNoteId,
    }),
    Result: Schema.Struct({ id: CrmNoteId }),
    execute: ({ projectId, clientId, noteId }) => sql`
      DELETE FROM crm_notes
      WHERE project_id = ${projectId} AND client_id = ${clientId} AND id = ${noteId}
      RETURNING id AS "id"
    `,
  });

  const listThreadsRows = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: ProjectId, clientId: CrmClientId }),
    Result: CrmClientThreadRow,
    execute: ({ projectId, clientId }) => sql`
      ${selectClientThread}
      WHERE project_id = ${projectId} AND client_id = ${clientId}
      ORDER BY created_at DESC, thread_id ASC
    `,
  });

  const linkThreadRow = SqlSchema.void({
    Request: LinkCrmClientThreadRow,
    execute: (input) => sql`
      INSERT OR IGNORE INTO crm_client_threads (
        project_id, client_id, thread_id, redacted_at, created_by, created_at
      ) VALUES (
        ${input.projectId}, ${input.clientId}, ${input.threadId}, NULL, ${input.createdBy}, ${input.createdAt}
      )
    `,
  });

  const unlinkThreadRow = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: ProjectId,
      clientId: CrmClientId,
      threadId: ThreadId,
    }),
    Result: Schema.Struct({ threadId: ThreadId }),
    execute: ({ projectId, clientId, threadId }) => sql`
      DELETE FROM crm_client_threads
      WHERE project_id = ${projectId} AND client_id = ${clientId} AND thread_id = ${threadId}
      RETURNING thread_id AS "threadId"
    `,
  });

  const listThreadIdsByPrincipalRows = SqlSchema.findAll({
    Request: PrincipalId,
    Result: Schema.Struct({ threadId: ThreadId }),
    execute: (principalId) => sql`
      SELECT DISTINCT ct.thread_id AS "threadId"
      FROM crm_client_threads ct
      INNER JOIN crm_clients c
        ON c.id = ct.client_id AND c.project_id = ct.project_id
      WHERE c.principal_id = ${principalId}
        AND ct.redacted_at IS NULL
    `,
  });

  const listClientIdsByPrincipalRows = SqlSchema.findAll({
    Request: Schema.Struct({
      principalId: PrincipalId,
      projectId: Schema.optionalKey(ProjectId),
    }),
    Result: Schema.Struct({ id: CrmClientId }),
    execute: ({ principalId, projectId }) =>
      projectId === undefined
        ? sql`SELECT id AS "id" FROM crm_clients WHERE principal_id = ${principalId}`
        : sql`SELECT id AS "id" FROM crm_clients WHERE principal_id = ${principalId} AND project_id = ${projectId}`,
  });

  return CrmRepository.of({
    listClientsForProject: Effect.fn("CrmRepository.listClientsForProject")(
      (projectId, principalId) =>
        listClientsRows({
          projectId,
          ...(principalId === undefined ? {} : { principalId }),
        }).pipe(Effect.mapError(toSqlOrDecodeError("listCrmClients", "EncryptedCrmClientRecord"))),
    ),
    getClient: Effect.fn("CrmRepository.getClient")((projectId, clientId) =>
      getClientRow({ projectId, clientId }).pipe(
        Effect.mapError(toSqlOrDecodeError("getCrmClient", "EncryptedCrmClientRecord")),
      ),
    ),
    getClientById: Effect.fn("CrmRepository.getClientById")((clientId) =>
      getClientRowById(clientId).pipe(
        Effect.mapError(toSqlOrDecodeError("getCrmClientById", "EncryptedCrmClientRecord")),
      ),
    ),
    createClient: Effect.fn("CrmRepository.createClient")((input) =>
      createClientRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("createCrmClient", "CreateCrmClientRow")),
      ),
    ),
    updateClient: Effect.fn("CrmRepository.updateClient")((input) =>
      updateClientRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("updateCrmClient", "UpdateCrmClientRow")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
    bindClientPrincipal: Effect.fn("CrmRepository.bindClientPrincipal")((input) =>
      bindClientPrincipalRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("bindCrmClientPrincipal", "CrmClientId")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
    deleteClient: Effect.fn("CrmRepository.deleteClient")((projectId, clientId) =>
      deleteClientRow({ projectId, clientId }).pipe(
        Effect.mapError(toSqlOrDecodeError("deleteCrmClient", "CrmClientId")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
    purgeClientPii: Effect.fn("CrmRepository.purgeClientPii")((input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* purgeClientRow({
              id: input.clientId,
              projectId: input.projectId,
              redactedName: input.redactedName,
              redactedAt: input.redactedAt,
            });
            if (rows.length === 0) {
              return false;
            }
            yield* purgeClientContactsRow({
              id: input.clientId,
              projectId: input.projectId,
              redactedName: input.redactedName,
              redactedAt: input.redactedAt,
            });
            yield* purgeClientNotesRow({
              projectId: input.projectId,
              clientId: input.clientId,
              redactedAt: input.redactedAt,
            });
            return true;
          }),
        )
        .pipe(Effect.mapError(toSqlOrDecodeError("purgeCrmClientPii", "PurgeCrmClientRow"))),
    ),
    listContactsForClient: Effect.fn("CrmRepository.listContactsForClient")((projectId, clientId) =>
      listContactsRows({ projectId, clientId }).pipe(
        Effect.mapError(toSqlOrDecodeError("listCrmContacts", "EncryptedCrmContactRecord")),
      ),
    ),
    getContact: Effect.fn("CrmRepository.getContact")((projectId, clientId, contactId) =>
      getContactRow({ projectId, clientId, contactId }).pipe(
        Effect.mapError(toSqlOrDecodeError("getCrmContact", "EncryptedCrmContactRecord")),
      ),
    ),
    createContact: Effect.fn("CrmRepository.createContact")((input) =>
      createContactRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("createCrmContact", "CreateCrmContactRow")),
      ),
    ),
    updateContact: Effect.fn("CrmRepository.updateContact")((input) =>
      updateContactRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("updateCrmContact", "UpdateCrmContactRow")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
    deleteContact: Effect.fn("CrmRepository.deleteContact")((projectId, clientId, contactId) =>
      deleteContactRow({ projectId, clientId, contactId }).pipe(
        Effect.mapError(toSqlOrDecodeError("deleteCrmContact", "CrmContactId")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
    listNotesForClient: Effect.fn("CrmRepository.listNotesForClient")((projectId, clientId) =>
      listNotesRows({ projectId, clientId }).pipe(
        Effect.mapError(toSqlOrDecodeError("listCrmNotes", "CrmNote")),
      ),
    ),
    getNote: Effect.fn("CrmRepository.getNote")((projectId, clientId, noteId) =>
      getNoteRow({ projectId, clientId, noteId }).pipe(
        Effect.mapError(toSqlOrDecodeError("getCrmNote", "CrmNote")),
      ),
    ),
    createNote: Effect.fn("CrmRepository.createNote")((input) =>
      createNoteRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("createCrmNote", "CreateCrmNoteRow")),
      ),
    ),
    updateNote: Effect.fn("CrmRepository.updateNote")((input) =>
      updateNoteRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("updateCrmNote", "UpdateCrmNoteRow")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
    deleteNote: Effect.fn("CrmRepository.deleteNote")((projectId, clientId, noteId) =>
      deleteNoteRow({ projectId, clientId, noteId }).pipe(
        Effect.mapError(toSqlOrDecodeError("deleteCrmNote", "CrmNoteId")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
    listThreadsForClient: Effect.fn("CrmRepository.listThreadsForClient")((projectId, clientId) =>
      listThreadsRows({ projectId, clientId }).pipe(
        Effect.mapError(toSqlOrDecodeError("listCrmClientThreads", "CrmClientThread")),
      ),
    ),
    linkThread: Effect.fn("CrmRepository.linkThread")((input) =>
      linkThreadRow(input).pipe(
        Effect.mapError(toSqlOrDecodeError("linkCrmClientThread", "LinkCrmClientThreadRow")),
      ),
    ),
    unlinkThread: Effect.fn("CrmRepository.unlinkThread")((projectId, clientId, threadId) =>
      unlinkThreadRow({ projectId, clientId, threadId }).pipe(
        Effect.mapError(toSqlOrDecodeError("unlinkCrmClientThread", "ThreadId")),
        Effect.map((rows) => rows.length > 0),
      ),
    ),
    listThreadIdsForPrincipal: Effect.fn("CrmRepository.listThreadIdsForPrincipal")((principalId) =>
      listThreadIdsByPrincipalRows(principalId).pipe(
        Effect.mapError(toSqlOrDecodeError("listCrmThreadsForPrincipal", "ThreadId")),
        Effect.map((rows) => rows.map((row) => row.threadId)),
      ),
    ),
    listClientIdsForPrincipal: Effect.fn("CrmRepository.listClientIdsForPrincipal")(
      (principalId, projectId) =>
        listClientIdsByPrincipalRows({
          principalId,
          ...(projectId === undefined ? {} : { projectId }),
        }).pipe(
          Effect.mapError(toSqlOrDecodeError("listCrmClientsForPrincipal", "CrmClientId")),
          Effect.map((rows) => rows.map((row) => row.id)),
        ),
    ),
  } satisfies CrmRepository["Service"]);
});

export const layer = Layer.effect(CrmRepository, make);
