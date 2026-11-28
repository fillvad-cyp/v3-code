// @effect-diagnostics nodeBuiltinImport:off - node:crypto sha256 verifies fingerprint compatibility.
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import {
  AuthAccessReadScope,
  AuthAdministrativeClientScopes,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  EnvironmentHttpApi,
  EventId,
  PrincipalId,
  ProjectId,
  SecretProviderId,
  AuthSessionId,
  ceilingScopes,
  formatProjectSecretReference,
  roleScopes,
  type ProjectSecret,
} from "@t3tools/contracts";
import * as SecretResolverCore from "@t3tools/secret-provider-core/server/SecretResolver";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PrincipalLimitsService from "../identity/PrincipalLimitsService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ApiTokens from "../persistence/ApiTokens.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as Invitations from "../persistence/Invitations.ts";
import * as MemberLimits from "../persistence/MemberLimits.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as ProjectSecretRepo from "../persistence/ProjectSecrets.ts";
import * as RecoveryCodes from "../persistence/RecoveryCodes.ts";
import * as SessionPrincipals from "../persistence/SessionPrincipals.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as SecretResolver from "../secrets/SecretResolver.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import * as ProjectHttp from "./http.ts";
import * as ProjectQuotaService from "./ProjectQuotaService.ts";
import * as ProjectSecrets from "./ProjectSecrets.ts";
import * as ProjectService from "./ProjectService.ts";

const OWNER_ID = PrincipalId.make("owner");
const ADMIN_A_ID = PrincipalId.make("member-admin-a");
const DEV_A_ID = PrincipalId.make("member-dev-a");
const PROJECT_A = ProjectId.make("project-alpha");
const PROJECT_B = ProjectId.make("project-beta");
const PROJECT_MISSING = ProjectId.make("project-missing");
const DEV_TOKEN = "reusable-dev-auth-token-for-project-secrets";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

class ProjectsSecretsHttpTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.projects,
) {}

const makeBaseLayer = () => {
  const layerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        mode: "web",
        devUrl: new URL("http://127.0.0.1:5173"),
        devAuthToken: Redacted.make(DEV_TOKEN),
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-secrets-" })));

  const layerIdentityRepositories = Layer.mergeAll(
    Principals.layer,
    Memberships.layer,
    Invitations.layer,
    AuditEvents.layer,
    ApiTokens.layer,
    MemberLimits.layer,
    RecoveryCodes.layer,
    SessionPrincipals.layer,
  );

  const layerAccess = ProjectAccess.layer.pipe(
    Layer.provide(layerIdentityRepositories),
    Layer.provide(ProjectStore.layer),
  );

  const layerProjectSecrets = ProjectSecrets.layer.pipe(
    Layer.provide(ProjectSecretRepo.layer),
    Layer.provide(layerIdentityRepositories),
    Layer.provide(layerAccess),
  );

  const layerSecretResolver = SecretResolver.layer.pipe(
    Layer.provide(ServerSettings.layerTest({ multiUser: true })),
    Layer.provide(layerProjectSecrets),
  );

  const layerPrincipalLimits = PrincipalLimitsService.layer.pipe(
    Layer.provide(layerIdentityRepositories),
  );

  const layerEnvAuth = EnvironmentAuth.layer.pipe(
    Layer.provide(ServerSettings.layerTest({ multiUser: true })),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(layerPrincipalLimits),
    Layer.provide(layerIdentityRepositories),
  );

  return Layer.mergeAll(
    layerIdentityRepositories,
    layerAccess,
    layerProjectSecrets,
    ProjectSecretRepo.layer,
    ProjectStore.layer,
    layerSecretResolver,
    layerEnvAuth,
  ).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provide(layerConfig),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, PlatformNodeCrypto.layer)),
  );
};

const seedProjectsAndMembers = Effect.gen(function* () {
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const principals = yield* Principals.PrincipalRepository;
  const memberships = yield* Memberships.MembershipRepository;
  const now = DateTime.formatIso(yield* DateTime.now);

  let seq = 1;
  for (const [id, title, root] of [
    [PROJECT_A, "Alpha", "/tmp/alpha"],
    [PROJECT_B, "Beta", "/tmp/beta"],
  ] as const) {
    yield* projectStore.apply({
      sequence: seq++,
      type: "project.created",
      eventId: EventId.make(`evt-create-${id}`),
      aggregateKind: "project",
      aggregateId: id,
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        projectId: id,
        title,
        workspaceRoot: root,
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    });
  }

  yield* principals.create({
    id: ADMIN_A_ID,
    kind: "member",
    displayName: "Admin Alpha",
    email: null,
    status: "active",
    ceiling: [...ceilingScopes("staff")],
    createdAt: now,
  });
  yield* principals.create({
    id: DEV_A_ID,
    kind: "member",
    displayName: "Dev Alpha",
    email: null,
    status: "active",
    ceiling: [...ceilingScopes("staff")],
    createdAt: now,
  });

  yield* memberships.upsert({
    projectId: PROJECT_A,
    principalId: ADMIN_A_ID,
    role: "admin",
    state: "active",
    invitedBy: OWNER_ID,
    expiresAt: null,
    updatedAt: now,
  });
  yield* memberships.upsert({
    projectId: PROJECT_B,
    principalId: ADMIN_A_ID,
    role: "developer",
    state: "active",
    invitedBy: OWNER_ID,
    expiresAt: null,
    updatedAt: now,
  });
  yield* memberships.upsert({
    projectId: PROJECT_A,
    principalId: DEV_A_ID,
    role: "developer",
    state: "active",
    invitedBy: OWNER_ID,
    expiresAt: null,
    updatedAt: now,
  });

  const ownerActor: ProjectAccess.AccessActor = {
    sessionId: AuthSessionId.make("sess-owner"),
    subject: "owner",
    scopes: [...AuthAdministrativeClientScopes],
    principalId: OWNER_ID,
    binding: { _tag: "environment" },
    isOwner: true,
    roles: new Map(),
  };

  const adminActor: ProjectAccess.AccessActor = {
    sessionId: AuthSessionId.make("sess-admin-a"),
    subject: "admin-a",
    scopes: [...roleScopes("admin")],
    principalId: ADMIN_A_ID,
    binding: { _tag: "principal" },
    isOwner: false,
    roles: new Map([
      [PROJECT_A, "admin"],
      [PROJECT_B, "developer"],
    ]),
  };

  const devActor: ProjectAccess.AccessActor = {
    sessionId: AuthSessionId.make("sess-dev-a"),
    subject: "dev-a",
    scopes: [...roleScopes("developer")],
    principalId: DEV_A_ID,
    binding: { _tag: "principal" },
    isOwner: false,
    roles: new Map([[PROJECT_A, "developer"]]),
  };

  return { ownerActor, adminActor, devActor };
});

describe("ProjectSecrets", () => {
  it.live(
    "supports set/list/update/delete round trip with deterministic fingerprints and audit trail",
    () =>
      Effect.gen(function* () {
        const { ownerActor, adminActor } = yield* seedProjectsAndMembers;
        const secrets = yield* ProjectSecrets.ProjectSecrets;
        const auditEvents = yield* AuditEvents.AuditEventRepository;

        const secretValue1 = "sk-live-super-secret-value-1";
        const secretValue2 = "sk-live-rotated-secret-value-2";
        const expectedFp1 = NodeCrypto.createHash("sha256")
          .update(secretValue1, "utf8")
          .digest()
          .subarray(0, 8)
          .toString("base64url");
        const expectedFp2 = NodeCrypto.createHash("sha256")
          .update(secretValue2, "utf8")
          .digest()
          .subarray(0, 8)
          .toString("base64url");

        expect(ProjectSecrets.fingerprintSecretValue(secretValue1)).toBe(expectedFp1);

        const created = yield* secrets.set({
          projectId: PROJECT_A,
          name: "OPENAI_API_KEY",
          value: secretValue1,
          actor: adminActor,
        });
        expect(created.projectId).toBe(PROJECT_A);
        expect(created.name).toBe("OPENAI_API_KEY");
        expect(created.fingerprint).toBe(expectedFp1);
        expect(JSON.stringify(created)).not.toContain(secretValue1);

        const listed = yield* secrets.list({ projectId: PROJECT_A, actor: adminActor });
        expect(listed).toEqual([created]);
        expect(JSON.stringify(listed)).not.toContain(secretValue1);

        const decrypted1 = yield* secrets.getValue({
          projectId: PROJECT_A,
          name: "OPENAI_API_KEY",
          actor: adminActor,
        });
        expect(decrypted1).toBe(secretValue1);

        // Update overwrites ciphertext and fingerprint.
        const updated = yield* secrets.set({
          projectId: PROJECT_A,
          name: "OPENAI_API_KEY",
          value: secretValue2,
          actor: ownerActor,
        });
        expect(updated.fingerprint).toBe(expectedFp2);
        expect(updated.fingerprint).not.toBe(expectedFp1);

        const decrypted2 = yield* secrets.getValue({
          projectId: PROJECT_A,
          name: "OPENAI_API_KEY",
          actor: ownerActor,
        });
        expect(decrypted2).toBe(secretValue2);

        // Delete removes secret and second delete returns false.
        expect(
          yield* secrets.remove({
            projectId: PROJECT_A,
            name: "OPENAI_API_KEY",
            actor: adminActor,
          }),
        ).toBe(true);
        expect(
          yield* secrets.remove({
            projectId: PROJECT_A,
            name: "OPENAI_API_KEY",
            actor: adminActor,
          }),
        ).toBe(false);
        expect(yield* secrets.list({ projectId: PROJECT_A, actor: adminActor })).toEqual([]);

        const events = yield* auditEvents.list({ projectId: PROJECT_A });
        const actions = events.map((event) => event.action);
        expect(actions).toContain("project.secret.set");
        expect(actions).toContain("secret.read");
        expect(actions).toContain("project.secret.deleted");
        const serializedAudit = JSON.stringify(events);
        expect(serializedAudit).not.toContain(secretValue1);
        expect(serializedAudit).not.toContain(secretValue2);
      }).pipe(Effect.provide(makeBaseLayer())),
  );

  it.live(
    "detects AES-GCM tampering, envelope corruption, and cross-project ciphertext swapping",
    () =>
      Effect.gen(function* () {
        const { ownerActor } = yield* seedProjectsAndMembers;
        const secrets = yield* ProjectSecrets.ProjectSecrets;
        const repo = yield* ProjectSecretRepo.ProjectSecretRepository;
        const sql = yield* SqlClient.SqlClient;

        yield* secrets.set({
          projectId: PROJECT_A,
          name: "DB_PASSWORD",
          value: "correct-horse-battery-staple",
          actor: ownerActor,
        });

        const stored = yield* repo.get(PROJECT_A, "DB_PASSWORD");
        expect(Option.isSome(stored)).toBe(true);
        if (Option.isNone(stored)) return;

        // 1. Copy ciphertext to project B under same name -> AAD mismatch must fail authentication.
        yield* repo.upsert({
          projectId: PROJECT_B,
          name: stored.value.name,
          ciphertext: stored.value.ciphertext,
          fingerprint: stored.value.fingerprint,
          updatedAt: stored.value.updatedAt,
        });
        const swapError = yield* secrets
          .getValue({ projectId: PROJECT_B, name: "DB_PASSWORD", actor: ownerActor })
          .pipe(Effect.flip);
        expect(swapError._tag).toBe("ProjectSecretDecryptError");
        if (swapError._tag === "ProjectSecretDecryptError") {
          expect(swapError.reason).toBe("authentication_failed");
        }

        // 2. Flip a single bit in the stored ciphertext blob -> authentication_failed.
        const tampered = Uint8Array.from(stored.value.ciphertext);
        tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
        yield* sql`
        UPDATE project_secrets
        SET ciphertext = ${tampered}
        WHERE project_id = ${PROJECT_A} AND name = 'DB_PASSWORD'
      `;
        const tamperError = yield* secrets
          .getValue({ projectId: PROJECT_A, name: "DB_PASSWORD", actor: ownerActor })
          .pipe(Effect.flip);
        expect(tamperError._tag).toBe("ProjectSecretDecryptError");
        if (tamperError._tag === "ProjectSecretDecryptError") {
          expect(tamperError.reason).toBe("authentication_failed");
        }

        // 3. Truncate envelope -> invalid_envelope.
        yield* sql`
        UPDATE project_secrets
        SET ciphertext = ${new Uint8Array([1, 2, 3])}
        WHERE project_id = ${PROJECT_A} AND name = 'DB_PASSWORD'
      `;
        const envelopeError = yield* secrets
          .getValue({ projectId: PROJECT_A, name: "DB_PASSWORD", actor: ownerActor })
          .pipe(Effect.flip);
        expect(envelopeError._tag).toBe("ProjectSecretDecryptError");
        if (envelopeError._tag === "ProjectSecretDecryptError") {
          expect(envelopeError.reason).toBe("invalid_envelope");
        }
      }).pipe(Effect.provide(makeBaseLayer())),
  );

  it.live(
    "resolves secret://project/<projectId>/<name> with actor enforcement via ProjectSecrets and SecretResolver",
    () =>
      Effect.gen(function* () {
        const { ownerActor, adminActor, devActor } = yield* seedProjectsAndMembers;
        const secrets = yield* ProjectSecrets.ProjectSecrets;
        const resolver = yield* SecretResolverCore.SecretResolver;
        const auditEvents = yield* AuditEvents.AuditEventRepository;

        yield* secrets.set({
          projectId: PROJECT_A,
          name: "STRIPE_KEY",
          value: "rk_live_alpha_123",
          actor: ownerActor,
        });
        yield* secrets.set({
          projectId: PROJECT_B,
          name: "STRIPE_KEY",
          value: "rk_live_beta_456",
          actor: ownerActor,
        });

        const refA = formatProjectSecretReference(PROJECT_A, "STRIPE_KEY");
        const refB = formatProjectSecretReference(PROJECT_B, "STRIPE_KEY");

        // Direct resolveReference: admin of A can read A, not B; dev cannot read A; owner reads both.
        expect(yield* secrets.resolveReference({ reference: refA, actor: adminActor })).toBe(
          "rk_live_alpha_123",
        );
        expect(yield* secrets.resolveReference({ reference: refB, actor: ownerActor })).toBe(
          "rk_live_beta_456",
        );

        const adminReadB = yield* secrets
          .resolveReference({ reference: refB, actor: adminActor })
          .pipe(Effect.flip);
        expect(adminReadB._tag).toBe("project_forbidden");

        const devReadA = yield* secrets
          .resolveReference({ reference: refA, actor: devActor })
          .pipe(Effect.flip);
        expect(devReadA._tag).toBe("project_forbidden");

        const badRef = yield* secrets
          .resolveReference({ reference: "secret://server/foo", actor: ownerActor })
          .pipe(Effect.flip);
        expect(badRef._tag).toBe("ProjectSecretInvalidInputError");

        // Through SecretResolver + requireSettingsSecret:
        const providerRefA = { provider: SecretProviderId.make("project"), reference: refA };
        const providerRefB = { provider: SecretProviderId.make("project"), reference: refB };

        // No actor in context -> fail closed (undefined).
        const noActorValues = yield* resolver.read([providerRefA, providerRefB]);
        expect(noActorValues).toEqual([undefined, undefined]);

        // Admin of A -> resolves A, blocks B.
        const adminValues = yield* resolver
          .read([providerRefA, providerRefB])
          .pipe(Effect.provideService(SecretResolver.SecretResolutionActor, adminActor));
        expect(adminValues).toEqual(["rk_live_alpha_123", undefined]);

        // requireSettingsSecret also resolves plain string secret://project/... with actor.
        const resolvedLiteral = yield* requireSettingsSecret(resolver, refA).pipe(
          Effect.provideService(SecretResolver.SecretResolutionActor, adminActor),
        );
        expect(resolvedLiteral).toBe("rk_live_alpha_123");

        const forbiddenLiteral = yield* requireSettingsSecret(resolver, refB).pipe(
          Effect.provideService(SecretResolver.SecretResolutionActor, adminActor),
          Effect.flip,
        );
        expect(forbiddenLiteral._tag).toBe("SettingsSecretUnresolvedError");

        // Owner resolves both.
        const ownerValues = yield* resolver
          .read([providerRefA, providerRefB])
          .pipe(Effect.provideService(SecretResolver.SecretResolutionActor, ownerActor));
        expect(ownerValues).toEqual(["rk_live_alpha_123", "rk_live_beta_456"]);

        // Denied reads are audited as secret.read with outcome = "deny".
        const deniedEvents = (yield* auditEvents.list({ action: "secret.read" })).filter(
          (event) => event.outcome === "deny",
        );
        expect(deniedEvents.length).toBeGreaterThanOrEqual(2);
      }).pipe(Effect.provide(makeBaseLayer())),
  );

  it.live(
    "enforces HTTP status codes (200/400/401/403/404) and never echoes plaintext values",
    () =>
      Effect.gen(function* () {
        yield* seedProjectsAndMembers;
        const envAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const projectAccess = yield* ProjectAccess.ProjectAccess;
        const projectSecrets = yield* ProjectSecrets.ProjectSecrets;

        const adminBearer = yield* envAuth.issuePrincipalSession({
          principalId: ADMIN_A_ID,
          binding: { _tag: "principal" },
          scopes: [...roleScopes("admin")],
          method: "bearer-access-token",
          client: { deviceType: "desktop" },
        });
        const devBearer = yield* envAuth.issuePrincipalSession({
          principalId: DEV_A_ID,
          binding: { _tag: "principal" },
          scopes: [...roleScopes("developer")],
          method: "bearer-access-token",
          client: { deviceType: "desktop" },
        });
        const ownerBearer = yield* envAuth.issuePrincipalSession({
          principalId: OWNER_ID,
          binding: { _tag: "environment" },
          scopes: [AuthProvidersManageScope, AuthAccessReadScope, AuthOrchestrationReadScope],
          method: "bearer-access-token",
          client: { deviceType: "desktop" },
        });

        const appLayer = HttpApiBuilder.layer(ProjectsSecretsHttpTestApi).pipe(
          Layer.provide(ProjectHttp.layer),
          Layer.provide(AuthHttp.layerAuthenticatedAuth),
          Layer.provide(Layer.succeed(EnvironmentAuth.EnvironmentAuth, envAuth)),
          Layer.provide(Layer.succeed(ProjectAccess.ProjectAccess, projectAccess)),
          Layer.provide(Layer.succeed(ProjectSecrets.ProjectSecrets, projectSecrets)),
          Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
          Layer.provide(Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({})),
          Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
          Layer.provide(Layer.mock(ProjectQuotaService.ProjectQuotaService)({})),
          Layer.provide(HttpPlatform.layer),
          Layer.provide(Etag.layerWeak),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.acquireUseRelease(
          Effect.sync(() => HttpRouter.toWebHandler(appLayer, { disableLogger: true })),
          ({ handler }) =>
            Effect.promise(async () => {
              const call = (method: string, path: string, token?: string, body?: unknown) =>
                handler(
                  new Request(`http://127.0.0.1${path}`, {
                    method,
                    headers: {
                      ...(token ? { authorization: `Bearer ${token}` } : {}),
                      ...(body === undefined ? {} : { "content-type": "application/json" }),
                    },
                    ...(body === undefined ? {} : { body: encodeJson(body) }),
                  }),
                );

              // 401 when unauthenticated.
              expect((await call("GET", `/api/projects/${PROJECT_A}/secrets`)).status).toBe(401);

              // 403 for developer (lacks providers:manage scope / project:secrets).
              expect(
                (await call("GET", `/api/projects/${PROJECT_A}/secrets`, devBearer.token)).status,
              ).toBe(403);

              // 200 for admin of project A setting & listing secret.
              const plaintext = "ghp_secret_http_roundtrip_value";
              const putResp = await call(
                "PUT",
                `/api/projects/${PROJECT_A}/secrets/GITHUB_TOKEN`,
                adminBearer.token,
                { value: plaintext },
              );
              expect(putResp.status).toBe(200);
              const putText = await putResp.text();
              expect(putText).not.toContain(plaintext);
              const putBody = JSON.parse(putText) as ProjectSecret;
              expect(putBody.name).toBe("GITHUB_TOKEN");
              expect(putBody.fingerprint).toBe(ProjectSecrets.fingerprintSecretValue(plaintext));

              const listResp = await call(
                "GET",
                `/api/projects/${PROJECT_A}/secrets`,
                adminBearer.token,
              );
              expect(listResp.status).toBe(200);
              const listText = await listResp.text();
              expect(listText).not.toContain(plaintext);
              expect(JSON.parse(listText)).toHaveLength(1);

              // 403 for admin of A trying to access project B (where they are only developer).
              expect(
                (await call("GET", `/api/projects/${PROJECT_B}/secrets`, adminBearer.token)).status,
              ).toBe(403);
              expect(
                (
                  await call("PUT", `/api/projects/${PROJECT_B}/secrets/X`, adminBearer.token, {
                    value: "v",
                  })
                ).status,
              ).toBe(403);

              // 200 for owner accessing project B.
              expect(
                (
                  await call(
                    "PUT",
                    `/api/projects/${PROJECT_B}/secrets/BETA_KEY`,
                    ownerBearer.token,
                    { value: "beta-val" },
                  )
                ).status,
              ).toBe(200);

              // 400 for invalid secret name or empty value.
              expect(
                (
                  await call(
                    "PUT",
                    `/api/projects/${PROJECT_A}/secrets/${encodeURIComponent("-bad-name")}`,
                    adminBearer.token,
                    { value: "val" },
                  )
                ).status,
              ).toBe(400);
              expect(
                (
                  await call(
                    "PUT",
                    `/api/projects/${PROJECT_A}/secrets/GOOD_NAME`,
                    adminBearer.token,
                    {
                      value: "",
                    },
                  )
                ).status,
              ).toBe(400);

              // 404 for unknown project.
              expect(
                (await call("GET", `/api/projects/${PROJECT_MISSING}/secrets`, ownerBearer.token))
                  .status,
              ).toBe(404);

              // 200 for DELETE.
              const delResp = await call(
                "DELETE",
                `/api/projects/${PROJECT_A}/secrets/GITHUB_TOKEN`,
                adminBearer.token,
              );
              expect(delResp.status).toBe(200);
              expect(await delResp.json()).toEqual({ deleted: true });
            }),
          ({ dispose }) => Effect.promise(() => dispose()),
        );
      }).pipe(Effect.provide(makeBaseLayer())),
  );
});
