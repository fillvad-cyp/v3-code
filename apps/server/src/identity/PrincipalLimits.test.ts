import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ApiTokenId,
  AuthAccessReadScope,
  AuthOrchestrationReadScope,
  DEFAULT_MEMBER_MAX_API_TOKENS,
  DEFAULT_MEMBER_MAX_PREVIEW_TABS,
  DEFAULT_MEMBER_MAX_SESSIONS,
  DEFAULT_MEMBER_MAX_TERMINALS,
  EnvironmentHttpApi,
  EnvironmentId,
  PrincipalId,
  ThreadId,
} from "@t3tools/contracts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
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
import * as PortScanner from "../preview/PortScanner.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ApiTokenService from "./ApiTokenService.ts";
import * as AuditService from "./AuditService.ts";
import * as InvitationService from "./InvitationService.ts";
import * as MembershipService from "./MembershipService.ts";
import * as Passwords from "./Passwords.ts";
import * as PrincipalLimitsService from "./PrincipalLimitsService.ts";

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const OWNER_ID = PrincipalId.make("owner");
const MEMBER_ID = PrincipalId.make("member-limits-user");
const NOW_ISO = "2026-11-26T12:00:00.000Z";

function makeFakePtyAdapter(): PtyAdapter.PtyAdapter["Service"] {
  let nextPid = 41_000;
  return PtyAdapter.PtyAdapter.of({
    spawn: () =>
      Effect.sync(() => {
        const pid = ++nextPid;
        const exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
        const dataListeners = new Set<(data: string) => void>();
        let killed = false;
        return {
          pid,
          write: () => {},
          resize: () => {},
          kill: () => {
            if (killed) return;
            killed = true;
            for (const listener of exitListeners) {
              listener({ exitCode: 0, signal: null });
            }
          },
          onData: (listener) => {
            dataListeners.add(listener);
            return () => {
              dataListeners.delete(listener);
            };
          },
          onExit: (listener) => {
            exitListeners.add(listener);
            return () => {
              exitListeners.delete(listener);
            };
          },
        } satisfies PtyAdapter.PtyProcess;
      }),
  });
}

const layerSessionAndLimits = () =>
  Layer.mergeAll(
    SessionStore.layer,
    PrincipalLimitsService.layer,
    Principals.layer,
    MemberLimits.layer,
    ApiTokens.layer,
  ).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("limits-test-env")),
      }),
    ),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-principal-limits-" })),
    Layer.provide(NodeServices.layer),
    Layer.provide(NodeCrypto.layer),
  );

it.effect("enforces max sessions per principal (default 5, override, owner exempt)", () =>
  Effect.gen(function* () {
    const principals = yield* Principals.PrincipalRepository;
    const memberLimits = yield* MemberLimits.MemberLimitsRepository;
    const sessions = yield* SessionStore.SessionStore;

    yield* principals.create({
      id: MEMBER_ID,
      kind: "member",
      displayName: "Alice",
      email: "alice@example.com",
      status: "active",
      ceiling: [AuthOrchestrationReadScope, AuthAccessReadScope],
      createdAt: NOW_ISO,
    });

    // Default limit is 5 active sessions.
    const issuedIds = [];
    for (let index = 0; index < DEFAULT_MEMBER_MAX_SESSIONS; index += 1) {
      const issued = yield* sessions.issue({
        subject: `principal:${MEMBER_ID}`,
        principalId: MEMBER_ID,
        binding: { _tag: "principal" },
      });
      issuedIds.push(issued.sessionId);
    }

    const sixthError = yield* sessions
      .issue({
        subject: `principal:${MEMBER_ID}`,
        principalId: MEMBER_ID,
        binding: { _tag: "principal" },
      })
      .pipe(Effect.flip);
    expect(sixthError._tag).toBe("SessionLimitExceededError");
    if (sixthError._tag === "SessionLimitExceededError") {
      expect(sixthError.status).toBe(429);
      expect(sixthError.limit).toBe(DEFAULT_MEMBER_MAX_SESSIONS);
      expect(sixthError.activeCount).toBe(DEFAULT_MEMBER_MAX_SESSIONS);
      expect(sixthError.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }

    // Revoking one frees capacity.
    yield* sessions.revoke(issuedIds[0]!);
    const replacement = yield* sessions.issue({
      subject: `principal:${MEMBER_ID}`,
      principalId: MEMBER_ID,
      binding: { _tag: "principal" },
    });
    expect(replacement.sessionId).toBeTruthy();

    // Per-principal override is honored (null = default, explicit value overrides).
    yield* memberLimits.set({
      principalId: MEMBER_ID,
      maxSessions: 7,
      maxTerminals: null,
      maxPreviewTabs: null,
      invitesPerHour: null,
      maxApiTokens: null,
    });
    yield* sessions.issue({
      subject: `principal:${MEMBER_ID}`,
      principalId: MEMBER_ID,
      binding: { _tag: "principal" },
    });
    yield* sessions.issue({
      subject: `principal:${MEMBER_ID}`,
      principalId: MEMBER_ID,
      binding: { _tag: "principal" },
    });
    const eighthError = yield* sessions
      .issue({
        subject: `principal:${MEMBER_ID}`,
        principalId: MEMBER_ID,
        binding: { _tag: "principal" },
      })
      .pipe(Effect.flip);
    expect(eighthError._tag).toBe("SessionLimitExceededError");
    if (eighthError._tag === "SessionLimitExceededError") {
      expect(eighthError.limit).toBe(7);
    }

    // Owner is exempt even past default limit and even with an explicit member_limits row.
    yield* memberLimits.set({
      principalId: OWNER_ID,
      maxSessions: 1,
      maxTerminals: 1,
      maxPreviewTabs: 1,
      invitesPerHour: 1,
      maxApiTokens: 1,
    });
    for (let index = 0; index < DEFAULT_MEMBER_MAX_SESSIONS + 2; index += 1) {
      const ownerSession = yield* sessions.issue({
        subject: "owner",
        principalId: OWNER_ID,
        binding: { _tag: "environment" },
      });
      expect(ownerSession.sessionId).toBeTruthy();
    }
  }).pipe(Effect.provide(layerSessionAndLimits())),
);

it.effect(
  "returns HTTP 429 with Retry-After on POST /api/auth/login when session limit is hit",
  () =>
    Effect.gen(function* () {
      const layerConfig = ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-limits-http-live-",
      }).pipe(Layer.provide(NodeServices.layer));
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
      const layerSettings = ServerSettings.layerTest({ multiUser: true });
      const layerAuth = EnvironmentAuth.layer.pipe(
        Layer.provide(layerSettings),
        Layer.provide(layerIdentityRepositories),
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provide(ServerEnvironment.layerIdentity),
        Layer.provide(layerConfig),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );
      const layerAccess = ProjectAccess.layer.pipe(
        Layer.provide(layerIdentityRepositories),
        Layer.provide(ProjectStore.layer),
      );
      const layerMembership = MembershipService.layer.pipe(
        Layer.provide(layerAccess),
        Layer.provide(layerIdentityRepositories),
      );
      const layerIdentity = Layer.mergeAll(
        InvitationService.layer.pipe(
          Layer.provide(layerMembership),
          Layer.provide(layerAccess),
          Layer.provide(layerIdentityRepositories),
        ),
        Passwords.layer.pipe(Layer.provide(layerIdentityRepositories)),
        AuditService.layer.pipe(
          Layer.provide(layerAccess),
          Layer.provide(layerIdentityRepositories),
          Layer.provide(layerSettings),
        ),
        ApiTokenService.layer.pipe(
          Layer.provide(layerAccess),
          Layer.provide(layerIdentityRepositories),
        ),
        layerMembership,
        layerAccess,
        layerIdentityRepositories,
      ).pipe(Layer.provideMerge(layerAuth));

      const ctx = yield* Layer.build(
        Layer.mergeAll(layerIdentity, layerConfig, NodeServices.layer, NodeCrypto.layer),
      );
      const provided = Layer.succeedContext(ctx);
      const httpLayer = HttpApiBuilder.layer(AuthTestApi).pipe(
        Layer.provide(AuthHttp.layer),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
        Layer.provideMerge(provided),
        Layer.provideMerge(
          HttpPlatform.layer.pipe(
            Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            Layer.provideMerge(Etag.layerWeak),
          ),
        ),
      );

      const principals = Context.get(ctx, Principals.PrincipalRepository);
      const memberLimits = Context.get(ctx, MemberLimits.MemberLimitsRepository);
      const passwordService = Context.get(ctx, Passwords.Passwords);
      const random = Context.get(ctx, SecureRandom.SecureRandom);
      const secretStore = Context.get(ctx, ServerSecretStore.ServerSecretStore);

      yield* principals.create({
        id: MEMBER_ID,
        kind: "member",
        displayName: "Alice",
        email: "alice-http@example.com",
        status: "active",
        ceiling: [AuthOrchestrationReadScope, AuthAccessReadScope],
        createdAt: NOW_ISO,
      });
      yield* passwordService.setMemberPassword({
        actor: {
          sessionId: "owner-session" as never,
          subject: "owner",
          scopes: [],
          principalId: OWNER_ID,
          isOwner: true,
          roles: new Map(),
        },
        principalId: MEMBER_ID,
        password: "correct-horse-battery-staple",
      });
      yield* memberLimits.set({
        principalId: MEMBER_ID,
        maxSessions: 1,
        maxTerminals: null,
        maxPreviewTabs: null,
        invitesPerHour: null,
        maxApiTokens: null,
      });

      const requestContext = Context.make(SecureRandom.SecureRandom, random).pipe(
        Context.add(ServerSecretStore.ServerSecretStore, secretStore),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(httpLayer, { disableLogger: true });
      yield* Effect.addFinalizer(() => Effect.promise(dispose));

      const makeLoginRequest = () =>
        new Request("http://127.0.0.1/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "alice-http@example.com",
            password: "correct-horse-battery-staple",
          }),
        });

      const first = yield* Effect.promise(() => handler(makeLoginRequest(), requestContext));
      expect(first.status).toBe(200);

      const second = yield* Effect.promise(() => handler(makeLoginRequest(), requestContext));
      expect(second.status).toBe(429);
      const retryAfter = second.headers.get("retry-after");
      expect(retryAfter).not.toBeNull();
      expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
);

it.effect(
  "enforces concurrent terminal limit (409 with open terminal id list, overrides, owner exempt)",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-term-limit-cwd-" });
      const manager = yield* TerminalManager.TerminalManager;

      // Default limit is 3 concurrent terminals for a non-owner principal.
      for (let index = 1; index <= DEFAULT_MEMBER_MAX_TERMINALS; index += 1) {
        yield* manager.open(
          {
            threadId: `thread-${index}`,
            terminalId: `term-${index}`,
            cwd,
          },
          { principalId: MEMBER_ID },
        );
      }

      // Re-opening an already open terminal succeeds (same threadId + terminalId).
      const reopened = yield* manager.open(
        {
          threadId: "thread-1",
          terminalId: "term-1",
          cwd,
        },
        { principalId: MEMBER_ID },
      );
      expect(reopened.status).toBe("running");

      // 4th distinct concurrent terminal fails with 409 and open terminal id list.
      const fourthError = yield* manager
        .open(
          {
            threadId: "thread-4",
            terminalId: "term-4",
            cwd,
          },
          { principalId: MEMBER_ID },
        )
        .pipe(Effect.flip);
      expect(fourthError._tag).toBe("TerminalLimitExceededError");
      if (fourthError._tag === "TerminalLimitExceededError") {
        expect(fourthError.status).toBe(409);
        expect(fourthError.limit).toBe(DEFAULT_MEMBER_MAX_TERMINALS);
        expect(fourthError.openTerminalIds).toEqual([
          "thread-1:term-1",
          "thread-2:term-2",
          "thread-3:term-3",
        ]);
        expect(fourthError.openTerminals).toHaveLength(3);
      }

      // Closing one frees a slot.
      yield* manager.close({ threadId: "thread-1", terminalId: "term-1" });
      const fourthAfterClose = yield* manager.open(
        {
          threadId: "thread-4",
          terminalId: "term-4",
          cwd,
        },
        { principalId: MEMBER_ID },
      );
      expect(fourthAfterClose.status).toBe("running");

      // Per-principal override (maxTerminals: 4) allows one more, then rejects the 5th.
      const fifthWithOverride = yield* manager.open(
        {
          threadId: "thread-5",
          terminalId: "term-5",
          cwd,
        },
        { principalId: MEMBER_ID, maxTerminals: 4 },
      );
      expect(fifthWithOverride.status).toBe("running");
      const sixthWithOverride = yield* manager
        .open(
          {
            threadId: "thread-6",
            terminalId: "term-6",
            cwd,
          },
          { principalId: MEMBER_ID, maxTerminals: 4 },
        )
        .pipe(Effect.flip);
      expect(sixthWithOverride._tag).toBe("TerminalLimitExceededError");

      // Owner (no principalId limit passed) is exempt.
      for (let index = 1; index <= DEFAULT_MEMBER_MAX_TERMINALS + 2; index += 1) {
        const ownerTerm = yield* manager.open({
          threadId: `owner-thread-${index}`,
          terminalId: `owner-term-${index}`,
          cwd,
        });
        expect(ownerTerm.status).toBe("running");
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        TerminalManager.layer(() => ({})).pipe(
          Layer.provide(Layer.succeed(PtyAdapter.PtyAdapter, makeFakePtyAdapter())),
          Layer.provide(
            Layer.mock(PortScanner.PortDiscovery)({
              unregisterTerminal: () => Effect.void,
              trackAgent: () => () => undefined,
            }),
          ),
          Layer.provide(Layer.mock(NativeTelemetryClient.NativeTelemetryClient)({})),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-term-limit-" })),
          Layer.provideMerge(NodeServices.layer),
          Layer.provide(NodeCrypto.layer),
        ),
      ),
    ),
);

it.effect("enforces preview tab limit (429 with Retry-After, overrides, owner exempt)", () =>
  Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    const threadId = ThreadId.make("preview-limit-thread");

    const openedTabs = [];
    for (let index = 0; index < DEFAULT_MEMBER_MAX_PREVIEW_TABS; index += 1) {
      const tab = yield* manager.open({
        threadId,
        principalId: MEMBER_ID,
      });
      openedTabs.push(tab);
    }

    // 5th tab hits 429 with Retry-After.
    const fifthError = yield* manager
      .open({
        threadId,
        principalId: MEMBER_ID,
      })
      .pipe(Effect.flip);
    expect(fifthError._tag).toBe("PreviewTabLimitExceededError");
    if (fifthError._tag === "PreviewTabLimitExceededError") {
      expect(fifthError.status).toBe(429);
      expect(fifthError.limit).toBe(DEFAULT_MEMBER_MAX_PREVIEW_TABS);
      expect(fifthError.activeCount).toBe(DEFAULT_MEMBER_MAX_PREVIEW_TABS);
      expect(fifthError.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    }

    // Override maxPreviewTabs: 5 allows a 5th tab, then rejects 6th.
    const fifthOverride = yield* manager.open({
      threadId,
      principalId: MEMBER_ID,
      maxPreviewTabs: 5,
    });
    expect(fifthOverride.tabId).toBeTruthy();

    const sixthOverride = yield* manager
      .open({
        threadId,
        principalId: MEMBER_ID,
        maxPreviewTabs: 5,
      })
      .pipe(Effect.flip);
    expect(sixthOverride._tag).toBe("PreviewTabLimitExceededError");

    // Closing a tab frees capacity under the default limit.
    yield* manager.close({ threadId, tabId: openedTabs[0]!.tabId });
    yield* manager.close({ threadId, tabId: openedTabs[1]!.tabId });
    const reopened = yield* manager.open({ threadId, principalId: MEMBER_ID });
    expect(reopened.tabId).toBeTruthy();

    // Owner (no principalId limit passed) is exempt.
    for (let index = 0; index < DEFAULT_MEMBER_MAX_PREVIEW_TABS + 3; index += 1) {
      const ownerTab = yield* manager.open({ threadId });
      expect(ownerTab.tabId).toBeTruthy();
    }
  }).pipe(
    Effect.provide(
      PreviewManager.layer.pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-limit-" })),
        Layer.provide(NodeCrypto.layer),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

it.effect(
  "enforces PAT count limit (default 10, override, revoked/expired ignored, owner exempt)",
  () =>
    Effect.gen(function* () {
      const principals = yield* Principals.PrincipalRepository;
      const memberLimits = yield* MemberLimits.MemberLimitsRepository;
      const apiTokens = yield* ApiTokens.ApiTokenRepository;
      const limitsService = yield* PrincipalLimitsService.PrincipalLimitsService;

      yield* principals.create({
        id: MEMBER_ID,
        kind: "member",
        displayName: "Alice",
        email: "alice-pat@example.com",
        status: "active",
        ceiling: [AuthOrchestrationReadScope, AuthAccessReadScope],
        createdAt: NOW_ISO,
      });

      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const pastIso = DateTime.formatIso(DateTime.subtractDuration(now, Duration.hours(1)));

      for (let index = 0; index < DEFAULT_MEMBER_MAX_API_TOKENS; index += 1) {
        yield* limitsService.assertApiTokenLimit(MEMBER_ID);
        yield* apiTokens.create({
          id: ApiTokenId.make(`pat-${index}`),
          principalId: MEMBER_ID,
          tokenHmac: `hmac-${index}`,
          scopes: [AuthOrchestrationReadScope],
          binding: { _tag: "principal" },
          expiresAt: null,
          createdAt: nowIso,
        });
      }

      // 11th fails with 429 + retryAfterSeconds.
      const limitError = yield* limitsService.assertApiTokenLimit(MEMBER_ID).pipe(Effect.flip);
      expect(limitError._tag).toBe("ApiTokenLimitExceededError");
      if (limitError._tag === "ApiTokenLimitExceededError") {
        expect(limitError.status).toBe(429);
        expect(limitError.limit).toBe(DEFAULT_MEMBER_MAX_API_TOKENS);
        expect(limitError.activeCount).toBe(DEFAULT_MEMBER_MAX_API_TOKENS);
        expect(limitError.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      }

      // Revoking one frees capacity (and an expired token does not count).
      yield* apiTokens.revoke(ApiTokenId.make("pat-0"), nowIso);
      yield* apiTokens.create({
        id: ApiTokenId.make("pat-expired"),
        principalId: MEMBER_ID,
        tokenHmac: "hmac-expired",
        scopes: [AuthOrchestrationReadScope],
        binding: { _tag: "principal" },
        expiresAt: pastIso,
        createdAt: pastIso,
      });
      yield* limitsService.assertApiTokenLimit(MEMBER_ID);

      // Override maxApiTokens = 2 blocks while 9 active tokens exist; null restores default 10.
      yield* memberLimits.set({
        principalId: MEMBER_ID,
        maxSessions: null,
        maxTerminals: null,
        maxPreviewTabs: null,
        invitesPerHour: null,
        maxApiTokens: 2,
      });
      const overrideError = yield* limitsService.assertApiTokenLimit(MEMBER_ID).pipe(Effect.flip);
      expect(overrideError._tag).toBe("ApiTokenLimitExceededError");
      if (overrideError._tag === "ApiTokenLimitExceededError") {
        expect(overrideError.limit).toBe(2);
      }

      yield* memberLimits.set({
        principalId: MEMBER_ID,
        maxSessions: null,
        maxTerminals: null,
        maxPreviewTabs: null,
        invitesPerHour: null,
        maxApiTokens: null,
      });
      yield* limitsService.assertApiTokenLimit(MEMBER_ID);

      // Owner is exempt even with > 10 active tokens and an override row.
      yield* memberLimits.set({
        principalId: OWNER_ID,
        maxSessions: 1,
        maxTerminals: 1,
        maxPreviewTabs: 1,
        invitesPerHour: 1,
        maxApiTokens: 1,
      });
      for (let index = 0; index < DEFAULT_MEMBER_MAX_API_TOKENS + 2; index += 1) {
        yield* apiTokens.create({
          id: ApiTokenId.make(`owner-pat-${index}`),
          principalId: OWNER_ID,
          tokenHmac: `owner-hmac-${index}`,
          scopes: [AuthOrchestrationReadScope],
          binding: { _tag: "environment" },
          expiresAt: null,
          createdAt: nowIso,
        });
      }
      expect(yield* limitsService.resolveForPrincipal(OWNER_ID)).toBeNull();
      yield* limitsService.assertApiTokenLimit(OWNER_ID);
    }).pipe(Effect.provide(layerSessionAndLimits())),
);
