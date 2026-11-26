import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type ApplicationStoredEvent,
  AuthAccessReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  CommandId,
  DEFAULT_PROJECT_DISK_BYTES,
  DEFAULT_PROJECT_MAX_ACTIVE_THREADS,
  DEFAULT_PROJECT_MAX_WORKTREES,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EventId,
  MessageId,
  PrincipalId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AuthEnvironmentScope,
  type OrchestrationV2ShellStreamItem,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as ProjectSecrets from "./ProjectSecrets.ts";
import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as runtimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Memberships from "../persistence/Memberships.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as Principals from "../persistence/Principals.ts";
import * as ProjectQuotas from "../persistence/ProjectQuotas.ts";
import * as ProjectUsageSamples from "../persistence/ProjectUsageSamples.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as TaskFolders from "../workspace/TaskFolders.ts";
import * as Ws from "../ws.ts";
import * as ProjectHttp from "./http.ts";
import * as ManagedProjectFolders from "./ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "./ProjectCloneTracker.ts";
import * as ProjectEnrichment from "./ProjectEnrichmentService.ts";
import * as ProjectQuotaService from "./ProjectQuotaService.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "./WorktreeSetupTracker.ts";

class ProjectsTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.projects) {}

const OWNER_ID = PrincipalId.make("owner");
const MEMBER_ID = PrincipalId.make("quota-member");
const OUTSIDER_ID = PrincipalId.make("quota-outsider");
const PROJECT_ID = ProjectId.make("project-quota-test");
const OTHER_PROJECT_ID = ProjectId.make("project-quota-other");
const NOW_ISO = "2026-11-26T12:00:00.000Z";
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} as const;

const codexAdapter = {
  instanceId: MODEL_SELECTION.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in quota tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const makeQuotaTestLayer = () => {
  const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-quota-" }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const persistence = SqlitePersistence.layerMemory;
  const stores = Layer.mergeAll(
    runtimeLayer.layerEventInfrastructure,
    ProjectionStore.layer,
    ProjectStore.layer,
    CommandReceiptStore.layerFromApplicationReceipts.pipe(
      Layer.provide(runtimeLayer.layerEventInfrastructure),
    ),
    Principals.layer,
    Memberships.layer,
    ProjectQuotas.layer,
    ProjectUsageSamples.layer,
  );
  const quotas = ProjectQuotaService.layer.pipe(
    Layer.provide(config),
    Layer.provide(NodeServices.layer),
  );
  const projectAccess = ProjectAccess.layer.pipe(
    Layer.provide(Layer.mergeAll(Principals.layer, Memberships.layer, ProjectStore.layer)),
  );

  return Layer.mergeAll(
    stores,
    quotas,
    projectAccess,
    config,
    NodeServices.layer,
    NodeCrypto.layer,
  ).pipe(Layer.provideMerge(persistence));
};

let projectSeedSeq = 1;
const seedProjectRow = Effect.fn("seedProjectRow")(function* (
  projectId: ProjectId,
  workspaceRoot = "/workspaces/quota-project",
) {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sequence = projectSeedSeq++;
  yield* projects.apply({
    sequence,
    eventId: EventId.make(`quota-seed-proj-${projectId}-${sequence}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: NOW_ISO,
    commandId: null,
    causationEventId: EventId.make(`quota-seed-cause-${projectId}-${sequence}`),
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: `Project ${projectId}`,
      workspaceRoot,
      defaultModelSelection: MODEL_SELECTION,
      scripts: [],
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    },
  });
});

const seedThreadRow = Effect.fn("seedThreadRow")(function* (input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly worktreePath?: string | null;
  readonly archivedAt?: string | null;
  readonly deletedAt?: string | null;
}) {
  const sql = yield* SqlClient.SqlClient;
  const payload = {
    id: input.threadId,
    projectId: input.projectId,
    title: `Thread ${input.threadId}`,
    worktreePath: input.worktreePath ?? null,
  };
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
    ) VALUES (
      ${input.threadId}, ${input.projectId}, ${payload.title}, 'codex', 'auto', 'default',
      NULL, ${NOW_ISO}, ${NOW_ISO}, ${input.archivedAt ?? null}, ${input.deletedAt ?? null},
      ${JSON.stringify(payload)}
    )
  `;
});

it.effect(
  "blocks new threads/worktrees at 100% for non-owners, allows running turns, exempts owner, and honors overrides",
  () => {
    const layerDatabase = SqlitePersistence.layerMemory;
    const layerConfig = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-project-quota-launch-",
    }).pipe(Layer.provide(NodeServices.layer));
    const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([codexAdapter]);
    const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
      { name: "quota-launch" },
      layerRegistry,
      { databaseLayer: layerDatabase, runEffectWorker: false },
    );
    const layerSettings = ServerSettings.layerTest();
    const layerReceipts = CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase));
    const layerThreadManagement = ThreadManagement.layer.pipe(
      Layer.provide(layerOrchestrator),
      Layer.provide(layerSettings),
      Layer.provide(layerReceipts),
    );
    const layerQuotas = ProjectQuotaService.layer.pipe(
      Layer.provide(Layer.mergeAll(layerDatabase, layerConfig, NodeServices.layer)),
    );
    const layerLaunch = ThreadLaunchService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerQuotas,
          layerThreadManagement,
          layerReceipts,
          layerOrchestrator,
          IdAllocator.layer,
          layerSettings,
          WorktreeSetupTracker.layer,
          Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
          Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: (id) =>
              Effect.succeed(
                id === PROJECT_ID
                  ? Option.some({
                      id: PROJECT_ID,
                      title: "Quota Project",
                      workspaceRoot: "/workspaces/quota-project",
                      repositoryIdentity: null,
                      faviconPath: null,
                      defaultModelSelection: MODEL_SELECTION,
                      defaultThreadEnvMode: null,
                      scripts: [],
                      trackedFolders: [],
                      pinnedAt: null,
                      archivedAt: null,
                      createdAt: NOW_ISO,
                      updatedAt: NOW_ISO,
                      deletedAt: null,
                    })
                  : Option.none(),
              ),
          }),
          Layer.mock(GitWorkflow.GitWorkflowService)({
            repositoryRoot: () => Effect.succeed("/workspaces/quota-project"),
            createWorktree: (input) =>
              Effect.succeed({
                worktree: {
                  path: `/workspaces/quota-project-wt/${input.newRefName}`,
                  refName: input.newRefName,
                  headSha: "abc",
                },
              } as never),
            currentBranch: () => Effect.succeed("main"),
            resolveDefaultBranchName: () => Effect.succeed("main"),
            remoteExists: () => Effect.succeed(false),
            listLocalBranchNames: () => Effect.succeed(["main"]),
          }),
          Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
            runForThread: () => Effect.succeed({ status: "no-script" as const }),
          }),
          Layer.mock(TextGeneration.TextGeneration)({
            generateThreadTitle: () => Effect.succeed({ title: "Generated title" }),
            generateBranchName: () => Effect.succeed({ branch: "generated-branch" }),
          }),
          ProviderRegistryMock.layer(),
          Layer.mock(TaskFolders.TaskFolders)({ plan: () => Effect.succeed(null) }),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/workspaces",
            isScratchProject: () => Effect.succeed(false),
            folderForThread: () => Effect.succeedNone,
          }),
        ),
      ),
    );
    const fullLayer = Layer.mergeAll(
      layerDatabase,
      layerConfig,
      ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
      Principals.layer.pipe(Layer.provide(layerDatabase)),
      ProjectQuotas.layer.pipe(Layer.provide(layerDatabase)),
      ProjectUsageSamples.layer.pipe(Layer.provide(layerDatabase)),
      layerQuotas,
      layerThreadManagement,
      layerLaunch,
      NodeServices.layer,
      NodeCrypto.layer,
    );

    return Effect.gen(function* () {
      const principals = yield* Principals.PrincipalRepository;
      const projectQuotasRepo = yield* ProjectQuotas.ProjectQuotaRepository;
      const usageSamples = yield* ProjectUsageSamples.ProjectUsageSampleRepository;
      const quotaService = yield* ProjectQuotaService.ProjectQuotaService;
      const launchService = yield* ThreadLaunchService.ThreadLaunchService;
      const threadManagement = yield* ThreadManagement.ThreadManagementService;

      yield* seedProjectRow(PROJECT_ID);
      yield* principals.create({
        id: MEMBER_ID,
        kind: "member",
        displayName: "Dev Member",
        email: "dev@example.com",
        status: "active",
        ceiling: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope, AuthAccessReadScope],
        createdAt: NOW_ISO,
      });

      const launchThreadFor = (
        id: string,
        actorPrincipalId: PrincipalId,
        strategy: ThreadLaunchService.ThreadLaunchWorkspaceStrategy = { type: "root" },
      ) =>
        launchService.launch({
          commandId: CommandId.make(`cmd-${id}`),
          threadId: ThreadId.make(id),
          projectId: PROJECT_ID,
          title: `Thread ${id}`,
          modelSelection: MODEL_SELECTION,
          runtimeMode: "auto",
          interactionMode: "default",
          workspaceStrategy: strategy,
          createdBy: "user",
          creationSource: "web",
          actorPrincipalId,
        });

      // Override maxActiveThreads = 2, maxWorktrees = 1, diskBytes = 1000.
      yield* projectQuotasRepo.set({
        projectId: PROJECT_ID,
        maxActiveThreads: 2,
        maxWorktrees: 1,
        diskBytes: 1_000,
        attachmentBytes: null,
      });

      // Launching 2 threads succeeds for non-owner.
      yield* launchThreadFor("thread-1", MEMBER_ID);
      yield* launchThreadFor("thread-2", MEMBER_ID);

      // 3rd thread is blocked at 100% with ProjectQuotaExceededError(active_threads).
      const threadLimitError = yield* launchThreadFor("thread-3", MEMBER_ID).pipe(Effect.flip);
      expect(threadLimitError._tag).toBe("ProjectQuotaExceededError");
      if (threadLimitError._tag === "ProjectQuotaExceededError") {
        expect(threadLimitError.resource).toBe("active_threads");
        expect(threadLimitError.current).toBe(2);
        expect(threadLimitError.limit).toBe(2);
      }

      // Continuing/running a turn on an existing thread goes through ThreadManagementService.dispatch
      // and is NOT blocked even while active_threads is at 100%.
      const existingTurnDispatch = yield* threadManagement.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("cmd-existing-turn-at-thread-limit"),
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("msg-existing-1"),
        text: "continue running turn",
        attachments: [],
        modelSelection: MODEL_SELECTION,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      expect(existingTurnDispatch.sequence).toBeGreaterThan(0);

      // Owner is exempt from project quotas even at 100%.
      const ownerThread = yield* launchThreadFor("thread-owner", OWNER_ID);
      expect(ownerThread.threadId).toBe("thread-owner");

      // Worktree quota: seed 1 active worktree, then verify non-owner is blocked at 1/1 while owner passes.
      yield* projectQuotasRepo.set({
        projectId: PROJECT_ID,
        maxActiveThreads: null,
        maxWorktrees: 1,
        diskBytes: 1_000,
        attachmentBytes: null,
      });
      yield* seedThreadRow({
        projectId: PROJECT_ID,
        threadId: ThreadId.make("thread-wt-1"),
        worktreePath: "/workspaces/quota-project-wt-1",
      });
      const worktreeError = yield* quotaService
        .assertCanCreateWorktree({ projectId: PROJECT_ID, principalId: MEMBER_ID })
        .pipe(Effect.flip);
      expect(worktreeError._tag).toBe("ProjectQuotaExceededError");
      if (worktreeError._tag === "ProjectQuotaExceededError") {
        expect(worktreeError.resource).toBe("worktrees");
        expect(worktreeError.current).toBe(1);
        expect(worktreeError.limit).toBe(1);
      }
      const worktreeLaunchError = yield* launchThreadFor("thread-wt-2", MEMBER_ID, {
        type: "worktree",
        baseRef: "main",
      }).pipe(Effect.flip);
      expect(worktreeLaunchError._tag).toBe("ProjectQuotaExceededError");
      if (worktreeLaunchError._tag === "ProjectQuotaExceededError") {
        expect(worktreeLaunchError.resource).toBe("worktrees");
      }
      yield* quotaService.assertCanCreateWorktree({ projectId: PROJECT_ID, principalId: OWNER_ID });

      // Disk soft limit: at 85% (850/1000), launching is still allowed and emits a warning.
      yield* usageSamples.upsert({
        projectId: PROJECT_ID,
        diskBytes: 850,
        sampledAt: NOW_ISO,
      });
      const usageAt85 = yield* quotaService.getUsage(PROJECT_ID);
      expect(usageAt85.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            resource: "disk_bytes",
            level: "warning",
            current: 850,
            limit: 1_000,
          }),
        ]),
      );
      // Allowed at 85% (non-worktree thread, since maxActiveThreads is back to default 10).
      yield* launchThreadFor("thread-at-85", MEMBER_ID);

      // At 100% disk, NEW threads and worktrees are refused for non-owner, while existing turns still run
      // and the owner remains exempt.
      yield* usageSamples.upsert({
        projectId: PROJECT_ID,
        diskBytes: 1_000,
        sampledAt: NOW_ISO,
      });
      const diskThreadError = yield* launchThreadFor("thread-at-100", MEMBER_ID).pipe(Effect.flip);
      expect(diskThreadError._tag).toBe("ProjectQuotaExceededError");
      if (diskThreadError._tag === "ProjectQuotaExceededError") {
        expect(diskThreadError.resource).toBe("disk_bytes");
      }
      const diskWorktreeError = yield* quotaService
        .assertCanCreateWorktree({ projectId: PROJECT_ID, principalId: MEMBER_ID })
        .pipe(Effect.flip);
      expect(diskWorktreeError._tag).toBe("ProjectQuotaExceededError");
      if (diskWorktreeError._tag === "ProjectQuotaExceededError") {
        expect(diskWorktreeError.resource).toBe("disk_bytes");
      }
      const turnAtDiskLimit = yield* threadManagement.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("cmd-existing-turn-at-disk-limit"),
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("msg-existing-2"),
        text: "running turn still allowed at 100% disk",
        attachments: [],
        modelSelection: MODEL_SELECTION,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      expect(turnAtDiskLimit.sequence).toBeGreaterThan(existingTurnDispatch.sequence);

      yield* quotaService.assertCanLaunchThread({
        projectId: PROJECT_ID,
        principalId: OWNER_ID,
        createsWorktree: true,
      });
    }).pipe(Effect.scoped, Effect.provide(fullLayer));
  },
);

it.live(
  "samples disk usage cheaply and attaches 80% warning marker to shell snapshot and live updates",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const projectQuotasRepo = yield* ProjectQuotas.ProjectQuotaRepository;
      const quotaService = yield* ProjectQuotaService.ProjectQuotaService;
      const projects = yield* ProjectStore.ProjectStoreV2;

      yield* seedProjectRow(PROJECT_ID);
      const threadId = ThreadId.make("thread-disk-sample");
      yield* seedThreadRow({ projectId: PROJECT_ID, threadId });

      // Write an attachment belonging to this thread so sampleProject measures SQLite + attachment bytes.
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      const segment = toSafeThreadAttachmentSegment(threadId)!;
      const attachmentFile = path.join(
        config.attachmentsDir,
        `${segment}-11111111-1111-1111-1111-111111111111.bin`,
      );
      yield* fs.writeFile(attachmentFile, new Uint8Array(1_200));

      // Set disk quota so the sampled size lands right in the 80-99% warning zone.
      const initialSample = yield* quotaService.sampleProject(PROJECT_ID);
      expect(initialSample.diskBytes).toBeGreaterThanOrEqual(1_200);
      const limitFor85Percent = Math.ceil(initialSample.diskBytes / 0.85);
      yield* projectQuotasRepo.set({
        projectId: PROJECT_ID,
        maxActiveThreads: null,
        maxWorktrees: null,
        diskBytes: limitFor85Percent,
        attachmentBytes: null,
      });

      // Subscribe to shell stream and verify the initial snapshot carries the 80% warning marker.
      const enrichmentPubSub = yield* PubSub.unbounded<ProjectEnrichment.ProjectEnrichmentChange>();
      const projectShell = Option.getOrThrow(yield* projects.getShell(PROJECT_ID));
      const stream = yield* Ws.subscribeOrchestrationV2Shell({
        requestCompletionMarker: true,
      }).pipe(
        Effect.provideService(OrchestrationEventStore.OrchestrationEventStore, {
          latestApplicationSequence: Effect.succeed(1),
          streamProjectedApplicationEvents: () =>
            Stream.never as Stream.Stream<ApplicationStoredEvent>,
        } as unknown as OrchestrationEventStore.OrchestrationEventStore["Service"]),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          listActiveShellIndex: () => Effect.succeed([]),
          readShellSnapshot: () =>
            Effect.succeed(
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 1,
                threads: [],
                archivedThreads: [],
              }),
            ),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedSome(projectShell),
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
      );

      const queue = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      yield* stream.pipe(
        Stream.runForEach((item) => Queue.offer(queue, item).pipe(Effect.asVoid)),
        Effect.forkScoped,
      );

      const snapshotItem = yield* Queue.take(queue);
      expect(snapshotItem.kind).toBe("snapshot");
      if (snapshotItem.kind === "snapshot") {
        const shellProject = snapshotItem.snapshot.projects.find((p) => p.id === PROJECT_ID);
        expect(shellProject?.quotaWarnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              resource: "disk_bytes",
              level: "warning",
            }),
          ]),
        );
      }

      // Drain synchronized marker, then push disk usage to 100% and verify a live project.updated marker arrives.
      const syncItem = yield* Queue.take(queue);
      expect(syncItem.kind).toBe("synchronized");

      yield* fs.writeFile(attachmentFile, new Uint8Array(limitFor85Percent + 500));
      yield* quotaService.sampleAll;

      const liveUpdate = yield* Queue.take(queue);
      expect(liveUpdate.kind).toBe("project.updated");
      if (liveUpdate.kind === "project.updated") {
        expect(liveUpdate.project.id).toBe(PROJECT_ID);
        expect(liveUpdate.project.quotaWarnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              resource: "disk_bytes",
              level: "exceeded",
            }),
          ]),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(makeQuotaTestLayer())),
);

it.effect(
  "GET /api/projects/:id/usage reports accurate counts, limits, enforces access:read and project membership",
  () =>
    Effect.gen(function* () {
      const principals = yield* Principals.PrincipalRepository;
      const memberships = yield* Memberships.MembershipRepository;
      const projectQuotasRepo = yield* ProjectQuotas.ProjectQuotaRepository;
      const usageSamples = yield* ProjectUsageSamples.ProjectUsageSampleRepository;
      const projectAccess = yield* ProjectAccess.ProjectAccess;
      const quotaService = yield* ProjectQuotaService.ProjectQuotaService;
      const projects = yield* ProjectStore.ProjectStoreV2;

      yield* seedProjectRow(PROJECT_ID);
      yield* seedProjectRow(OTHER_PROJECT_ID, "/workspaces/quota-other");

      // 2 active threads (1 with a worktree), 1 archived thread with a worktree, 1 deleted thread (excluded).
      yield* seedThreadRow({ projectId: PROJECT_ID, threadId: ThreadId.make("u-t1") });
      yield* seedThreadRow({
        projectId: PROJECT_ID,
        threadId: ThreadId.make("u-t2"),
        worktreePath: "/workspaces/quota-project-wt-a",
      });
      yield* seedThreadRow({
        projectId: PROJECT_ID,
        threadId: ThreadId.make("u-t3"),
        worktreePath: "/workspaces/quota-project-wt-b",
        archivedAt: NOW_ISO,
      });
      yield* seedThreadRow({
        projectId: PROJECT_ID,
        threadId: ThreadId.make("u-t4"),
        worktreePath: "/workspaces/quota-project-wt-deleted",
        deletedAt: NOW_ISO,
      });
      yield* usageSamples.upsert({
        projectId: PROJECT_ID,
        diskBytes: 42_000,
        sampledAt: NOW_ISO,
      });
      yield* projectQuotasRepo.set({
        projectId: PROJECT_ID,
        maxActiveThreads: 8,
        maxWorktrees: null,
        diskBytes: null,
        attachmentBytes: null,
      });

      yield* principals.create({
        id: MEMBER_ID,
        kind: "member",
        displayName: "Member",
        email: "usage-member@example.com",
        status: "active",
        ceiling: [AuthAccessReadScope, AuthOrchestrationReadScope],
        createdAt: NOW_ISO,
      });
      yield* memberships.upsert({
        projectId: PROJECT_ID,
        principalId: MEMBER_ID,
        role: "viewer",
        state: "active",
        invitedBy: OWNER_ID,
        expiresAt: null,
        updatedAt: NOW_ISO,
      });
      yield* principals.create({
        id: OUTSIDER_ID,
        kind: "member",
        displayName: "Outsider",
        email: "usage-outsider@example.com",
        status: "active",
        ceiling: [AuthAccessReadScope, AuthOrchestrationReadScope],
        createdAt: NOW_ISO,
      });

      const callUsage = (
        projectId: string,
        session: {
          readonly principalId?: PrincipalId;
          readonly binding?: { readonly _tag: "principal" } | { readonly _tag: "environment" };
          readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
        },
      ) =>
        Effect.gen(function* () {
          const appLayer = HttpApiBuilder.layer(ProjectsTestApi).pipe(
            Layer.provide(ProjectHttp.layer),
            Layer.provide(
              Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
                effect.pipe(
                  Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                    sessionId: AuthSessionId.make("usage-http-session"),
                    subject: "test",
                    method: "browser-session-cookie",
                    scopes: new Set(session.scopes),
                    ...(session.principalId === undefined
                      ? {}
                      : { principalId: session.principalId }),
                    ...(session.binding === undefined ? {} : { binding: session.binding }),
                  }),
                ),
              ),
            ),
            Layer.provide(Layer.succeed(ProjectAccess.ProjectAccess, projectAccess)),
            Layer.provide(Layer.succeed(ProjectQuotaService.ProjectQuotaService, quotaService)),
            Layer.provide(
              Layer.mock(ProjectService.ProjectService)({
                getById: (id) =>
                  projects.get(id).pipe(
                    Effect.map(
                      Option.map((row) => ({
                        id: row.projectId,
                        title: row.title,
                        workspaceRoot: row.workspaceRoot,
                        repositoryIdentity: null,
                        faviconPath: row.faviconPath,
                        defaultModelSelection: row.defaultModelSelection,
                        defaultThreadEnvMode: row.defaultThreadEnvMode,
                        scripts: row.scripts,
                        trackedFolders: row.trackedFolders,
                        pinnedAt: row.pinnedAt,
                        archivedAt: row.archivedAt,
                        createdAt: row.createdAt,
                        updatedAt: row.updatedAt,
                        deletedAt: row.deletedAt,
                      })),
                    ),
                    Effect.orDie,
                  ),
              }),
            ),
            Layer.provide(Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({})),
            Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
            Layer.provide(Layer.mock(ProjectSecrets.ProjectSecrets)({})),
            Layer.provideMerge(
              HttpPlatform.layer.pipe(
                Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
                Layer.provideMerge(Etag.layerWeak),
              ),
            ),
            Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          );
          return yield* Effect.acquireUseRelease(
            Effect.sync(() => HttpRouter.toWebHandler(appLayer, { disableLogger: true })),
            ({ handler }) =>
              Effect.promise(() =>
                handler(
                  new Request(`http://127.0.0.1/api/projects/${projectId}/usage`),
                  Context.empty(),
                ),
              ),
            ({ dispose }) => Effect.promise(dispose),
          );
        });

      // Member with project access and access:read gets accurate usage + resolved limits.
      const memberResp = yield* callUsage(PROJECT_ID, {
        principalId: MEMBER_ID,
        binding: { _tag: "principal" },
        scopes: [AuthAccessReadScope],
      });
      expect(memberResp.status).toBe(200);
      const body = yield* Effect.promise(() => memberResp.json());
      expect(body).toEqual({
        projectId: PROJECT_ID,
        activeThreads: 2,
        worktrees: 2,
        diskBytes: 42_000,
        sampledAt: NOW_ISO,
        limits: {
          maxActiveThreads: 8,
          maxWorktrees: DEFAULT_PROJECT_MAX_WORKTREES,
          diskBytes: DEFAULT_PROJECT_DISK_BYTES,
          attachmentBytes: 200 * 1024 * 1024,
        },
        warnings: [],
      });

      // Member without access:read scope gets 403.
      const missingScopeResp = yield* callUsage(PROJECT_ID, {
        principalId: MEMBER_ID,
        binding: { _tag: "principal" },
        scopes: [AuthOrchestrationReadScope],
      });
      expect(missingScopeResp.status).toBe(403);

      // Outsider without membership on PROJECT_ID gets 403.
      const outsiderResp = yield* callUsage(PROJECT_ID, {
        principalId: OUTSIDER_ID,
        binding: { _tag: "principal" },
        scopes: [AuthAccessReadScope],
      });
      expect(outsiderResp.status).toBe(403);

      // Owner can read any project's usage, and gets 404 for unknown project.
      const ownerResp = yield* callUsage(OTHER_PROJECT_ID, {
        principalId: OWNER_ID,
        binding: { _tag: "environment" },
        scopes: [AuthAccessReadScope],
      });
      expect(ownerResp.status).toBe(200);
      const ownerBody = yield* Effect.promise(() => ownerResp.json());
      expect(ownerBody).toMatchObject({
        projectId: OTHER_PROJECT_ID,
        activeThreads: 0,
        worktrees: 0,
        diskBytes: 0,
        sampledAt: null,
        limits: {
          maxActiveThreads: DEFAULT_PROJECT_MAX_ACTIVE_THREADS,
          maxWorktrees: DEFAULT_PROJECT_MAX_WORKTREES,
          diskBytes: DEFAULT_PROJECT_DISK_BYTES,
        },
      });

      const missingProjectResp = yield* callUsage("nonexistent-project", {
        principalId: OWNER_ID,
        binding: { _tag: "environment" },
        scopes: [AuthAccessReadScope],
      });
      expect(missingProjectResp.status).toBe(404);
    }).pipe(Effect.scoped, Effect.provide(makeQuotaTestLayer())),
);
