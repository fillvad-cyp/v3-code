import {
  type AuthSessionId,
  CRM_REDACTED_PLACEHOLDER,
  type CrmClient,
  type CrmClientCreateInput,
  type CrmClientDeleteResult,
  type CrmClientDetail,
  CrmClientId,
  type CrmClientInviteResult,
  type CrmClientThread,
  type CrmClientUpdateInput,
  type CrmContact,
  type CrmContactCreateInput,
  CrmContactId,
  type CrmContactUpdateInput,
  type CrmNote,
  type CrmNoteCreateInput,
  CrmNoteId,
  type CrmNoteUpdateInput,
  type CrmPortalThread,
  type CrmPortalView,
  OrchestrationV2ShellThreadStatus,
  ProjectForbiddenError,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  ceilingScopes,
  maskCrmEmail,
  maskCrmPhone,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as ResourceResolver from "../access/ResourceResolver.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as InvitationService from "../identity/InvitationService.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as CrmRepo from "../persistence/Crm.ts";
import * as ProjectSecrets from "../project/ProjectSecrets.ts";

export interface CrmAuditContext {
  readonly sessionId?: AuthSessionId | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export const CrmInvalidInputReason = Schema.Literals([
  "empty_name",
  "empty_body",
  "client_redacted",
]);
export type CrmInvalidInputReason = typeof CrmInvalidInputReason.Type;

export class CrmInvalidInputError extends Schema.TaggedError<CrmInvalidInputError>()(
  "CrmInvalidInputError",
  {
    reason: CrmInvalidInputReason,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "empty_name":
        return "A non-empty name is required.";
      case "empty_body":
        return "A non-empty note body is required.";
      case "client_redacted":
        return "This CRM client has been purged and cannot be modified or invited.";
    }
  }
}

export class CrmNotFoundError extends Schema.TaggedError<CrmNotFoundError>()("CrmNotFoundError", {
  resource: Schema.Literals(["project", "client", "contact", "note", "thread"]),
  projectId: Schema.optionalKey(ProjectId),
}) {
  override get message(): string {
    return this.projectId === undefined
      ? `The requested CRM ${this.resource} was not found.`
      : `The requested CRM ${this.resource} was not found in project ${this.projectId}.`;
  }
}

export class CrmRateLimitedError extends Schema.TaggedError<CrmRateLimitedError>()(
  "CrmRateLimitedError",
  {
    message: Schema.String,
  },
) {}

export class CrmInternalError extends Schema.TaggedError<CrmInternalError>()("CrmInternalError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `CRM operation failed (${this.operation}).`;
  }
}

export type CrmServiceError =
  | ProjectForbiddenError
  | CrmInvalidInputError
  | CrmNotFoundError
  | CrmRateLimitedError
  | CrmInternalError;

const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeShellThreadStatus = Schema.decodeUnknownOption(OrchestrationV2ShellThreadStatus);

interface EncryptedPiiField {
  readonly ciphertext: Uint8Array | null;
  readonly fingerprint: string | null;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function encryptOptionalPii(input: {
  readonly key: Uint8Array;
  readonly projectId: ProjectId;
  readonly aadName: string;
  readonly value: string | null | undefined;
  readonly normalizeForFingerprint?: (raw: string) => string;
}): EncryptedPiiField {
  const cleaned = normalizeOptionalText(input.value);
  if (cleaned === null) {
    return { ciphertext: null, fingerprint: null };
  }
  const fpSource = input.normalizeForFingerprint ? input.normalizeForFingerprint(cleaned) : cleaned;
  return {
    ciphertext: ProjectSecrets.encryptProjectAesValue(
      input.key,
      input.projectId,
      input.aadName,
      cleaned,
    ),
    fingerprint: ProjectSecrets.fingerprintSecretValue(fpSource),
  };
}

function isExternalActor(actor: ProjectAccess.AccessActor): boolean {
  return !actor.isOwner && actor.principalKind === "external";
}

export class CrmService extends Context.Service<
  CrmService,
  {
    readonly listClients: (input: {
      readonly projectId: ProjectId;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<ReadonlyArray<CrmClient>, CrmServiceError>;
    readonly getClient: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<CrmClientDetail, CrmServiceError>;
    readonly createClient: (input: {
      readonly projectId: ProjectId;
      readonly data: CrmClientCreateInput;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<CrmClient, CrmServiceError>;
    readonly updateClient: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly data: CrmClientUpdateInput;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<CrmClient, CrmServiceError>;
    readonly deleteClient: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly purge: boolean;
      readonly actor: ProjectAccess.AccessActor;
      readonly audit?: CrmAuditContext;
    }) => Effect.Effect<CrmClientDeleteResult, CrmServiceError>;
    readonly listContacts: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<ReadonlyArray<CrmContact>, CrmServiceError>;
    readonly createContact: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly data: CrmContactCreateInput;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<CrmContact, CrmServiceError>;
    readonly updateContact: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly contactId: CrmContactId;
      readonly data: CrmContactUpdateInput;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<CrmContact, CrmServiceError>;
    readonly deleteContact: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly contactId: CrmContactId;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<boolean, CrmServiceError>;
    readonly listNotes: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<ReadonlyArray<CrmNote>, CrmServiceError>;
    readonly createNote: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly data: CrmNoteCreateInput;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<CrmNote, CrmServiceError>;
    readonly updateNote: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly noteId: CrmNoteId;
      readonly data: CrmNoteUpdateInput;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<CrmNote, CrmServiceError>;
    readonly deleteNote: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly noteId: CrmNoteId;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<boolean, CrmServiceError>;
    readonly listClientThreads: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<ReadonlyArray<CrmClientThread>, CrmServiceError>;
    readonly linkClientThread: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly threadId: ThreadId;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<CrmClientThread, CrmServiceError>;
    readonly unlinkClientThread: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly threadId: ThreadId;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<boolean, CrmServiceError>;
    readonly inviteClient: (input: {
      readonly projectId: ProjectId;
      readonly clientId: CrmClientId;
      readonly actor: ProjectAccess.AccessActor;
      readonly audit?: CrmAuditContext;
    }) => Effect.Effect<CrmClientInviteResult, CrmServiceError>;
    readonly exportJsonl: (input: {
      readonly projectId: ProjectId;
      readonly clientId?: CrmClientId;
      readonly actor: ProjectAccess.AccessActor;
      readonly audit?: CrmAuditContext;
    }) => Effect.Effect<string, CrmServiceError>;
    readonly getPortal: (input: {
      readonly clientId?: CrmClientId;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<CrmPortalView, CrmServiceError>;
  }
>()("v3code/crm/CrmService") {}

const make = Effect.gen(function* () {
  const repo = yield* CrmRepo.CrmRepository;
  const projectAccess = yield* ProjectAccess.ProjectAccess;
  const resourceResolver = yield* ResourceResolver.ResourceResolver;
  const invitations = yield* InvitationService.InvitationService;
  const auditEvents = yield* AuditEvents.AuditEventRepository;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;

  const keyRef = yield* Ref.make<Option.Option<Uint8Array>>(Option.none());
  const keyLock = yield* Semaphore.make(1);

  const loadKey = Effect.fn("CrmService.loadKey")(function* () {
    const cached = yield* Ref.get(keyRef);
    if (Option.isSome(cached)) {
      return cached.value;
    }
    return yield* keyLock.withPermits(1)(
      Effect.gen(function* () {
        const rechecked = yield* Ref.get(keyRef);
        if (Option.isSome(rechecked)) {
          return rechecked.value;
        }
        const loaded = yield* secretStore
          .getOrCreateRandom(ProjectSecrets.PROJECT_SECRETS_KEY_NAME, ProjectSecrets.AES_KEY_BYTES)
          .pipe(
            Effect.mapError(
              (cause) => new CrmInternalError({ operation: "loadEncryptionKey", cause }),
            ),
          );
        if (loaded.byteLength !== ProjectSecrets.AES_KEY_BYTES) {
          return yield* new CrmInternalError({
            operation: "loadEncryptionKey",
            cause: new Error(`Unexpected project secrets key length: ${loaded.byteLength}.`),
          });
        }
        yield* Ref.set(keyRef, Option.some(loaded));
        return loaded;
      }),
    );
  });

  const assertActiveProject = Effect.fn("CrmService.assertActiveProject")(function* (
    projectId: ProjectId,
  ) {
    const rows = yield* sql<{ readonly present: number }>`
      SELECT 1 AS "present"
      FROM projection_projects
      WHERE project_id = ${projectId} AND deleted_at IS NULL
      LIMIT 1
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError((cause) => new CrmInternalError({ operation: "getActiveProject", cause })),
    );
    if (rows.length === 0) {
      return yield* new CrmNotFoundError({ resource: "project", projectId });
    }
  });

  const decryptAndMaskField = Effect.fnUntraced(function* (input: {
    readonly key: Uint8Array;
    readonly projectId: ProjectId;
    readonly aadName: string;
    readonly ciphertext: Uint8Array | null;
    readonly mask: (plaintext: string) => string;
  }) {
    if (input.ciphertext === null) {
      return null;
    }
    const plaintext = yield* ProjectSecrets.decryptProjectAesValue(
      input.key,
      input.projectId,
      input.aadName,
      input.ciphertext,
    ).pipe(Effect.mapError((cause) => new CrmInternalError({ operation: "decryptCrmPii", cause })));
    return input.mask(plaintext);
  });

  const toPublicClient = Effect.fnUntraced(function* (
    key: Uint8Array,
    record: CrmRepo.EncryptedCrmClientRecord,
  ): Effect.fn.Return<CrmClient, CrmInternalError> {
    const emailMasked =
      record.redactedAt !== null
        ? null
        : yield* decryptAndMaskField({
            key,
            projectId: record.projectId,
            aadName: `crm:client:${record.id}:email`,
            ciphertext: record.emailCiphertext,
            mask: maskCrmEmail,
          });
    const phoneMasked =
      record.redactedAt !== null
        ? null
        : yield* decryptAndMaskField({
            key,
            projectId: record.projectId,
            aadName: `crm:client:${record.id}:phone`,
            ciphertext: record.phoneCiphertext,
            mask: maskCrmPhone,
          });
    return {
      id: record.id,
      projectId: record.projectId,
      principalId: record.principalId,
      name: record.name,
      company: record.company,
      status: record.status,
      emailMasked,
      emailFingerprint: record.emailFingerprint,
      phoneMasked,
      phoneFingerprint: record.phoneFingerprint,
      redactedAt: record.redactedAt,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    } satisfies CrmClient;
  });

  const toPublicContact = Effect.fnUntraced(function* (
    key: Uint8Array,
    record: CrmRepo.EncryptedCrmContactRecord,
  ): Effect.fn.Return<CrmContact, CrmInternalError> {
    const emailMasked =
      record.redactedAt !== null
        ? null
        : yield* decryptAndMaskField({
            key,
            projectId: record.projectId,
            aadName: `crm:contact:${record.id}:email`,
            ciphertext: record.emailCiphertext,
            mask: maskCrmEmail,
          });
    const phoneMasked =
      record.redactedAt !== null
        ? null
        : yield* decryptAndMaskField({
            key,
            projectId: record.projectId,
            aadName: `crm:contact:${record.id}:phone`,
            ciphertext: record.phoneCiphertext,
            mask: maskCrmPhone,
          });
    return {
      id: record.id,
      projectId: record.projectId,
      clientId: record.clientId,
      name: record.name,
      roleTitle: record.roleTitle,
      emailMasked,
      emailFingerprint: record.emailFingerprint,
      phoneMasked,
      phoneFingerprint: record.phoneFingerprint,
      redactedAt: record.redactedAt,
      createdBy: record.createdBy,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    } satisfies CrmContact;
  });

  const requireClientInProject = Effect.fnUntraced(function* (input: {
    readonly projectId: ProjectId;
    readonly clientId: CrmClientId;
    readonly actor: ProjectAccess.AccessActor;
  }) {
    const maybeClient = yield* repo
      .getClient(input.projectId, input.clientId)
      .pipe(Effect.mapError((cause) => new CrmInternalError({ operation: "getClient", cause })));
    if (Option.isNone(maybeClient)) {
      return yield* new CrmNotFoundError({ resource: "client", projectId: input.projectId });
    }
    if (isExternalActor(input.actor)) {
      const resolvedPrincipal = yield* resourceResolver.resolveCrmClientPrincipal(input.clientId);
      if (input.actor.principalId === undefined || resolvedPrincipal !== input.actor.principalId) {
        return yield* new CrmNotFoundError({ resource: "client", projectId: input.projectId });
      }
    }
    return maybeClient.value;
  });

  const appendAudit = Effect.fn("CrmService.appendAudit")(function* (input: {
    readonly actor: ProjectAccess.AccessActor;
    readonly action: "crm.exported" | "crm.purged";
    readonly projectId: ProjectId;
    readonly resourceId: string;
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly audit?: CrmAuditContext;
  }) {
    const now = yield* DateTime.now;
    yield* auditEvents
      .append({
        at: DateTime.formatIso(now),
        actorPrincipalId: input.actor.principalId ?? null,
        actorSessionId: input.audit?.sessionId ?? input.actor.sessionId,
        action: input.action,
        resourceType: "crm_client",
        resourceId: TrimmedNonEmptyString.make(input.resourceId),
        projectId: input.projectId,
        ip: input.audit?.ip ?? null,
        userAgent: input.audit?.userAgent ?? null,
        outcome: "allow",
        metadata: input.metadata,
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to write CRM audit event.", {
            action: input.action,
            projectId: input.projectId,
            resourceId: input.resourceId,
            cause,
          }),
        ),
        Effect.ignore,
      );
  });

  const listClients: CrmService["Service"]["listClients"] = Effect.fn("CrmService.listClients")(
    function* ({ projectId, actor }) {
      const resource = resourceResolver.resourceForCrmHttpEndpoint("listClients", { projectId });
      yield* projectAccess.assert(actor, resource.projectId, resource.capability);
      yield* assertActiveProject(projectId);
      const principalFilter = isExternalActor(actor) ? actor.principalId : undefined;
      if (isExternalActor(actor) && principalFilter === undefined) {
        return [];
      }
      const rows = yield* repo
        .listClientsForProject(projectId, principalFilter)
        .pipe(
          Effect.mapError((cause) => new CrmInternalError({ operation: "listClients", cause })),
        );
      if (rows.length === 0) return [];
      const key = yield* loadKey();
      return yield* Effect.forEach(rows, (row) => toPublicClient(key, row));
    },
  );

  const getClient: CrmService["Service"]["getClient"] = Effect.fn("CrmService.getClient")(
    function* ({ projectId, clientId, actor }) {
      const resource = resourceResolver.resourceForCrmHttpEndpoint("getClient", {
        projectId,
        clientId,
      });
      yield* projectAccess.assert(actor, resource.projectId, resource.capability);
      yield* assertActiveProject(projectId);
      const clientRow = yield* requireClientInProject({ projectId, clientId, actor });
      const [contactRows, notes, threads] = yield* Effect.all([
        repo.listContactsForClient(projectId, clientId),
        repo.listNotesForClient(projectId, clientId),
        repo.listThreadsForClient(projectId, clientId),
      ]).pipe(Effect.mapError((cause) => new CrmInternalError({ operation: "getClient", cause })));
      const key = yield* loadKey();
      const client = yield* toPublicClient(key, clientRow);
      const contacts = yield* Effect.forEach(contactRows, (row) => toPublicContact(key, row));
      return { client, contacts, notes, threads } satisfies CrmClientDetail;
    },
  );

  const createClient: CrmService["Service"]["createClient"] = Effect.fn("CrmService.createClient")(
    function* ({ projectId, data, actor }) {
      const resource = resourceResolver.resourceForCrmHttpEndpoint("createClient", { projectId });
      yield* projectAccess.assert(actor, resource.projectId, resource.capability);
      yield* assertActiveProject(projectId);
      const trimmedName = data.name.trim();
      if (trimmedName.length === 0) {
        return yield* new CrmInvalidInputError({ reason: "empty_name" });
      }
      const id = CrmClientId.make(
        yield* random
          .uuidV4()
          .pipe(
            Effect.mapError((cause) => new CrmInternalError({ operation: "createClient", cause })),
          ),
      );
      const key = yield* loadKey();
      const email = encryptOptionalPii({
        key,
        projectId,
        aadName: `crm:client:${id}:email`,
        value: data.email,
        normalizeForFingerprint: (raw) => raw.toLowerCase(),
      });
      const phone = encryptOptionalPii({
        key,
        projectId,
        aadName: `crm:client:${id}:phone`,
        value: data.phone,
      });
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const record: CrmRepo.CreateCrmClientRecordInput = {
        id,
        projectId,
        principalId: null,
        name: trimmedName,
        company: normalizeOptionalText(data.company),
        status: data.status ?? "active",
        emailCiphertext: email.ciphertext,
        emailFingerprint: email.fingerprint,
        phoneCiphertext: phone.ciphertext,
        phoneFingerprint: phone.fingerprint,
        createdBy: actor.principalId ?? InvitationService.OWNER_PRINCIPAL_ID,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      yield* repo
        .createClient(record)
        .pipe(
          Effect.mapError((cause) => new CrmInternalError({ operation: "createClient", cause })),
        );
      return yield* toPublicClient(key, { ...record, redactedAt: null });
    },
  );

  const updateClient: CrmService["Service"]["updateClient"] = Effect.fn("CrmService.updateClient")(
    function* ({ projectId, clientId, data, actor }) {
      const resource = resourceResolver.resourceForCrmHttpEndpoint("updateClient", {
        projectId,
        clientId,
      });
      yield* projectAccess.assert(actor, resource.projectId, resource.capability);
      yield* assertActiveProject(projectId);
      const existing = yield* requireClientInProject({ projectId, clientId, actor });
      if (existing.redactedAt !== null) {
        return yield* new CrmInvalidInputError({ reason: "client_redacted" });
      }
      const nextName = data.name !== undefined ? data.name.trim() : existing.name;
      if (nextName.length === 0) {
        return yield* new CrmInvalidInputError({ reason: "empty_name" });
      }
      const key = yield* loadKey();
      const nextEmail: EncryptedPiiField =
        data.email === undefined
          ? { ciphertext: existing.emailCiphertext, fingerprint: existing.emailFingerprint }
          : encryptOptionalPii({
              key,
              projectId,
              aadName: `crm:client:${clientId}:email`,
              value: data.email,
              normalizeForFingerprint: (raw) => raw.toLowerCase(),
            });
      const nextPhone: EncryptedPiiField =
        data.phone === undefined
          ? { ciphertext: existing.phoneCiphertext, fingerprint: existing.phoneFingerprint }
          : encryptOptionalPii({
              key,
              projectId,
              aadName: `crm:client:${clientId}:phone`,
              value: data.phone,
            });
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const updated: CrmRepo.EncryptedCrmClientRecord = {
        ...existing,
        name: nextName,
        company:
          data.company === undefined ? existing.company : normalizeOptionalText(data.company),
        status: data.status ?? existing.status,
        emailCiphertext: nextEmail.ciphertext,
        emailFingerprint: nextEmail.fingerprint,
        phoneCiphertext: nextPhone.ciphertext,
        phoneFingerprint: nextPhone.fingerprint,
        updatedAt,
      };
      const saved = yield* repo
        .updateClient({
          id: clientId,
          projectId,
          name: updated.name,
          company: updated.company,
          status: updated.status,
          emailCiphertext: updated.emailCiphertext,
          emailFingerprint: updated.emailFingerprint,
          phoneCiphertext: updated.phoneCiphertext,
          phoneFingerprint: updated.phoneFingerprint,
          updatedAt,
        })
        .pipe(
          Effect.mapError((cause) => new CrmInternalError({ operation: "updateClient", cause })),
        );
      if (!saved) {
        return yield* new CrmNotFoundError({ resource: "client", projectId });
      }
      return yield* toPublicClient(key, updated);
    },
  );

  const deleteClient: CrmService["Service"]["deleteClient"] = Effect.fn("CrmService.deleteClient")(
    function* ({ projectId, clientId, purge, actor, audit }) {
      const resource = resourceResolver.resourceForCrmHttpEndpoint("deleteClient", {
        projectId,
        clientId,
      });
      yield* projectAccess.assert(actor, resource.projectId, resource.capability);
      yield* assertActiveProject(projectId);
      const existing = yield* requireClientInProject({ projectId, clientId, actor });
      if (!purge) {
        const deleted = yield* repo
          .deleteClient(projectId, clientId)
          .pipe(
            Effect.mapError((cause) => new CrmInternalError({ operation: "deleteClient", cause })),
          );
        return { deleted, purged: false, redactedAt: null } satisfies CrmClientDeleteResult;
      }

      const key = yield* loadKey();
      const publicBefore = yield* toPublicClient(key, existing);
      const contactRows = yield* repo
        .listContactsForClient(projectId, clientId)
        .pipe(
          Effect.mapError((cause) => new CrmInternalError({ operation: "purgeClientPii", cause })),
        );
      const publicContactsBefore = yield* Effect.forEach(contactRows, (row) =>
        toPublicContact(key, row),
      );
      const redactedAt = DateTime.formatIso(yield* DateTime.now);
      const purged = yield* repo
        .purgeClientPii({
          projectId,
          clientId,
          redactedName: CRM_REDACTED_PLACEHOLDER,
          redactedAt,
        })
        .pipe(
          Effect.mapError((cause) => new CrmInternalError({ operation: "purgeClientPii", cause })),
        );
      if (!purged) {
        return yield* new CrmNotFoundError({ resource: "client", projectId });
      }

      yield* appendAudit({
        actor,
        action: "crm.purged",
        projectId,
        resourceId: clientId,
        metadata: {
          clientId,
          emailMasked: publicBefore.emailMasked,
          emailFingerprint: publicBefore.emailFingerprint,
          phoneMasked: publicBefore.phoneMasked,
          phoneFingerprint: publicBefore.phoneFingerprint,
          redactedAt,
          contactCount: publicContactsBefore.length,
          contacts: publicContactsBefore.map((contact) => ({
            id: contact.id,
            emailMasked: contact.emailMasked,
            emailFingerprint: contact.emailFingerprint,
            phoneMasked: contact.phoneMasked,
            phoneFingerprint: contact.phoneFingerprint,
          })),
        },
        ...(audit === undefined ? {} : { audit }),
      });

      return { deleted: false, purged: true, redactedAt } satisfies CrmClientDeleteResult;
    },
  );

  const listContacts: CrmService["Service"]["listContacts"] = Effect.fn("CrmService.listContacts")(
    function* ({ projectId, clientId, actor }) {
      const resource = resourceResolver.resourceForCrmHttpEndpoint("listContacts", {
        projectId,
        clientId,
      });
      yield* projectAccess.assert(actor, resource.projectId, resource.capability);
      yield* assertActiveProject(projectId);
      yield* requireClientInProject({ projectId, clientId, actor });
      const rows = yield* repo
        .listContactsForClient(projectId, clientId)
        .pipe(
          Effect.mapError((cause) => new CrmInternalError({ operation: "listContacts", cause })),
        );
      if (rows.length === 0) return [];
      const key = yield* loadKey();
      return yield* Effect.forEach(rows, (row) => toPublicContact(key, row));
    },
  );

  const createContact: CrmService["Service"]["createContact"] = Effect.fn(
    "CrmService.createContact",
  )(function* ({ projectId, clientId, data, actor }) {
    const resource = resourceResolver.resourceForCrmHttpEndpoint("createContact", {
      projectId,
      clientId,
    });
    yield* projectAccess.assert(actor, resource.projectId, resource.capability);
    yield* assertActiveProject(projectId);
    const client = yield* requireClientInProject({ projectId, clientId, actor });
    if (client.redactedAt !== null) {
      return yield* new CrmInvalidInputError({ reason: "client_redacted" });
    }
    const trimmedName = data.name.trim();
    if (trimmedName.length === 0) {
      return yield* new CrmInvalidInputError({ reason: "empty_name" });
    }
    const id = CrmContactId.make(
      yield* random
        .uuidV4()
        .pipe(
          Effect.mapError((cause) => new CrmInternalError({ operation: "createContact", cause })),
        ),
    );
    const key = yield* loadKey();
    const email = encryptOptionalPii({
      key,
      projectId,
      aadName: `crm:contact:${id}:email`,
      value: data.email,
      normalizeForFingerprint: (raw) => raw.toLowerCase(),
    });
    const phone = encryptOptionalPii({
      key,
      projectId,
      aadName: `crm:contact:${id}:phone`,
      value: data.phone,
    });
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const record: CrmRepo.CreateCrmContactRecordInput = {
      id,
      projectId,
      clientId,
      name: trimmedName,
      roleTitle: normalizeOptionalText(data.roleTitle),
      emailCiphertext: email.ciphertext,
      emailFingerprint: email.fingerprint,
      phoneCiphertext: phone.ciphertext,
      phoneFingerprint: phone.fingerprint,
      createdBy: actor.principalId ?? InvitationService.OWNER_PRINCIPAL_ID,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    yield* repo
      .createContact(record)
      .pipe(
        Effect.mapError((cause) => new CrmInternalError({ operation: "createContact", cause })),
      );
    return yield* toPublicContact(key, { ...record, redactedAt: null });
  });

  const updateContact: CrmService["Service"]["updateContact"] = Effect.fn(
    "CrmService.updateContact",
  )(function* ({ projectId, clientId, contactId, data, actor }) {
    const resource = resourceResolver.resourceForCrmHttpEndpoint("updateContact", {
      projectId,
      clientId,
    });
    yield* projectAccess.assert(actor, resource.projectId, resource.capability);
    yield* assertActiveProject(projectId);
    const client = yield* requireClientInProject({ projectId, clientId, actor });
    if (client.redactedAt !== null) {
      return yield* new CrmInvalidInputError({ reason: "client_redacted" });
    }
    const existingOpt = yield* repo
      .getContact(projectId, clientId, contactId)
      .pipe(Effect.mapError((cause) => new CrmInternalError({ operation: "getContact", cause })));
    if (Option.isNone(existingOpt)) {
      return yield* new CrmNotFoundError({ resource: "contact", projectId });
    }
    const existing = existingOpt.value;
    const nextName = data.name !== undefined ? data.name.trim() : existing.name;
    if (nextName.length === 0) {
      return yield* new CrmInvalidInputError({ reason: "empty_name" });
    }
    const key = yield* loadKey();
    const nextEmail: EncryptedPiiField =
      data.email === undefined
        ? { ciphertext: existing.emailCiphertext, fingerprint: existing.emailFingerprint }
        : encryptOptionalPii({
            key,
            projectId,
            aadName: `crm:contact:${contactId}:email`,
            value: data.email,
            normalizeForFingerprint: (raw) => raw.toLowerCase(),
          });
    const nextPhone: EncryptedPiiField =
      data.phone === undefined
        ? { ciphertext: existing.phoneCiphertext, fingerprint: existing.phoneFingerprint }
        : encryptOptionalPii({
            key,
            projectId,
            aadName: `crm:contact:${contactId}:phone`,
            value: data.phone,
          });
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    const updated: CrmRepo.EncryptedCrmContactRecord = {
      ...existing,
      name: nextName,
      roleTitle:
        data.roleTitle === undefined ? existing.roleTitle : normalizeOptionalText(data.roleTitle),
      emailCiphertext: nextEmail.ciphertext,
      emailFingerprint: nextEmail.fingerprint,
      phoneCiphertext: nextPhone.ciphertext,
      phoneFingerprint: nextPhone.fingerprint,
      updatedAt,
    };
    const saved = yield* repo
      .updateContact({
        id: contactId,
        projectId,
        clientId,
        name: updated.name,
        roleTitle: updated.roleTitle,
        emailCiphertext: updated.emailCiphertext,
        emailFingerprint: updated.emailFingerprint,
        phoneCiphertext: updated.phoneCiphertext,
        phoneFingerprint: updated.phoneFingerprint,
        updatedAt,
      })
      .pipe(
        Effect.mapError((cause) => new CrmInternalError({ operation: "updateContact", cause })),
      );
    if (!saved) {
      return yield* new CrmNotFoundError({ resource: "contact", projectId });
    }
    return yield* toPublicContact(key, updated);
  });

  const deleteContact: CrmService["Service"]["deleteContact"] = Effect.fn(
    "CrmService.deleteContact",
  )(function* ({ projectId, clientId, contactId, actor }) {
    const resource = resourceResolver.resourceForCrmHttpEndpoint("deleteContact", {
      projectId,
      clientId,
    });
    yield* projectAccess.assert(actor, resource.projectId, resource.capability);
    yield* assertActiveProject(projectId);
    yield* requireClientInProject({ projectId, clientId, actor });
    const deleted = yield* repo
      .deleteContact(projectId, clientId, contactId)
      .pipe(
        Effect.mapError((cause) => new CrmInternalError({ operation: "deleteContact", cause })),
      );
    if (!deleted) {
      return yield* new CrmNotFoundError({ resource: "contact", projectId });
    }
    return true;
  });

  const listNotes: CrmService["Service"]["listNotes"] = Effect.fn("CrmService.listNotes")(
    function* ({ projectId, clientId, actor }) {
      const resource = resourceResolver.resourceForCrmHttpEndpoint("listNotes", {
        projectId,
        clientId,
      });
      yield* projectAccess.assert(actor, resource.projectId, resource.capability);
      yield* assertActiveProject(projectId);
      yield* requireClientInProject({ projectId, clientId, actor });
      return yield* repo
        .listNotesForClient(projectId, clientId)
        .pipe(Effect.mapError((cause) => new CrmInternalError({ operation: "listNotes", cause })));
    },
  );

  const createNote: CrmService["Service"]["createNote"] = Effect.fn("CrmService.createNote")(
    function* ({ projectId, clientId, data, actor }) {
      const resource = resourceResolver.resourceForCrmHttpEndpoint("createNote", {
        projectId,
        clientId,
      });
      yield* projectAccess.assert(actor, resource.projectId, resource.capability);
      yield* assertActiveProject(projectId);
      const client = yield* requireClientInProject({ projectId, clientId, actor });
      if (client.redactedAt !== null) {
        return yield* new CrmInvalidInputError({ reason: "client_redacted" });
      }
      const trimmedBody = data.body.trim();
      if (trimmedBody.length === 0) {
        return yield* new CrmInvalidInputError({ reason: "empty_body" });
      }
      const contactId = data.contactId ?? null;
      if (contactId !== null) {
        const contact = yield* repo
          .getContact(projectId, clientId, contactId)
          .pipe(
            Effect.mapError((cause) => new CrmInternalError({ operation: "getContact", cause })),
          );
        if (Option.isNone(contact)) {
          return yield* new CrmNotFoundError({ resource: "contact", projectId });
        }
      }
      const id = CrmNoteId.make(
        yield* random
          .uuidV4()
          .pipe(
            Effect.mapError((cause) => new CrmInternalError({ operation: "createNote", cause })),
          ),
      );
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const note: CrmNote = {
        id,
        projectId,
        clientId,
        contactId,
        body: trimmedBody,
        redactedAt: null,
        createdBy: actor.principalId ?? InvitationService.OWNER_PRINCIPAL_ID,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      yield* repo
        .createNote({
          id: note.id,
          projectId: note.projectId,
          clientId: note.clientId,
          contactId: note.contactId,
          body: note.body,
          createdBy: note.createdBy,
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        })
        .pipe(Effect.mapError((cause) => new CrmInternalError({ operation: "createNote", cause })));
      return note;
    },
  );

  const updateNote: CrmService["Service"]["updateNote"] = Effect.fn("CrmService.updateNote")(
    function* ({ projectId, clientId, noteId, data, actor }) {
      const resource = resourceResolver.resourceForCrmHttpEndpoint("updateNote", {
        projectId,
        clientId,
      });
      yield* projectAccess.assert(actor, resource.projectId, resource.capability);
      yield* assertActiveProject(projectId);
      const client = yield* requireClientInProject({ projectId, clientId, actor });
      if (client.redactedAt !== null) {
        return yield* new CrmInvalidInputError({ reason: "client_redacted" });
      }
      const existingOpt = yield* repo
        .getNote(projectId, clientId, noteId)
        .pipe(Effect.mapError((cause) => new CrmInternalError({ operation: "getNote", cause })));
      if (Option.isNone(existingOpt)) {
        return yield* new CrmNotFoundError({ resource: "note", projectId });
      }
      const existing = existingOpt.value;
      const nextBody = data.body !== undefined ? data.body.trim() : existing.body;
      if (nextBody.length === 0) {
        return yield* new CrmInvalidInputError({ reason: "empty_body" });
      }
      const nextContactId = data.contactId === undefined ? existing.contactId : data.contactId;
      if (nextContactId !== null) {
        const contact = yield* repo
          .getContact(projectId, clientId, nextContactId)
          .pipe(
            Effect.mapError((cause) => new CrmInternalError({ operation: "getContact", cause })),
          );
        if (Option.isNone(contact)) {
          return yield* new CrmNotFoundError({ resource: "contact", projectId });
        }
      }
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const saved = yield* repo
        .updateNote({
          id: noteId,
          projectId,
          clientId,
          contactId: nextContactId,
          body: nextBody,
          updatedAt,
        })
        .pipe(Effect.mapError((cause) => new CrmInternalError({ operation: "updateNote", cause })));
      if (!saved) {
        return yield* new CrmNotFoundError({ resource: "note", projectId });
      }
      return {
        ...existing,
        contactId: nextContactId,
        body: nextBody,
        updatedAt,
      } satisfies CrmNote;
    },
  );

  const deleteNote: CrmService["Service"]["deleteNote"] = Effect.fn("CrmService.deleteNote")(
    function* ({ projectId, clientId, noteId, actor }) {
      const resource = resourceResolver.resourceForCrmHttpEndpoint("deleteNote", {
        projectId,
        clientId,
      });
      yield* projectAccess.assert(actor, resource.projectId, resource.capability);
      yield* assertActiveProject(projectId);
      yield* requireClientInProject({ projectId, clientId, actor });
      const deleted = yield* repo
        .deleteNote(projectId, clientId, noteId)
        .pipe(Effect.mapError((cause) => new CrmInternalError({ operation: "deleteNote", cause })));
      if (!deleted) {
        return yield* new CrmNotFoundError({ resource: "note", projectId });
      }
      return true;
    },
  );

  const listClientThreads: CrmService["Service"]["listClientThreads"] = Effect.fn(
    "CrmService.listClientThreads",
  )(function* ({ projectId, clientId, actor }) {
    const resource = resourceResolver.resourceForCrmHttpEndpoint("listClientThreads", {
      projectId,
      clientId,
    });
    yield* projectAccess.assert(actor, resource.projectId, resource.capability);
    yield* assertActiveProject(projectId);
    yield* requireClientInProject({ projectId, clientId, actor });
    return yield* repo
      .listThreadsForClient(projectId, clientId)
      .pipe(
        Effect.mapError((cause) => new CrmInternalError({ operation: "listClientThreads", cause })),
      );
  });

  const linkClientThread: CrmService["Service"]["linkClientThread"] = Effect.fn(
    "CrmService.linkClientThread",
  )(function* ({ projectId, clientId, threadId, actor }) {
    const resource = resourceResolver.resourceForCrmHttpEndpoint("linkClientThread", {
      projectId,
      clientId,
      threadId,
    });
    yield* projectAccess.assert(actor, resource.projectId, resource.capability);
    yield* assertActiveProject(projectId);
    yield* requireClientInProject({ projectId, clientId, actor });
    const threadProjectId = yield* resourceResolver.resolveThreadProject(threadId);
    if (threadProjectId !== projectId) {
      return yield* new CrmNotFoundError({ resource: "thread", projectId });
    }
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const createdBy = actor.principalId ?? InvitationService.OWNER_PRINCIPAL_ID;
    yield* repo
      .linkThread({
        projectId,
        clientId,
        threadId,
        createdBy,
        createdAt: nowIso,
      })
      .pipe(
        Effect.mapError((cause) => new CrmInternalError({ operation: "linkClientThread", cause })),
      );
    const threads = yield* repo
      .listThreadsForClient(projectId, clientId)
      .pipe(
        Effect.mapError((cause) => new CrmInternalError({ operation: "linkClientThread", cause })),
      );
    const linked = threads.find((entry) => entry.threadId === threadId);
    return (
      linked ?? {
        projectId,
        clientId,
        threadId,
        redactedAt: null,
        createdBy,
        createdAt: nowIso,
      }
    );
  });

  const unlinkClientThread: CrmService["Service"]["unlinkClientThread"] = Effect.fn(
    "CrmService.unlinkClientThread",
  )(function* ({ projectId, clientId, threadId, actor }) {
    const resource = resourceResolver.resourceForCrmHttpEndpoint("unlinkClientThread", {
      projectId,
      clientId,
      threadId,
    });
    yield* projectAccess.assert(actor, resource.projectId, resource.capability);
    yield* assertActiveProject(projectId);
    yield* requireClientInProject({ projectId, clientId, actor });
    return yield* repo
      .unlinkThread(projectId, clientId, threadId)
      .pipe(
        Effect.mapError(
          (cause) => new CrmInternalError({ operation: "unlinkClientThread", cause }),
        ),
      );
  });

  const inviteClient: CrmService["Service"]["inviteClient"] = Effect.fn("CrmService.inviteClient")(
    function* ({ projectId, clientId, actor, audit }) {
      const resource = resourceResolver.resourceForCrmHttpEndpoint("inviteClient", {
        projectId,
        clientId,
      });
      yield* projectAccess.assert(actor, resource.projectId, resource.capability);
      yield* assertActiveProject(projectId);
      const client = yield* requireClientInProject({ projectId, clientId, actor });
      if (client.redactedAt !== null) {
        return yield* new CrmInvalidInputError({ reason: "client_redacted" });
      }
      const createdBy = actor.principalId ?? InvitationService.OWNER_PRINCIPAL_ID;
      const issued = yield* invitations
        .issue({
          kind: "client",
          role: "viewer",
          projectId,
          crmClientId: clientId,
          ceiling: ceilingScopes("client"),
          createdBy,
          actor,
          ...(audit === undefined ? {} : { audit }),
        })
        .pipe(
          Effect.catchTags({
            InvitationForbiddenError: (error) =>
              Effect.fail(
                new ProjectForbiddenError({
                  message: error.message,
                  projectId,
                  requiredPermission: "project:crm.invite_client",
                }),
              ),
            InvitationRateLimitedError: (error) =>
              Effect.fail(new CrmRateLimitedError({ message: error.message })),
            InvitationInternalError: (cause) =>
              Effect.fail(new CrmInternalError({ operation: "inviteClient", cause })),
          }),
        );
      return {
        clientId,
        invitation: issued.invitation,
        code: TrimmedNonEmptyString.make(issued.code),
      } satisfies CrmClientInviteResult;
    },
  );

  const exportJsonl: CrmService["Service"]["exportJsonl"] = Effect.fn("CrmService.exportJsonl")(
    function* ({ projectId, clientId, actor, audit }) {
      const resource = resourceResolver.resourceForCrmHttpEndpoint("exportCrm", {
        projectId,
        ...(clientId === undefined ? {} : { clientId }),
      });
      yield* projectAccess.assert(actor, resource.projectId, resource.capability);
      yield* assertActiveProject(projectId);

      const clientRows =
        clientId !== undefined
          ? [yield* requireClientInProject({ projectId, clientId, actor })]
          : isExternalActor(actor) && actor.principalId === undefined
            ? []
            : yield* repo
                .listClientsForProject(
                  projectId,
                  isExternalActor(actor) ? actor.principalId : undefined,
                )
                .pipe(
                  Effect.mapError(
                    (cause) => new CrmInternalError({ operation: "exportJsonl", cause }),
                  ),
                );

      const key = yield* loadKey();
      const lines: string[] = [];
      let contactCount = 0;
      let noteCount = 0;
      let threadLinkCount = 0;
      const clientAuditSummary: Array<{
        readonly id: CrmClientId;
        readonly emailMasked: string | null;
        readonly phoneMasked: string | null;
      }> = [];

      for (const clientRow of clientRows) {
        const publicClient = yield* toPublicClient(key, clientRow);
        clientAuditSummary.push({
          id: publicClient.id,
          emailMasked: publicClient.emailMasked,
          phoneMasked: publicClient.phoneMasked,
        });
        lines.push(encodeJsonLine({ type: "client", ...publicClient }));

        const [contacts, notes, threads] = yield* Effect.all([
          repo.listContactsForClient(projectId, clientRow.id),
          repo.listNotesForClient(projectId, clientRow.id),
          repo.listThreadsForClient(projectId, clientRow.id),
        ]).pipe(
          Effect.mapError((cause) => new CrmInternalError({ operation: "exportJsonl", cause })),
        );

        for (const contactRow of contacts) {
          const publicContact = yield* toPublicContact(key, contactRow);
          contactCount += 1;
          lines.push(encodeJsonLine({ type: "contact", ...publicContact }));
        }
        for (const note of notes) {
          noteCount += 1;
          lines.push(encodeJsonLine({ type: "note", ...note }));
        }
        for (const thread of threads) {
          threadLinkCount += 1;
          lines.push(encodeJsonLine({ type: "thread", ...thread }));
        }
      }

      yield* appendAudit({
        actor,
        action: "crm.exported",
        projectId,
        resourceId: clientId ?? projectId,
        metadata: {
          projectId,
          ...(clientId === undefined ? {} : { clientId }),
          clientCount: clientAuditSummary.length,
          contactCount,
          noteCount,
          threadLinkCount,
          clients: clientAuditSummary,
        },
        ...(audit === undefined ? {} : { audit }),
      });

      return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    },
  );

  const getPortal: CrmService["Service"]["getPortal"] = Effect.fn("CrmService.getPortal")(
    function* ({ clientId, actor }) {
      if (!isExternalActor(actor) || actor.principalId === undefined) {
        return yield* new CrmNotFoundError({ resource: "client" });
      }
      const externalPrincipalId = actor.principalId;

      let targetClientId = clientId;
      if (targetClientId === undefined) {
        const ownClientIds = yield* repo
          .listClientIdsForPrincipal(externalPrincipalId)
          .pipe(
            Effect.mapError((cause) => new CrmInternalError({ operation: "getPortal", cause })),
          );
        targetClientId = ownClientIds[0];
        if (targetClientId === undefined) {
          return yield* new CrmNotFoundError({ resource: "client" });
        }
      }

      const clientOpt = yield* repo
        .getClientById(targetClientId)
        .pipe(Effect.mapError((cause) => new CrmInternalError({ operation: "getPortal", cause })));
      if (Option.isNone(clientOpt) || clientOpt.value.principalId !== externalPrincipalId) {
        return yield* new CrmNotFoundError({ resource: "client" });
      }

      const projectId = clientOpt.value.projectId;
      const resource = resourceResolver.resourceForCrmHttpEndpoint("getClient", {
        projectId,
        clientId: targetClientId,
      });
      yield* projectAccess.assert(actor, resource.projectId, resource.capability);
      yield* assertActiveProject(projectId);
      const clientRow = yield* requireClientInProject({
        projectId,
        clientId: targetClientId,
        actor,
      });

      const [projectRows, contactRows, threadLinks] = yield* Effect.all([
        sql<{ readonly title: string }>`
          SELECT title AS "title"
          FROM projection_projects
          WHERE project_id = ${projectId} AND deleted_at IS NULL
          LIMIT 1
        `.pipe(NodeSqliteClient.readOnly),
        repo.listContactsForClient(projectId, targetClientId),
        repo.listThreadsForClient(projectId, targetClientId),
      ]).pipe(Effect.mapError((cause) => new CrmInternalError({ operation: "getPortal", cause })));

      const key = yield* loadKey();
      const client = yield* toPublicClient(key, clientRow);
      const contacts = yield* Effect.forEach(contactRows, (row) => toPublicContact(key, row));

      let threads: Array<CrmPortalThread> = [];
      if (threadLinks.length > 0) {
        const linkedThreadIds = threadLinks.map((entry) => entry.threadId);
        const linkedAtByThreadId = new Map<string, string>(
          threadLinks.map((entry) => [entry.threadId, entry.createdAt]),
        );
        const threadRows = yield* sql<{
          readonly threadId: string;
          readonly projectId: string;
          readonly title: string;
          readonly archivedAt: string | null;
          readonly updatedAt: string | null;
          readonly latestRunStatus: string | null;
        }>`
          SELECT
            t.thread_id AS "threadId",
            t.project_id AS "projectId",
            t.title AS "title",
            t.archived_at AS "archivedAt",
            t.updated_at AS "updatedAt",
            (
              SELECT r.status
              FROM orchestration_v2_projection_runs AS r
              WHERE r.thread_id = t.thread_id
              ORDER BY r.ordinal DESC
              LIMIT 1
            ) AS "latestRunStatus"
          FROM orchestration_v2_projection_threads AS t
          WHERE t.project_id = ${projectId}
            AND t.deleted_at IS NULL
            AND t.thread_id IN ${sql.in(linkedThreadIds)}
          ORDER BY t.updated_at DESC, t.thread_id ASC
        `.pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError(
            (cause) => new CrmInternalError({ operation: "getPortalThreads", cause }),
          ),
        );

        threads = threadRows.map((row): CrmPortalThread => {
          const parsedStatus =
            row.latestRunStatus === null
              ? Option.none()
              : decodeShellThreadStatus(row.latestRunStatus);
          return {
            threadId: ThreadId.make(row.threadId),
            projectId: ProjectId.make(row.projectId),
            title: row.title,
            status: Option.getOrElse(parsedStatus, () => "idle" as const),
            archivedAt: row.archivedAt,
            linkedAt: linkedAtByThreadId.get(row.threadId) ?? client.updatedAt,
            updatedAt: row.updatedAt,
          };
        });
      }

      return {
        projectTitle: projectRows[0]?.title ?? null,
        client,
        contacts,
        threads,
      } satisfies CrmPortalView;
    },
  );

  return CrmService.of({
    listClients,
    getClient,
    createClient,
    updateClient,
    deleteClient,
    listContacts,
    createContact,
    updateContact,
    deleteContact,
    listNotes,
    createNote,
    updateNote,
    deleteNote,
    listClientThreads,
    linkClientThread,
    unlinkClientThread,
    inviteClient,
    exportJsonl,
    getPortal,
  });
});

export const layer = Layer.effect(CrmService, make);
