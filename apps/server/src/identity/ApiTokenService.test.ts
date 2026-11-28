import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessReadScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthStandardClientScopes,
  AuthTerminalOperateScope,
  PrincipalId,
  ProjectId,
  ceilingScopes,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ApiTokens from "../persistence/ApiTokens.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as Invitations from "../persistence/Invitations.ts";
import * as MemberLimits from "../persistence/MemberLimits.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as Principals from "../persistence/Principals.ts";
import * as RecoveryCodes from "../persistence/RecoveryCodes.ts";
import * as SessionPrincipals from "../persistence/SessionPrincipals.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import { API_TOKEN_PREFIX } from "./ApiTokenCodes.ts";
import * as ApiTokenService from "./ApiTokenService.ts";
import * as PrincipalLimitsService from "./PrincipalLimitsService.ts";

const OWNER_ID = PrincipalId.make("owner");
const DEV_ID = PrincipalId.make("member-dev");
const RESTRICTED_ID = PrincipalId.make("member-restricted");
const VIEWER_ID = PrincipalId.make("member-viewer");
const OPERATOR_ID = PrincipalId.make("member-operator");
const MANAGER_ID = PrincipalId.make("member-manager");
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");
const SESSION_ID = AuthSessionId.make("session-test");

const makeTestLayer = () => {
  const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-pat-service-test-" });
  const layerPersistence = SqlitePersistence.layerMemory;
  const layerRepos = Layer.mergeAll(
    Principals.layer,
    Memberships.layer,
    Invitations.layer,
    AuditEvents.layer,
    ApiTokens.layer,
    MemberLimits.layer,
    RecoveryCodes.layer,
    SessionPrincipals.layer,
    ProjectStore.layer,
  );
  const layerAccess = ProjectAccess.layer.pipe(Layer.provide(layerRepos));
  const layerSecrets = ServerSecretStore.layer;
  const layerPrincipalLimits = PrincipalLimitsService.layer.pipe(Layer.provide(layerRepos));
  const layerEnvAuth = EnvironmentAuth.layer.pipe(
    Layer.provide(ServerSettings.layerTest({ multiUser: true })),
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(layerPrincipalLimits),
    Layer.provide(layerRepos),
    Layer.provide(layerSecrets),
    Layer.provide(ServerEnvironment.layerIdentity),
  );
  const layerApiTokens = ApiTokenService.layer.pipe(
    Layer.provide(layerAccess),
    Layer.provide(layerRepos),
    Layer.provide(layerSecrets),
  );

  return Layer.mergeAll(layerApiTokens, layerEnvAuth, layerAccess, layerRepos, layerSecrets).pipe(
    Layer.provideMerge(layerPersistence),
    Layer.provide(layerConfig),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
};

const seedPrincipals = Effect.gen(function* () {
  const principals = yield* Principals.PrincipalRepository;
  const memberships = yield* Memberships.MembershipRepository;
  const nowIso = DateTime.formatIso(yield* DateTime.now);

  yield* principals.create({
    id: DEV_ID,
    kind: "member",
    displayName: "Alice Dev",
    email: "alice@example.com",
    status: "active",
    ceiling: [...ceilingScopes("staff")],
    createdAt: nowIso,
  });
  yield* principals.create({
    id: RESTRICTED_ID,
    kind: "member",
    displayName: "Bob Restricted",
    email: "bob@example.com",
    status: "active",
    ceiling: [...ceilingScopes("restricted")],
    createdAt: nowIso,
  });
  yield* principals.create({
    id: VIEWER_ID,
    kind: "member",
    displayName: "Cara Viewer",
    email: "cara@example.com",
    status: "active",
    ceiling: [...ceilingScopes("staff")],
    createdAt: nowIso,
  });
  yield* principals.create({
    id: OPERATOR_ID,
    kind: "member",
    displayName: "Dan Operator",
    email: null,
    status: "active",
    ceiling: [...ceilingScopes("staff")],
    createdAt: nowIso,
  });
  yield* principals.create({
    id: MANAGER_ID,
    kind: "member",
    displayName: "Eve Manager",
    email: null,
    status: "active",
    ceiling: [...ceilingScopes("staff")],
    createdAt: nowIso,
  });

  yield* memberships.upsert({
    projectId: PROJECT_A,
    principalId: DEV_ID,
    role: "developer",
    state: "active",
    invitedBy: OWNER_ID,
    expiresAt: null,
    updatedAt: nowIso,
  });
  yield* memberships.upsert({
    projectId: PROJECT_B,
    principalId: DEV_ID,
    role: "admin",
    state: "suspended",
    invitedBy: OWNER_ID,
    expiresAt: null,
    updatedAt: nowIso,
  });
  yield* memberships.upsert({
    projectId: PROJECT_A,
    principalId: RESTRICTED_ID,
    role: "developer",
    state: "active",
    invitedBy: OWNER_ID,
    expiresAt: null,
    updatedAt: nowIso,
  });
  yield* memberships.upsert({
    projectId: PROJECT_A,
    principalId: VIEWER_ID,
    role: "viewer",
    state: "active",
    invitedBy: OWNER_ID,
    expiresAt: null,
    updatedAt: nowIso,
  });
  yield* memberships.upsert({
    projectId: PROJECT_A,
    principalId: OPERATOR_ID,
    role: "operator",
    state: "active",
    invitedBy: OWNER_ID,
    expiresAt: null,
    updatedAt: nowIso,
  });
  yield* memberships.upsert({
    projectId: PROJECT_A,
    principalId: MANAGER_ID,
    role: "manager",
    state: "active",
    invitedBy: OWNER_ID,
    expiresAt: null,
    updatedAt: nowIso,
  });
});

const makeBearerRequest = (
  token: string,
): Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {},
    headers: {
      authorization: `Bearer ${token}`,
    },
  }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

describe("ApiTokenService", () => {
  it.effect("round-trips create, list, bearer authenticate, and revoke with audit events", () =>
    Effect.gen(function* () {
      yield* seedPrincipals;
      const service = yield* ApiTokenService.ApiTokenService;
      const access = yield* ProjectAccess.ProjectAccess;
      const envAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const auditEvents = yield* AuditEvents.AuditEventRepository;

      const ownerActor = yield* access.resolve({
        sessionId: SESSION_ID,
        subject: "owner",
        scopes: [...AuthStandardClientScopes],
        principalId: OWNER_ID,
        binding: { _tag: "environment" },
      });
      const devActor = yield* access.resolve({
        sessionId: SESSION_ID,
        subject: `principal:${DEV_ID}`,
        scopes: [...AuthStandardClientScopes],
        principalId: DEV_ID,
        binding: { _tag: "principal" },
      });
      const viewerActor = yield* access.resolve({
        sessionId: SESSION_ID,
        subject: `principal:${VIEWER_ID}`,
        scopes: [AuthOrchestrationReadScope, AuthFilesystemReadScope, AuthAccessReadScope],
        principalId: VIEWER_ID,
        binding: { _tag: "principal" },
      });

      const created = yield* service.create({
        actor: devActor,
        scopes: [AuthOrchestrationReadScope, AuthFilesystemWriteScope],
        binding: { _tag: "principal" },
        audit: { sessionId: SESSION_ID, ip: "127.0.0.1", userAgent: "vitest" },
      });

      expect(created.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
      expect(created.apiToken.principalId).toBe(DEV_ID);
      expect(created.apiToken.scopes).toEqual([
        AuthOrchestrationReadScope,
        AuthFilesystemWriteScope,
      ]);
      expect(created.apiToken.revokedAt).toBeNull();
      expect(created.apiToken.lastUsedAt).toBeNull();

      // Member sees only own tokens; owner sees all tokens with principal display names.
      const devList = yield* service.listForActor({ actor: devActor });
      expect(devList).toHaveLength(1);
      expect(devList[0]?.id).toBe(created.apiToken.id);
      expect(devList[0]?.principalDisplayName).toBe("Alice Dev");

      const viewerList = yield* service.listForActor({ actor: viewerActor });
      expect(viewerList).toHaveLength(0);

      const ownerList = yield* service.listForActor({ actor: ownerActor });
      expect(ownerList).toHaveLength(1);
      expect(ownerList[0]?.principalDisplayName).toBe("Alice Dev");

      // Another member cannot revoke Alice's token.
      const foreignRevokeErr = yield* service
        .revoke({ actor: viewerActor, id: created.apiToken.id })
        .pipe(Effect.flip);
      expect(foreignRevokeErr._tag).toBe("ApiTokenForbiddenError");

      // Bearer authentication resolves the session with principalId, binding, and scopes.
      const session = yield* envAuth.authenticateHttpRequest(makeBearerRequest(created.token));
      expect(session.principalId).toBe(DEV_ID);
      expect(session.binding).toEqual({ _tag: "principal" });
      expect(session.scopes).toEqual([AuthOrchestrationReadScope, AuthFilesystemWriteScope]);
      expect(session.method).toBe("bearer-access-token");

      // Revoking invalidates bearer auth and writes token.revoked audit event.
      const revoked = yield* service.revoke({
        actor: devActor,
        id: created.apiToken.id,
        audit: { sessionId: SESSION_ID },
      });
      expect(revoked).toBe(true);

      const authAfterRevoke = yield* envAuth
        .authenticateHttpRequest(makeBearerRequest(created.token))
        .pipe(Effect.flip);
      expect(authAfterRevoke._tag).toBe("ServerAuthInvalidCredentialError");

      const events = yield* auditEvents.list({});
      const actions = events.map((event) => event.action);
      expect(actions).toContain("token.created");
      expect(actions).toContain("token.revoked");
      for (const event of events) {
        expect(JSON.stringify(event.metadata)).not.toContain(created.token);
      }
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("rejects scope ceiling, role, and invalid input violations", () =>
    Effect.gen(function* () {
      yield* seedPrincipals;
      const service = yield* ApiTokenService.ApiTokenService;
      const access = yield* ProjectAccess.ProjectAccess;

      const restrictedActor = yield* access.resolve({
        sessionId: SESSION_ID,
        subject: `principal:${RESTRICTED_ID}`,
        scopes: [...AuthStandardClientScopes],
        principalId: RESTRICTED_ID,
        binding: { _tag: "principal" },
      });
      const viewerActor = yield* access.resolve({
        sessionId: SESSION_ID,
        subject: `principal:${VIEWER_ID}`,
        scopes: [...AuthStandardClientScopes],
        principalId: VIEWER_ID,
        binding: { _tag: "principal" },
      });

      // Developer role allows filesystem:write, but restricted ceiling blocks it.
      const ceilingErr = yield* service
        .create({
          actor: restrictedActor,
          scopes: [AuthFilesystemWriteScope],
          binding: { _tag: "principal" },
        })
        .pipe(Effect.flip);
      expect(ceilingErr._tag).toBe("ApiTokenForbiddenError");
      if (ceilingErr._tag === "ApiTokenForbiddenError") {
        expect(ceilingErr.reason).toBe("scope_exceeds_ceiling");
      }

      // Staff ceiling allows orchestration:operate, but viewer role blocks it.
      const roleScopeErr = yield* service
        .create({
          actor: viewerActor,
          scopes: [AuthOrchestrationOperateScope],
          binding: { _tag: "principal" },
        })
        .pipe(Effect.flip);
      expect(roleScopeErr._tag).toBe("ApiTokenForbiddenError");
      if (roleScopeErr._tag === "ApiTokenForbiddenError") {
        expect(roleScopeErr.reason).toBe("scope_exceeds_ceiling");
      }

      // Empty scopes and retired/unknown scopes are rejected as invalid input.
      const emptyErr = yield* service
        .create({
          actor: viewerActor,
          scopes: [],
          binding: { _tag: "principal" },
        })
        .pipe(Effect.flip);
      expect(emptyErr._tag).toBe("ApiTokenInvalidInputError");

      const invalidScopeErr = yield* service
        .create({
          actor: viewerActor,
          scopes: ["review:write"],
          binding: { _tag: "principal" },
        })
        .pipe(Effect.flip);
      expect(invalidScopeErr._tag).toBe("ApiTokenInvalidInputError");
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("enforces project binding membership, role rank, sibling roles, and scope fit", () =>
    Effect.gen(function* () {
      yield* seedPrincipals;
      const service = yield* ApiTokenService.ApiTokenService;
      const access = yield* ProjectAccess.ProjectAccess;

      const devActor = yield* access.resolve({
        sessionId: SESSION_ID,
        subject: `principal:${DEV_ID}`,
        scopes: [...AuthStandardClientScopes],
        principalId: DEV_ID,
        binding: { _tag: "principal" },
      });
      const operatorActor = yield* access.resolve({
        sessionId: SESSION_ID,
        subject: `principal:${OPERATOR_ID}`,
        scopes: [...AuthStandardClientScopes],
        principalId: OPERATOR_ID,
        binding: { _tag: "principal" },
      });
      const managerActor = yield* access.resolve({
        sessionId: SESSION_ID,
        subject: `principal:${MANAGER_ID}`,
        scopes: [...AuthStandardClientScopes],
        principalId: MANAGER_ID,
        binding: { _tag: "principal" },
      });

      // Developer can bind PROJECT_A as viewer with viewer scopes.
      const ok = yield* service.create({
        actor: devActor,
        scopes: [AuthOrchestrationReadScope],
        binding: { _tag: "projects", projects: [{ projectId: PROJECT_A, role: "viewer" }] },
      });
      expect(ok.apiToken.binding).toEqual({
        _tag: "projects",
        projects: [{ projectId: PROJECT_A, role: "viewer" }],
      });

      // Developer binding PROJECT_A as viewer cannot request orchestration:operate.
      const boundScopeErr = yield* service
        .create({
          actor: devActor,
          scopes: [AuthOrchestrationOperateScope],
          binding: { _tag: "projects", projects: [{ projectId: PROJECT_A, role: "viewer" }] },
        })
        .pipe(Effect.flip);
      expect(boundScopeErr._tag).toBe("ApiTokenForbiddenError");

      // Developer cannot bind PROJECT_A with role admin (> developer).
      const roleErr = yield* service
        .create({
          actor: devActor,
          scopes: [AuthOrchestrationReadScope],
          binding: { _tag: "projects", projects: [{ projectId: PROJECT_A, role: "admin" }] },
        })
        .pipe(Effect.flip);
      expect(roleErr._tag).toBe("ApiTokenForbiddenError");
      if (roleErr._tag === "ApiTokenForbiddenError") {
        expect(roleErr.reason).toBe("role_exceeds_membership");
      }

      // Suspended membership on PROJECT_B is rejected.
      const foreignProjectErr = yield* service
        .create({
          actor: devActor,
          scopes: [AuthOrchestrationReadScope],
          binding: { _tag: "projects", projects: [{ projectId: PROJECT_B, role: "viewer" }] },
        })
        .pipe(Effect.flip);
      expect(foreignProjectErr._tag).toBe("ApiTokenForbiddenError");
      if (foreignProjectErr._tag === "ApiTokenForbiddenError") {
        expect(foreignProjectErr.reason).toBe("project_not_accessible");
      }

      // Sibling roles (operator vs manager) cannot cross-bind.
      const opAsMgrErr = yield* service
        .create({
          actor: operatorActor,
          scopes: [AuthOrchestrationReadScope],
          binding: { _tag: "projects", projects: [{ projectId: PROJECT_A, role: "manager" }] },
        })
        .pipe(Effect.flip);
      expect(opAsMgrErr._tag).toBe("ApiTokenForbiddenError");

      const mgrAsOpErr = yield* service
        .create({
          actor: managerActor,
          scopes: [AuthOrchestrationReadScope],
          binding: { _tag: "projects", projects: [{ projectId: PROJECT_A, role: "operator" }] },
        })
        .pipe(Effect.flip);
      expect(mgrAsOpErr._tag).toBe("ApiTokenForbiddenError");

      // Project-bound actor cannot mint a principal-bound token.
      const boundActor = yield* access.resolve({
        sessionId: SESSION_ID,
        subject: "pat:narrow",
        scopes: [AuthOrchestrationReadScope],
        principalId: DEV_ID,
        binding: { _tag: "projects", projects: [{ projectId: PROJECT_A, role: "viewer" }] },
      });
      const widenErr = yield* service
        .create({
          actor: boundActor,
          scopes: [AuthOrchestrationReadScope],
          binding: { _tag: "principal" },
        })
        .pipe(Effect.flip);
      expect(widenErr._tag).toBe("ApiTokenForbiddenError");
      if (widenErr._tag === "ApiTokenForbiddenError") {
        expect(widenErr.reason).toBe("binding_exceeds_actor");
      }
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect("enforces MemberLimits.maxApiTokens and default limit of 10", () =>
    Effect.gen(function* () {
      yield* seedPrincipals;
      const service = yield* ApiTokenService.ApiTokenService;
      const access = yield* ProjectAccess.ProjectAccess;
      const limits = yield* MemberLimits.MemberLimitsRepository;

      const devActor = yield* access.resolve({
        sessionId: SESSION_ID,
        subject: `principal:${DEV_ID}`,
        scopes: [...AuthStandardClientScopes],
        principalId: DEV_ID,
        binding: { _tag: "principal" },
      });

      yield* limits.set({
        principalId: DEV_ID,
        maxSessions: null,
        maxTerminals: null,
        invitesPerHour: null,
        maxApiTokens: 2,
      });

      const first = yield* service.create({
        actor: devActor,
        scopes: [AuthOrchestrationReadScope],
        binding: { _tag: "principal" },
      });
      yield* service.create({
        actor: devActor,
        scopes: [AuthOrchestrationReadScope],
        binding: { _tag: "principal" },
      });

      const limitErr = yield* service
        .create({
          actor: devActor,
          scopes: [AuthOrchestrationReadScope],
          binding: { _tag: "principal" },
        })
        .pipe(Effect.flip);
      expect(limitErr._tag).toBe("ApiTokenLimitExceededError");
      if (limitErr._tag === "ApiTokenLimitExceededError") {
        expect(limitErr.limit).toBe(2);
      }

      // Revoking one frees a slot.
      yield* service.revoke({ actor: devActor, id: first.apiToken.id });
      const third = yield* service.create({
        actor: devActor,
        scopes: [AuthOrchestrationReadScope],
        binding: { _tag: "principal" },
      });
      expect(third.token.startsWith(API_TOKEN_PREFIX)).toBe(true);

      // Default limit is 10 for principals without a MemberLimits row.
      const viewerActor = yield* access.resolve({
        sessionId: SESSION_ID,
        subject: `principal:${VIEWER_ID}`,
        scopes: [AuthOrchestrationReadScope],
        principalId: VIEWER_ID,
        binding: { _tag: "principal" },
      });
      for (let i = 0; i < 10; i++) {
        yield* service.create({
          actor: viewerActor,
          scopes: [AuthOrchestrationReadScope],
          binding: { _tag: "principal" },
        });
      }
      const defaultLimitErr = yield* service
        .create({
          actor: viewerActor,
          scopes: [AuthOrchestrationReadScope],
          binding: { _tag: "principal" },
        })
        .pipe(Effect.flip);
      expect(defaultLimitErr._tag).toBe("ApiTokenLimitExceededError");
      if (defaultLimitErr._tag === "ApiTokenLimitExceededError") {
        expect(defaultLimitErr.limit).toBe(10);
      }
    }).pipe(Effect.provide(makeTestLayer())),
  );

  it.effect(
    "throttles last_used_at updates to once per minute and applies live ceiling narrowing",
    () =>
      Effect.gen(function* () {
        yield* seedPrincipals;
        const service = yield* ApiTokenService.ApiTokenService;
        const access = yield* ProjectAccess.ProjectAccess;
        const envAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const apiTokens = yield* ApiTokens.ApiTokenRepository;
        const principals = yield* Principals.PrincipalRepository;
        const memberships = yield* Memberships.MembershipRepository;

        const devActor = yield* access.resolve({
          sessionId: SESSION_ID,
          subject: `principal:${DEV_ID}`,
          scopes: [...AuthStandardClientScopes],
          principalId: DEV_ID,
          binding: { _tag: "principal" },
        });

        const created = yield* service.create({
          actor: devActor,
          scopes: [AuthOrchestrationReadScope, AuthFilesystemWriteScope, AuthTerminalOperateScope],
          binding: { _tag: "projects", projects: [{ projectId: PROJECT_A, role: "developer" }] },
        });

        // Advance from epoch 0 to a realistic timestamp.
        yield* TestClock.setTime(Date.parse("2026-11-26T12:00:00.000Z"));

        // First auth touches last_used_at.
        const session1 = yield* envAuth.authenticateHttpRequest(makeBearerRequest(created.token));
        expect(session1.scopes).toEqual([
          AuthOrchestrationReadScope,
          AuthFilesystemWriteScope,
          AuthTerminalOperateScope,
        ]);
        const row1 = Option.getOrThrow(yield* apiTokens.getById(created.apiToken.id));
        expect(row1.lastUsedAt).toBe("2026-11-26T12:00:00.000Z");

        // Auth 20 seconds later is throttled (no DB update).
        yield* TestClock.adjust(Duration.seconds(20));
        yield* envAuth.authenticateHttpRequest(makeBearerRequest(created.token));
        const row2 = Option.getOrThrow(yield* apiTokens.getById(created.apiToken.id));
        expect(row2.lastUsedAt).toBe("2026-11-26T12:00:00.000Z");

        // Auth 41 seconds later (61s total) updates last_used_at.
        yield* TestClock.adjust(Duration.seconds(41));
        yield* envAuth.authenticateHttpRequest(makeBearerRequest(created.token));
        const row3 = Option.getOrThrow(yield* apiTokens.getById(created.apiToken.id));
        expect(row3.lastUsedAt).toBe("2026-11-26T12:01:01.000Z");

        // Lowering principal ceiling immediately narrows authenticated scopes on next request.
        yield* principals.update({
          id: DEV_ID,
          ceiling: [...ceilingScopes("client")],
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          bumpAccessRevision: true,
        });
        const sessionAfterCeiling = yield* envAuth.authenticateHttpRequest(
          makeBearerRequest(created.token),
        );
        expect(sessionAfterCeiling.scopes).toEqual([AuthOrchestrationReadScope]);

        // Downgrading live membership to viewer narrows bound project role to viewer.
        yield* memberships.setRole({
          projectId: PROJECT_A,
          principalId: DEV_ID,
          role: "viewer",
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
        const sessionAfterRole = yield* envAuth.authenticateHttpRequest(
          makeBearerRequest(created.token),
        );
        expect(sessionAfterRole.binding).toEqual({
          _tag: "projects",
          projects: [{ projectId: PROJECT_A, role: "viewer" }],
        });

        // Suspending principal rejects the PAT immediately.
        yield* principals.update({
          id: DEV_ID,
          status: "suspended",
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          bumpAccessRevision: true,
        });
        const suspendedErr = yield* envAuth
          .authenticateHttpRequest(makeBearerRequest(created.token))
          .pipe(Effect.flip);
        expect(suspendedErr._tag).toBe("ServerAuthInvalidCredentialError");
      }).pipe(Effect.provide(makeTestLayer())),
  );
});
