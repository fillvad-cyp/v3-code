import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  CrmClientId,
  ORCHESTRATION_V2_WS_METHODS,
  PrincipalId,
  type ProjectCapability,
  ProjectId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as CrmRepo from "../persistence/Crm.ts";

export interface RpcResource {
  readonly projectId?: string;
  readonly threadId?: string;
  readonly terminalId?: string;
  readonly projectIds?: ReadonlyArray<string>;
}

export type CrmHttpEndpointName =
  | "listClients"
  | "createClient"
  | "getClient"
  | "updateClient"
  | "deleteClient"
  | "listContacts"
  | "createContact"
  | "updateContact"
  | "deleteContact"
  | "listNotes"
  | "createNote"
  | "updateNote"
  | "deleteNote"
  | "listClientThreads"
  | "linkClientThread"
  | "unlinkClientThread"
  | "inviteClient"
  | "exportCrm";

export interface CrmHttpResource {
  readonly projectId: ProjectId;
  readonly clientId?: CrmClientId;
  readonly threadId?: ThreadId;
  readonly capability: ProjectCapability;
}

/** Required project capability for each `/api/projects/:id/crm/*` HTTP endpoint. */
const CRM_HTTP_CAPABILITIES: Readonly<Record<CrmHttpEndpointName, ProjectCapability>> = {
  listClients: "project:crm.read",
  createClient: "project:crm.write",
  getClient: "project:crm.read",
  updateClient: "project:crm.write",
  deleteClient: "project:crm.write",
  listContacts: "project:crm.read",
  createContact: "project:crm.write",
  updateContact: "project:crm.write",
  deleteContact: "project:crm.write",
  listNotes: "project:crm.read",
  createNote: "project:crm.write",
  updateNote: "project:crm.write",
  deleteNote: "project:crm.write",
  listClientThreads: "project:crm.read",
  linkClientThread: "project:crm.write",
  unlinkClientThread: "project:crm.write",
  inviteClient: "project:crm.invite_client",
  exportCrm: "project:crm.read",
};

function resourceForCrmHttpEndpoint(
  endpoint: CrmHttpEndpointName,
  params: {
    readonly projectId: ProjectId;
    readonly clientId?: CrmClientId | undefined;
    readonly threadId?: ThreadId | undefined;
  },
): CrmHttpResource {
  return {
    projectId: params.projectId,
    ...(params.clientId === undefined ? {} : { clientId: params.clientId }),
    ...(params.threadId === undefined ? {} : { threadId: params.threadId }),
    capability: CRM_HTTP_CAPABILITIES[endpoint],
  };
}

const THREAD_MANAGE_COMMANDS = new Set<string>([
  "thread.archive",
  "thread.unarchive",
  "thread.delete",
  "thread.tag.set",
  "thread.fork",
  "thread.merge_back",
]);

/**
 * Default project capability per WS RPC method, matching docs/internals/18_multi-user.md §2.3.
 * Methods absent from this table are environment-wide or covered solely by the scope gate.
 */
const METHOD_CAPABILITIES: Readonly<Partial<Record<string, ProjectCapability>>> = {
  // Orchestration reads
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.subscribePromptSuggestion]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.searchThreads]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.searchThread]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.getThreadTitles]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.getThreadLinkMetadata]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: "project:read",
  [ORCHESTRATION_V2_WS_METHODS.getNativeChildWork]: "project:read",

  // Orchestration operations
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: "project:thread.operate",
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: "project:thread.operate",
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: "project:thread.operate",
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: "project:thread.operate",

  // Projects & files
  [WS_METHODS.projectsMutate]: "project:settings",
  [WS_METHODS.projectsCreateNew]: "project:create",
  [WS_METHODS.projectsCreateFromThread]: "project:create",
  [WS_METHODS.projectsEnsureScratch]: "project:create",
  [WS_METHODS.projectsListEntries]: "project:read",
  [WS_METHODS.projectsListIgnoredFiles]: "project:read",
  [WS_METHODS.projectsReadFile]: "project:read",
  [WS_METHODS.projectsSearchContents]: "project:read",
  [WS_METHODS.projectsSearchEntries]: "project:read",
  [WS_METHODS.projectsWriteFile]: "project:file.write",
  [WS_METHODS.projectCloneStart]: "project:source.write",
  [WS_METHODS.projectCloneCancel]: "project:source.write",
  [WS_METHODS.projectCloneRetry]: "project:source.write",

  // Terminal
  [WS_METHODS.terminalObserve]: "project:terminal.read",
  [WS_METHODS.subscribeTerminalMetadata]: "project:terminal.read",
  [WS_METHODS.terminalOpen]: "project:terminal.operate",
  [WS_METHODS.terminalAttach]: "project:terminal.operate",
  [WS_METHODS.terminalWrite]: "project:terminal.operate",
  [WS_METHODS.terminalResize]: "project:terminal.operate",
  [WS_METHODS.terminalClear]: "project:terminal.operate",
  [WS_METHODS.terminalClose]: "project:terminal.operate",

  // Preview
  [WS_METHODS.previewList]: "project:read",
  [WS_METHODS.previewOpen]: "project:preview.operate",
  [WS_METHODS.previewResize]: "project:preview.operate",
  [WS_METHODS.previewAdjust]: "project:preview.operate",
  [WS_METHODS.previewClose]: "project:preview.operate",
  [WS_METHODS.previewReportStatus]: "project:preview.operate",

  // Thread-scoped helpers
  [WS_METHODS.secretsAnswerRequest]: "project:thread.operate",
  [WS_METHODS.agentFeedbackAnswerRequest]: "project:thread.operate",
  [WS_METHODS.guestShareCreate]: "project:members",
  [WS_METHODS.assetsCreateUrl]: "project:read",
  [WS_METHODS.assetsPersistChatAttachments]: "project:file.write",
  [WS_METHODS.mcpAppsToolInfo]: "project:read",
  [WS_METHODS.mcpAppsReadResource]: "project:read",
  [WS_METHODS.mcpAppsCallTool]: "project:thread.operate",
  [WS_METHODS.mcpAppsUpdateModelContext]: "project:thread.operate",
  [WS_METHODS.subscribeWorktreeSetup]: "project:read",
  [WS_METHODS.worktreeSetupCancel]: "project:thread.operate",

  // VCS, pull requests & issues
  [WS_METHODS.vcsPull]: "project:source.write",
  [WS_METHODS.vcsCreateWorktree]: "project:source.write",
  [WS_METHODS.vcsRemoveWorktree]: "project:source.write",
  [WS_METHODS.vcsCreateRef]: "project:source.write",
  [WS_METHODS.vcsSwitchRef]: "project:source.write",
  [WS_METHODS.vcsInit]: "project:source.write",
  [WS_METHODS.gitRunStackedAction]: "project:source.write",
  [WS_METHODS.gitPreparePullRequestThread]: "project:source.write",
  [WS_METHODS.pullRequestsList]: "project:read",
  [WS_METHODS.pullRequestsListStats]: "project:read",
  [WS_METHODS.pullRequestsFilterOptions]: "project:read",
  [WS_METHODS.pullRequestsSummary]: "project:read",
  [WS_METHODS.pullRequestsRouting]: "project:read",
  [WS_METHODS.pullRequestsRoutingIdentity]: "project:read",
  [WS_METHODS.pullRequestsStack]: "project:read",
  [WS_METHODS.pullRequestsLinkedThreads]: "project:read",
  [WS_METHODS.pullRequestsDetail]: "project:read",
  [WS_METHODS.pullRequestsPreview]: "project:read",
  [WS_METHODS.pullRequestsChecks]: "project:read",
  [WS_METHODS.pullRequestsActivity]: "project:read",
  [WS_METHODS.pullRequestsReviewGuide]: "project:read",
  [WS_METHODS.pullRequestsThreadComments]: "project:read",
  [WS_METHODS.pullRequestsDiffFileContents]: "project:read",
  [WS_METHODS.pullRequestsFilesViewed]: "project:read",
  [WS_METHODS.pullRequestsChangeBreakdown]: "project:read",
  [WS_METHODS.pullRequestsInvalidate]: "project:read",
  [WS_METHODS.pullRequestsReportState]: "project:read",
  [WS_METHODS.pullRequestsReviewerCandidates]: "project:read",
  [WS_METHODS.pullRequestsLabelCandidates]: "project:read",
  [WS_METHODS.pullRequestsGenerateReviewGuide]: "project:thread.operate",
  [WS_METHODS.pullRequestsSetFilesViewed]: "project:source.write",
  [WS_METHODS.pullRequestsRunAction]: "project:source.write",
  [WS_METHODS.pullRequestsUpdate]: "project:source.write",
  [WS_METHODS.pullRequestsComment]: "project:source.write",
  [WS_METHODS.pullRequestsUpdateComment]: "project:source.write",
  [WS_METHODS.pullRequestsSubmitReview]: "project:source.write",
  [WS_METHODS.pullRequestsReplyToThread]: "project:source.write",
  [WS_METHODS.pullRequestsSetThreadResolution]: "project:source.write",
  [WS_METHODS.pullRequestsSetReaction]: "project:source.write",
  [WS_METHODS.pullRequestsRequestReviewers]: "project:source.write",
  [WS_METHODS.pullRequestsSetLabels]: "project:source.write",
  [WS_METHODS.issuesList]: "project:read",
  [WS_METHODS.issuesDetail]: "project:read",
  [WS_METHODS.issuesComments]: "project:read",
  [WS_METHODS.issuesTemplates]: "project:read",
  [WS_METHODS.issuesCandidates]: "project:read",
  [WS_METHODS.issuesLinkedThreads]: "project:read",
  [WS_METHODS.issuesCreate]: "project:source.write",
  [WS_METHODS.issuesComment]: "project:source.write",
  [WS_METHODS.issuesUpdate]: "project:source.write",
  [WS_METHODS.issuesSetState]: "project:source.write",
  [WS_METHODS.issuesReact]: "project:source.write",
  [WS_METHODS.issueTrackersBindProject]: "project:settings",

  // Scheduled tasks & webhooks
  [WS_METHODS.scheduledTasksUpsert]: "project:thread.operate",
  [WS_METHODS.scheduledTasksRotateWebhookToken]: "project:webhooks",
  [WS_METHODS.scheduledTasksListWebhookDeliveries]: "project:webhooks",
  [WS_METHODS.scheduledTasksGetWebhookDelivery]: "project:webhooks",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
): ReadonlyArray<string> | undefined {
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  const items = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return items.length > 0 ? items : undefined;
}

function buildResource(parts: {
  readonly projectId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly terminalId?: string | undefined;
  readonly projectIds?: ReadonlyArray<string> | undefined;
}): RpcResource | undefined {
  const resource: {
    projectId?: string;
    threadId?: string;
    terminalId?: string;
    projectIds?: ReadonlyArray<string>;
  } = {};
  if (parts.projectId !== undefined) resource.projectId = parts.projectId;
  if (parts.threadId !== undefined) resource.threadId = parts.threadId;
  if (parts.terminalId !== undefined) resource.terminalId = parts.terminalId;
  if (parts.projectIds !== undefined) resource.projectIds = parts.projectIds;
  return Object.keys(resource).length > 0 ? resource : undefined;
}

const THREAD_ONLY_METHODS = new Set<string>([
  ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
  ORCHESTRATION_V2_WS_METHODS.getTurnItem,
  ORCHESTRATION_V2_WS_METHODS.subscribeThread,
  ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
  ORCHESTRATION_V2_WS_METHODS.subscribePromptSuggestion,
  ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
  ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff,
  ORCHESTRATION_V2_WS_METHODS.searchThread,
  ORCHESTRATION_V2_WS_METHODS.searchThreadStream,
  ORCHESTRATION_V2_WS_METHODS.getThreadFamily,
  ORCHESTRATION_V2_WS_METHODS.getWorkflowScript,
  ORCHESTRATION_V2_WS_METHODS.getNativeChildWork,
  ORCHESTRATION_V2_WS_METHODS.stopWorkflow,
  ORCHESTRATION_V2_WS_METHODS.forceStopThread,
  WS_METHODS.projectsCreateFromThread,
  WS_METHODS.previewList,
  WS_METHODS.previewOpen,
  WS_METHODS.previewResize,
  WS_METHODS.previewAdjust,
  WS_METHODS.previewClose,
  WS_METHODS.previewReportStatus,
  WS_METHODS.secretsAnswerRequest,
  WS_METHODS.agentFeedbackAnswerRequest,
  WS_METHODS.guestShareCreate,
  WS_METHODS.assetsPersistChatAttachments,
  WS_METHODS.mcpAppsToolInfo,
  WS_METHODS.mcpAppsReadResource,
  WS_METHODS.mcpAppsCallTool,
  WS_METHODS.mcpAppsUpdateModelContext,
  WS_METHODS.subscribeWorktreeSetup,
  WS_METHODS.worktreeSetupCancel,
  WS_METHODS.gitPreparePullRequestThread,
]);

const TERMINAL_METHODS = new Set<string>([
  WS_METHODS.terminalOpen,
  WS_METHODS.terminalAttach,
  WS_METHODS.terminalObserve,
  WS_METHODS.terminalWrite,
  WS_METHODS.terminalResize,
  WS_METHODS.terminalClear,
  WS_METHODS.terminalClose,
]);

const PROJECT_ID_METHODS = new Set<string>([
  WS_METHODS.projectsMutate,
  WS_METHODS.projectCloneStart,
  WS_METHODS.projectCloneCancel,
  WS_METHODS.projectCloneRetry,
  WS_METHODS.issueTrackersBindProject,
  WS_METHODS.issuesList,
  WS_METHODS.issuesDetail,
  WS_METHODS.issuesComments,
  WS_METHODS.issuesTemplates,
  WS_METHODS.issuesCandidates,
  WS_METHODS.issuesLinkedThreads,
  WS_METHODS.issuesCreate,
  WS_METHODS.issuesComment,
  WS_METHODS.issuesUpdate,
  WS_METHODS.issuesSetState,
  WS_METHODS.issuesReact,
  // PR review endpoints carry a GitHub review `threadId`, not an orchestration threadId.
  WS_METHODS.pullRequestsSummary,
  WS_METHODS.pullRequestsRouting,
  WS_METHODS.pullRequestsRoutingIdentity,
  WS_METHODS.pullRequestsStack,
  WS_METHODS.pullRequestsLinkedThreads,
  WS_METHODS.pullRequestsDetail,
  WS_METHODS.pullRequestsPreview,
  WS_METHODS.pullRequestsChecks,
  WS_METHODS.pullRequestsActivity,
  WS_METHODS.pullRequestsReviewGuide,
  WS_METHODS.pullRequestsGenerateReviewGuide,
  WS_METHODS.pullRequestsThreadComments,
  WS_METHODS.pullRequestsDiffFileContents,
  WS_METHODS.pullRequestsFilesViewed,
  WS_METHODS.pullRequestsChangeBreakdown,
  WS_METHODS.pullRequestsInvalidate,
  WS_METHODS.pullRequestsReportState,
  WS_METHODS.pullRequestsReviewerCandidates,
  WS_METHODS.pullRequestsLabelCandidates,
  WS_METHODS.pullRequestsSetFilesViewed,
  WS_METHODS.pullRequestsRunAction,
  WS_METHODS.pullRequestsUpdate,
  WS_METHODS.pullRequestsComment,
  WS_METHODS.pullRequestsUpdateComment,
  WS_METHODS.pullRequestsSubmitReview,
  WS_METHODS.pullRequestsReplyToThread,
  WS_METHODS.pullRequestsSetThreadResolution,
  WS_METHODS.pullRequestsSetReaction,
  WS_METHODS.pullRequestsRequestReviewers,
  WS_METHODS.pullRequestsSetLabels,
]);

export function capabilityForRpcCall(
  method: string,
  payload?: unknown,
): ProjectCapability | undefined {
  if (method === WS_METHODS.projectsMutate && isRecord(payload)) {
    switch (payload.type) {
      case "project.create":
        return "project:create";
      case "project.delete":
        return "project:delete";
      case "project.update":
        return "project:settings";
    }
  }
  if (method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand && isRecord(payload)) {
    const commandType = readString(payload, "type");
    if (commandType !== undefined && THREAD_MANAGE_COMMANDS.has(commandType)) {
      return "project:thread.manage";
    }
  }
  if (method === WS_METHODS.scheduledTasksUpsert && isRecord(payload)) {
    if (isRecord(payload.schedule) && payload.schedule.type === "webhook") {
      return "project:webhooks";
    }
  }
  return Object.hasOwn(METHOD_CAPABILITIES, method) ? METHOD_CAPABILITIES[method] : undefined;
}

export function resourcesForRpcCall(method: string, payload: unknown): RpcResource | undefined {
  if (!isRecord(payload)) return undefined;

  if (
    method === ORCHESTRATION_V2_WS_METHODS.launchThread ||
    method === WS_METHODS.gitRunStackedAction ||
    method === WS_METHODS.scheduledTasksUpsert
  ) {
    return buildResource({
      projectId: readString(payload, "projectId"),
      threadId: readString(payload, "threadId"),
    });
  }

  if (method === ORCHESTRATION_V2_WS_METHODS.dispatchCommand) {
    return buildResource({
      projectId: readString(payload, "projectId"),
      threadId:
        readString(payload, "threadId") ??
        readString(payload, "sourceThreadId") ??
        readString(payload, "parentThreadId"),
    });
  }

  if (TERMINAL_METHODS.has(method)) {
    return buildResource({
      threadId: readString(payload, "threadId"),
      terminalId: readString(payload, "terminalId"),
    });
  }

  if (THREAD_ONLY_METHODS.has(method)) {
    return buildResource({ threadId: readString(payload, "threadId") });
  }

  if (method === WS_METHODS.projectsMutate && payload.type === "project.create") {
    return undefined;
  }

  if (PROJECT_ID_METHODS.has(method)) {
    const projectId =
      readString(payload, "projectId") ??
      (isRecord(payload.reference) ? readString(payload.reference, "projectId") : undefined);
    return buildResource({ projectId });
  }

  if (
    method === ORCHESTRATION_V2_WS_METHODS.searchThreads ||
    method === ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads
  ) {
    return buildResource({ projectIds: readStringArray(payload, "projectIds") });
  }

  if (method === WS_METHODS.pullRequestsList || method === WS_METHODS.pullRequestsFilterOptions) {
    return buildResource({
      projectId: readString(payload, "projectId"),
      projectIds: readStringArray(payload, "projectIds"),
    });
  }

  if (method === WS_METHODS.assetsCreateUrl && isRecord(payload.resource)) {
    return buildResource({ threadId: readString(payload.resource, "threadId") });
  }

  return undefined;
}

export class ResourceResolver extends Context.Service<
  ResourceResolver,
  {
    readonly resourcesForRpcCall: (method: string, payload: unknown) => RpcResource | undefined;
    readonly capabilityForRpcCall: (
      method: string,
      payload?: unknown,
    ) => ProjectCapability | undefined;
    readonly resourceForCrmHttpEndpoint: (
      endpoint: CrmHttpEndpointName,
      params: {
        readonly projectId: ProjectId;
        readonly clientId?: CrmClientId | undefined;
        readonly threadId?: ThreadId | undefined;
      },
    ) => CrmHttpResource;
    readonly resolveThreadProject: (
      threadId: ThreadId | string,
    ) => Effect.Effect<string | undefined>;
    readonly resolveCrmClientPrincipal: (
      clientId: CrmClientId | string,
    ) => Effect.Effect<PrincipalId | undefined>;
    readonly resolveCrmClientProject: (
      clientId: CrmClientId | string,
    ) => Effect.Effect<ProjectId | undefined>;
    readonly resolveExternalPrincipalThreadIds: (
      principalId: PrincipalId,
    ) => Effect.Effect<ReadonlySet<string>>;
    readonly isThreadAccessibleByExternalPrincipal: (
      principalId: PrincipalId,
      threadId: ThreadId | string,
    ) => Effect.Effect<boolean>;
  }
>()("v3code/access/ResourceResolver") {}

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const crmRepoOption = yield* Effect.serviceOption(CrmRepo.CrmRepository);

  const resolveThreadProject = Effect.fn("ResourceResolver.resolveThreadProject")(function* (
    threadId: ThreadId | string,
  ) {
    const trimmed = threadId.trim();
    if (trimmed.length === 0) return undefined;
    // Fail closed on missing threads or read errors so callers answer 404 without leaking existence.
    const thread = yield* projections
      .findThread(ThreadId.make(trimmed))
      .pipe(Effect.orElseSucceed(() => null));
    return thread?.projectId;
  });

  const resolveCrmClientPrincipal = Effect.fn("ResourceResolver.resolveCrmClientPrincipal")(
    function* (clientId: CrmClientId | string) {
      const trimmed = clientId.trim();
      if (trimmed.length === 0 || Option.isNone(crmRepoOption)) return undefined;
      const client = yield* crmRepoOption.value
        .getClientById(CrmClientId.make(trimmed))
        .pipe(Effect.orElseSucceed(() => Option.none()));
      return Option.isSome(client) ? (client.value.principalId ?? undefined) : undefined;
    },
  );

  const resolveCrmClientProject = Effect.fn("ResourceResolver.resolveCrmClientProject")(function* (
    clientId: CrmClientId | string,
  ) {
    const trimmed = clientId.trim();
    if (trimmed.length === 0 || Option.isNone(crmRepoOption)) return undefined;
    const client = yield* crmRepoOption.value
      .getClientById(CrmClientId.make(trimmed))
      .pipe(Effect.orElseSucceed(() => Option.none()));
    return Option.isSome(client) ? client.value.projectId : undefined;
  });

  const resolveExternalPrincipalThreadIds = Effect.fn(
    "ResourceResolver.resolveExternalPrincipalThreadIds",
  )(function* (principalId: PrincipalId) {
    if (Option.isNone(crmRepoOption)) return new Set<string>();
    const threadIds = yield* crmRepoOption.value
      .listThreadIdsForPrincipal(principalId)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<ThreadId>));
    return new Set<string>(threadIds);
  });

  const isThreadAccessibleByExternalPrincipal = Effect.fn(
    "ResourceResolver.isThreadAccessibleByExternalPrincipal",
  )(function* (principalId: PrincipalId, threadId: ThreadId | string) {
    const trimmed = threadId.trim();
    if (trimmed.length === 0) return false;
    const allowed = yield* resolveExternalPrincipalThreadIds(principalId);
    return allowed.has(trimmed);
  });

  return ResourceResolver.of({
    resourcesForRpcCall,
    capabilityForRpcCall,
    resourceForCrmHttpEndpoint,
    resolveThreadProject,
    resolveCrmClientPrincipal,
    resolveCrmClientProject,
    resolveExternalPrincipalThreadIds,
    isThreadAccessibleByExternalPrincipal,
  });
});

export const layer = Layer.effect(ResourceResolver, make);
