// @effect-diagnostics nodeBuiltinImport:off - node:crypto provides AES-256-GCM and SHA-256 for project secret encryption and fingerprinting.
import * as NodeCrypto from "node:crypto";
import {
  type AuthSessionId,
  ProjectForbiddenError,
  ProjectId,
  ProjectSecret,
  ProjectSecretName,
  TrimmedNonEmptyString,
  parseProjectSecretReference,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as ProjectSecretRepo from "../persistence/ProjectSecrets.ts";

const PROJECT_SECRETS_KEY_NAME = "project-secrets-key";
const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;
const AES_AUTH_TAG_BYTES = 16;
const CIPHERTEXT_VERSION = 1;
const MIN_CIPHERTEXT_BYTES = 1 + AES_IV_BYTES + AES_AUTH_TAG_BYTES;
const MAX_SECRET_VALUE_LENGTH = 65_536;

const isProjectSecretName = Schema.is(ProjectSecretName);

export interface ProjectSecretAuditContext {
  readonly sessionId?: AuthSessionId | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export const ProjectSecretInvalidInputReason = Schema.Literals([
  "invalid_name",
  "empty_value",
  "value_too_large",
  "invalid_reference",
]);
export type ProjectSecretInvalidInputReason = typeof ProjectSecretInvalidInputReason.Type;

export class ProjectSecretInvalidInputError extends Schema.TaggedError<ProjectSecretInvalidInputError>()(
  "ProjectSecretInvalidInputError",
  {
    reason: ProjectSecretInvalidInputReason,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid_name":
        return "Secret name must start with a letter, digit, or underscore and contain only letters, digits, dots, hyphens, and underscores (max 128 characters).";
      case "empty_value":
        return "Secret value must not be empty.";
      case "value_too_large":
        return "Secret value exceeds the maximum allowed length.";
      case "invalid_reference":
        return "Invalid project secret reference.";
    }
  }
}

export class ProjectSecretNotFoundError extends Schema.TaggedError<ProjectSecretNotFoundError>()(
  "ProjectSecretNotFoundError",
  {
    resource: Schema.Literals(["project", "secret"]),
    projectId: ProjectId,
  },
) {
  override get message(): string {
    return this.resource === "project"
      ? `Project ${this.projectId} was not found.`
      : `The requested secret was not found in project ${this.projectId}.`;
  }
}

export class ProjectSecretDecryptError extends Schema.TaggedError<ProjectSecretDecryptError>()(
  "ProjectSecretDecryptError",
  {
    projectId: ProjectId,
    secretName: Schema.String,
    reason: Schema.Literals(["invalid_envelope", "authentication_failed"]),
  },
) {
  override get message(): string {
    return `Failed to decrypt project secret "${this.secretName}" (${this.reason}).`;
  }
}

export class ProjectSecretInternalError extends Schema.TaggedError<ProjectSecretInternalError>()(
  "ProjectSecretInternalError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project secrets operation failed (${this.operation}).`;
  }
}

export type ProjectSecretError =
  | ProjectForbiddenError
  | ProjectSecretInvalidInputError
  | ProjectSecretNotFoundError
  | ProjectSecretDecryptError
  | ProjectSecretInternalError;

export function fingerprintSecretValue(plaintext: string): string {
  return NodeCrypto.createHash("sha256")
    .update(plaintext, "utf8")
    .digest()
    .subarray(0, 8)
    .toString("base64url");
}

function buildAad(projectId: ProjectId, name: string): Buffer {
  return Buffer.from(`${projectId}\u0000${name}`, "utf8");
}

function encryptSecretValue(
  key: Uint8Array,
  projectId: ProjectId,
  name: string,
  value: string,
): Uint8Array {
  const iv = NodeCrypto.randomBytes(AES_IV_BYTES);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(buildAad(projectId, name));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Uint8Array.from(
    Buffer.concat([Buffer.from([CIPHERTEXT_VERSION]), iv, authTag, encrypted]),
  );
}

function decryptSecretValue(
  key: Uint8Array,
  projectId: ProjectId,
  name: string,
  payload: Uint8Array,
): Effect.Effect<string, ProjectSecretDecryptError> {
  if (payload.byteLength < MIN_CIPHERTEXT_BYTES || payload[0] !== CIPHERTEXT_VERSION) {
    return Effect.fail(
      new ProjectSecretDecryptError({ projectId, secretName: name, reason: "invalid_envelope" }),
    );
  }
  const iv = payload.subarray(1, 1 + AES_IV_BYTES);
  const authTag = payload.subarray(1 + AES_IV_BYTES, 1 + AES_IV_BYTES + AES_AUTH_TAG_BYTES);
  const ciphertext = payload.subarray(1 + AES_IV_BYTES + AES_AUTH_TAG_BYTES);
  return Effect.try({
    try: () => {
      const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(buildAad(projectId, name));
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return decrypted.toString("utf8");
    },
    catch: () =>
      new ProjectSecretDecryptError({
        projectId,
        secretName: name,
        reason: "authentication_failed",
      }),
  });
}

export class ProjectSecrets extends Context.Service<
  ProjectSecrets,
  {
    readonly list: (input: {
      readonly projectId: ProjectId;
      readonly actor: ProjectAccess.AccessActor;
    }) => Effect.Effect<
      ReadonlyArray<ProjectSecret>,
      ProjectForbiddenError | ProjectSecretNotFoundError | ProjectSecretInternalError
    >;
    readonly set: (input: {
      readonly projectId: ProjectId;
      readonly name: string;
      readonly value: string;
      readonly actor: ProjectAccess.AccessActor;
      readonly audit?: ProjectSecretAuditContext;
    }) => Effect.Effect<
      ProjectSecret,
      | ProjectForbiddenError
      | ProjectSecretInvalidInputError
      | ProjectSecretNotFoundError
      | ProjectSecretInternalError
    >;
    readonly remove: (input: {
      readonly projectId: ProjectId;
      readonly name: string;
      readonly actor: ProjectAccess.AccessActor;
      readonly audit?: ProjectSecretAuditContext;
    }) => Effect.Effect<
      boolean,
      | ProjectForbiddenError
      | ProjectSecretInvalidInputError
      | ProjectSecretNotFoundError
      | ProjectSecretInternalError
    >;
    /** Server-side only: decrypts and returns plaintext after enforcing `project:secrets` and auditing. */
    readonly getValue: (input: {
      readonly projectId: ProjectId;
      readonly name: string;
      readonly actor: ProjectAccess.AccessActor;
      readonly audit?: ProjectSecretAuditContext;
    }) => Effect.Effect<string, ProjectSecretError>;
    /** Server-side only: resolves a `secret://project/<projectId>/<name>` reference for `actor`. */
    readonly resolveReference: (input: {
      readonly reference: string;
      readonly actor: ProjectAccess.AccessActor;
      readonly audit?: ProjectSecretAuditContext;
    }) => Effect.Effect<string, ProjectSecretError>;
  }
>()("v3code/project/ProjectSecrets") {}

const make = Effect.gen(function* () {
  const repo = yield* ProjectSecretRepo.ProjectSecretRepository;
  const projectAccess = yield* ProjectAccess.ProjectAccess;
  const sql = yield* SqlClient.SqlClient;
  const auditEvents = yield* AuditEvents.AuditEventRepository;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;

  const keyRef = yield* Ref.make<Option.Option<Uint8Array>>(Option.none());
  const keyLock = yield* Semaphore.make(1);

  const loadKey = Effect.fn("ProjectSecrets.loadKey")(function* () {
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
          .getOrCreateRandom(PROJECT_SECRETS_KEY_NAME, AES_KEY_BYTES)
          .pipe(
            Effect.mapError(
              (cause) => new ProjectSecretInternalError({ operation: "loadEncryptionKey", cause }),
            ),
          );
        if (loaded.byteLength !== AES_KEY_BYTES) {
          return yield* new ProjectSecretInternalError({
            operation: "loadEncryptionKey",
            cause: new Error(`Unexpected project secrets key length: ${loaded.byteLength}.`),
          });
        }
        yield* Ref.set(keyRef, Option.some(loaded));
        return loaded;
      }),
    );
  });

  const assertActiveProject = Effect.fn("ProjectSecrets.assertActiveProject")(function* (
    projectId: ProjectId,
  ) {
    const rows = yield* sql<{ readonly present: number }>`
      SELECT 1 AS "present"
      FROM projection_projects
      WHERE project_id = ${projectId} AND deleted_at IS NULL
      LIMIT 1
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        (cause) => new ProjectSecretInternalError({ operation: "getActiveProject", cause }),
      ),
    );
    if (rows.length === 0) {
      return yield* new ProjectSecretNotFoundError({ resource: "project", projectId });
    }
  });

  const appendAudit = Effect.fn("ProjectSecrets.appendAudit")(function* (input: {
    readonly actor: ProjectAccess.AccessActor;
    readonly action: "secret.read" | "project.secret.set" | "project.secret.deleted";
    readonly projectId: ProjectId;
    readonly name: string;
    readonly outcome: "allow" | "deny" | "error";
    readonly metadata: Readonly<Record<string, unknown>>;
    readonly audit?: ProjectSecretAuditContext;
  }) {
    const now = yield* DateTime.now;
    yield* auditEvents
      .append({
        at: DateTime.formatIso(now),
        actorPrincipalId: input.actor.principalId ?? null,
        actorSessionId: input.audit?.sessionId ?? input.actor.sessionId,
        action: input.action,
        resourceType: "secret",
        resourceId: TrimmedNonEmptyString.make(input.name),
        projectId: input.projectId,
        ip: input.audit?.ip ?? null,
        userAgent: input.audit?.userAgent ?? null,
        outcome: input.outcome,
        metadata: input.metadata,
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to write project secret audit event.", {
            action: input.action,
            projectId: input.projectId,
            name: input.name,
            cause,
          }),
        ),
        Effect.ignore,
      );
  });

  const list: ProjectSecrets["Service"]["list"] = Effect.fn("ProjectSecrets.list")(function* ({
    projectId,
    actor,
  }) {
    yield* projectAccess.assert(actor, projectId, "project:secrets");
    yield* assertActiveProject(projectId);
    return yield* repo
      .listForProject(projectId)
      .pipe(
        Effect.mapError(
          (cause) => new ProjectSecretInternalError({ operation: "listProjectSecrets", cause }),
        ),
      );
  });

  const set: ProjectSecrets["Service"]["set"] = Effect.fn("ProjectSecrets.set")(function* ({
    projectId,
    name,
    value,
    actor,
    audit,
  }) {
    yield* projectAccess.assert(actor, projectId, "project:secrets");
    if (!isProjectSecretName(name)) {
      return yield* new ProjectSecretInvalidInputError({ reason: "invalid_name" });
    }
    if (value.length === 0) {
      return yield* new ProjectSecretInvalidInputError({ reason: "empty_value" });
    }
    if (value.length > MAX_SECRET_VALUE_LENGTH) {
      return yield* new ProjectSecretInvalidInputError({ reason: "value_too_large" });
    }
    yield* assertActiveProject(projectId);
    const key = yield* loadKey();
    const fingerprint = TrimmedNonEmptyString.make(fingerprintSecretValue(value));
    const ciphertext = encryptSecretValue(key, projectId, name, value);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);

    yield* repo
      .upsert({
        projectId,
        name: TrimmedNonEmptyString.make(name),
        ciphertext,
        fingerprint,
        updatedAt,
      })
      .pipe(
        Effect.mapError(
          (cause) => new ProjectSecretInternalError({ operation: "upsertProjectSecret", cause }),
        ),
      );

    yield* appendAudit({
      actor,
      action: "project.secret.set",
      projectId,
      name,
      outcome: "allow",
      metadata: { name, fingerprint },
      ...(audit === undefined ? {} : { audit }),
    });

    return {
      projectId,
      name: TrimmedNonEmptyString.make(name),
      fingerprint,
      updatedAt,
    } satisfies ProjectSecret;
  });

  const remove: ProjectSecrets["Service"]["remove"] = Effect.fn("ProjectSecrets.remove")(
    function* ({ projectId, name, actor, audit }) {
      yield* projectAccess.assert(actor, projectId, "project:secrets");
      if (!isProjectSecretName(name)) {
        return yield* new ProjectSecretInvalidInputError({ reason: "invalid_name" });
      }
      yield* assertActiveProject(projectId);
      const deleted = yield* repo
        .remove(projectId, name)
        .pipe(
          Effect.mapError(
            (cause) => new ProjectSecretInternalError({ operation: "removeProjectSecret", cause }),
          ),
        );

      yield* appendAudit({
        actor,
        action: "project.secret.deleted",
        projectId,
        name,
        outcome: "allow",
        metadata: { name, deleted },
        ...(audit === undefined ? {} : { audit }),
      });

      return deleted;
    },
  );

  const getValue: ProjectSecrets["Service"]["getValue"] = Effect.fn("ProjectSecrets.getValue")(
    function* ({ projectId, name, actor, audit }) {
      if (!isProjectSecretName(name)) {
        return yield* new ProjectSecretInvalidInputError({ reason: "invalid_name" });
      }
      if (!projectAccess.can(actor, projectId, "project:secrets")) {
        yield* appendAudit({
          actor,
          action: "secret.read",
          projectId,
          name,
          outcome: "deny",
          metadata: { name, reason: "project_forbidden" },
          ...(audit === undefined ? {} : { audit }),
        });
        return yield* projectAccess.assert(actor, projectId, "project:secrets").pipe(
          Effect.andThen(
            Effect.fail(
              new ProjectForbiddenError({
                message: `Missing required capability project:secrets on project ${projectId}.`,
                projectId,
                requiredPermission: "project:secrets",
              }),
            ),
          ),
        );
      }
      yield* assertActiveProject(projectId);
      const record = yield* repo
        .get(projectId, name)
        .pipe(
          Effect.mapError(
            (cause) => new ProjectSecretInternalError({ operation: "getProjectSecret", cause }),
          ),
        );
      if (Option.isNone(record)) {
        return yield* new ProjectSecretNotFoundError({ resource: "secret", projectId });
      }
      const key = yield* loadKey();
      const plaintext = yield* decryptSecretValue(
        key,
        projectId,
        name,
        record.value.ciphertext,
      ).pipe(
        Effect.tapError((error) =>
          appendAudit({
            actor,
            action: "secret.read",
            projectId,
            name,
            outcome: "error",
            metadata: { name, reason: error.reason },
            ...(audit === undefined ? {} : { audit }),
          }),
        ),
      );
      yield* appendAudit({
        actor,
        action: "secret.read",
        projectId,
        name,
        outcome: "allow",
        metadata: { name, fingerprint: record.value.fingerprint },
        ...(audit === undefined ? {} : { audit }),
      });
      return plaintext;
    },
  );

  const resolveReference: ProjectSecrets["Service"]["resolveReference"] = Effect.fn(
    "ProjectSecrets.resolveReference",
  )(function* ({ reference, actor, audit }) {
    const parsed = parseProjectSecretReference(reference);
    if (parsed === null) {
      return yield* new ProjectSecretInvalidInputError({ reason: "invalid_reference" });
    }
    return yield* getValue({
      projectId: parsed.projectId,
      name: parsed.name,
      actor,
      ...(audit === undefined ? {} : { audit }),
    });
  });

  return ProjectSecrets.of({
    list,
    set,
    remove,
    getValue,
    resolveReference,
  });
});

export const layer = Layer.effect(ProjectSecrets, make);
