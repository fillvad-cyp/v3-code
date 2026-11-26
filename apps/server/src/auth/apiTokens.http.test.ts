import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthStandardClientScopes,
  EnvironmentHttpApi,
  EventId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  OrchestrationV2AppThread,
  PrincipalId,
  ProjectId,
  ThreadId,
  ceilingScopes,
  type ApiTokenCreateResult,
  type ApiTokenListItem,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ApiTokenService from "../identity/ApiTokenService.ts";
import * as AuditService from "../identity/AuditService.ts";
import * as InvitationService from "../identity/InvitationService.ts";
import * as MembershipService from "../identity/MembershipService.ts";
import * as Passwords from "../identity/Passwords.ts";
import * as PrincipalLimitsService from "../identity/PrincipalLimitsService.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import * as OrchestrationHttp from "../orchestration-v2/http.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ApiTokens from "../persistence/ApiTokens.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as Invitations from "../persistence/Invitations.ts";
import * as MemberLimits from "../persistence/MemberLimits.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as Principals from "../persistence/Principals.ts";
import * as RecoveryCodes from "../persistence/RecoveryCodes.ts";
import * as SessionPrincipals from "../persistence/SessionPrincipals.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import * as ProjectHttp from "../project/http.ts";
import * as ProjectQuotaService from "../project/ProjectQuotaService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";

class PatHttpTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.projects)
  .add(EnvironmentHttpApi.groups.orchestration) {}

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
const OWNER_ID = PrincipalId.make("owner");
const MEMBER_ID = PrincipalId.make("member-pat-http");
const PROJECT_ALLOWED = ProjectId.make("project-allowed");
const PROJECT_FOREIGN = ProjectId.make("project-foreign");
const THREAD_ALLOWED = ThreadId.make("thread-allowed");
const THREAD_FOREIGN = ThreadId.make("thread-foreign");

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeAppThread = Schema.decodeSync(OrchestrationV2AppThread);

const jsonRequest = (
  method: string,
  path: string,
  body?: unknown,
  headers?: Readonly<Record<string, string>>,
) =>
  new Request(`http://127.0.0.1${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: encodeJson(body) }),
  });

const orchestrationHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
});

function makeAppThread(threadId: ThreadId, projectId: ProjectId, title: string, now: DateTime.Utc) {
  return decodeAppThread({
    id: threadId,
    projectId,
    title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  });
}

it.live(
  "handles /api/tokens CRUD, 429 limits, and bearer PAT auth across orchestration and project routes",
  () =>
    Effect.gen(function* () {
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
      ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pat-http-test-" })));

      const replayRuntime = ProviderReplayHarness.layerWithRegistry(
        { name: "pat-http-e2e" },
        ProviderAdapterRegistry.layerFromAdapters([]),
        { runEffectWorker: false },
      );

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

      const layerPrincipalLimits = PrincipalLimitsService.layer.pipe(
        Layer.provide(layerIdentityRepositories),
      );

      const layerEnvAuth = EnvironmentAuth.layer.pipe(
        Layer.provide(ServerSettings.layerTest({ multiUser: true })),
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(layerPrincipalLimits),
        Layer.provide(layerIdentityRepositories),
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
          Layer.provide(ServerSettings.layerTest({ multiUser: true })),
        ),
        ApiTokenService.layer.pipe(
          Layer.provide(layerAccess),
          Layer.provide(layerIdentityRepositories),
        ),
        layerMembership,
        layerAccess,
        layerIdentityRepositories,
      ).pipe(Layer.provideMerge(layerEnvAuth));

      const layerThreadManagement = ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(replayRuntime, CommandReceiptStore.layer, ServerSettings.layerTest({})),
        ),
      );

      const layerProjectEnrichment = Layer.mock(ProjectEnrichmentService)({
        getAvailable: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: true,
          }),
      });

      const layerProjectService = Layer.mock(ProjectService.ProjectService)({
        snapshot: Effect.succeed({
          projects: [],
          updatedAt: "2026-11-26T00:00:00.000Z",
        }),
      });

      const layerStartup = Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
        enqueueCommand: <A, E, R>(effect: Effect.Effect<A, E, R>) => effect,
      });

      const layerCloneTracker = Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({});
      const layerProjectQuota = Layer.mock(ProjectQuotaService.ProjectQuotaService)({
        getWarningsForProjects: () => Effect.succeed(new Map()),
      });

      const baseAppLayer = Layer.mergeAll(
        layerIdentity,
        layerThreadManagement,
        layerProjectEnrichment,
        layerProjectService,
        layerStartup,
        layerCloneTracker,
        layerProjectQuota,
        OrchestrationEventStore.layer,
        ProjectStore.layer,
      ).pipe(
        Layer.provideMerge(replayRuntime),
        Layer.provideMerge(SqlitePersistence.layerMemory),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(ServerEnvironment.layerIdentity),
        Layer.provide(layerConfig),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );

      const services = yield* Layer.build(baseAppLayer);

      // Seed projects, threads, member, and memberships.
      const now = DateTime.toUtc(yield* DateTime.now);
      const nowIso = DateTime.formatIso(now);
      const principals = Context.get(services, Principals.PrincipalRepository);
      const memberships = Context.get(services, Memberships.MembershipRepository);
      const limits = Context.get(services, MemberLimits.MemberLimitsRepository);
      const projectStore = Context.get(services, ProjectStore.ProjectStoreV2);
      const eventSink = Context.get(services, EventSinkV2);
      const envAuth = Context.get(services, EnvironmentAuth.EnvironmentAuth);

      yield* projectStore.apply({
        sequence: 1,
        eventId: EventId.make("evt-project-allowed"),
        aggregateKind: "project",
        aggregateId: PROJECT_ALLOWED,
        occurredAt: nowIso,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId: PROJECT_ALLOWED,
          title: "Allowed Project",
          workspaceRoot: "/tmp/pat-allowed",
          defaultModelSelection: null,
          scripts: [],
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      });
      yield* projectStore.apply({
        sequence: 2,
        eventId: EventId.make("evt-project-foreign"),
        aggregateKind: "project",
        aggregateId: PROJECT_FOREIGN,
        occurredAt: nowIso,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId: PROJECT_FOREIGN,
          title: "Foreign Project",
          workspaceRoot: "/tmp/pat-foreign",
          defaultModelSelection: null,
          scripts: [],
          createdAt: nowIso,
          updatedAt: nowIso,
        },
      });

      yield* eventSink.write({
        events: [
          {
            id: EventId.make("evt-thread-allowed"),
            type: "thread.created",
            threadId: THREAD_ALLOWED,
            occurredAt: now,
            payload: makeAppThread(THREAD_ALLOWED, PROJECT_ALLOWED, "Allowed thread", now),
          },
          {
            id: EventId.make("evt-thread-foreign"),
            type: "thread.created",
            threadId: THREAD_FOREIGN,
            occurredAt: now,
            payload: makeAppThread(THREAD_FOREIGN, PROJECT_FOREIGN, "Foreign thread", now),
          },
        ],
      });

      yield* principals.create({
        id: MEMBER_ID,
        kind: "member",
        displayName: "Member One",
        email: "member1@example.com",
        status: "active",
        ceiling: [...ceilingScopes("staff")],
        createdAt: nowIso,
      });
      yield* memberships.upsert({
        projectId: PROJECT_ALLOWED,
        principalId: MEMBER_ID,
        role: "admin",
        state: "active",
        invitedBy: OWNER_ID,
        expiresAt: null,
        updatedAt: nowIso,
      });
      yield* limits.set({
        principalId: MEMBER_ID,
        maxSessions: null,
        maxTerminals: null,
        invitesPerHour: null,
        maxApiTokens: 2,
      });

      const memberIssued = yield* envAuth.issuePrincipalSession({
        principalId: MEMBER_ID,
        binding: { _tag: "principal" },
        scopes: [
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
          AuthFilesystemReadScope,
          AuthSettingsWriteScope,
          AuthAccessReadScope,
          AuthAccessWriteScope,
        ],
        method: "bearer-access-token",
        client: { deviceType: "desktop" },
      });
      const memberToken = memberIssued.token;

      const ownerIssued = yield* envAuth.issuePrincipalSession({
        principalId: OWNER_ID,
        binding: { _tag: "environment" },
        scopes: [...AuthStandardClientScopes],
        method: "bearer-access-token",
        client: { deviceType: "desktop" },
      });
      const ownerSessionToken = ownerIssued.token;

      const routesLayer = HttpApiBuilder.layer(PatHttpTestApi).pipe(
        Layer.provide(AuthHttp.layer),
        Layer.provide(ProjectHttp.layer),
        Layer.provide(OrchestrationHttp.layer),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
        Layer.provide(Layer.succeedContext(services)),
        Layer.provide(HttpPlatform.layer),
        Layer.provide(Etag.layerWeak),
        Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      );

      const { handler: rawHandler, dispose } = HttpRouter.toWebHandler(routesLayer, {
        disableLogger: true,
      });
      const handler = (request: Request) => rawHandler(request, services);
      yield* Effect.addFinalizer(() => Effect.promise(dispose));

      yield* Effect.promise(async () => {
        // 1. Member creates a project-bound PAT for PROJECT_ALLOWED.
        const createRes = await handler(
          jsonRequest(
            "POST",
            "/api/tokens",
            {
              scopes: [AuthOrchestrationReadScope, AuthSettingsWriteScope, AuthAccessReadScope],
              binding: {
                _tag: "projects",
                projects: [{ projectId: PROJECT_ALLOWED, role: "admin" }],
              },
            },
            { authorization: `Bearer ${memberToken}` },
          ),
        );
        expect(createRes.status).toBe(200);
        expect(createRes.headers.get("cache-control")).toBe("no-store");
        const created = (await createRes.json()) as ApiTokenCreateResult;
        expect(created.token.startsWith("t3p_")).toBe(true);

        // 2. Member creating a PAT for foreign project fails with 403.
        const foreignBindRes = await handler(
          jsonRequest(
            "POST",
            "/api/tokens",
            {
              scopes: [AuthOrchestrationReadScope],
              binding: {
                _tag: "projects",
                projects: [{ projectId: PROJECT_FOREIGN, role: "viewer" }],
              },
            },
            { authorization: `Bearer ${memberToken}` },
          ),
        );
        expect(foreignBindRes.status).toBe(403);

        // 3. Second token succeeds, third hits 429 (maxApiTokens = 2).
        const create2Res = await handler(
          jsonRequest(
            "POST",
            "/api/tokens",
            {
              scopes: [AuthOrchestrationReadScope],
              binding: { _tag: "principal" },
            },
            { authorization: `Bearer ${memberToken}` },
          ),
        );
        expect(create2Res.status).toBe(200);

        const create3Res = await handler(
          jsonRequest(
            "POST",
            "/api/tokens",
            {
              scopes: [AuthOrchestrationReadScope],
              binding: { _tag: "principal" },
            },
            { authorization: `Bearer ${memberToken}` },
          ),
        );
        expect(create3Res.status).toBe(429);

        // 4. Bearer PAT works on orchestration shell read and returns ONLY allowed project/thread.
        const shellRes = await handler(
          new Request("http://127.0.0.1/api/orchestration/shell", {
            headers: orchestrationHeaders(created.token),
          }),
        );
        expect(shellRes.status).toBe(200);
        const shellBody = (await shellRes.json()) as {
          projects: Array<{ id: string }>;
          threads: Array<{ id: string }>;
        };
        expect(shellBody.projects.map((p) => p.id)).toEqual([PROJECT_ALLOWED]);
        expect(shellBody.threads.map((t) => t.id)).toEqual([THREAD_ALLOWED]);

        // 5. Bearer PAT can read allowed thread snapshot, while foreign thread is hidden (404).
        const ownThreadRes = await handler(
          new Request(`http://127.0.0.1/api/orchestration/threads/${THREAD_ALLOWED}`, {
            headers: orchestrationHeaders(created.token),
          }),
        );
        expect(ownThreadRes.status).toBe(200);

        const foreignThreadRes = await handler(
          new Request(`http://127.0.0.1/api/orchestration/threads/${THREAD_FOREIGN}`, {
            headers: orchestrationHeaders(created.token),
          }),
        );
        expect(foreignThreadRes.status).toBe(404);

        // 6. Foreign project returns 403 on project mutation and audit query.
        const foreignMutateRes = await handler(
          jsonRequest(
            "POST",
            "/api/projects/mutate",
            {
              type: "project.update",
              commandId: "cmd-foreign-member",
              projectId: PROJECT_FOREIGN,
              title: "Hijacked",
            },
            { authorization: `Bearer ${created.token}` },
          ),
        );
        expect(foreignMutateRes.status).toBe(403);

        const foreignAuditRes = await handler(
          new Request(`http://127.0.0.1/api/audit?projectId=${PROJECT_FOREIGN}`, {
            headers: { authorization: `Bearer ${created.token}` },
          }),
        );
        expect(foreignAuditRes.status).toBe(403);

        // 7. Owner creates a projects-bound PAT; it is ALSO restricted to PROJECT_ALLOWED (403 on foreign).
        const ownerBoundRes = await handler(
          jsonRequest(
            "POST",
            "/api/tokens",
            {
              scopes: [AuthOrchestrationReadScope, AuthSettingsWriteScope],
              binding: {
                _tag: "projects",
                projects: [{ projectId: PROJECT_ALLOWED, role: "admin" }],
              },
            },
            { authorization: `Bearer ${ownerSessionToken}` },
          ),
        );
        expect(ownerBoundRes.status).toBe(200);
        const ownerBound = (await ownerBoundRes.json()) as ApiTokenCreateResult;

        const ownerBoundForeignRes = await handler(
          jsonRequest(
            "POST",
            "/api/projects/mutate",
            {
              type: "project.update",
              commandId: "cmd-foreign-owner-bound",
              projectId: PROJECT_FOREIGN,
              title: "Owner bound should not touch foreign",
            },
            { authorization: `Bearer ${ownerBound.token}` },
          ),
        );
        expect(ownerBoundForeignRes.status).toBe(403);

        // 8. Owner GET /api/tokens returns all tokens with principalDisplayName; member sees only own.
        const ownerListRes = await handler(
          new Request("http://127.0.0.1/api/tokens", {
            headers: { authorization: `Bearer ${ownerSessionToken}` },
          }),
        );
        expect(ownerListRes.status).toBe(200);
        const ownerTokens = (await ownerListRes.json()) as Array<ApiTokenListItem>;
        expect(ownerTokens.length).toBe(3);
        expect(ownerTokens.some((t) => t.principalDisplayName === "Member One")).toBe(true);
        expect(ownerTokens.some((t) => t.principalId === OWNER_ID)).toBe(true);

        const memberListRes = await handler(
          new Request("http://127.0.0.1/api/tokens", {
            headers: { authorization: `Bearer ${memberToken}` },
          }),
        );
        expect(memberListRes.status).toBe(200);
        const memberTokens = (await memberListRes.json()) as Array<ApiTokenListItem>;
        expect(memberTokens.every((t) => t.principalId === MEMBER_ID)).toBe(true);

        // 9. Member gets 403 trying to revoke owner's token; owner can revoke member's token.
        const memberRevokeOwnerRes = await handler(
          new Request(`http://127.0.0.1/api/tokens/${ownerBound.apiToken.id}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${memberToken}` },
          }),
        );
        expect(memberRevokeOwnerRes.status).toBe(403);

        const ownerRevokeMemberRes = await handler(
          new Request(`http://127.0.0.1/api/tokens/${created.apiToken.id}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${ownerSessionToken}` },
          }),
        );
        expect(ownerRevokeMemberRes.status).toBe(200);
        expect(await ownerRevokeMemberRes.json()).toEqual({ revoked: true });

        // 10. Revoked PAT immediately fails with 401.
        const revokedAuthRes = await handler(
          new Request("http://127.0.0.1/api/orchestration/shell", {
            headers: orchestrationHeaders(created.token),
          }),
        );
        expect(revokedAuthRes.status).toBe(401);
      });
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
