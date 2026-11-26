import { describe, expect, it } from "@effect/vitest";
import {
  type ApplicationProjectEvent,
  type ApplicationStoredEvent,
  type AuthEnvironmentScope,
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthTerminalOperateScope,
  CrmClientId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EventId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadShell,
  PrincipalId,
  type Project,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ProjectAccess from "./access/ProjectAccess.ts";
import * as ProjectPaths from "./access/ProjectPaths.ts";
import * as ResourceResolver from "./access/ResourceResolver.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as EventSink from "./orchestration-v2/EventSink.ts";
import * as EventStore from "./orchestration-v2/EventStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import {
  domainEventProjectId,
  filterShellSnapshot,
  filterShellStreamItem,
  shouldPublishShellApplicationEventForProjects,
} from "./orchestration-v2/ShellStream.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as CrmRepo from "./persistence/Crm.ts";
import * as Memberships from "./persistence/Memberships.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as Principals from "./persistence/Principals.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ProjectHttp from "./project/http.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import * as ProjectQuotaService from "./project/ProjectQuotaService.ts";
import * as ProjectSecrets from "./project/ProjectSecrets.ts";
import * as PrincipalLimitsService from "./identity/PrincipalLimitsService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import { layerWsRpc, subscribeOrchestrationV2Shell } from "./ws.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as AssetSigner from "./assets/AssetSigner.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as DeviceService from "./device/DeviceService.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as FeedbackStore from "./feedback/FeedbackStore.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as GuestShareService from "./guest/GuestShareService.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as IssueService from "./issue/IssueService.ts";
import * as IssueTrackerConnections from "./issue/IssueTrackerConnections.ts";
import * as Keybindings from "./keybindings.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as McpAppRequests from "./mcpApps/McpAppRequests.ts";
import * as McpSignIn from "./mcpApps/McpSignIn.ts";
import * as NativeChildWorkQuery from "./orchestration-v2/NativeChildWorkQuery.ts";
import * as NpmRelease from "./cloud/npmRelease.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as OtlpEndpointCheck from "./observability/OtlpEndpointCheck.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as PeerClientPairing from "./peer/PeerClientPairing.ts";
import * as PeerLinkRequests from "./peer/PeerLinkRequests.ts";
import * as PeerLinks from "./peer/PeerLinks.ts";
import * as PeerThreadRelay from "./peer/PeerThreadRelay.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ProviderAuthService from "./provider/ProviderAuthService.ts";
import * as ProviderInstallation from "./provider/providerInstallation.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as ScheduledTasks from "./scheduledTasks/ScheduledTaskService.ts";
import * as ScratchThreadPromotion from "./project/ScratchThreadPromotion.ts";
import * as SecretCheck from "./secrets/SecretCheck.ts";
import * as SecretRequests from "./secrets/SecretRequests.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as SourceControlSignIn from "./sourceControl/SourceControlSignIn.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as TaskFolders from "./workspace/TaskFolders.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as TextGenerators from "./textGeneration/TextGenerators.ts";
import * as ThreadIssueService from "./orchestration-v2/ThreadIssueService.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadViewers from "./orchestration-v2/ThreadViewers.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as WorkspacePreviewRevisions from "./assets/WorkspacePreviewRevisions.ts";
import * as TriageService from "./triage/TriageService.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as WorkflowRuntime from "./workflows/WorkflowRuntime.ts";
import * as Workflows from "./workflows/Workflows.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspaceFolders from "./workspace/WorkspaceFolders.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as AgentSessionImporter from "./project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import * as AcpRegistrySessions from "./provider/AcpRegistrySessions.ts";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as FeatureFlags from "@t3tools/shared/FeatureFlags";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";

const PROJECT_ALLOWED = ProjectId.make("project-allowed");
const PROJECT_FOREIGN = ProjectId.make("project-foreign");
const THREAD_ALLOWED = ThreadId.make("thread-allowed");
const THREAD_FOREIGN = ThreadId.make("thread-foreign");
const NOW_ISO = "2026-11-25T10:00:00.000Z";
const NOW = DateTime.makeUnsafe(NOW_ISO);

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

// Compile-time exhaustive table: adding a new OrchestrationV2DomainEvent variant without adding a
// case here fails typechecking.
const ALL_DOMAIN_EVENT_TYPES = {
  "thread.created": "direct",
  "thread.archived": "direct",
  "thread.unarchived": "direct",
  "thread.deleted": "direct",
  "thread.settled": "direct",
  "thread.unsettled": "direct",
  "thread.snoozed": "direct",
  "thread.unsnoozed": "direct",
  "thread.pinned": "direct",
  "thread.auto-settle-set": "direct",
  "thread.unpinned": "direct",
  "thread.pin-reordered": "direct",
  "thread.active-reordered": "direct",
  "thread.tags-updated": "direct",
  "thread.visited": "direct",
  "thread.marked-unread": "direct",
  "thread.metadata-updated": "direct",
  "thread.pull-request-synced": "direct",
  "thread.issue-synced": "direct",
  "thread.runtime-mode-updated": "direct",
  "thread.interaction-mode-updated": "direct",
  "thread.model-selection-updated": "direct",
  "thread.provider-switched": "direct",
  "thread.guest-share-updated": "direct",
  "thread.pull-request-link-updated": "thread",
  "thread.visit-recorded": "thread",
  "run.created": "thread",
  "run.updated": "thread",
  "run.background-work-cancelled": "thread",
  "run.output-submitted": "thread",
  "run-attempt.created": "thread",
  "run-attempt.updated": "thread",
  "node.updated": "thread",
  "subagent.updated": "thread",
  "provider-session.attached": "thread",
  "provider-session.updated": "thread",
  "provider-session.detached": "thread",
  "provider-thread.updated": "thread",
  "provider-turn.updated": "thread",
  "runtime-request.updated": "thread",
  "message.updated": "thread",
  "turn-item.updated": "thread",
  "plan.updated": "thread",
  "checkpoint-scope.created": "thread",
  "checkpoint.captured": "thread",
  "checkpoint.rollback-requested": "thread",
  "context-handoff.updated": "thread",
  "context-transfer.created": "thread",
  "context-transfer.updated": "thread",
} as const satisfies Record<OrchestrationV2DomainEvent["type"], "direct" | "thread">;

const ALL_PROJECT_EVENT_TYPES = {
  "project.created": true,
  "project.meta-updated": true,
  "project.deleted": true,
} as const satisfies Record<ApplicationProjectEvent["type"], true>;

function makeStoredDomainEvent(
  type: OrchestrationV2DomainEvent["type"],
  threadId: ThreadId,
  projectId: ProjectId,
  sequence: number,
): OrchestrationV2StoredEvent {
  const mode = ALL_DOMAIN_EVENT_TYPES[type];
  return {
    sequence,
    commandId: null,
    event: {
      id: EventId.make(`evt:${type}:${sequence}`),
      threadId,
      occurredAt: NOW,
      type,
      payload: mode === "direct" ? makeAppThread(threadId, projectId) : { threadId },
    } as unknown as OrchestrationV2DomainEvent,
  };
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

describe("Shell stream project isolation", () => {
  const allowed = new Set<string>([PROJECT_ALLOWED]);
  const knownThreadProjects = new Map<string, string>([
    [THREAD_ALLOWED, PROJECT_ALLOWED],
    [THREAD_FOREIGN, PROJECT_FOREIGN],
  ]);

  it("enumerates every OrchestrationV2DomainEvent variant and drops foreign project payloads", () => {
    const eventTypes = Object.keys(ALL_DOMAIN_EVENT_TYPES) as Array<
      OrchestrationV2DomainEvent["type"]
    >;
    expect(eventTypes.length).toBeGreaterThanOrEqual(45);

    for (const [index, type] of eventTypes.entries()) {
      const foreignEvent = makeStoredDomainEvent(type, THREAD_FOREIGN, PROJECT_FOREIGN, index + 1);
      const allowedEvent = makeStoredDomainEvent(type, THREAD_ALLOWED, PROJECT_ALLOWED, index + 1);

      if (ALL_DOMAIN_EVENT_TYPES[type] === "direct") {
        expect(domainEventProjectId(foreignEvent.event)).toBe(PROJECT_FOREIGN);
        expect(domainEventProjectId(allowedEvent.event)).toBe(PROJECT_ALLOWED);
        // Even without a thread->project map, direct payload events drop foreign projects.
        expect(shouldPublishShellApplicationEventForProjects(foreignEvent, allowed)).toBe(false);
        expect(shouldPublishShellApplicationEventForProjects(allowedEvent, allowed)).toBe(true);
      } else {
        expect(domainEventProjectId(foreignEvent.event)).toBeUndefined();
        expect(
          shouldPublishShellApplicationEventForProjects(foreignEvent, allowed, knownThreadProjects),
        ).toBe(false);
        expect(
          shouldPublishShellApplicationEventForProjects(allowedEvent, allowed, knownThreadProjects),
        ).toBe(true);
        // Unknown thread fails closed by default.
        expect(shouldPublishShellApplicationEventForProjects(foreignEvent, allowed)).toBe(false);
      }

      // Unfiltered actors (owner / environment binding) receive all variants.
      expect(shouldPublishShellApplicationEventForProjects(foreignEvent, undefined)).toBe(true);
    }
  });

  it("enumerates every ApplicationProjectEvent variant and drops foreign projects", () => {
    const projectEventTypes = Object.keys(ALL_PROJECT_EVENT_TYPES) as Array<
      ApplicationProjectEvent["type"]
    >;
    for (const [index, type] of projectEventTypes.entries()) {
      const foreign = makeStoredProjectEvent(type, PROJECT_FOREIGN, index + 1);
      const own = makeStoredProjectEvent(type, PROJECT_ALLOWED, index + 1);
      expect(shouldPublishShellApplicationEventForProjects(foreign, allowed)).toBe(false);
      expect(shouldPublishShellApplicationEventForProjects(own, allowed)).toBe(true);
      expect(shouldPublishShellApplicationEventForProjects(foreign, undefined)).toBe(true);
    }
  });

  it("filters every OrchestrationV2ShellStreamItem variant without leaking foreign projects", () => {
    const allowedProject = makeProjectShell(PROJECT_ALLOWED, "/workspaces/allowed");
    const foreignProject = makeProjectShell(PROJECT_FOREIGN, "/workspaces/foreign");
    const allowedThread = makeThreadShell(THREAD_ALLOWED, PROJECT_ALLOWED);
    const foreignThread = makeThreadShell(THREAD_FOREIGN, PROJECT_FOREIGN);
    const snapshot: OrchestrationV2ShellSnapshot = {
      schemaVersion: 1,
      snapshotSequence: 10,
      projects: [allowedProject, foreignProject],
      threads: [allowedThread, foreignThread],
      archivedThreads: [
        { ...allowedThread, archivedAt: NOW },
        { ...foreignThread, archivedAt: NOW },
      ],
      olderSettled: {
        before: NOW_ISO,
        asOfSequence: 10,
        counts: [
          { projectId: PROJECT_ALLOWED, count: 2 },
          { projectId: PROJECT_FOREIGN, count: 9 },
        ],
      },
    };
    const accessibleThreads = new Set<string>([THREAD_ALLOWED]);

    const filteredSnapshot = filterShellSnapshot(snapshot, allowed);
    expect(filteredSnapshot.projects.map((p) => p.id)).toEqual([PROJECT_ALLOWED]);
    expect(filteredSnapshot.threads.map((t) => t.id)).toEqual([THREAD_ALLOWED]);
    expect(filteredSnapshot.archivedThreads.map((t) => t.id)).toEqual([THREAD_ALLOWED]);
    expect(filteredSnapshot.olderSettled?.counts).toEqual([
      { projectId: PROJECT_ALLOWED, count: 2 },
    ]);

    const items = {
      synchronized: { kind: "synchronized" },
      "snapshot-required": { kind: "snapshot-required" },
      snapshot: {
        kind: "snapshot",
        snapshot,
        resolvedRepositoryIdentityRoots: [
          allowedProject.workspaceRoot,
          foreignProject.workspaceRoot,
        ],
      },
      "project.updated": { kind: "project.updated", sequence: 11, project: foreignProject },
      "project.removed": { kind: "project.removed", sequence: 12, projectId: PROJECT_FOREIGN },
      "thread.updated": {
        kind: "thread.updated",
        sequence: 13,
        location: "active",
        thread: foreignThread,
      },
      "thread.removed": {
        kind: "thread.removed",
        sequence: 14,
        location: "active",
        threadId: THREAD_FOREIGN,
      },
    } satisfies Record<OrchestrationV2ShellStreamItem["kind"], OrchestrationV2ShellStreamItem>;

    expect(filterShellStreamItem(items.synchronized, allowed, accessibleThreads)).toEqual(
      items.synchronized,
    );
    expect(filterShellStreamItem(items["snapshot-required"], allowed, accessibleThreads)).toEqual(
      items["snapshot-required"],
    );
    const filteredSnapshotItem = filterShellStreamItem(items.snapshot, allowed, accessibleThreads);
    expect(filteredSnapshotItem).toMatchObject({
      kind: "snapshot",
      resolvedRepositoryIdentityRoots: [allowedProject.workspaceRoot],
    });
    // Foreign-only enrichment snapshot is dropped completely.
    expect(
      filterShellStreamItem(
        {
          kind: "snapshot",
          snapshot: {
            schemaVersion: 1,
            snapshotSequence: 10,
            projects: [foreignProject],
            threads: [],
            archivedThreads: [],
          },
          resolvedRepositoryIdentityRoots: [foreignProject.workspaceRoot],
        },
        allowed,
        accessibleThreads,
      ),
    ).toBeNull();
    expect(filterShellStreamItem(items["project.updated"], allowed, accessibleThreads)).toBeNull();
    expect(filterShellStreamItem(items["project.removed"], allowed, accessibleThreads)).toBeNull();
    expect(filterShellStreamItem(items["thread.updated"], allowed, accessibleThreads)).toBeNull();
    expect(filterShellStreamItem(items["thread.removed"], allowed, accessibleThreads)).toBeNull();

    // Accessible items pass through.
    expect(
      filterShellStreamItem(
        { kind: "project.updated", sequence: 15, project: allowedProject },
        allowed,
        accessibleThreads,
      ),
    ).not.toBeNull();
    expect(
      filterShellStreamItem(
        { kind: "thread.updated", sequence: 16, location: "active", thread: allowedThread },
        allowed,
        accessibleThreads,
      ),
    ).not.toBeNull();
    expect(
      filterShellStreamItem(
        { kind: "thread.removed", sequence: 17, location: "active", threadId: THREAD_ALLOWED },
        allowed,
        accessibleThreads,
      ),
    ).not.toBeNull();
  });

  it.live(
    "subscribeOrchestrationV2Shell drops foreign initial rows, live events, and enrichments",
    () =>
      Effect.gen(function* () {
        const allowedProject = makeProjectShell(PROJECT_ALLOWED, "/workspaces/allowed");
        const foreignProject = makeProjectShell(PROJECT_FOREIGN, "/workspaces/foreign");
        const allowedThread = makeThreadShell(THREAD_ALLOWED, PROJECT_ALLOWED);
        const foreignThread = makeThreadShell(THREAD_FOREIGN, PROJECT_FOREIGN);
        const enrichmentPubSub = yield* PubSub.unbounded<{
          readonly workspaceRoot: string;
          readonly enrichment: {
            readonly repositoryIdentity: null;
            readonly faviconPath: null;
            readonly repositoryIdentityResolved: boolean;
          };
          readonly repositoryIdentityResolved: boolean;
        }>();
        const liveEvents: ReadonlyArray<ApplicationStoredEvent> = [
          makeStoredProjectEvent("project.meta-updated", PROJECT_FOREIGN, 11),
          makeStoredDomainEvent("thread.created", THREAD_FOREIGN, PROJECT_FOREIGN, 12),
          makeStoredDomainEvent("message.updated", THREAD_FOREIGN, PROJECT_FOREIGN, 13),
          makeStoredDomainEvent("thread.deleted", THREAD_FOREIGN, PROJECT_FOREIGN, 14),
          makeStoredProjectEvent("project.deleted", PROJECT_FOREIGN, 15),
          makeStoredProjectEvent("project.meta-updated", PROJECT_ALLOWED, 16),
          makeStoredDomainEvent("message.updated", THREAD_ALLOWED, PROJECT_ALLOWED, 17),
        ];

        const stream = yield* subscribeOrchestrationV2Shell({
          requestCompletionMarker: true,
          allowedProjectIds: allowed,
        }).pipe(
          Effect.provideService(OrchestrationEventStore.OrchestrationEventStore, {
            latestApplicationSequence: Effect.succeed(10),
            streamProjectedApplicationEvents: ({
              filter,
              project,
            }: {
              readonly filter: (event: ApplicationStoredEvent) => boolean;
              readonly project: (event: ApplicationStoredEvent) => unknown;
            }) => Stream.fromIterable(liveEvents).pipe(Stream.filter(filter), Stream.map(project)),
          } as unknown as OrchestrationEventStore.OrchestrationEventStore["Service"]),
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            listActiveShellIndex: () => Effect.succeed([]),
            readShellSnapshot: () =>
              Effect.succeed(
                Effect.succeed({
                  schemaVersion: 1,
                  snapshotSequence: 10,
                  threads: [allowedThread, foreignThread],
                  archivedThreads: [],
                }),
              ),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 17,
                threads: [allowedThread],
                archivedThreads: [],
              }),
            getThreadShell: (threadId: ThreadId) =>
              Effect.succeed(
                threadId === THREAD_ALLOWED
                  ? allowedThread
                  : threadId === THREAD_FOREIGN
                    ? foreignThread
                    : null,
              ),
          } as unknown as ThreadManagement.ThreadManagementService["Service"]),
          Effect.provideService(ProjectStore.ProjectStoreV2, {
            listShells: () => Effect.succeed([allowedProject, foreignProject]),
          } as unknown as ProjectStore.ProjectStoreV2["Service"]),
          Effect.provideService(ProjectService.ProjectService, {
            getShell: (projectId: ProjectId) =>
              Effect.succeed(
                projectId === PROJECT_ALLOWED
                  ? Option.some(allowedProject)
                  : projectId === PROJECT_FOREIGN
                    ? Option.some(foreignProject)
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

        const items = yield* stream.pipe(
          Stream.takeUntil(
            (item) => item.kind === "thread.updated" && item.thread.id === THREAD_ALLOWED,
          ),
          Stream.runCollect,
        );

        const serialized = JSON.stringify(Array.from(items));
        expect(serialized).not.toContain(PROJECT_FOREIGN);
        expect(serialized).not.toContain(THREAD_FOREIGN);

        const firstSnapshot = Array.from(items).find((item) => item.kind === "snapshot");
        expect(firstSnapshot?.kind).toBe("snapshot");
        if (firstSnapshot?.kind === "snapshot") {
          expect(firstSnapshot.snapshot.projects.map((p) => p.id)).toEqual([PROJECT_ALLOWED]);
          expect(firstSnapshot.snapshot.threads.map((t) => t.id)).toEqual([THREAD_ALLOWED]);
        }
        expect(Array.from(items).some((item) => item.kind === "synchronized")).toBe(true);
        expect(
          Array.from(items).some(
            (item) => item.kind === "project.updated" && item.project.id === PROJECT_ALLOWED,
          ),
        ).toBe(true);
        expect(
          Array.from(items).some(
            (item) => item.kind === "thread.updated" && item.thread.id === THREAD_ALLOWED,
          ),
        ).toBe(true);
      }).pipe(Effect.provide(SqlitePersistence.layerMemory), Effect.scoped),
  );
});

describe("Projects list and search filtering", () => {
  class ProjectsTestApi extends HttpApi.make("environment").add(
    EnvironmentHttpApi.groups.projects,
  ) {}

  const projectA: Project = {
    id: PROJECT_ALLOWED,
    title: "Allowed Project",
    workspaceRoot: "/workspaces/allowed",
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    deletedAt: null,
  };
  const projectB: Project = {
    id: PROJECT_FOREIGN,
    title: "Foreign Project",
    workspaceRoot: "/workspaces/foreign",
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    deletedAt: null,
  };

  it.effect(
    "GET /api/projects filters snapshot projects to accessible ones and rejects suspended principals",
    () =>
      Effect.gen(function* () {
        const principals = yield* Principals.PrincipalRepository;
        const memberships = yield* Memberships.MembershipRepository;
        const staffId = PrincipalId.make("principal-staff");
        yield* principals.create({
          id: staffId,
          kind: "member",
          displayName: "Staff",
          email: "staff@example.com",
          status: "active",
          ceiling: [AuthOrchestrationReadScope],
          createdAt: NOW_ISO,
        });
        yield* memberships.upsert({
          projectId: PROJECT_ALLOWED,
          principalId: staffId,
          role: "viewer",
          state: "active",
          invitedBy: null,
          expiresAt: null,
          updatedAt: NOW_ISO,
        });
        const suspendedId = PrincipalId.make("principal-suspended");
        yield* principals.create({
          id: suspendedId,
          kind: "member",
          displayName: "Suspended",
          email: "suspended@example.com",
          status: "suspended",
          ceiling: [AuthOrchestrationReadScope],
          createdAt: NOW_ISO,
        });

        const runSnapshot = (principal: {
          readonly principalId?: PrincipalId;
          readonly binding?: { readonly _tag: "principal" } | { readonly _tag: "environment" };
        }) =>
          Effect.gen(function* () {
            const access = yield* ProjectAccess.ProjectAccess;
            const appLayer = HttpApiBuilder.layer(ProjectsTestApi).pipe(
              Layer.provide(ProjectHttp.layer),
              Layer.provide(
                Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
                  effect.pipe(
                    Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                      sessionId: AuthSessionId.make("http-test"),
                      subject: "test",
                      method: "browser-session-cookie",
                      scopes: new Set<AuthEnvironmentScope>([AuthOrchestrationReadScope]),
                      ...principal,
                    }),
                  ),
                ),
              ),
              Layer.provide(Layer.succeed(ProjectAccess.ProjectAccess, access)),
              Layer.provide(
                Layer.mock(ProjectService.ProjectService)({
                  snapshot: Effect.succeed({
                    projects: [projectA, projectB],
                    updatedAt: NOW_ISO,
                  }),
                }),
              ),
              Layer.provide(Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({})),
              Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
              Layer.provide(
                Layer.mock(ProjectQuotaService.ProjectQuotaService)({
                  getWarningsForProjects: () => Effect.succeed(new Map()),
                }),
              ),
              Layer.provide(Layer.mock(ProjectSecrets.ProjectSecrets)({})),
              Layer.provide(HttpPlatform.layer),
              Layer.provide(Etag.layerWeak),
              Layer.provide(NodeServices.layer),
            );
            return yield* Effect.acquireUseRelease(
              Effect.sync(() => HttpRouter.toWebHandler(appLayer, { disableLogger: true })),
              ({ handler }) =>
                Effect.promise(async () => {
                  const response = await handler(
                    new Request("http://environment.test/api/projects"),
                  );
                  return { status: response.status, body: await response.json() };
                }),
              ({ dispose }) => Effect.promise(() => dispose()),
            );
          });

        const staffRes = yield* runSnapshot({
          principalId: staffId,
          binding: { _tag: "principal" },
        });
        expect(staffRes.status).toBe(200);
        expect(
          (staffRes.body as { projects: Array<{ id: string }> }).projects.map((p) => p.id),
        ).toEqual([PROJECT_ALLOWED]);

        const ownerRes = yield* runSnapshot({});
        expect(ownerRes.status).toBe(200);
        expect(
          (ownerRes.body as { projects: Array<{ id: string }> }).projects.map((p) => p.id),
        ).toEqual([PROJECT_ALLOWED, PROJECT_FOREIGN]);

        const suspendedRes = yield* runSnapshot({
          principalId: suspendedId,
          binding: { _tag: "principal" },
        });
        expect(suspendedRes.status).toBe(401);
        expect(suspendedRes.body).toMatchObject({
          code: "auth_invalid",
          reason: "invalid_credential",
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Principals.layer,
            Memberships.layer,
            ProjectAccess.layer.pipe(
              Layer.provide(
                Layer.mergeAll(Principals.layer, Memberships.layer, ProjectStore.layer),
              ),
            ),
          ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
        ),
      ),
  );

  it.effect(
    "projectsListEntries and searchThreads enforce project isolation for narrowed actors",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sink = yield* EventSink.EventSinkV2;
        const projects = yield* ProjectStore.ProjectStoreV2;

        for (const proj of [projectA, projectB]) {
          yield* projects.apply({
            sequence: proj.id === PROJECT_ALLOWED ? 1 : 2,
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
        }
        for (const [threadId, projectId, secretWord] of [
          [THREAD_ALLOWED, PROJECT_ALLOWED, "sharedneedle"],
          [THREAD_FOREIGN, PROJECT_FOREIGN, "sharedneedle"],
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
              {
                id: EventId.make(`msg:${threadId}`),
                type: "message.updated",
                threadId,
                occurredAt: NOW,
                payload: {
                  id: MessageId.make(`msg:${threadId}`),
                  threadId,
                  runId: null,
                  nodeId: null,
                  role: "user",
                  createdBy: "user",
                  creationSource: "web",
                  text: `Looking for ${secretWord} in ${projectId}`,
                  attachments: [],
                  streaming: false,
                  createdAt: NOW,
                  updatedAt: NOW,
                },
              },
            ],
          });
        }

        const THREAD_SAME_PROJECT_FOREIGN = ThreadId.make("thread-allowed-foreign-same-project");
        const THREAD_SETTLED_LINKED = ThreadId.make("thread-settled-linked");
        const THREAD_SETTLED_FOREIGN = ThreadId.make("thread-settled-foreign");
        const THREAD_ARCHIVED_LINKED = ThreadId.make("thread-archived-linked");
        const THREAD_ARCHIVED_FOREIGN = ThreadId.make("thread-archived-foreign");
        const EXTERNAL_PRINCIPAL_ID = PrincipalId.make("principal-external-client");
        const CRM_CLIENT_ID = CrmClientId.make("crm-client-external");

        const settledAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
        for (const [threadId, projectId, opts] of [
          [THREAD_SAME_PROJECT_FOREIGN, PROJECT_ALLOWED, { title: "Foreign Same Project" }],
          [
            THREAD_SETTLED_LINKED,
            PROJECT_ALLOWED,
            { title: "Settled Needle Linked", settled: true },
          ],
          [
            THREAD_SETTLED_FOREIGN,
            PROJECT_ALLOWED,
            { title: "Settled Needle Foreign", settled: true },
          ],
          [THREAD_ARCHIVED_LINKED, PROJECT_ALLOWED, { title: "Archived Linked", archived: true }],
          [THREAD_ARCHIVED_FOREIGN, PROJECT_ALLOWED, { title: "Archived Foreign", archived: true }],
        ] as const) {
          const baseThread = makeAppThread(threadId, projectId);
          yield* sink.write({
            events: [
              {
                id: EventId.make(`evt-create-${threadId}`),
                threadId,
                occurredAt: NOW,
                type: "thread.created",
                payload: {
                  ...baseThread,
                  title: opts.title,
                  ...("settled" in opts && opts.settled
                    ? { settledOverride: "settled" as const, settledAt }
                    : {}),
                  ...("archived" in opts && opts.archived ? { archivedAt: NOW } : {}),
                },
              },
              {
                id: EventId.make(`evt-msg-${threadId}`),
                threadId,
                occurredAt: NOW,
                type: "message.updated",
                payload: {
                  id: MessageId.make(`msg-${threadId}`),
                  threadId,
                  runId: null,
                  nodeId: null,
                  role: "user",
                  createdBy: "user",
                  creationSource: "web",
                  text: `sharedneedle from ${threadId}`,
                  attachments: [],
                  streaming: false,
                  createdAt: NOW,
                  updatedAt: NOW,
                },
              },
            ],
          });
        }

        const principalsRepo = yield* Principals.PrincipalRepository;
        const crmRepo = yield* CrmRepo.CrmRepository;
        yield* principalsRepo.create({
          id: EXTERNAL_PRINCIPAL_ID,
          kind: "external",
          displayName: "External Client",
          email: null,
          status: "active",
          ceiling: [AuthOrchestrationReadScope],
          createdAt: NOW_ISO,
        });
        yield* crmRepo.createClient({
          id: CRM_CLIENT_ID,
          projectId: PROJECT_ALLOWED,
          principalId: EXTERNAL_PRINCIPAL_ID,
          name: "External Co",
          company: null,
          status: "active",
          emailCiphertext: null,
          emailFingerprint: null,
          phoneCiphertext: null,
          phoneFingerprint: null,
          createdBy: PrincipalId.make("owner"),
          createdAt: NOW_ISO,
          updatedAt: NOW_ISO,
        });
        for (const linkedId of [THREAD_ALLOWED, THREAD_SETTLED_LINKED, THREAD_ARCHIVED_LINKED]) {
          yield* crmRepo.linkThread({
            projectId: PROJECT_ALLOWED,
            clientId: CRM_CLIENT_ID,
            threadId: linkedId,
            createdBy: PrincipalId.make("owner"),
            createdAt: NOW_ISO,
          });
        }

        const tested = [
          WS_METHODS.projectsListEntries,
          WS_METHODS.projectsReadFile,
          WS_METHODS.terminalOpen,
          ORCHESTRATION_V2_WS_METHODS.searchThreads,
          ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot,
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
        const scopes: ReadonlyArray<AuthEnvironmentScope> = [
          AuthOrchestrationReadScope,
          AuthFilesystemReadScope,
          AuthTerminalOperateScope,
        ];
        const listedCwds: Array<string> = [];
        const readRequests: Array<{ readonly cwd: string; readonly relativePath: string }> = [];
        const openedTerminals: Array<{
          readonly threadId: string;
          readonly cwd: string;
          readonly env: Record<string, string> | undefined;
        }> = [];

        const threadSearch = yield* ThreadSearch.ThreadSearch;
        const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-shell-filter-",
        }).pipe(Layer.provide(NodeServices.layer));
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
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const resolverLayer = ResourceResolver.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
              Layer.succeed(CrmRepo.CrmRepository, crmRepo),
            ),
          ),
        );
        const unusedServices = Layer.mergeAll(
          Layer.succeed(SqlClient.SqlClient, sql),
          Layer.succeed(ProjectStore.ProjectStoreV2, projects),
          Layer.succeed(ThreadSearch.ThreadSearch, threadSearch),
          resolverLayer,
          projectPathsLayer,
          Layer.mock(WorkspaceEntries.WorkspaceEntries)({
            list: (input) =>
              Effect.sync(() => {
                listedCwds.push(input.cwd);
                return { entries: [], truncated: false };
              }),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Effect.succeed(
                threadId === THREAD_ALLOWED
                  ? makeThreadShell(THREAD_ALLOWED, PROJECT_ALLOWED)
                  : threadId === THREAD_FOREIGN
                    ? makeThreadShell(THREAD_FOREIGN, PROJECT_FOREIGN)
                    : null,
              ),
            readShellSnapshot: (options) =>
              projections.readShellSnapshot(options).pipe(
                Effect.orDie,
                Effect.map((decode) => decode.pipe(Effect.orDie)),
              ),
          }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(PrincipalLimitsService.PrincipalLimitsService)({
            resolveForPrincipal: () => Effect.succeed(null),
          }),
          Layer.mock(ProjectQuotaService.ProjectQuotaService)({
            getWarningsForProjects: () => Effect.succeed(new Map()),
            assertCanCreateWorktree: () => Effect.void,
            subscribeChanges: PubSub.unbounded<ProjectId>().pipe(Effect.flatMap(PubSub.subscribe)),
          }),
          Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
            latestApplicationSequence: Effect.succeed(10),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
          Layer.mock(ScratchThreadPromotion.ScratchThreadPromotion)({}),
          Layer.mock(AnalyticsService.AnalyticsService)({}),
          Layer.mock(CommandOutputHub.CommandOutputHub)({}),
          ThreadViewers.layer,
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
          Layer.mock(McpAppRequests.McpAppRequests)({}),
          Layer.mock(McpSignIn.McpSignIn)({}),
          Layer.mock(ScheduledTasks.ScheduledTaskService)({}),
          Layer.mock(Workflows.Workflows)({}),
          Layer.mock(WorkflowRuntime.WorkflowDefinitions)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(FeedbackStore.FeedbackStore)({}),
          Layer.mock(GuestShareService.GuestShareService)({}),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(IssueService.IssueService)({}),
          Layer.mock(ThreadIssueService.ThreadIssueService)({}),
          Layer.mock(IssueTrackerConnections.IssueTrackerConnections)({}),
          Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
          Layer.mock(PullRequestSyncReactor.PullRequestSyncReactor)({}),
          Layer.mock(DeviceService.DeviceService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({}),
          Layer.mock(UsageService.UsageService)({}),
          Layer.mock(UsageLimitSources.UsageLimitSources)({}),
          Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
          Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({}),
          Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({
            getAvailable: () =>
              Effect.succeed({
                repositoryIdentity: null,
                faviconPath: null,
                repositoryIdentityResolved: true,
              }),
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
          Layer.mock(TerminalManager.TerminalManager)({
            open: (input) =>
              Effect.sync(() => {
                openedTerminals.push({
                  threadId: input.threadId,
                  cwd: input.cwd,
                  env: input.env,
                });
                return {
                  threadId: input.threadId,
                  terminalId: input.terminalId,
                  cwd: input.cwd,
                  worktreePath: input.worktreePath ?? null,
                  status: "running",
                  pid: 1234,
                  history: "",
                  exitCode: null,
                  exitSignal: null,
                  label: "shell",
                  updatedAt: NOW_ISO,
                };
              }),
          }),
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
          serverConfigLayer,
          Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({}),
          Layer.mock(StorageCleanup.StorageCleanup)({}),
          Layer.mock(DatabaseStorage.DatabaseStorage)({}),
          Layer.mock(ServerSettings.ServerSettingsService)({}),
          Layer.mock(SecretResolver.SecretResolver)({}),
          Layer.mock(PeerLinks.PeerLinks)({}),
          Layer.mock(PeerLinkRequests.PeerLinkRequests)({}),
          Layer.mock(PeerThreadRelay.PeerThreadRelay)({}),
          Layer.mock(PeerClientPairing.PeerClientPairing)({}),
          Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({}),
          Layer.mock(WorkspaceFolders.WorkspaceFolders)({}),
          Layer.mock(TaskFolders.TaskFolders)({}),
          Layer.mock(WorkspaceFileSystem.WorkspaceFileSystem)({
            readFile: (input) =>
              Effect.sync(() => {
                readRequests.push({ cwd: input.cwd, relativePath: input.relativePath });
                return {
                  relativePath: input.relativePath,
                  contents: "ok",
                  byteLength: 2,
                  truncated: false,
                };
              }),
          }),
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
            cookieName: "filter-test",
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
          NodeServices.layer,
        );

        const viewerActor: ProjectAccess.AccessActor = {
          sessionId: AuthSessionId.make("viewer-rpc"),
          subject: "viewer",
          scopes,
          principalId: PrincipalId.make("principal-viewer"),
          binding: { _tag: "principal" },
          isOwner: false,
          roles: new Map([[PROJECT_ALLOWED, "viewer"]]),
        };
        const devActor: ProjectAccess.AccessActor = {
          sessionId: AuthSessionId.make("dev-rpc"),
          subject: "dev",
          scopes,
          principalId: PrincipalId.make("principal-dev"),
          binding: { _tag: "principal" },
          isOwner: false,
          roles: new Map([[PROJECT_ALLOWED, "developer"]]),
        };

        const makeActorClient = (actor?: ProjectAccess.AccessActor) =>
          RpcTest.makeClient(group).pipe(
            Effect.provide(
              layerWsRpc(
                {
                  sessionId: actor?.sessionId ?? AuthSessionId.make("owner-rpc"),
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
              ).pipe(Layer.provide(unusedServices), Layer.merge(RpcAuthorization.layer(scopes))),
            ),
          );

        const narrowedClient = yield* makeActorClient(viewerActor);
        const devClient = yield* makeActorClient(devActor);

        // Accessible cwd passes; foreign cwd is denied with project_forbidden.
        yield* narrowedClient[WS_METHODS.projectsListEntries]({ cwd: projectA.workspaceRoot });
        const deniedEntries = yield* narrowedClient[WS_METHODS.projectsListEntries]({
          cwd: projectB.workspaceRoot,
        }).pipe(Effect.flip);
        expect(deniedEntries).toMatchObject({
          _tag: "project_forbidden",
          projectId: PROJECT_FOREIGN,
          requiredPermission: "project:read",
        });
        expect(listedCwds).toEqual([projectA.workspaceRoot]);

        // projectsReadFile allows own project files and refuses foreign cwd, absolute foreign path, and '..' escape.
        yield* narrowedClient[WS_METHODS.projectsReadFile]({
          cwd: projectA.workspaceRoot,
          relativePath: "README.md",
        });
        const deniedReadCwd = yield* narrowedClient[WS_METHODS.projectsReadFile]({
          cwd: projectB.workspaceRoot,
          relativePath: "secret.txt",
        }).pipe(Effect.flip);
        expect(deniedReadCwd).toMatchObject({
          _tag: "project_forbidden",
          projectId: PROJECT_FOREIGN,
          requiredPermission: "project:read",
        });
        const deniedReadAbsolute = yield* narrowedClient[WS_METHODS.projectsReadFile]({
          cwd: projectA.workspaceRoot,
          relativePath: `${projectB.workspaceRoot}/secret.txt`,
        }).pipe(Effect.flip);
        expect(deniedReadAbsolute).toMatchObject({
          _tag: "project_forbidden",
          projectId: PROJECT_FOREIGN,
          requiredPermission: "project:read",
        });
        const deniedReadTraversal = yield* narrowedClient[WS_METHODS.projectsReadFile]({
          cwd: projectA.workspaceRoot,
          relativePath: "../foreign/secret.txt",
        }).pipe(Effect.flip);
        expect(deniedReadTraversal).toMatchObject({
          _tag: "project_forbidden",
          projectId: PROJECT_FOREIGN,
          requiredPermission: "project:read",
        });
        expect(readRequests).toEqual([{ cwd: projectA.workspaceRoot, relativePath: "README.md" }]);

        // terminalOpen enforces thread project cwd and injects T3_PROJECT_ID / T3_MEMBER_ID.
        yield* devClient[WS_METHODS.terminalOpen]({
          threadId: THREAD_ALLOWED,
          terminalId: "term-1",
          cwd: projectA.workspaceRoot,
          env: { T3_PROJECT_ID: "spoofed", T3_MEMBER_ID: "spoofed", CUSTOM: "yes" },
        });
        expect(openedTerminals).toEqual([
          {
            threadId: THREAD_ALLOWED,
            cwd: projectA.workspaceRoot,
            env: {
              CUSTOM: "yes",
              T3_PROJECT_ID: PROJECT_ALLOWED,
              T3_MEMBER_ID: devActor.principalId,
            },
          },
        ]);

        const deniedTerminalForeignCwd = yield* devClient[WS_METHODS.terminalOpen]({
          threadId: THREAD_ALLOWED,
          terminalId: "term-2",
          cwd: projectB.workspaceRoot,
        }).pipe(Effect.flip);
        expect(deniedTerminalForeignCwd).toMatchObject({
          _tag: "project_forbidden",
          projectId: PROJECT_FOREIGN,
          requiredPermission: "project:terminal.operate",
        });

        const deniedViewerTerminal = yield* narrowedClient[WS_METHODS.terminalOpen]({
          threadId: THREAD_ALLOWED,
          terminalId: "term-3",
          cwd: projectA.workspaceRoot,
        }).pipe(Effect.flip);
        expect(deniedViewerTerminal).toMatchObject({
          _tag: "project_forbidden",
          projectId: PROJECT_ALLOWED,
          requiredPermission: "project:terminal.operate",
        });

        // searchThreads without explicit projectIds is narrowed to PROJECT_ALLOWED.
        const narrowedSearch = yield* narrowedClient[ORCHESTRATION_V2_WS_METHODS.searchThreads]({
          query: "sharedneedle",
        });
        expect(new Set(narrowedSearch.matches.map((m) => m.projectId))).toEqual(
          new Set([PROJECT_ALLOWED]),
        );

        // External principal over WS searchThreads sees ONLY linked threads (foreign thread in the SAME project is absent).
        const externalActor: ProjectAccess.AccessActor = {
          sessionId: AuthSessionId.make("external-rpc"),
          subject: `principal:${EXTERNAL_PRINCIPAL_ID}`,
          scopes: [AuthOrchestrationReadScope],
          principalId: EXTERNAL_PRINCIPAL_ID,
          principalKind: "external",
          binding: { _tag: "principal" },
          isOwner: false,
          roles: new Map([[PROJECT_ALLOWED, "viewer"]]),
        };
        const externalClient = yield* makeActorClient(externalActor);
        const externalSearch = yield* externalClient[ORCHESTRATION_V2_WS_METHODS.searchThreads]({
          query: "sharedneedle",
        });
        expect(externalSearch.matches.map((m) => m.threadId).toSorted()).toEqual(
          [THREAD_ALLOWED, THREAD_SETTLED_LINKED].toSorted(),
        );
        expect(externalSearch.matches.some((m) => m.threadId === THREAD_SAME_PROJECT_FOREIGN)).toBe(
          false,
        );
        expect(externalSearch.matches.some((m) => m.threadId === THREAD_SETTLED_FOREIGN)).toBe(
          false,
        );

        // External principal olderSettledBefore search excludes foreign settled threads in the same project.
        const externalOlderSettledSearch = yield* externalClient[
          ORCHESTRATION_V2_WS_METHODS.searchThreads
        ]({
          query: "Settled Needle",
          olderSettledBefore: NOW_ISO,
        });
        expect((externalOlderSettledSearch.threads ?? []).map((t) => t.id)).toEqual([
          THREAD_SETTLED_LINKED,
        ]);

        // External principal getArchivedShellSnapshot excludes foreign archived threads in the same project.
        const externalArchived = yield* externalClient[
          ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot
        ]({});
        expect(externalArchived.threads.map((t) => t.id)).toEqual([THREAD_ARCHIVED_LINKED]);

        // Regular staff viewer on PROJECT_ALLOWED still sees both archived threads in PROJECT_ALLOWED.
        const viewerArchived = yield* narrowedClient[
          ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot
        ]({});
        expect(viewerArchived.threads.map((t) => t.id).toSorted()).toEqual(
          [THREAD_ARCHIVED_LINKED, THREAD_ARCHIVED_FOREIGN].toSorted(),
        );

        // Owner / legacy actor sees both projects and keeps arbitrary terminal cwd behavior.
        const ownerClient = yield* makeActorClient();
        yield* ownerClient[WS_METHODS.terminalOpen]({
          threadId: THREAD_ALLOWED,
          terminalId: "term-owner",
          cwd: "/tmp/arbitrary-owner-cwd",
        });
        expect(openedTerminals.at(-1)?.cwd).toBe("/tmp/arbitrary-owner-cwd");
        const ownerSearch = yield* ownerClient[ORCHESTRATION_V2_WS_METHODS.searchThreads]({
          query: "sharedneedle",
        });
        expect(new Set(ownerSearch.matches.map((m) => m.projectId))).toEqual(
          new Set([PROJECT_ALLOWED, PROJECT_FOREIGN]),
        );
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
            ThreadSearch.layer,
            Principals.layer,
            CrmRepo.layer,
          ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
        ),
        Effect.scoped,
      ),
  );
});
