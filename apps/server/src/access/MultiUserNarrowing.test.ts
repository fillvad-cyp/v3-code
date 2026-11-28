import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EventId,
  IssueTrackerAccountId,
  IssueTrackerKind,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  PrincipalId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskWebhookDeliveryId,
  type ServerSettings,
  SourceControlProviderKind,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as FeatureFlags from "@t3tools/shared/FeatureFlags";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import {
  type IssueTrackerApi,
  type TrackerIssueDetail,
} from "@t3tools/source-control-core/server/IssueTracker";
import {
  type ProviderChangeRequest,
  type PullRequestProviderApi,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { fakePullRequestProvider } from "@t3tools/source-control-testing/fakeSourceControlDriver";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as AssetSigner from "../assets/AssetSigner.ts";
import * as WorkspacePreviewRevisions from "../assets/WorkspacePreviewRevisions.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as NpmRelease from "../cloud/npmRelease.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as ProcessDiagnostics from "../diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "../diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "../diagnostics/TraceDiagnostics.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "../environment/RemoteOpenTargets.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as FeedbackStore from "../feedback/FeedbackStore.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as GuestShareService from "../guest/GuestShareService.ts";
import * as IssueService from "../issue/IssueService.ts";
import * as IssueTrackerConnections from "../issue/IssueTrackerConnections.ts";
import * as IssueTrackerRegistry from "../issue/IssueTrackerRegistry.ts";
import { listLinkedIssueThreads } from "../issue/linkedThreads.ts";
import * as Keybindings from "../keybindings.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as McpSignIn from "../mcpApps/McpSignIn.ts";
import * as MilestoneHub from "../milestones/MilestoneHub.ts";
import * as OtlpEndpointCheck from "../observability/OtlpEndpointCheck.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as OrchestrationHttp from "../orchestration-v2/http.ts";
import * as NativeChildWorkQuery from "../orchestration-v2/NativeChildWorkQuery.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestSyncReactor from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as ThreadIssueService from "../orchestration-v2/ThreadIssueService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ThreadViewers from "../orchestration-v2/ThreadViewers.ts";
import * as PeerClientPairing from "../peer/PeerClientPairing.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerThreadRelay from "../peer/PeerThreadRelay.ts";
import * as DatabaseStorage from "../persistence/DatabaseStorage.ts";
import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as Principals from "../persistence/Principals.ts";
import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectQuotaService from "../project/ProjectQuotaService.ts";
import * as PrincipalLimitsService from "../identity/PrincipalLimitsService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ScratchThreadPromotion from "../project/ScratchThreadPromotion.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as PromptCostService from "../promptCost/PromptCostService.ts";
import * as AcpRegistrySessions from "../provider/AcpRegistrySessions.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderInstallation from "../provider/providerInstallation.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderMaintenanceRunner from "../provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as PullRequestHttp from "../pullRequest/http.ts";
import { listLinkedPullRequestThreads } from "../pullRequest/linkedThreads.ts";
import * as PullRequestProviderRegistry from "../pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestReadCache from "../pullRequest/PullRequestReadCache.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretCheck from "../secrets/SecretCheck.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as SourceControlDiscovery from "../sourceControl/SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "../sourceControl/SourceControlSignIn.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGenerators from "../textGeneration/TextGenerators.ts";
import * as TriageService from "../triage/TriageService.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as VcsProvisioningService from "../vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { workflow, wait } from "../workflows/workflow.ts";
import * as WorkflowAgents from "../workflows/WorkflowAgents.ts";
import * as WorkflowEngine from "../workflows/WorkflowEngine.ts";
import * as WorkflowForge from "../workflows/WorkflowForge.ts";
import * as WorkflowRuntime from "../workflows/WorkflowRuntime.ts";
import * as Workflows from "../workflows/Workflows.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspaceFolders from "../workspace/WorkspaceFolders.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { layerWsRpc } from "../ws.ts";
import * as ProjectAccess from "./ProjectAccess.ts";
import * as ProjectPaths from "./ProjectPaths.ts";

const PROJECT_ALLOWED = ProjectId.make("project-allowed");
const PROJECT_FOREIGN = ProjectId.make("project-foreign");
const THREAD_ALLOWED = ThreadId.make("thread-allowed");
const THREAD_FOREIGN = ThreadId.make("thread-foreign");
const NOW_ISO = "2026-11-25T10:00:00.000Z";
const NOW = DateTime.makeUnsafe(NOW_ISO);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

function makeRepoProject(id: ProjectId, repo: string): OrchestrationProjectShell {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot: `/workspaces/${id}`,
    repositoryIdentity: {
      canonicalKey: normalizeGitRemoteUrl(`https://github.com/${repo}.git`),
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: `https://github.com/${repo}.git`,
      },
      provider: SourceControlProviderKind.make("github"),
      displayName: repo,
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
}

function makeAppThread(id: ThreadId, projectId: ProjectId): OrchestrationV2AppThread {
  return {
    id,
    projectId,
    title: `Thread ${id}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "auto",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: id,
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeChangeRequest(number: number, repo: string): ProviderChangeRequest {
  return {
    number,
    title: `PR ${repo}#${number}`,
    url: `https://github.com/${repo}/pull/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `feat/${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 5,
    deletions: 1,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    reviewRequestLogins: [],
    labels: [{ name: repo, color: "ffffff" }],
  };
}

function makeHostedChangeRequest(number: number, repo: string) {
  return {
    ...makeChangeRequest(number, repo),
    body: `Body for ${repo}#${number}`,
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    reviewers: [],
    checks: [],
    mergeCapabilities: { merge: true, squash: true, rebase: true },
    viewerPermissions: {
      actions: ["merge"] as const,
      comment: true,
      resolve: true,
      verdicts: ["comment", "approve", "request-changes"] as const,
      requestReviewers: true,
    },
  };
}

function makeIssueDetail(key: string, scope: string): TrackerIssueDetail {
  return {
    key,
    displayKey: `#${key}`,
    title: `Issue ${scope}#${key}`,
    url: `https://github.com/${scope}/issues/${key}`,
    author: null,
    state: { category: "open", name: "open" },
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    closedAt: null,
    assignees: [],
    labels: [],
    commentCount: 0,
    body: "",
    viewer: "octocat",
    viewerPermissions: { setState: true, comment: true, edit: true, labels: true, assignees: true },
    states: [],
    comments: [],
    commentsCursor: null,
    events: [],
    linkedPullRequests: [],
  };
}

const seedProject = (
  projects: ProjectStore.ProjectStoreV2["Service"],
  proj: { readonly id: ProjectId; readonly title: string; readonly workspaceRoot: string },
  sequence: number,
) =>
  projects.apply({
    sequence,
    eventId: EventId.make(`proj-create:${proj.id}`),
    aggregateKind: "project",
    aggregateId: proj.id,
    occurredAt: NOW_ISO,
    commandId: null,
    causationEventId: EventId.make(`cause:${proj.id}`),
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: proj.id,
      title: proj.title,
      workspaceRoot: proj.workspaceRoot,
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
  });

const makePullRequestService = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  provider: PullRequestProviderApi,
) =>
  Effect.flatMap(
    Layer.build(
      Layer.mergeAll(
        Layer.mock(ServerSettingsModule.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        Layer.succeed(
          PullRequestProviderRegistry.PullRequestProviderRegistry,
          PullRequestProviderRegistry.fromProviders([provider]),
        ),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
          resolveHandle: () => Effect.die("Unexpected resolveHandle"),
          get: () => Effect.succeed({} as never),
        }),
        Layer.mock(ProjectService.ProjectService)({
          listShells: (options) =>
            Effect.succeed(
              projects.filter((project) => options?.projectIds?.includes(project.id) ?? true),
            ),
          getShell: (projectId) =>
            Effect.succeed(Option.fromNullishOr(projects.find((p) => p.id === projectId))),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
        }),
        SourceControlRateLimit.layer,
        PullRequestFilesViewed.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        Layer.effect(PullRequestReadCache.PullRequestReadCache, PullRequestReadCache.make).pipe(
          Layer.provide(KeyValueStore.layerMemory),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
    (context) => Effect.provideContext(PullRequestService.make, context),
  );

describe("Multi-user cross-project narrowing", () => {
  it.effect(
    "narrows PullRequestService list/detail/routing, linked PR threads, and HTTP /api/pull-requests/diff",
    () =>
      Effect.gen(function* () {
        const ownProject = makeRepoProject(PROJECT_ALLOWED, "acme/own");
        const foreignProject = makeRepoProject(PROJECT_FOREIGN, "acme/foreign");
        const provider = fakePullRequestProvider(SourceControlProviderKind.make("github"), {
          listChangeRequests: (input) =>
            Effect.succeed({
              items: [makeChangeRequest(input.repository === "acme/own" ? 1 : 2, input.repository)],
              nextCursor: null,
              truncated: false,
              continues: false,
            }),
          getChangeRequest: (input) =>
            Effect.succeed(makeHostedChangeRequest(input.number, input.repository)),
          getDiff: (input) =>
            Effect.succeed({
              patch: `diff --git a/${input.repository}.ts b/${input.repository}.ts\n`,
              truncated: false,
              nextCursor: null,
            }),
        });

        const service = yield* makePullRequestService([ownProject, foreignProject], provider);
        const memberAllowed = new Set<string>([PROJECT_ALLOWED]);

        // List omits foreign project for non-owners; owner sees both.
        const memberList = yield* service
          .list({ state: "open" })
          .pipe(PullRequestService.withAllowedProjectIds(memberAllowed));
        expect(memberList.entries.map((entry) => entry.repository)).toEqual(["acme/own"]);

        const ownerList = yield* service.list({ state: "open" });
        expect(ownerList.entries.map((entry) => entry.repository).toSorted()).toEqual([
          "acme/foreign",
          "acme/own",
        ]);

        // Detail with accessible project + own repository succeeds.
        const ownDetail = yield* service
          .detail({ projectId: PROJECT_ALLOWED, repository: "acme/own", number: 1 })
          .pipe(PullRequestService.withAllowedProjectIds(memberAllowed));
        expect(ownDetail.repository).toBe("acme/own");

        // Detail with accessible project + foreign or unknown repository fails for non-owners (unknown mapping => owner only).
        const spoofedRepoErr = yield* service
          .detail({ projectId: PROJECT_ALLOWED, repository: "acme/foreign", number: 2 })
          .pipe(PullRequestService.withAllowedProjectIds(memberAllowed), Effect.flip);
        expect(spoofedRepoErr._tag).toBe("PullRequestOperationError");

        const unknownRepoErr = yield* service
          .detail({ projectId: PROJECT_ALLOWED, repository: "other/unknown", number: 99 })
          .pipe(PullRequestService.withAllowedProjectIds(memberAllowed), Effect.flip);
        expect(unknownRepoErr._tag).toBe("PullRequestOperationError");

        // Linked PR threads SQL pushdown omits foreign project threads.
        const sql = yield* SqlClient.SqlClient;
        const prLink = {
          host: "github.com",
          repository: "acme/own",
          number: 1,
          url: "https://github.com/acme/own/pull/1",
          source: "manual",
        };
        const prPayload = yield* encodeJson({ pullRequests: [prLink] });
        for (const [threadId, projectId] of [
          [THREAD_ALLOWED, PROJECT_ALLOWED],
          [THREAD_FOREIGN, PROJECT_FOREIGN],
        ] as const) {
          yield* sql`
            INSERT INTO orchestration_v2_projection_threads (
              thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
              created_at, updated_at, payload_json
            ) VALUES (
              ${threadId}, ${projectId}, ${threadId}, 'codex', 'auto', 'default',
              ${NOW_ISO}, ${NOW_ISO}, ${prPayload}
            )
          `;
        }
        const narrowedLinked = yield* listLinkedPullRequestThreads(
          { host: "github.com", repository: "acme/own", number: 1 },
          { projectIds: [PROJECT_ALLOWED] },
        );
        expect(narrowedLinked.threads.map((t) => t.id)).toEqual([THREAD_ALLOWED]);
        const allLinked = yield* listLinkedPullRequestThreads({
          host: "github.com",
          repository: "acme/own",
          number: 1,
        });
        expect(allLinked.threads.map((t) => t.id).toSorted()).toEqual(
          [THREAD_ALLOWED, THREAD_FOREIGN].toSorted(),
        );

        // HTTP POST /api/pull-requests/diff enforces ProjectAccess & AllowedProjectIds.
        const principals = yield* Principals.PrincipalRepository;
        const memberships = yield* Memberships.MembershipRepository;
        const memberPrincipalId = PrincipalId.make("principal-pr-member");
        yield* principals.create({
          id: memberPrincipalId,
          kind: "member",
          displayName: "PR Member",
          email: "pr-member@example.com",
          status: "active",
          ceiling: [AuthOrchestrationReadScope],
          createdAt: NOW_ISO,
        });
        yield* memberships.upsert({
          principalId: memberPrincipalId,
          projectId: PROJECT_ALLOWED,
          role: "viewer",
          state: "active",
          invitedBy: null,
          expiresAt: null,
          updatedAt: NOW_ISO,
        });

        class PrTestApi extends HttpApi.make("environment").add(
          EnvironmentHttpApi.groups.pullRequests,
        ) {}
        const prHttpLayer = HttpApiBuilder.layer(PrTestApi).pipe(
          Layer.provide(PullRequestHttp.layer),
          Layer.provide(Layer.succeed(PullRequestService.PullRequestService, service)),
          Layer.provide(
            ProjectAccess.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Principals.layer,
                  Memberships.layer,
                  Layer.mock(ProjectStore.ProjectStoreV2)({
                    listShells: () => Effect.succeed([ownProject, foreignProject]),
                    listOwnedByPrincipal: () => Effect.succeed([]),
                  }),
                ),
              ),
              Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
            ),
          ),
          Layer.provide(
            Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
              effect.pipe(
                Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                  sessionId: AuthSessionId.make("pr-http-member"),
                  subject: "member",
                  method: "browser-session-cookie",
                  scopes: new Set<AuthEnvironmentScope>([AuthOrchestrationReadScope]),
                  principalId: memberPrincipalId,
                  binding: { _tag: "principal" },
                }),
              ),
            ),
          ),
          Layer.provide(HttpPlatform.layer),
          Layer.provide(Etag.layerWeak),
          Layer.provide(NodeServices.layer),
        );

        const httpResults = yield* Effect.acquireUseRelease(
          Effect.sync(() => HttpRouter.toWebHandler(prHttpLayer, { disableLogger: true })),
          ({ handler }) =>
            Effect.promise(async () => {
              const okRes = await handler(
                new Request("http://environment.test/api/pull-requests/diff", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    projectId: PROJECT_ALLOWED,
                    repository: "acme/own",
                    number: 1,
                  }),
                }),
              );
              const foreignProjectRes = await handler(
                new Request("http://environment.test/api/pull-requests/diff", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    projectId: PROJECT_FOREIGN,
                    repository: "acme/foreign",
                    number: 2,
                  }),
                }),
              );
              const foreignRepoRes = await handler(
                new Request("http://environment.test/api/pull-requests/diff", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    projectId: PROJECT_ALLOWED,
                    repository: "acme/foreign",
                    number: 2,
                  }),
                }),
              );
              return {
                okStatus: okRes.status,
                foreignProjectStatus: foreignProjectRes.status,
                foreignRepoStatus: foreignRepoRes.status,
              };
            }),
          ({ dispose }) => Effect.promise(() => dispose()),
        );
        expect(httpResults.okStatus).toBe(200);
        expect(httpResults.foreignProjectStatus).toBe(403);
        expect(httpResults.foreignRepoStatus).toBeGreaterThanOrEqual(400);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(Principals.layer, Memberships.layer).pipe(
            Layer.provideMerge(SqlitePersistence.layerMemory),
          ),
        ),
        Effect.scoped,
      ),
  );

  it.effect(
    "narrows IssueService list/detail and linked issue threads to accessible projects",
    () =>
      Effect.gen(function* () {
        const ownProject = makeRepoProject(PROJECT_ALLOWED, "acme/own");
        const foreignProject = makeRepoProject(PROJECT_FOREIGN, "acme/foreign");
        const githubKind = IssueTrackerKind.make("github");
        const tracker: IssueTrackerApi = {
          kind: githubKind,
          capabilities: {
            create: true,
            edit: true,
            comment: true,
            labels: true,
            assignees: true,
            reactions: false,
            templates: false,
            linkedPullRequests: true,
            events: true,
            search: true,
          },
          getViewer: () => Effect.succeed("octocat"),
          listIssues: (input) =>
            Effect.succeed({
              items: [makeIssueDetail(input.scope === "acme/own" ? "10" : "20", input.scope)],
              nextCursor: null,
            }),
          getIssue: (input) => Effect.succeed(makeIssueDetail(input.key, input.scope)),
          getComments: () => Effect.succeed({ comments: [], nextCursor: null }),
          comment: () => Effect.void,
          update: () => Effect.void,
          setState: () => Effect.void,
        };

        const service = yield* IssueService.IssueService.pipe(
          Effect.provide(
            IssueService.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(IssueTrackerBindings.IssueTrackerBindingsRepository)({
                    list: () => Effect.succeed(new Map()),
                  }),
                  Layer.succeed(
                    IssueTrackerRegistry.IssueTrackerRegistry,
                    IssueTrackerRegistry.fromTrackers([tracker]),
                  ),
                  Layer.mock(ProjectService.ProjectService)({
                    listShells: (options) =>
                      Effect.succeed(
                        [ownProject, foreignProject].filter(
                          (p) => options?.projectIds?.includes(p.id) ?? true,
                        ),
                      ),
                    getShell: (projectId) =>
                      Effect.succeed(
                        Option.fromNullishOr(
                          [ownProject, foreignProject].find((p) => p.id === projectId),
                        ),
                      ),
                  }),
                  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
                    resolve: () => Effect.succeed(null),
                  }),
                ),
              ),
            ),
          ),
        );

        const memberAllowed = new Set<string>([PROJECT_ALLOWED]);
        const memberList = yield* service
          .list({ state: "open" })
          .pipe(IssueService.withAllowedProjectIds(memberAllowed));
        expect(memberList.entries.map((entry) => entry.scope)).toEqual(["acme/own"]);

        const ownerList = yield* service.list({ state: "open" });
        expect(ownerList.entries.map((entry) => entry.scope).toSorted()).toEqual([
          "acme/foreign",
          "acme/own",
        ]);

        // Own project + own scope succeeds.
        const ownDetail = yield* service
          .detail({
            projectId: PROJECT_ALLOWED,
            tracker: githubKind,
            scope: "acme/own",
            key: "10",
          })
          .pipe(IssueService.withAllowedProjectIds(memberAllowed));
        expect(ownDetail.key).toBe("10");

        // Accessible project + foreign scope is rejected for non-owners.
        const foreignScopeErr = yield* service
          .detail({
            projectId: PROJECT_ALLOWED,
            tracker: githubKind,
            scope: "acme/foreign",
            key: "20",
          })
          .pipe(IssueService.withAllowedProjectIds(memberAllowed), Effect.flip);
        expect(foreignScopeErr._tag).toBe("IssueUnavailableError");

        // Linked issue threads SQL pushdown omits foreign project threads.
        const sql = yield* SqlClient.SqlClient;
        const issueRef = { tracker: "github", host: "github.com", scope: "acme/own", key: "10" };
        const issuePayload = yield* encodeJson({ issues: [issueRef] });
        for (const [threadId, projectId] of [
          [THREAD_ALLOWED, PROJECT_ALLOWED],
          [THREAD_FOREIGN, PROJECT_FOREIGN],
        ] as const) {
          yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            created_at, updated_at, payload_json
          ) VALUES (
            ${threadId}, ${projectId}, ${threadId}, 'codex', 'auto', 'default',
            ${NOW_ISO}, ${NOW_ISO}, ${issuePayload}
          )
        `;
        }
        const narrowedLinked = yield* listLinkedIssueThreads(
          { tracker: githubKind, host: "github.com", scope: "acme/own", key: "10" },
          { projectIds: [PROJECT_ALLOWED] },
        );
        expect(narrowedLinked.threads.map((t) => t.id)).toEqual([THREAD_ALLOWED]);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory), Effect.scoped),
  );

  it.effect(
    "narrows Workflows list/counts/watch/get/cancel so foreign and unmapped runs are hidden from non-owners",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const holdWorkflow = workflow(
          "hold",
          {
            version: 1,
            payload: Schema.Struct({
              label: Schema.String,
              projectId: Schema.optional(Schema.String),
            }),
          },
          () => wait("go", { returns: Schema.String }),
        );
        const workflowLayer = WorkflowEngine.layer([holdWorkflow]).pipe(
          Layer.provide(
            Layer.mergeAll(
              MilestoneHub.layer,
              Layer.mock(WorkflowAgents.WorkflowAgents)({}),
              Layer.mock(WorkflowForge.WorkflowForge)({
                issues: {} as never,
                pullRequests: {} as never,
              }),
            ),
          ),
          Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        );

        yield* Effect.gen(function* () {
          const engine = yield* Workflows.Workflows;
          const { runId: ownRunId } = yield* engine.start(
            "hold",
            { label: "own", projectId: PROJECT_ALLOWED },
            { idempotencyKey: "own-run" },
          );
          const { runId: foreignRunId } = yield* engine.start(
            "hold",
            { label: "foreign", projectId: PROJECT_FOREIGN },
            { idempotencyKey: "foreign-run" },
          );
          const { runId: unmappedRunId } = yield* engine.start(
            "hold",
            { label: "unmapped" },
            { idempotencyKey: "unmapped-run" },
          );

          const memberAllowed = new Set<string>([PROJECT_ALLOWED]);

          // Owner sees all three runs.
          const ownerRuns = yield* engine.list();
          expect(ownerRuns.map((r) => r.runId).toSorted()).toEqual(
            [ownRunId, foreignRunId, unmappedRunId].toSorted(),
          );

          // Non-owner sees only ownRunId (foreign and unmapped are absent).
          const memberRuns = yield* engine
            .list()
            .pipe(Workflows.withAllowedProjectIds(memberAllowed));
          expect(memberRuns.map((r) => r.runId)).toEqual([ownRunId]);

          const memberCounts = yield* engine.counts.pipe(
            Workflows.withResolveAllowedProjectIds(Effect.succeed(memberAllowed)),
            Stream.runHead,
          );
          expect(Option.getOrThrow(memberCounts).total).toBe(1);

          const memberWatch = yield* engine.watch.pipe(
            Workflows.withResolveAllowedProjectIds(Effect.succeed(memberAllowed)),
            Stream.runHead,
          );
          expect(Option.getOrThrow(memberWatch).runs.map((r) => r.runId)).toEqual([ownRunId]);

          // Direct get & cancel on own run succeed; on foreign and unmapped fail as not found.
          const ownDetail = yield* engine
            .get(ownRunId)
            .pipe(Workflows.withAllowedProjectIds(memberAllowed));
          expect(ownDetail.run.runId).toBe(ownRunId);

          for (const hiddenId of [foreignRunId, unmappedRunId]) {
            const getErr = yield* engine
              .get(hiddenId)
              .pipe(Workflows.withAllowedProjectIds(memberAllowed), Effect.flip);
            expect(getErr._tag).toBe("WorkflowRunNotFoundError");

            const cancelErr = yield* engine
              .cancel(hiddenId, "denied")
              .pipe(Workflows.withAllowedProjectIds(memberAllowed), Effect.flip);
            expect(cancelErr._tag).toBe("WorkflowRunNotFoundError");
          }
        }).pipe(Effect.provide(workflowLayer));
      }).pipe(Effect.provide(SqlitePersistence.layerMemory), Effect.scoped),
  );

  it.effect(
    "pushes projectIds into ProjectionStore queries and returns 404 on HTTP thread endpoints for foreign threads",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const principals = yield* Principals.PrincipalRepository;
        const memberships = yield* Memberships.MembershipRepository;

        yield* seedProject(
          projects,
          { id: PROJECT_ALLOWED, title: "Allowed", workspaceRoot: "/workspaces/allowed" },
          1,
        );
        yield* seedProject(
          projects,
          { id: PROJECT_FOREIGN, title: "Foreign", workspaceRoot: "/workspaces/foreign" },
          2,
        );

        for (const [threadId, projectId] of [
          [THREAD_ALLOWED, PROJECT_ALLOWED],
          [THREAD_FOREIGN, PROJECT_FOREIGN],
        ] as const) {
          yield* sink.write({
            events: [
              {
                id: EventId.make(`create:${threadId}`),
                type: "thread.created",
                threadId,
                occurredAt: NOW,
                payload: makeAppThread(threadId, projectId),
              },
            ],
          });
        }

        // Store-level SQL pushdown.
        const activeIndex = yield* projections.listActiveShellIndex({
          projectIds: [PROJECT_ALLOWED],
        });
        expect(activeIndex.map((row) => row.id)).toEqual([THREAD_ALLOWED]);

        const shellRows = yield* projections.getShellSnapshot({
          location: "active",
          projectIds: [PROJECT_ALLOWED],
        });
        expect(shellRows.threads.map((row) => row.id)).toEqual([THREAD_ALLOWED]);

        const linkMeta = yield* projections.getThreadLinkMetadata(
          [THREAD_ALLOWED, THREAD_FOREIGN],
          { projectIds: [PROJECT_ALLOWED] },
        );
        expect(Object.keys(linkMeta)).toEqual([THREAD_ALLOWED]);

        const titles = yield* projections.getThreadTitles([THREAD_ALLOWED, THREAD_FOREIGN], {
          projectIds: [PROJECT_ALLOWED],
        });
        expect(Object.keys(titles)).toEqual([THREAD_ALLOWED]);

        // HTTP orchestration endpoints reject foreign thread with 404 and narrow /shell.
        const memberPrincipalId = PrincipalId.make("principal-orch-member");
        yield* principals.create({
          id: memberPrincipalId,
          kind: "member",
          displayName: "Orch Member",
          email: "orch@example.com",
          status: "active",
          ceiling: [AuthOrchestrationReadScope],
          createdAt: NOW_ISO,
        });
        yield* memberships.upsert({
          principalId: memberPrincipalId,
          projectId: PROJECT_ALLOWED,
          role: "viewer",
          state: "active",
          invitedBy: null,
          expiresAt: null,
          updatedAt: NOW_ISO,
        });

        const threadManagementLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
          listActiveShellIndex: (options) =>
            projections.listActiveShellIndex(options).pipe(Effect.orDie),
          readShellSnapshot: (options) =>
            Effect.succeed(projections.getShellSnapshot(options).pipe(Effect.orDie)),
          getThreadSnapshot: (threadId) =>
            projections.getThreadSnapshot(threadId).pipe(Effect.orDie),
          getThreadShell: (threadId) => projections.getThreadShell(threadId).pipe(Effect.orDie),
        });
        class OrchTestApi extends HttpApi.make("environment").add(
          EnvironmentHttpApi.groups.orchestration,
        ) {}
        const orchHttpLayer = HttpApiBuilder.layer(OrchTestApi).pipe(
          Layer.provide(OrchestrationHttp.layer),
          Layer.provide(threadManagementLayer),
          Layer.provide(Layer.succeed(ProjectStore.ProjectStoreV2, projects)),
          Layer.provide(
            OrchestrationEventStore.layer.pipe(
              Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
            ),
          ),
          Layer.provide(
            Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({
              getAvailable: () =>
                Effect.succeed({
                  repositoryIdentity: null,
                  faviconPath: null,
                  hasGit: false,
                  branch: null,
                } as never),
            }),
          ),
          Layer.provide(
            Layer.mock(ProjectQuotaService.ProjectQuotaService)({
              getWarningsForProjects: () => Effect.succeed(new Map()),
            }),
          ),
          Layer.provide(
            ServerEnvironment.layerIdentity.pipe(
              Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-orch-http-" })),
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provide(
            ProjectAccess.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Principals.layer,
                  Memberships.layer,
                  Layer.succeed(ProjectStore.ProjectStoreV2, projects),
                ),
              ),
              Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
            ),
          ),
          Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
          Layer.provide(
            Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
              effect.pipe(
                Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                  sessionId: AuthSessionId.make("orch-http-member"),
                  subject: "member",
                  method: "browser-session-cookie",
                  scopes: new Set<AuthEnvironmentScope>([AuthOrchestrationReadScope]),
                  principalId: memberPrincipalId,
                  binding: { _tag: "principal" },
                }),
              ),
            ),
          ),
          Layer.provide(HttpPlatform.layer),
          Layer.provide(Etag.layerWeak),
          Layer.provide(NodeCrypto.layer),
          Layer.provide(NodeServices.layer),
        );

        const protocolHeaders = {
          [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
        };
        const httpResults = yield* Effect.acquireUseRelease(
          Effect.sync(() => HttpRouter.toWebHandler(orchHttpLayer, { disableLogger: true })),
          ({ handler }) =>
            Effect.promise(async () => {
              const shellRes = await handler(
                new Request("http://environment.test/api/orchestration/shell", {
                  headers: protocolHeaders,
                }),
              );
              const shellJson = (await shellRes.json()) as {
                readonly projects: ReadonlyArray<{ readonly id: string }>;
                readonly threads: ReadonlyArray<{ readonly id: string }>;
              };
              const ownThreadRes = await handler(
                new Request(`http://environment.test/api/orchestration/threads/${THREAD_ALLOWED}`, {
                  headers: protocolHeaders,
                }),
              );
              const foreignThreadRes = await handler(
                new Request(`http://environment.test/api/orchestration/threads/${THREAD_FOREIGN}`, {
                  headers: protocolHeaders,
                }),
              );
              return {
                shellStatus: shellRes.status,
                shellProjectIds: shellJson.projects.map((p) => p.id),
                shellThreadIds: shellJson.threads.map((t) => t.id),
                ownThreadStatus: ownThreadRes.status,
                foreignThreadStatus: foreignThreadRes.status,
              };
            }),
          ({ dispose }) => Effect.promise(() => dispose()),
        );
        expect(httpResults.shellStatus).toBe(200);
        expect(httpResults.shellProjectIds).toEqual([PROJECT_ALLOWED]);
        expect(httpResults.shellThreadIds).toEqual([THREAD_ALLOWED]);
        expect(httpResults.ownThreadStatus).toBe(200);
        expect(httpResults.foreignThreadStatus).toBe(404);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            EventSink.layer.pipe(
              Layer.provide(
                Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer),
              ),
            ),
            ProjectionStore.layer,
            ProjectStore.layer,
            Principals.layer,
            Memberships.layer,
          ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
        ),
        Effect.scoped,
      ),
  );

  it.effect(
    "enforces WS RPC narrowing for settings redaction/updates, issueTrackersList, and scheduledTasks webhook logs",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projects = yield* ProjectStore.ProjectStoreV2;
        yield* seedProject(
          projects,
          { id: PROJECT_ALLOWED, title: "Allowed", workspaceRoot: "/workspaces/allowed" },
          1,
        );
        yield* seedProject(
          projects,
          { id: PROJECT_FOREIGN, title: "Foreign", workspaceRoot: "/workspaces/foreign" },
          2,
        );

        const testedMethods = [
          WS_METHODS.serverGetSettings,
          WS_METHODS.serverUpdateSettings,
          WS_METHODS.issueTrackersList,
          WS_METHODS.scheduledTasksSubscribe,
          WS_METHODS.scheduledTasksListWebhookDeliveries,
          WS_METHODS.scheduledTasksGetWebhookDelivery,
          WS_METHODS.scheduledTasksSetEnabled,
          WS_METHODS.scheduledTasksDelete,
          WS_METHODS.scheduledTasksRunNow,
          WS_METHODS.scheduledTasksRotateWebhookToken,
        ] as const;
        const group = WsRpcGroup.omit(
          ...[...WsRpcGroup.requests.keys()].filter(
            (
              tag,
            ): tag is Exclude<
              keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
              (typeof testedMethods)[number]
            > => !(testedMethods as ReadonlyArray<string>).includes(tag),
          ),
        );

        const scopes = [
          AuthOrchestrationReadScope,
          AuthOrchestrationOperateScope,
          AuthSettingsWriteScope,
          AuthFilesystemReadScope,
        ];
        const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-ws-narrowing-",
        }).pipe(Layer.provide(NodeServices.layer));
        const secretsLayer = ServerSecretStore.layer.pipe(
          Layer.provide(serverConfigLayer),
          Layer.provide(NodeServices.layer),
        );
        const settingsLayer = ServerSettingsModule.layer.pipe(
          Layer.provide(secretsLayer),
          Layer.provide(ManagedPolicy.layerTest()),
          Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
          Layer.provide(serverConfigLayer),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        );
        const settingsService = yield* ServerSettingsModule.ServerSettingsService.pipe(
          Effect.provide(settingsLayer),
        );
        const codexId = ProviderInstanceId.make("codex");
        yield* settingsService.updateSettings({
          worktreesDirectory: "/srv/host/worktrees",
          enablePreviewTunnel: true,
          providerInstances: {
            [codexId]: {
              driver: ProviderDriverKind.make("codex"),
              displayName: "Codex Host",
              enabled: true,
              config: {
                binaryPath: "/usr/local/bin/codex",
                homePath: "/home/owner/.codex",
              },
            },
          },
          projectSettingsOverrides: {
            [PROJECT_ALLOWED]: { defaultAutoPull: true },
            [PROJECT_FOREIGN]: { defaultAutoPull: false },
          },
        });

        const scheduledTaskService = yield* ScheduledTasks.ScheduledTaskService.pipe(
          Effect.provide(
            ScheduledTasks.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(SqlClient.SqlClient, sql),
                  NodeCrypto.layer,
                  NodeCrypto.layerDigest,
                  NodeCrypto.layerMac,
                  Scheduler.layer,
                  Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                    launch: () =>
                      Effect.succeed({ threadId: THREAD_ALLOWED, resumed: false } as never),
                  }),
                  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                    namedProjectsRoot: "/projects",
                    isScratchProject: () => Effect.succeed(false),
                  }),
                  Layer.mock(ThreadManagement.ThreadManagementService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.succeed(
                    ScheduledTasks.ScheduledTaskWebhookOrigin,
                    Effect.succeed({ relayHookBaseUrl: "https://hooks.t3.test" }),
                  ),
                  ManagedPolicy.layerTest(),
                ),
              ),
            ),
          ),
        );
        const ownTask = (yield* scheduledTaskService.upsert({
          title: "Own webhook",
          projectId: PROJECT_ALLOWED,
          prompt: "Run own",
          schedule: { type: "webhook" },
          enabled: true,
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: codexId, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        })).task;
        const foreignTask = (yield* scheduledTaskService.upsert({
          title: "Foreign webhook",
          projectId: PROJECT_FOREIGN,
          prompt: "Run foreign",
          schedule: { type: "webhook" },
          enabled: true,
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: codexId, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        })).task;
        const deliveryId = ScheduledTaskWebhookDeliveryId.make("del-own-1");
        yield* sql`
          INSERT INTO scheduled_task_webhook_deliveries (
            delivery_id, task_id, received_at, method, query, headers_json,
            body, body_bytes, body_truncated, outcome, signature_verified, missing_fields_json
          ) VALUES (
            ${deliveryId}, ${ownTask.id}, ${NOW_ISO}, 'POST', '', '{}',
            '{}', 2, 0, 'accepted', 1, '[]'
          )
        `;

        const accessLayer = ProjectAccess.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Principals.layer,
              Memberships.layer,
              Layer.succeed(ProjectStore.ProjectStoreV2, projects),
            ),
          ),
          Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
        );
        const projectPathsLayer = ProjectPaths.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              accessLayer,
              Layer.succeed(ProjectStore.ProjectStoreV2, projects),
              serverConfigLayer,
              Layer.succeed(SqlClient.SqlClient, sql),
              NodeServices.layer,
            ),
          ),
        );

        const deps = Layer.mergeAll(
          Layer.succeed(SqlClient.SqlClient, sql),
          Layer.succeed(ProjectStore.ProjectStoreV2, projects),
          Layer.succeed(ServerSettingsModule.ServerSettingsService, settingsService),
          Layer.succeed(ScheduledTasks.ScheduledTaskService, scheduledTaskService),
          projectPathsLayer,
          serverConfigLayer,
          Layer.mock(IssueTrackerConnections.IssueTrackerConnections)({
            list: Effect.succeed({
              trackers: [],
              accounts: [],
              bindings: {
                [PROJECT_ALLOWED]: {
                  tracker: IssueTrackerKind.make("linear"),
                  accountId: IssueTrackerAccountId.make("acc-1"),
                  scope: "OWN",
                },
                [PROJECT_FOREIGN]: {
                  tracker: IssueTrackerKind.make("linear"),
                  accountId: IssueTrackerAccountId.make("acc-1"),
                  scope: "FOREIGN",
                },
              },
            }),
          }),
          Layer.mock(ThreadSearch.ThreadSearch)({}),
          Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
          Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
          Layer.mock(AnalyticsService.AnalyticsService)({}),
          Layer.mock(CommandOutputHub.CommandOutputHub)({}),
          ThreadViewers.layer,
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
          Layer.mock(McpAppRequests.McpAppRequests)({}),
          Layer.mock(McpSignIn.McpSignIn)({}),
          Layer.mock(Workflows.Workflows)({}),
          Layer.mock(WorkflowRuntime.WorkflowDefinitions)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(FeedbackStore.FeedbackStore)({}),
          Layer.mock(GuestShareService.GuestShareService)({}),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(IssueService.IssueService)({}),
          Layer.mock(ThreadIssueService.ThreadIssueService)({}),
          Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
          Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
          Layer.mock(DeviceService.DeviceService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({}),
          Layer.mock(UsageService.UsageService)({}),
          Layer.mock(PromptCostService.PromptCostService)({}),
          Layer.mock(UsageLimitSources.UsageLimitSources)({}),
          Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
          Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
          Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
          Layer.mock(PrincipalLimitsService.PrincipalLimitsService)({
            resolveForPrincipal: () => Effect.succeed(null),
          }),
          Layer.mock(ProjectQuotaService.ProjectQuotaService)({
            getWarningsForProjects: () => Effect.succeed(new Map()),
            assertCanCreateWorktree: () => Effect.void,
            subscribeChanges: PubSub.unbounded<ProjectId>().pipe(Effect.flatMap(PubSub.subscribe)),
          }),
          Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
          Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
          Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
          Layer.mock(NativeChildWorkQuery.NativeChildWorkQuery)({}),
          Layer.mock(Keybindings.Keybindings)({}),
          FeatureFlags.layerTest(),
          Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
          Layer.mock(ExternalLauncher.ExternalLauncher)({}),
          Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
          Layer.mock(DirectEndpoints.DirectEndpoints)({}),
          Layer.mock(GitWorkflowService.GitWorkflowService)({}),
          Layer.mock(ReviewService.ReviewService)({}),
          Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
          Layer.mock(TerminalManager.TerminalManager)({}),
          Layer.mock(PreviewManager.PreviewManager)({}),
          Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => undefined }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({}),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
          Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
          Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
          Layer.mock(AcpRegistrySessions.AcpRegistrySessions)({}),
          Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
          Layer.mock(ProviderAuthService.ProviderAuthService)({}),
          Layer.mock(ProviderInstallation.ProviderInstallation)({}),
          Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
          Layer.mock(NpmRelease.NpmRelease)({}),
          Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
          Layer.mock(StorageCleanup.StorageCleanup)({}),
          Layer.mock(DatabaseStorage.DatabaseStorage)({}),
          Layer.mock(SecretResolver.SecretResolver)({}),
          Layer.mock(PeerLinks.PeerLinks)({}),
          Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
          Layer.mock(PeerThreadRelay.PeerThreadRelay)({}),
          Layer.mock(PeerClientPairing.PeerClientPairing)({}),
          Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
          Layer.mock(WorkspaceFolders.WorkspaceFolders)({}),
          Layer.mock(TaskFolders.TaskFolders)({}),
          Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
          Layer.mock(ServerEnvironment.ServerEnvironment)({}),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
          Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
          Layer.mock(SecretCheck.SecretCheck)({}),
          Layer.mock(OtlpEndpointCheck.OtlpEndpointCheck)({}),
          Layer.mock(TextGenerators.TextGenerators)({}),
          Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
          Layer.mock(SourceControlSignIn.SourceControlSignIn)({}),
          Layer.mock(PairingGrantStore.PairingGrantStore)({}),
          Layer.mock(SessionStore.SessionStore)({
            cookieName: "narrow-test",
            legacyCookieName: undefined,
          }),
          Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
          Layer.mock(TriageService.TriageService)({}),
          Layer.mock(HostResources.HostResources)({}),
          Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
          Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
          Layer.mock(RelayClient.RelayClient)({}),
          Layer.mock(DocumentText.DocumentText)({}),
          Layer.mock(ServerBrowser.ServerBrowser)({}),
          Layer.mock(AssetSigner.AssetSigner)({}),
          Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
          Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
          Layer.mock(WorkspacePaths.WorkspacePaths)({}),
          Layer.mock(WorkspacePreviewRevisions.WorkspacePreviewRevisions)({}),
          NodeCrypto.layer,
        ).pipe(Layer.provideMerge(NodeServices.layer));

        const adminActor: ProjectAccess.AccessActor = {
          sessionId: AuthSessionId.make("ws-admin"),
          subject: "admin",
          scopes,
          principalId: PrincipalId.make("principal-ws-admin"),
          binding: { _tag: "principal" },
          isOwner: false,
          roles: new Map([[PROJECT_ALLOWED, "admin"]]),
        };
        const devActor: ProjectAccess.AccessActor = {
          sessionId: AuthSessionId.make("ws-dev"),
          subject: "dev",
          scopes,
          principalId: PrincipalId.make("principal-ws-dev"),
          binding: { _tag: "principal" },
          isOwner: false,
          roles: new Map([[PROJECT_ALLOWED, "developer"]]),
        };

        const makeClient = (actor?: ProjectAccess.AccessActor) =>
          RpcTest.makeClient(group).pipe(
            Effect.provide(
              layerWsRpc(
                {
                  sessionId: actor?.sessionId ?? AuthSessionId.make("ws-owner"),
                  subject: actor?.subject ?? "owner",
                  method: "browser-session-cookie",
                  scopes,
                  ...(actor?.principalId === undefined ? {} : { principalId: actor.principalId }),
                  ...(actor?.binding === undefined ? {} : { binding: actor.binding }),
                },
                {},
                {} as ServerBrowser.ServerBrowser["Service"],
                () => Effect.void,
                { secretReferences: false },
                actor,
              ).pipe(Layer.provide(deps), Layer.merge(RpcAuthorization.layer(scopes))),
            ),
          );

        const adminClient = yield* makeClient(adminActor);
        const devClient = yield* makeClient(devActor);
        const ownerClient = yield* makeClient();

        // 1. Settings view & update narrowing.
        const memberSettings: ServerSettings = yield* adminClient[WS_METHODS.serverGetSettings]({});
        expect(memberSettings.worktreesDirectory).toBe("");
        expect(memberSettings.enablePreviewTunnel).toBe(false);
        expect(Object.keys(memberSettings.projectSettingsOverrides)).toEqual([PROJECT_ALLOWED]);
        expect(JSON.stringify(memberSettings.providerInstances[codexId])).not.toContain(
          "/usr/local/bin",
        );

        const ownerSettings: ServerSettings = yield* ownerClient[WS_METHODS.serverGetSettings]({});
        expect(ownerSettings.worktreesDirectory).toBe("/srv/host/worktrees");
        expect(Object.keys(ownerSettings.projectSettingsOverrides).toSorted()).toEqual(
          [PROJECT_ALLOWED, PROJECT_FOREIGN].toSorted(),
        );

        const ownPatchResult = yield* adminClient[WS_METHODS.serverUpdateSettings]({
          patch: { projectSettingsOverrides: { [PROJECT_ALLOWED]: { defaultAutoPull: false } } },
        });
        expect(ownPatchResult.projectSettingsOverrides[PROJECT_ALLOWED]).toMatchObject({
          defaultAutoPull: false,
        });
        expect(Object.keys(ownPatchResult.projectSettingsOverrides)).toEqual([PROJECT_ALLOWED]);

        const foreignPatchErr = yield* adminClient[WS_METHODS.serverUpdateSettings]({
          patch: { projectSettingsOverrides: { [PROJECT_FOREIGN]: { defaultAutoPull: true } } },
        }).pipe(Effect.flip);
        expect(foreignPatchErr).toMatchObject({
          _tag: "project_forbidden",
          projectId: PROJECT_FOREIGN,
          requiredPermission: "project:settings",
        });

        // 2. issueTrackersList omits foreign project bindings.
        const memberTrackers = yield* adminClient[WS_METHODS.issueTrackersList]({});
        expect(Object.keys(memberTrackers.bindings)).toEqual([PROJECT_ALLOWED]);

        // 3. scheduledTasksSubscribe omits foreign project tasks and hides webhook URL from non-admins.
        const adminSub = Option.getOrThrow(
          yield* adminClient[WS_METHODS.scheduledTasksSubscribe]({}).pipe(Stream.runHead),
        );
        expect(adminSub.tasks.map((t) => t.id)).toEqual([ownTask.id]);
        expect(adminSub.tasks[0]?.webhook?.url).toBeDefined();

        const devSub = Option.getOrThrow(
          yield* devClient[WS_METHODS.scheduledTasksSubscribe]({}).pipe(Stream.runHead),
        );
        expect(devSub.tasks.map((t) => t.id)).toEqual([ownTask.id]);
        expect(devSub.tasks[0]?.webhook).toBeUndefined();

        // 4. Webhook delivery logs require admin (project:webhooks) on own project; foreign task returns not found.
        const adminLogs = yield* adminClient[WS_METHODS.scheduledTasksListWebhookDeliveries]({
          id: ownTask.id,
        });
        expect(adminLogs.deliveries.map((d) => d.id)).toEqual([deliveryId]);

        const adminDetail = yield* adminClient[WS_METHODS.scheduledTasksGetWebhookDelivery]({
          id: ownTask.id,
          deliveryId,
        });
        expect(adminDetail.delivery.id).toBe(deliveryId);

        const devLogsErr = yield* devClient[WS_METHODS.scheduledTasksListWebhookDeliveries]({
          id: ownTask.id,
        }).pipe(Effect.flip);
        expect(devLogsErr).toMatchObject({
          _tag: "project_forbidden",
          projectId: PROJECT_ALLOWED,
          requiredPermission: "project:webhooks",
        });

        const foreignLogsErr = yield* adminClient[WS_METHODS.scheduledTasksListWebhookDeliveries]({
          id: foreignTask.id,
        }).pipe(Effect.flip);
        expect(foreignLogsErr._tag).toBe("ScheduledTaskError");

        const foreignToggleErr = yield* adminClient[WS_METHODS.scheduledTasksSetEnabled]({
          id: foreignTask.id,
          enabled: false,
        }).pipe(Effect.flip);
        expect(foreignToggleErr._tag).toBe("ScheduledTaskError");

        const foreignDeleteErr = yield* adminClient[WS_METHODS.scheduledTasksDelete]({
          id: foreignTask.id,
        }).pipe(Effect.flip);
        expect(foreignDeleteErr._tag).toBe("ScheduledTaskError");

        // Owner still sees both tasks (foreign task was not deleted).
        const ownerTasks = yield* scheduledTaskService.list();
        expect(ownerTasks.tasks.map((t) => t.id).toSorted()).toEqual(
          [ownTask.id, foreignTask.id].toSorted(),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ProjectStore.layer,
            Principals.layer,
            Memberships.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
        ),
        Effect.scoped,
      ),
  );
});
