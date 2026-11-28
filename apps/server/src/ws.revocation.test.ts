import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WebSocket } from "@effect/platform-node/NodeWS";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Bind an isolated WebSocket revocation fixture.
import * as NodeHttp from "node:http";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as FeatureFlags from "@t3tools/shared/FeatureFlags";
import * as RelayClient from "@t3tools/shared/relayClient";
import { describe, expect, it } from "@effect/vitest";
import {
  type ApplicationProjectEvent,
  type ApplicationStoredEvent,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthStandardClientScopes,
  CommandId,
  EventId,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationProjectShell,
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  PrincipalId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  VcsProcessSpawnError,
  WS_METHODS,
  WsRpcGroup,
  ceilingScopes,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { HttpRouter, HttpServer } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Stream from "effect/Stream";

import * as ProjectAccess from "./access/ProjectAccess.ts";
import * as ProjectPaths from "./access/ProjectPaths.ts";
import * as PrincipalLimitsService from "./identity/PrincipalLimitsService.ts";
import * as ProjectQuotaService from "./project/ProjectQuotaService.ts";
import * as ResourceResolver from "./access/ResourceResolver.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as AssetSigner from "./assets/AssetSigner.ts";
import * as WorkspacePreviewRevisions from "./assets/WorkspacePreviewRevisions.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as NpmRelease from "./cloud/npmRelease.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServerConfigModule from "./config.ts";
import * as DeviceService from "./device/DeviceService.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as FeedbackStore from "./feedback/FeedbackStore.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as GuestShareService from "./guest/GuestShareService.ts";
import * as MembershipService from "./identity/MembershipService.ts";
import * as IssueService from "./issue/IssueService.ts";
import * as IssueTrackerConnections from "./issue/IssueTrackerConnections.ts";
import * as Keybindings from "./keybindings.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as McpSignIn from "./mcpApps/McpSignIn.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as NativeChildWorkQuery from "./orchestration-v2/NativeChildWorkQuery.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as ThreadIssueService from "./orchestration-v2/ThreadIssueService.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as ThreadViewers from "./orchestration-v2/ThreadViewers.ts";
import * as PeerClientPairing from "./peer/PeerClientPairing.ts";
import * as PeerLinkRequests from "./peer/PeerLinkRequests.ts";
import * as PeerLinks from "./peer/PeerLinks.ts";
import * as PeerThreadRelay from "./peer/PeerThreadRelay.ts";
import * as ApiTokens from "./persistence/ApiTokens.ts";
import * as AuditEvents from "./persistence/AuditEvents.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as Invitations from "./persistence/Invitations.ts";
import * as MemberLimits from "./persistence/MemberLimits.ts";
import * as Memberships from "./persistence/Memberships.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as Principals from "./persistence/Principals.ts";
import * as SessionPrincipals from "./persistence/SessionPrincipals.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ManagedPolicy from "./policy/ManagedPolicy.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as PromptCostService from "./promptCost/PromptCostService.ts";
import * as AcpRegistrySessions from "./provider/AcpRegistrySessions.ts";
import * as AntigravityInstallation from "./provider/AntigravityInstallation.ts";
import * as CodexInstallation from "./provider/CodexInstallation.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ProviderAuthService from "./provider/ProviderAuthService.ts";
import * as ProviderInstallation from "./provider/providerInstallation.ts";
import * as ProviderInstallationGate from "./provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as SecretCheck from "./secrets/SecretCheck.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "./sourceControl/SourceControlSignIn.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import * as TextGenerators from "./textGeneration/TextGenerators.ts";
import * as TriageService from "./triage/TriageService.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as WorkflowRuntime from "./workflows/WorkflowRuntime.ts";
import * as Workflows from "./workflows/Workflows.ts";
import * as TaskFolders from "./workspace/TaskFolders.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspaceFolders from "./workspace/WorkspaceFolders.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as Ws from "./ws.ts";

const NOW_ISO = "2026-11-25T10:00:00.000Z";
const NOW = DateTime.makeUnsafe(NOW_ISO);
const OWNER_ID = PrincipalId.make("owner");
const MEMBER_ID = PrincipalId.make("member-live");
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");
const THREAD_A = ThreadId.make("thread-a");
const THREAD_B = ThreadId.make("thread-b");
const SESSION_ID = AuthSessionId.make("session-live");

function makeProjectShell(id: ProjectId, workspaceRoot: string): OrchestrationProjectShell {
  return {
    id,
    title: `Project ${id}`,
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
  };
}

function makeThreadShell(id: ThreadId, projectId: ProjectId): OrchestrationV2ThreadShell {
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
    lineage: {
      rootThreadId: id,
      parentThreadId: null,
      relationshipToParent: null,
    },
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
  } as unknown as OrchestrationV2ThreadShell;
}

function makeStoredProjectEvent(
  type: ApplicationProjectEvent["type"],
  projectId: ProjectId,
  sequence: number,
): ApplicationProjectEvent {
  return {
    sequence,
    eventId: EventId.make(`proj:${type}:${sequence}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: NOW_ISO,
    commandId: null,
    causationEventId: EventId.make(`cause:${sequence}`),
    correlationId: null,
    metadata: {},
    type,
    payload: { projectId },
  } as unknown as ApplicationProjectEvent;
}

function makeStoredDomainEvent(threadId: ThreadId, sequence: number): OrchestrationV2StoredEvent {
  return {
    sequence,
    commandId: null,
    event: {
      id: EventId.make(`evt:message:${sequence}`),
      threadId,
      occurredAt: NOW,
      type: "message.updated",
      payload: { threadId },
    } as unknown as OrchestrationV2DomainEvent,
  };
}

function makeCoreLayer() {
  const sqlite = Layer.fresh(SqlitePersistence.layerMemory);
  const config = Layer.fresh(
    ServerConfigModule.layerTest(process.cwd(), { prefix: "t3-ws-revocation-test-" }),
  );
  const secrets = ServerSecretStore.layer.pipe(Layer.provide(config));
  const identity = ServerEnvironment.layerIdentity.pipe(Layer.provide(config));
  const sessionStore = SessionStore.layer.pipe(
    Layer.provide(Layer.mergeAll(sqlite, secrets, config, identity)),
  );
  const projectAccess = ProjectAccess.layer.pipe(
    Layer.provide(Layer.mergeAll(Principals.layer, Memberships.layer, ProjectStore.layer)),
  );
  const membershipService = MembershipService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Principals.layer,
        Memberships.layer,
        SessionPrincipals.layer,
        ApiTokens.layer,
        AuditEvents.layer,
        MemberLimits.layer,
        Invitations.layer,
        projectAccess,
        sessionStore,
      ),
    ),
  );
  return Layer.mergeAll(
    Principals.layer,
    Memberships.layer,
    ProjectStore.layer,
    ProjectionStore.layer,
    SessionPrincipals.layer,
    identity,
    projectAccess,
    membershipService,
    sessionStore,
    config,
    secrets,
  ).pipe(
    Layer.provideMerge(sqlite),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
}

const seedPrincipalAndMemberships = Effect.fn(function* (
  roles: ReadonlyArray<{ readonly projectId: ProjectId; readonly role: "developer" | "viewer" }>,
) {
  const principals = yield* Principals.PrincipalRepository;
  const memberships = yield* Memberships.MembershipRepository;
  yield* principals.create({
    id: MEMBER_ID,
    kind: "member",
    displayName: "Live Member",
    email: null,
    status: "active",
    ceiling: [...ceilingScopes("staff")],
    createdAt: NOW_ISO,
  });
  for (const entry of roles) {
    yield* memberships.upsert({
      projectId: entry.projectId,
      principalId: MEMBER_ID,
      role: entry.role,
      state: "active",
      invitedBy: OWNER_ID,
      expiresAt: null,
      updatedAt: NOW_ISO,
    });
  }
});

const makeOwnerActor = (): ProjectAccess.AccessActor => ({
  sessionId: AuthSessionId.make("owner-session"),
  subject: "owner",
  scopes: [...AuthStandardClientScopes],
  principalId: OWNER_ID,
  binding: { _tag: "environment" },
  isOwner: true,
  roles: new Map(),
});

const layerUnusedWsServices = Layer.mergeAll(
  Layer.mock(ProjectPaths.ProjectPaths)({
    assertPath: (_actor, targetPath) =>
      Effect.succeed({ realPath: targetPath, projectId: undefined }),
    assertCwd: (_actor, cwd) => Effect.succeed({ realPath: cwd, projectId: undefined }),
  }),
  Layer.mock(DocumentText.DocumentText)({}),
  Layer.mock(SecretCheck.SecretCheck)({}),
  Layer.mock(WorkspacePaths.WorkspacePaths)({}),
  Layer.mock(TraceDiagnostics.TraceDiagnostics)({}),
  Layer.mock(TriageService.TriageService)({}),
  Layer.mock(TextGenerators.TextGenerators)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({}),
  Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({}),
  Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({}),
  Layer.mock(AcpRegistrySessions.AcpRegistrySessions)({}),
  Layer.mock(AgentSessionImporter.AgentSessionImporter)({}),
  Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
  Layer.mock(AnalyticsService.AnalyticsService)({ recordOwners: () => Effect.void }),
  Layer.mock(AntigravityInstallation.AntigravityInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({}),
  Layer.mock(NativeChildWorkQuery.NativeChildWorkQuery)({}),
  Layer.mock(CommandOutputHub.CommandOutputHub)({}),
  ThreadViewers.layer,
  Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "/unused" }),
  Layer.mock(DeviceService.DeviceService)({}),
  Layer.mock(EnvironmentTheme.EnvironmentThemeService)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
  Layer.mock(HostResources.HostResources)({}),
  Layer.mock(McpAppRequests.McpAppRequests)({}),
  Layer.mock(McpSignIn.McpSignIn)({}),
  Layer.mock(ModelManifest.ModelManifest)({}),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({}),
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(OtlpEndpointCheck.OtlpEndpointCheck)({}),
  Layer.mock(PairingGrantStore.PairingGrantStore)({}),
  Layer.mock(PeerLinks.PeerLinks)({}),
  Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
  Layer.mock(PeerThreadRelay.PeerThreadRelay)({}),
  Layer.mock(PeerClientPairing.PeerClientPairing)({}),
  Layer.mock(PortScanner.PortDiscovery)({ trackAgent: () => () => undefined }),
  Layer.mock(PreviewManager.PreviewManager)({}),
  Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({}),
  Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({}),
  Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
  Layer.mock(ProjectService.ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
  Layer.mock(ProviderAuthService.ProviderAuthService)({}),
  Layer.mock(ProviderInstallation.ProviderInstallation)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(ProviderLatestVersions.ProviderLatestVersions)({}),
  Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({}),
  Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
  Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
  Layer.mock(PullRequestService.PullRequestService)({}),
  Layer.mock(IssueService.IssueService)({}),
  Layer.mock(ThreadIssueService.ThreadIssueService)({}),
  Layer.mock(IssueTrackerConnections.IssueTrackerConnections)({}),
  Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
  Layer.mock(RelayClient.RelayClient)({}),
  Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
  Layer.mock(ResourceTelemetry.ResourceTelemetry)({}),
  Layer.mock(ReviewService.ReviewService)({}),
  Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
  Workflows.layerDisabled,
  Layer.mock(WorkflowRuntime.WorkflowDefinitions)({}),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(FeedbackStore.FeedbackStore)({}),
  Layer.mock(SecretResolver.SecretResolver)({}),
  Layer.mock(GuestShareService.GuestShareService)({}),
  Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
  Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
  Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({}),
  Layer.mock(NpmRelease.NpmRelease)({}),
  Layer.mock(SourceControlDiscovery.SourceControlDiscovery)({}),
  Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({}),
  Layer.mock(SourceControlSignIn.SourceControlSignIn)({}),
  Layer.mock(StorageCleanup.StorageCleanup)({}),
  Layer.mock(DatabaseStorage.DatabaseStorage)({}),
  Layer.mock(TerminalManager.TerminalManager)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(PrincipalLimitsService.PrincipalLimitsService)({
    resolveForPrincipal: () => Effect.succeed(null),
  }),
  Layer.mock(ProjectQuotaService.ProjectQuotaService)({
    getWarningsForProjects: () => Effect.succeed(new Map()),
    assertCanCreateWorktree: () => Effect.void,
    subscribeChanges: PubSub.unbounded<ProjectId>().pipe(Effect.flatMap(PubSub.subscribe)),
  }),
  Layer.mock(ThreadManagement.ThreadManagementService)({}),
  Layer.mock(ThreadSearch.ThreadSearch)({}),
  Layer.mock(UsageService.UsageService)({}),
  Layer.mock(TextGeneration.TextGeneration)({}),
  PromptCostService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(UsageService.UsageService)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        Layer.mock(TextGeneration.TextGeneration)({}),
        Layer.mock(ServerSettings.ServerSettingsService)({}),
      ),
    ),
  ),
  Layer.mock(VcsProvisioningService.VcsProvisioningService)({}),
  Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
  Layer.mock(WorkspaceEntries.WorkspaceEntries)({}),
  Layer.mock(WorkspaceFolders.WorkspaceFolders)({}),
  Layer.mock(TaskFolders.TaskFolders)({}),
  Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({}),
  Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
  Layer.mock(ServerBrowser.ServerBrowser)({
    profileReporter: Effect.succeed(() => Effect.void),
  }),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: process.cwd(),
  }),
  Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
  Layer.mock(ProviderRegistry.ProviderRegistry)({}),
  Layer.mock(UsageLimitSources.UsageLimitSources)({}),
  Layer.mock(ExternalLauncher.ExternalLauncher)({}),
  Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({}),
  Layer.mock(DirectEndpoints.DirectEndpoints)({}),
  Layer.mock(ServerEnvironment.ServerEnvironment)({}),
  Layer.mock(VcsProcess.VcsProcess)({
    run: (input) =>
      Effect.fail(
        new VcsProcessSpawnError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          cause: "unused in revocation test",
        }),
      ),
  }),
  ProviderInstallationGate.layer,
  FetchHttpClient.layer,
  FeatureFlags.layerTest(),
);

describe("Live access revocation", () => {
  it.effect(
    "ProjectAccess.refresh skips membership reads when accessRevision is unchanged and re-resolves after bump",
    () =>
      Effect.gen(function* () {
        let membershipLookups = 0;
        let revision = 1;
        let currentRole: "developer" | "viewer" = "developer";

        const accessLayer = ProjectAccess.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Principals.PrincipalRepository, {
                get: (id) =>
                  Effect.succeedSome({
                    id,
                    kind: "member",
                    displayName: "Member",
                    email: null,
                    status: "active",
                    ceiling: [...ceilingScopes("staff")],
                    accessRevision: revision,
                    createdAt: NOW_ISO,
                    updatedAt: NOW_ISO,
                    removedAt: null,
                  }),
                getAccessStatus: () =>
                  Effect.succeedSome({ status: "active", accessRevision: revision }),
                getByEmail: () => Effect.die("unused"),
                getOwner: Effect.die("unused"),
                countOwners: Effect.die("unused"),
                list: Effect.die("unused"),
                create: () => Effect.die("unused"),
                update: () => Effect.die("unused"),
                bumpAccessRevision: () => Effect.die("unused"),
                getEnvironmentAccessRevision: Effect.succeed(0),
                streamEnvironmentAccessRevision: Stream.empty,
                getCredential: () => Effect.die("unused"),
                setCredential: () => Effect.die("unused"),
                deleteCredential: () => Effect.die("unused"),
              }),
              Layer.succeed(Memberships.MembershipRepository, {
                get: () => Effect.die("unused"),
                listForProject: () => Effect.die("unused"),
                listForPrincipal: (principalId) =>
                  Effect.sync(() => {
                    membershipLookups += 1;
                    return [
                      {
                        projectId: PROJECT_A,
                        principalId,
                        role: currentRole,
                        state: "active" as const,
                        invitedBy: OWNER_ID,
                        expiresAt: null,
                        createdAt: NOW_ISO,
                        updatedAt: NOW_ISO,
                      },
                    ];
                  }),
                upsert: () => Effect.die("unused"),
                setRole: () => Effect.die("unused"),
                setState: () => Effect.die("unused"),
                delete: () => Effect.die("unused"),
              }),
              Layer.succeed(ProjectStore.ProjectStoreV2, {
                apply: () => Effect.die("unused"),
                get: () => Effect.die("unused"),
                list: () => Effect.die("unused"),
                findActiveByWorkspaceRoot: () => Effect.die("unused"),
                getShell: () => Effect.die("unused"),
                listShells: () => Effect.die("unused"),
                setOwnership: () => Effect.die("unused"),
                listOwnedByPrincipal: () => Effect.succeed([]),
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const access = yield* ProjectAccess.ProjectAccess;
          const initial = yield* access.resolve({
            sessionId: SESSION_ID,
            subject: "member",
            scopes: [...AuthStandardClientScopes],
            principalId: MEMBER_ID,
            binding: { _tag: "principal" },
          });
          expect(membershipLookups).toBe(1);
          expect(initial.accessRevision).toBe(1);
          expect(access.can(initial, PROJECT_A, "project:thread.operate")).toBe(true);

          // Same revision: cheap path returns cached actor with zero membership queries.
          const cached = yield* access.refresh(initial);
          expect(cached).toBe(initial);
          expect(membershipLookups).toBe(1);

          // Bumping revision re-resolves memberships and sees the role downgrade.
          currentRole = "viewer";
          revision = 2;
          const refreshed = yield* access.refresh(initial);
          expect(membershipLookups).toBe(2);
          expect(refreshed.accessRevision).toBe(2);
          expect(access.can(refreshed, PROJECT_A, "project:thread.operate")).toBe(false);
          expect(access.can(refreshed, PROJECT_A, "project:read")).toBe(true);
        }).pipe(Effect.provide(accessLayer));
      }),
  );

  it.effect(
    "role and ceiling downgrades drop methods on the next RPC call without closing the socket",
    () =>
      Effect.gen(function* () {
        yield* seedPrincipalAndMemberships([{ projectId: PROJECT_A, role: "developer" }]);
        const access = yield* ProjectAccess.ProjectAccess;
        const membershipService = yield* MembershipService.MembershipService;

        const scopes = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;
        const initialActor = yield* access.resolve({
          sessionId: SESSION_ID,
          subject: "member",
          scopes,
          principalId: MEMBER_ID,
          binding: { _tag: "principal" },
        });
        const actorRef = yield* Ref.make(initialActor);
        const closed: Array<{ readonly code: number; readonly reason: string }> = [];

        const tested = [
          ORCHESTRATION_V2_WS_METHODS.launchThread,
          ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
        ] as const;
        const group = WsRpcGroup.omit(
          ...[...WsRpcGroup.requests.keys()].filter(
            (
              tag,
            ): tag is Exclude<
              keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
              (typeof tested)[number]
            > => !(tested as ReadonlyArray<string>).includes(tag),
          ),
        );
        const handled: Array<string> = [];
        const gate = RpcAuthorization.makeAccessGate({
          actorRef,
          access,
          resolver: {
            capabilityForRpcCall: ResourceResolver.capabilityForRpcCall,
            resourcesForRpcCall: ResourceResolver.resourcesForRpcCall,
            resolveThreadProject: (threadId) =>
              Effect.succeed(threadId === THREAD_A ? PROJECT_A : undefined),
          },
          onRevoked: (code, reason) =>
            Effect.sync(() => {
              closed.push({ code, reason });
            }),
        });

        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(ORCHESTRATION_V2_WS_METHODS.launchThread, ({ projectId }) =>
                Effect.sync(() => {
                  handled.push(`launch:${projectId}`);
                  return {
                    threadId: THREAD_A,
                    resumed: false,
                    sequence: 1,
                    projection: {} as never,
                  };
                }),
              ),
              group.toLayerHandler(
                ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
                ({ threadId }) =>
                  Effect.sync(() => {
                    handled.push(`get:${threadId}`);
                    return {} as never;
                  }),
              ),
              RpcAuthorization.layer(scopes, undefined, gate),
            ),
          ),
        );

        const launchPayload = {
          commandId: CommandId.make("launch-1"),
          projectId: PROJECT_A,
          title: "Launch",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "auto" as const,
          interactionMode: "default" as const,
          workspaceStrategy: { type: "root" as const },
        };

        // Initially developer can launch and read.
        yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread](launchPayload);
        yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: THREAD_A });
        expect(handled).toEqual([`launch:${PROJECT_A}`, `get:${THREAD_A}`]);

        // Role downgrade: developer -> viewer drops launchThread on the very next call.
        yield* membershipService.setRole({
          actor: makeOwnerActor(),
          projectId: PROJECT_A,
          principalId: MEMBER_ID,
          role: "viewer",
        });

        const launchError = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread](
          launchPayload,
        ).pipe(Effect.flip);
        expect(launchError).toMatchObject({
          _tag: "project_forbidden",
          projectId: PROJECT_A,
          requiredPermission: "project:thread.operate",
        });
        // Reads still succeed and the socket stays open.
        yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId: THREAD_A });
        expect(closed).toEqual([]);
        expect((yield* Ref.get(actorRef)).roles.get(PROJECT_A)).toBe("viewer");

        // Ceiling downgrade: drops operate scope at the scope layer too.
        yield* membershipService.setCeiling({
          actor: makeOwnerActor(),
          principalId: MEMBER_ID,
          template: "client",
        });
        const ceilingError = yield* client[ORCHESTRATION_V2_WS_METHODS.launchThread](
          launchPayload,
        ).pipe(Effect.flip);
        expect(ceilingError).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthOrchestrationOperateScope,
        });
        expect(closed).toEqual([]);
      }).pipe(Effect.provide(makeCoreLayer()), Effect.scoped),
  );

  it.live(
    "closes a live WebSocket with 4401 on suspension and 4403 when only project is removed",
    () =>
      Effect.gen(function* () {
        const runScenario = (mode: "suspend-on-call" | "remove-only-project") =>
          Effect.gen(function* () {
            const coreLayer = makeCoreLayer();
            let activeSessionId: AuthSessionId | undefined;
            const wsTestLayer = Layer.mergeAll(
              layerUnusedWsServices,
              Keybindings.layer,
              AssetSigner.layer,
              WorkspacePreviewRevisions.layer,
              ServerSettings.layer.pipe(Layer.provide(ManagedPolicy.layerTest())),
              ResourceResolver.layer,
              Layer.mock(EnvironmentAuth.EnvironmentAuth)({
                authenticateWebSocketUpgrade: () =>
                  Effect.succeed({
                    sessionId: activeSessionId!,
                    subject: `principal:${MEMBER_ID}`,
                    method: "bearer-access-token" as const,
                    scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
                    principalId: MEMBER_ID,
                    binding: { _tag: "principal" as const },
                  }),
              }),
            ).pipe(Layer.provideMerge(coreLayer));

            const built = yield* Layer.build(
              HttpRouter.serve(Ws.layer, { disableListenLog: true }).pipe(
                Layer.provideMerge(
                  NodeHttpServer.layer(NodeHttp.createServer, {
                    host: "127.0.0.1",
                    port: 0,
                  }),
                ),
                Layer.provideMerge(wsTestLayer),
              ),
            );

            const principals = Context.get(built, Principals.PrincipalRepository);
            const memberships = Context.get(built, Memberships.MembershipRepository);
            const membershipService = Context.get(built, MembershipService.MembershipService);
            const sessionStore = Context.get(built, SessionStore.SessionStore);
            const server = Context.get(built, HttpServer.HttpServer);

            yield* principals.create({
              id: MEMBER_ID,
              kind: "member",
              displayName: "Socket Member",
              email: null,
              status: "active",
              ceiling: [...ceilingScopes("staff")],
              createdAt: NOW_ISO,
            });
            yield* memberships.upsert({
              projectId: PROJECT_A,
              principalId: MEMBER_ID,
              role: "developer",
              state: "active",
              invitedBy: OWNER_ID,
              expiresAt: null,
              updatedAt: NOW_ISO,
            });
            const issued = yield* sessionStore.issue({
              method: "bearer-access-token",
              subject: `principal:${MEMBER_ID}`,
              scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
              principalId: MEMBER_ID,
              binding: { _tag: "principal" },
            });
            activeSessionId = (yield* sessionStore.verify(issued.token)).sessionId;

            const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
            const socket = yield* Effect.acquireRelease(
              Effect.sync(
                () =>
                  new WebSocket(
                    `${origin}/ws?${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION}`,
                    { origin: "t3code://app" },
                  ),
              ),
              (ws) => Effect.sync(() => ws.terminate()),
            );

            const closedPromise = new Promise<{ readonly code: number; readonly reason: string }>(
              (resolve) => {
                socket.once("close", (code, reason) => {
                  resolve({ code, reason: reason.toString("utf8") });
                });
              },
            );

            yield* Effect.promise(
              () =>
                new Promise<void>((resolve, reject) => {
                  socket.once("open", resolve);
                  socket.once("error", reject);
                }),
            );

            const sendProbe = (id: string) =>
              Effect.sync(() => {
                socket.send(
                  JSON.stringify({
                    _tag: "Request",
                    id,
                    tag: WS_METHODS.serverProbe,
                    payload: {},
                    headers: [],
                  }),
                );
              });

            // Verify the open socket processes an RPC before revocation.
            const firstMessage = new Promise<string>((resolve) => {
              socket.once("message", (data) => resolve(data.toString()));
            });
            yield* sendProbe("1");
            expect(yield* Effect.promise(() => firstMessage)).toContain('"requestId":"1"');

            if (mode === "suspend-on-call") {
              // Suspend principal in DB while session row stays live so the next RPC refresh closes 4401.
              yield* principals.update({
                id: MEMBER_ID,
                status: "suspended",
                updatedAt: NOW_ISO,
                bumpAccessRevision: true,
              });
              yield* sendProbe("2");
              const closeEvent = yield* Effect.promise(() => closedPromise);
              expect(closeEvent.code).toBe(4401);
            } else {
              yield* membershipService.removeFromProject({
                actor: makeOwnerActor(),
                projectId: PROJECT_A,
                principalId: MEMBER_ID,
              });
              yield* sendProbe("2");
              const closeEvent = yield* Effect.promise(() => closedPromise);
              expect(closeEvent.code).toBe(4403);
            }
          }).pipe(Effect.scoped);

        yield* runScenario("suspend-on-call");
        yield* runScenario("remove-only-project");
      }),
  );

  it.live(
    "closes an idle WebSocket immediately with 4401 when MembershipService.suspendPrincipal revokes its session",
    () =>
      Effect.gen(function* () {
        const coreLayer = makeCoreLayer();
        let authenticatedSessionId: AuthSessionId | undefined;
        const wsTestLayer = Layer.mergeAll(
          layerUnusedWsServices,
          Keybindings.layer,
          AssetSigner.layer,
          WorkspacePreviewRevisions.layer,
          ServerSettings.layer.pipe(Layer.provide(ManagedPolicy.layerTest())),
          ResourceResolver.layer,
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            authenticateWebSocketUpgrade: () =>
              Effect.succeed({
                sessionId: authenticatedSessionId!,
                subject: `principal:${MEMBER_ID}`,
                method: "bearer-access-token" as const,
                scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
                principalId: MEMBER_ID,
                binding: { _tag: "principal" as const },
              }),
          }),
        ).pipe(Layer.provideMerge(coreLayer));

        const built = yield* Layer.build(
          HttpRouter.serve(Ws.layer, { disableListenLog: true }).pipe(
            Layer.provideMerge(
              NodeHttpServer.layer(NodeHttp.createServer, {
                host: "127.0.0.1",
                port: 0,
              }),
            ),
            Layer.provideMerge(wsTestLayer),
          ),
        );

        const principals = Context.get(built, Principals.PrincipalRepository);
        const memberships = Context.get(built, Memberships.MembershipRepository);
        const membershipService = Context.get(built, MembershipService.MembershipService);
        const sessionStore = Context.get(built, SessionStore.SessionStore);
        const server = Context.get(built, HttpServer.HttpServer);

        yield* principals.create({
          id: MEMBER_ID,
          kind: "member",
          displayName: "Idle Socket Member",
          email: null,
          status: "active",
          ceiling: [...ceilingScopes("staff")],
          createdAt: NOW_ISO,
        });
        yield* memberships.upsert({
          projectId: PROJECT_A,
          principalId: MEMBER_ID,
          role: "developer",
          state: "active",
          invitedBy: OWNER_ID,
          expiresAt: null,
          updatedAt: NOW_ISO,
        });
        const issued = yield* sessionStore.issue({
          method: "bearer-access-token",
          subject: `principal:${MEMBER_ID}`,
          scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
          principalId: MEMBER_ID,
          binding: { _tag: "principal" },
        });
        const verified = yield* sessionStore.verify(issued.token);
        authenticatedSessionId = verified.sessionId;

        const origin = HttpServer.formatAddress(server.address).replace(/^http/, "ws");
        const socket = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new WebSocket(
                `${origin}/ws?${ORCHESTRATION_PROTOCOL_QUERY_PARAM}=${ORCHESTRATION_PROTOCOL_VERSION}`,
                { origin: "t3code://app" },
              ),
          ),
          (ws) => Effect.sync(() => ws.terminate()),
        );

        const closedPromise = new Promise<{ readonly code: number; readonly reason: string }>(
          (resolve) => {
            socket.once("close", (code, reason) => {
              resolve({ code, reason: reason.toString("utf8") });
            });
          },
        );
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              socket.once("open", resolve);
              socket.once("error", reject);
            }),
        );

        // Wait for one RPC round-trip so the socket writer & invalidation watcher are active.
        const firstMessage = new Promise<string>((resolve) => {
          socket.once("message", (data) => resolve(data.toString()));
        });
        socket.send(
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag: WS_METHODS.serverProbe,
            payload: {},
            headers: [],
          }),
        );
        expect(yield* Effect.promise(() => firstMessage)).toContain('"requestId":"1"');

        // Suspend via MembershipService without sending another RPC: socket closes 4401 immediately.
        yield* membershipService.suspendPrincipal({
          actor: makeOwnerActor(),
          principalId: MEMBER_ID,
        });
        const closeEvent = yield* Effect.promise(() => closedPromise);
        expect(closeEvent.code).toBe(4401);
      }).pipe(Effect.scoped),
  );

  it.live(
    "subscribeShell stops emitting a removed project while continuing accessible ones, then closes 4403 when the last project is removed",
    () =>
      Effect.gen(function* () {
        yield* seedPrincipalAndMemberships([
          { projectId: PROJECT_A, role: "developer" },
          { projectId: PROJECT_B, role: "developer" },
        ]);
        const access = yield* ProjectAccess.ProjectAccess;
        const membershipService = yield* MembershipService.MembershipService;

        const initialActor = yield* access.resolve({
          sessionId: SESSION_ID,
          subject: "member",
          scopes: [AuthOrchestrationReadScope],
          principalId: MEMBER_ID,
          binding: { _tag: "principal" },
        });
        const actorRef = yield* Ref.make(initialActor);
        const closed: Array<{ readonly code: number; readonly reason: string }> = [];
        const gate = RpcAuthorization.makeAccessGate({
          actorRef,
          access,
          resolver: {
            capabilityForRpcCall: ResourceResolver.capabilityForRpcCall,
            resourcesForRpcCall: ResourceResolver.resourcesForRpcCall,
            resolveThreadProject: () => Effect.undefined,
          },
          onRevoked: (code, reason) =>
            Effect.sync(() => {
              closed.push({ code, reason });
            }),
        });

        const projectA = makeProjectShell(PROJECT_A, "/workspaces/a");
        const projectB = makeProjectShell(PROJECT_B, "/workspaces/b");
        const threadA = makeThreadShell(THREAD_A, PROJECT_A);
        const threadB = makeThreadShell(THREAD_B, PROJECT_B);

        const eventQueue = yield* Queue.unbounded<ApplicationStoredEvent>();
        const enrichmentPubSub = yield* PubSub.unbounded<{
          readonly workspaceRoot: string;
          readonly enrichment: {
            readonly repositoryIdentity: null;
            readonly faviconPath: null;
            readonly repositoryIdentityResolved: boolean;
          };
          readonly repositoryIdentityResolved: boolean;
        }>();

        const shellStream = yield* Ws.subscribeOrchestrationV2Shell({
          requestCompletionMarker: true,
          refreshAllowedProjectIds: gate
            .refreshForStream()
            .pipe(Effect.map(ProjectAccess.accessibleProjectIdsForActor)),
        }).pipe(
          Effect.provideService(OrchestrationEventStore.OrchestrationEventStore, {
            latestApplicationSequence: Effect.succeed(10),
            streamProjectedApplicationEvents: ({
              filter,
              project,
            }: {
              readonly filter: (event: ApplicationStoredEvent) => boolean;
              readonly project: (event: ApplicationStoredEvent) => unknown;
            }) => Stream.fromQueue(eventQueue).pipe(Stream.filter(filter), Stream.map(project)),
          } as unknown as OrchestrationEventStore.OrchestrationEventStore["Service"]),
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            listActiveShellIndex: () => Effect.succeed([]),
            readShellSnapshot: () =>
              Effect.succeed(
                Effect.succeed({
                  schemaVersion: 1,
                  snapshotSequence: 10,
                  threads: [threadA, threadB],
                  archivedThreads: [],
                }),
              ),
            getShellSnapshot: ({ threadIds }: { readonly threadIds: ReadonlyArray<ThreadId> }) =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 20,
                threads: [threadA, threadB].filter((t) => threadIds.includes(t.id)),
                archivedThreads: [],
              }),
            getThreadShell: (threadId: ThreadId) =>
              Effect.succeed(
                threadId === THREAD_A ? threadA : threadId === THREAD_B ? threadB : null,
              ),
          } as unknown as ThreadManagement.ThreadManagementService["Service"]),
          Effect.provideService(ProjectStore.ProjectStoreV2, {
            listShells: () => Effect.succeed([projectA, projectB]),
          } as unknown as ProjectStore.ProjectStoreV2["Service"]),
          Effect.provideService(ProjectService.ProjectService, {
            getShell: (projectId: ProjectId) =>
              Effect.succeed(
                projectId === PROJECT_A
                  ? Option.some(projectA)
                  : projectId === PROJECT_B
                    ? Option.some(projectB)
                    : Option.none(),
              ),
          } as unknown as ProjectService.ProjectService["Service"]),
          Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
            subscribeChanges: PubSub.subscribe(enrichmentPubSub),
            getAvailable: () =>
              Effect.succeed({
                repositoryIdentity: null,
                faviconPath: null,
                repositoryIdentityResolved: false,
              }),
          } as unknown as ProjectEnrichment.ProjectEnrichmentService["Service"]),
          Effect.provideService(ProjectQuotaService.ProjectQuotaService, {
            getWarningsForProjects: () => Effect.succeed(new Map()),
            subscribeChanges: PubSub.unbounded<ProjectId>().pipe(Effect.flatMap(PubSub.subscribe)),
          } as unknown as ProjectQuotaService.ProjectQuotaService["Service"]),
        );

        const received = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
        const streamFailure = yield* Deferred.make<unknown>();
        const consumer = yield* shellStream.pipe(
          Stream.runForEach((item) => Queue.offer(received, item).pipe(Effect.asVoid)),
          Effect.catch((error) => Deferred.succeed(streamFailure, error)),
          Effect.forkScoped,
        );

        // Initial snapshot includes both projects and threads, followed by synchronized marker.
        const initial = yield* Queue.take(received);
        expect(initial.kind).toBe("snapshot");
        if (initial.kind === "snapshot") {
          expect(initial.snapshot.projects.map((p) => p.id)).toEqual([PROJECT_A, PROJECT_B]);
          expect(initial.snapshot.threads.map((t) => t.id)).toEqual([THREAD_A, THREAD_B]);
        }
        expect((yield* Queue.take(received)).kind).toBe("synchronized");

        // Remove PROJECT_A while PROJECT_B stays active.
        yield* membershipService.removeFromProject({
          actor: makeOwnerActor(),
          projectId: PROJECT_A,
          principalId: MEMBER_ID,
        });

        // Emit events for both PROJECT_A (must be dropped) and PROJECT_B (must pass).
        yield* Queue.offer(
          eventQueue,
          makeStoredProjectEvent("project.meta-updated", PROJECT_A, 11),
        );
        yield* Queue.offer(eventQueue, makeStoredDomainEvent(THREAD_A, 12));
        yield* Queue.offer(
          eventQueue,
          makeStoredProjectEvent("project.meta-updated", PROJECT_B, 13),
        );

        const nextItem = yield* Queue.take(received);
        expect(nextItem).toMatchObject({
          kind: "project.updated",
          project: { id: PROJECT_B },
        });
        expect(closed).toEqual([]);

        // Now remove the last remaining project (PROJECT_B): next emission closes 4403 and fails stream.
        yield* membershipService.removeFromProject({
          actor: makeOwnerActor(),
          projectId: PROJECT_B,
          principalId: MEMBER_ID,
        });
        yield* Queue.offer(
          eventQueue,
          makeStoredProjectEvent("project.meta-updated", PROJECT_B, 14),
        );

        const err = yield* Deferred.await(streamFailure);
        expect(err).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
        expect(closed).toEqual([{ code: 4403, reason: "project_access_revoked" }]);
        yield* Fiber.join(consumer);
      }).pipe(Effect.provide(makeCoreLayer()), Effect.scoped),
  );

  it.live(
    "subscribeThread and subscribeCommandOutput close 4403 when their thread's project leaves access and 4401 on suspension",
    () =>
      Effect.gen(function* () {
        yield* seedPrincipalAndMemberships([
          { projectId: PROJECT_A, role: "developer" },
          { projectId: PROJECT_B, role: "developer" },
        ]);
        const access = yield* ProjectAccess.ProjectAccess;
        const membershipService = yield* MembershipService.MembershipService;

        const scopes = [AuthOrchestrationReadScope] as const;
        const threadEvents = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
        const commandFrames = yield* Queue.unbounded<OrchestrationV2CommandOutputFrame>();

        const makeClient = Effect.fn(function* (
          closed: Array<{ readonly code: number; readonly reason: string }>,
        ) {
          const initialActor = yield* access.resolve({
            sessionId: SESSION_ID,
            subject: "member",
            scopes,
            principalId: MEMBER_ID,
            binding: { _tag: "principal" },
          });
          const actorRef = yield* Ref.make(initialActor);
          const gate = RpcAuthorization.makeAccessGate({
            actorRef,
            access,
            resolver: {
              capabilityForRpcCall: ResourceResolver.capabilityForRpcCall,
              resourcesForRpcCall: ResourceResolver.resourcesForRpcCall,
              resolveThreadProject: (threadId) =>
                Effect.succeed(
                  threadId === THREAD_A ? PROJECT_A : threadId === THREAD_B ? PROJECT_B : undefined,
                ),
            },
            onRevoked: (code, reason) =>
              Effect.sync(() => {
                closed.push({ code, reason });
              }),
          });

          const tested = [
            ORCHESTRATION_V2_WS_METHODS.subscribeThread,
            ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
          ] as const;
          const group = WsRpcGroup.omit(
            ...[...WsRpcGroup.requests.keys()].filter(
              (
                tag,
              ): tag is Exclude<
                keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
                (typeof tested)[number]
              > => !(tested as ReadonlyArray<string>).includes(tag),
            ),
          );

          const services = Layer.mergeAll(
            layerUnusedWsServices,
            Keybindings.layer,
            AssetSigner.layer,
            WorkspacePreviewRevisions.layer,
            ServerSettings.layer.pipe(Layer.provide(ManagedPolicy.layerTest())),
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
            Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
              latestAgentSequence: () => Effect.succeed(0),
              prunedThroughSequence: Effect.succeed(0),
              getAgentReplayStats: () =>
                Effect.succeed({ eventCount: 0, rawPayloadBytes: 0, hasCreateEvent: false }),
              readAgentEvents: () => Stream.empty,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              ensureLegacyTranscript: () => Effect.void,
              streamStoredEventsFrom: () => Stream.fromQueue(threadEvents),
            }),
            Layer.mock(CommandOutputHub.CommandOutputHub)({
              subscribe: () => Stream.fromQueue(commandFrames),
            }),
          );

          return yield* RpcTest.makeClient(group).pipe(
            Effect.provide(
              Ws.layerWsRpc(
                {
                  sessionId: SESSION_ID,
                  subject: "member",
                  method: "bearer-access-token",
                  scopes,
                  principalId: MEMBER_ID,
                  binding: { _tag: "principal" },
                },
                {},
                {} as ServerBrowser.ServerBrowser["Service"],
                () => Effect.void,
                { secretReferences: false },
                initialActor,
                gate,
              ).pipe(
                Layer.provide(services),
                Layer.merge(RpcAuthorization.layer(scopes, undefined, gate)),
              ),
            ),
          );
        });

        // 1) subscribeThread on THREAD_A (PROJECT_A) closes 4403 when PROJECT_A is removed even though PROJECT_B remains.
        const threadClosed: Array<{ readonly code: number; readonly reason: string }> = [];
        const threadClient = yield* makeClient(threadClosed);
        const threadItems = yield* Queue.unbounded<unknown>();
        const threadFailure = yield* Deferred.make<unknown>();
        const threadFiber = yield* threadClient[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
          threadId: THREAD_A,
          afterSequence: 0,
        }).pipe(
          Stream.runForEach((item) => Queue.offer(threadItems, item).pipe(Effect.asVoid)),
          Effect.catch((error) => Deferred.succeed(threadFailure, error)),
          Effect.forkScoped,
        );

        yield* Queue.offer(threadEvents, makeStoredDomainEvent(THREAD_A, 1));
        expect(yield* Queue.take(threadItems)).toMatchObject({ kind: "event", sequence: 1 });

        yield* membershipService.removeFromProject({
          actor: makeOwnerActor(),
          projectId: PROJECT_A,
          principalId: MEMBER_ID,
        });
        yield* Queue.offer(threadEvents, makeStoredDomainEvent(THREAD_A, 2));
        expect(yield* Deferred.await(threadFailure)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
        });
        expect(threadClosed).toEqual([{ code: 4403, reason: "resource_access_revoked" }]);
        yield* Fiber.join(threadFiber);

        // 2) subscribeCommandOutput on THREAD_B (PROJECT_B) closes 4401 when principal is suspended.
        const cmdClosed: Array<{ readonly code: number; readonly reason: string }> = [];
        const cmdClient = yield* makeClient(cmdClosed);
        const cmdItems = yield* Queue.unbounded<OrchestrationV2CommandOutputFrame>();
        const cmdFailure = yield* Deferred.make<unknown>();
        const cmdFiber = yield* cmdClient[ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]({
          threadId: THREAD_B,
          itemId: TurnItemId.make("cmd-1"),
        }).pipe(
          Stream.runForEach((item) => Queue.offer(cmdItems, item).pipe(Effect.asVoid)),
          Effect.catch((error) => Deferred.succeed(cmdFailure, error)),
          Effect.forkScoped,
        );

        yield* Queue.offer(commandFrames, {
          kind: "replace",
          text: "hello",
          truncated: false,
          running: true,
        });
        expect(yield* Queue.take(cmdItems)).toMatchObject({ kind: "replace", text: "hello" });

        yield* membershipService.suspendPrincipal({
          actor: makeOwnerActor(),
          principalId: MEMBER_ID,
        });
        yield* Queue.offer(commandFrames, {
          kind: "append",
          text: " world",
          truncated: false,
          running: true,
        });
        expect(yield* Deferred.await(cmdFailure)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
        });
        expect(cmdClosed).toEqual([{ code: 4401, reason: "principal_suspended" }]);
        yield* Fiber.join(cmdFiber);
      }).pipe(Effect.provide(makeCoreLayer()), Effect.scoped),
  );
});
