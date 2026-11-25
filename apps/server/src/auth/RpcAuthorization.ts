import {
  CLIENT_GUARDED_RPC_SCOPES,
  type DeviceListInput,
  clientRpcRequiredScopes,
  containsSecretReference,
  authScopeRequiredResponse,
  AssetCreateUrlInput,
  AuthAccessReadScope,
  ServerSettingsPatch,
  ProviderInstanceMutation,
  requiredScopesForServerSettingsPatch,
  requiredScopesForProjectMutation,
  ProjectMutation,
  SecretRequestAnswerInput,
  AuthSettingsWriteScope,
  AuthProvidersManageScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthDiagnosticsReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthTerminalOperateScope,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
  AuthTerminalReadScope,
  type AuthEnvironmentScope,
  EnvironmentAuthorizationError,
  ProjectForbiddenError,
  ProjectId,
  RpcScopeAuthorization,
  WS_METHODS,
  WsRpcGroup,
  intersectScopes,
  passesProjectChecks,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type * as ProjectAccess from "../access/ProjectAccess.ts";
import type * as ResourceResolver from "../access/ResourceResolver.ts";
import { isProviderSignOutPrompt } from "../orchestration-v2/CommandPolicy.ts";

type WsRpcMethod = RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"];

export const RPC_REQUIRED_SCOPES = {
  ...CLIENT_GUARDED_RPC_SCOPES,
  [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.getWorkflowScript]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getNativeChildWork]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.forceStopThread]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.getTurnDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.searchThreads]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.searchThread]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.searchThreadStream]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadTitles]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadLinkMetadata]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.getTurnItem]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.launchThread]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput]: AuthOrchestrationReadScope,
  [ORCHESTRATION_V2_WS_METHODS.subscribePromptSuggestion]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsMutate]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverProbe]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetNpmRelease]: AuthOrchestrationReadScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateProvider]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthStart]: AuthProvidersManageScope,
  [WS_METHODS.providerConsumeResetCredit]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthComplete]: AuthProvidersManageScope,
  [WS_METHODS.providerMcpSignInStart]: AuthProvidersManageScope,
  [WS_METHODS.providerMcpSignInComplete]: AuthProvidersManageScope,
  [WS_METHODS.chatGptReconnectProfile]: AuthProvidersManageScope,
  [WS_METHODS.chatGptImportProfile]: AuthProvidersManageScope,
  [WS_METHODS.chatGptHandoffSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthRespond]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthCancel]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthRemoveMethod]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthLogout]: AuthProvidersManageScope,
  [WS_METHODS.providerAuthSubscribe]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallStart]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallCancel]: AuthProvidersManageScope,
  [WS_METHODS.providerInstallSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.providerInstallRemove]: AuthProvidersManageScope,
  [WS_METHODS.serverUpdateServer]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverUpdateServerWithProgress]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverCommitDesktopUpdate]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverUpsertKeybinding]: AuthSettingsWriteScope,
  [WS_METHODS.serverRemoveKeybinding]: AuthSettingsWriteScope,
  [WS_METHODS.serverGetStorageCleanupReport]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetDatabaseStorage]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetSettings]: AuthOrchestrationReadScope,
  [WS_METHODS.peerLinksList]: AuthAccessReadScope,
  // Names only, so a client that reads threads can open a linked environment's.
  [WS_METHODS.peerLinksNames]: AuthOrchestrationReadScope,
  // A linked environment's thread is read as this one's own are.
  [WS_METHODS.peerLinksSubscribeThread]: AuthOrchestrationReadScope,
  [WS_METHODS.peerLinksThreadHistoryPage]: AuthOrchestrationReadScope,
  [WS_METHODS.peerLinksThreadItem]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateSettings]: AuthSettingsWriteScope,
  [WS_METHODS.serverSearchAcpRegistry]: AuthOrchestrationReadScope,
  [WS_METHODS.serverPrepareAcpRegistryAgent]: AuthProvidersManageScope,
  [WS_METHODS.serverUninstallAcpRegistryManagedBinary]: AuthProvidersManageScope,
  [WS_METHODS.serverAcceptAcpRegistryUrlAuth]: AuthProvidersManageScope,
  [WS_METHODS.serverListAcpRegistrySessions]: AuthOrchestrationReadScope,
  [WS_METHODS.serverImportAcpRegistrySession]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverDeleteAcpRegistrySession]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverListAcpRegistryProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.serverSetAcpRegistryProvider]: AuthProvidersManageScope,
  [WS_METHODS.serverDisableAcpRegistryProvider]: AuthProvidersManageScope,
  [WS_METHODS.serverLogoutAcpRegistry]: AuthProvidersManageScope,
  [WS_METHODS.serverDiscoverSourceControl]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetTraceDiagnostics]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetProcessDiagnostics]: AuthDiagnosticsReadScope,
  // Thread load balancing reads host load, so it needs thread scope rather than diagnostics scope.
  [WS_METHODS.serverGetHostResources]: AuthOrchestrationReadScope,
  [WS_METHODS.serverGetProcessResourceHistory]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetResourceTelemetryHistory]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverRetryResourceTelemetry]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverGetUsageSummary]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverRefreshUsageRates]: AuthDiagnosticsReadScope,
  [WS_METHODS.serverSignalProcess]: AuthEnvironmentMaintainScope,
  [WS_METHODS.serverReportClientActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.scheduledTasksSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.workflowsSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.workflowsCounts]: AuthOrchestrationReadScope,
  [WS_METHODS.workflowsGet]: AuthOrchestrationReadScope,
  [WS_METHODS.workflowsGetDefinition]: AuthFilesystemReadScope,
  [WS_METHODS.secretsAnswerRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.agentFeedbackAnswerRequest]: AuthOrchestrationOperateScope,
  // Delivery logs hold request bodies, so they need the same scope as the URL.
  [WS_METHODS.scheduledTasksListWebhookDeliveries]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksGetWebhookDelivery]: AuthOrchestrationOperateScope,
  [WS_METHODS.cloudGetRelayClientStatus]: AuthRelayReadScope,
  [WS_METHODS.cloudInstallRelayClient]: AuthRelayWriteScope,
  [WS_METHODS.pullRequestsList]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsListStats]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsFilterOptions]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSummary]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRouting]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsRoutingIdentity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsStack]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsLinkedThreads]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.issuesList]: AuthOrchestrationReadScope,
  [WS_METHODS.issuesDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.issuesComments]: AuthOrchestrationReadScope,
  [WS_METHODS.issuesTemplates]: AuthOrchestrationReadScope,
  [WS_METHODS.issuesCandidates]: AuthOrchestrationReadScope,
  [WS_METHODS.issuesLinkedThreads]: AuthOrchestrationReadScope,
  [WS_METHODS.issueTrackersList]: AuthOrchestrationReadScope,
  [WS_METHODS.issueTrackersConnect]: AuthSettingsWriteScope,
  [WS_METHODS.issueTrackersBindProject]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsPreview]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsChecks]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsActivity]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsReviewGuide]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsThreadComments]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsDiffFileContents]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsFilesViewed]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsChangeBreakdown]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsInvalidate]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsReportState]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSubscribeRefreshes]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsSubscribeLinkedThreadRefreshes]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsReviewerCandidates]: AuthOrchestrationReadScope,
  [WS_METHODS.pullRequestsLabelCandidates]: AuthOrchestrationReadScope,
  [WS_METHODS.sourceControlLookupRepository]: AuthOrchestrationReadScope,
  [WS_METHODS.sourceControlAppAccess]: AuthOrchestrationReadScope,
  [WS_METHODS.sourceControlStarred]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeProjectClones]: AuthOrchestrationReadScope,
  [WS_METHODS.projectsListEntries]: AuthFilesystemReadScope,
  [WS_METHODS.projectsListIgnoredFiles]: AuthFilesystemReadScope,
  [WS_METHODS.projectsReadFile]: AuthFilesystemReadScope,
  [WS_METHODS.projectsSearchContents]: AuthFilesystemReadScope,
  [WS_METHODS.projectsSearchEntries]: AuthFilesystemReadScope,
  [WS_METHODS.projectsWriteFile]: AuthFilesystemWriteScope,
  [WS_METHODS.projectsEnsureScratch]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateNew]: AuthOrchestrationOperateScope,
  [WS_METHODS.shellOpenInEditor]: AuthOrchestrationOperateScope,
  [WS_METHODS.filesystemBrowse]: AuthFilesystemReadScope,
  [WS_METHODS.workspaceListFolders]: AuthFilesystemReadScope,
  [WS_METHODS.workspaceScanFolders]: AuthFilesystemReadScope,
  [WS_METHODS.workspaceTaskFolder]: AuthFilesystemReadScope,
  [WS_METHODS.filesystemGetMetadata]: AuthFilesystemReadScope,
  [WS_METHODS.agentSessionsScan]: AuthOrchestrationReadScope,
  [WS_METHODS.agentSessionsImport]: AuthOrchestrationOperateScope,
  [WS_METHODS.assetsCreateUrl]: AuthOrchestrationReadScope,
  [WS_METHODS.assetsPersistChatAttachments]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsCreateUploadUrl]: AuthOrchestrationOperateScope,
  [WS_METHODS.attachmentsDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.providerUploadFeedback]: AuthOrchestrationOperateScope,
  [WS_METHODS.mcpAppsCallTool]: AuthOrchestrationOperateScope,
  [WS_METHODS.mcpAppsToolInfo]: AuthOrchestrationReadScope,
  [WS_METHODS.mcpAppsReadResource]: AuthOrchestrationReadScope,
  [WS_METHODS.mcpAppsUpdateModelContext]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeVcsStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeVcsBranch]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsRefreshBranch]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeWorktreeSetup]: AuthOrchestrationReadScope,
  [WS_METHODS.worktreeSetupCancel]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeResourceTelemetry]: AuthDiagnosticsReadScope,
  [WS_METHODS.vcsRefreshStatus]: AuthOrchestrationReadScope,
  [WS_METHODS.gitResolvePullRequest]: AuthOrchestrationReadScope,
  [WS_METHODS.vcsListRefs]: AuthOrchestrationReadScope,
  [WS_METHODS.reviewGetBranchCommits]: AuthFilesystemReadScope,
  [WS_METHODS.reviewGetDiffPreview]: AuthFilesystemReadScope,
  [WS_METHODS.reviewGetDiffFileContents]: AuthFilesystemReadScope,
  [WS_METHODS.terminalOpen]: AuthTerminalOperateScope,
  [WS_METHODS.terminalAttach]: AuthTerminalOperateScope,
  [WS_METHODS.terminalObserve]: AuthTerminalReadScope,
  [WS_METHODS.terminalWrite]: AuthTerminalOperateScope,
  [WS_METHODS.terminalResize]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClear]: AuthTerminalOperateScope,
  [WS_METHODS.terminalClose]: AuthTerminalOperateScope,
  [WS_METHODS.subscribeTerminalMetadata]: AuthTerminalReadScope,
  [WS_METHODS.previewOpen]: AuthPreviewOperateScope,
  [WS_METHODS.previewResize]: AuthPreviewOperateScope,
  [WS_METHODS.previewAdjust]: AuthPreviewOperateScope,
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  [WS_METHODS.previewList]: AuthOrchestrationReadScope,
  [WS_METHODS.previewClearProfile]: AuthPreviewOperateScope,
  [WS_METHODS.previewReportProfiles]: AuthPreviewOperateScope,
  [WS_METHODS.previewReportStatus]: AuthPreviewOperateScope,
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  [WS_METHODS.subscribePreviewEvents]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeDiscoveredLocalServers]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceConfigure]: AuthSettingsWriteScope,
  [WS_METHODS.deviceTestHost]: AuthSettingsWriteScope,
  [WS_METHODS.deviceEasAccount]: AuthSettingsWriteScope,
  [WS_METHODS.deviceSimlockIdentity]: AuthSettingsWriteScope,
  [WS_METHODS.deviceList]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceClose]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceShutdown]: AuthOrchestrationOperateScope,
  [WS_METHODS.deviceDetail]: AuthOrchestrationReadScope,
  [WS_METHODS.deviceAction]: AuthOrchestrationOperateScope,
  [WS_METHODS.subscribeDeviceState]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerConfig]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeServerLifecycle]: AuthOrchestrationReadScope,
  [WS_METHODS.subscribeAuthAccess]: AuthAccessReadScope,
} as const satisfies Readonly<Record<WsRpcMethod, AuthEnvironmentScope>>;

export function requiredScopeForRpcMethod(method: string): AuthEnvironmentScope {
  if (!Object.hasOwn(RPC_REQUIRED_SCOPES, method)) {
    throw new Error(`RPC method ${method} has no declared authorization scope.`);
  }
  const requiredScope = RPC_REQUIRED_SCOPES[method as WsRpcMethod];
  if (requiredScope === undefined) {
    throw new Error(`RPC method ${method} has no declared authorization scope.`);
  }
  return requiredScope;
}

export const rpcAuthorizationError = (requiredScope: AuthEnvironmentScope) =>
  new EnvironmentAuthorizationError({
    message: `The authenticated token is missing required scope: ${requiredScope}.`,
    ...authScopeRequiredResponse(requiredScope),
  });

const SettingsUpdate = Schema.Struct({
  patch: ServerSettingsPatch,
  providerInstanceMutation: Schema.optionalKey(ProviderInstanceMutation),
});
// Middleware receives the payload already decoded, so it is checked against the decoded shape.
const decodeSettingsUpdate = Schema.decodeUnknownSync(Schema.toType(SettingsUpdate));

const requiredScopesForSettingsUpdate = (payload: unknown) => {
  const input = decodeSettingsUpdate(payload);
  const scopes = requiredScopesForServerSettingsPatch(input.patch);
  if (input.providerInstanceMutation === undefined) return scopes;
  return Object.values(input.patch).every((value) => value === undefined)
    ? [AuthProvidersManageScope]
    : [...new Set([...scopes, AuthProvidersManageScope])];
};

const decodeProjectMutation = Schema.decodeUnknownSync(ProjectMutation);
const decodeAssetCreateUrlInput = Schema.decodeUnknownSync(AssetCreateUrlInput);
const decodeSecretRequestAnswer = Schema.decodeUnknownSync(SecretRequestAnswerInput);

/**
 * A queued edit that omits `attachments` keeps the queued ones, which a payload cannot show;
 * ThreadMessageIntake.dispatchCommand decides that case.
 */
const sendsProviderSignOutPrompt = (method: string, payload: unknown): boolean => {
  if (method === ORCHESTRATION_V2_WS_METHODS.launchThread) {
    const message = (payload as OrchestrationV2ThreadLaunchInput).initialMessage;
    return message !== undefined && isProviderSignOutPrompt(message);
  }
  if (method !== ORCHESTRATION_V2_WS_METHODS.dispatchCommand) return false;
  const command = payload as OrchestrationV2Command;
  switch (command.type) {
    case "message.dispatch":
      return isProviderSignOutPrompt(command);
    case "queued-run.edit":
      return (
        command.attachments !== undefined &&
        isProviderSignOutPrompt({ text: command.text, attachments: command.attachments })
      );
    case "delegated_task.request":
      return isProviderSignOutPrompt({ text: command.task, attachments: [] });
    default:
      return false;
  }
};

const requiredScopesForRpcCall = (
  method: string,
  payload: unknown,
): ReadonlyArray<AuthEnvironmentScope> => {
  if (method === WS_METHODS.serverRetryResourceTelemetry) {
    return [AuthEnvironmentMaintainScope, AuthDiagnosticsReadScope];
  }
  if (method === WS_METHODS.assetsCreateUrl) {
    const { resource } = decodeAssetCreateUrlInput(payload);
    return [
      resource._tag === "workspace-file" ||
      resource._tag === "media-file" ||
      resource._tag === "draft-workspace-file" ||
      (resource._tag === "native-app-icon" && resource.app._tag === "app-path")
        ? AuthFilesystemReadScope
        : AuthOrchestrationReadScope,
    ];
  }
  if (method === WS_METHODS.serverUpdateSettings) return requiredScopesForSettingsUpdate(payload);
  // These send the credential they are given to a URL the caller names, as a saved setting would.
  if (
    (method === WS_METHODS.deviceSimlockIdentity ||
      method === WS_METHODS.deviceEasAccount ||
      method === WS_METHODS.serverListTextGeneratorModels) &&
    containsSecretReference(payload)
  ) {
    return [AuthSettingsWriteScope, AuthProvidersManageScope];
  }
  // A reference answer has the server read a secret the caller names, as a saved reference does.
  // Typed values can use any field names, so the answer's type decides, not its shape.
  if (
    method === WS_METHODS.secretsAnswerRequest &&
    decodeSecretRequestAnswer(payload).answer.type === "reference"
  ) {
    return [AuthOrchestrationOperateScope, AuthProvidersManageScope];
  }
  if (method === WS_METHODS.projectsMutate) {
    return requiredScopesForProjectMutation(decodeProjectMutation(payload));
  }
  const guarded = clientRpcRequiredScopes(method, payload);
  const scopes = guarded.length > 0 ? guarded : [requiredScopeForRpcMethod(method)];
  return sendsProviderSignOutPrompt(method, payload)
    ? [...scopes, AuthProvidersManageScope]
    : scopes;
};

const NON_OWNER_WRITABLE_SETTINGS_KEYS = new Set<string>([
  "projectSettingsOverrides",
  "projectScriptOverrides",
]);

/**
 * Non-owners may only update `projectSettingsOverrides` and `projectScriptOverrides` for projects
 * where they hold `project:settings`; all other settings remain owner-only.
 */
export const assertServerSettingsUpdateAuthorized = Effect.fnUntraced(function* (input: {
  readonly actor: ProjectAccess.AccessActor;
  readonly patch: ServerSettingsPatch;
  readonly providerInstanceMutation: ProviderInstanceMutation | undefined;
  readonly assertProject: ProjectAccess.ProjectAccess["Service"]["assert"];
}) {
  const { actor, patch, providerInstanceMutation, assertProject } = input;
  if (actor.isOwner || passesProjectChecks(actor.binding)) {
    return;
  }
  if (patch.multiUser !== undefined) {
    return yield* new EnvironmentAuthorizationError({
      message: "Only the environment owner may change multi-user mode.",
      ...authScopeRequiredResponse(AuthEnvironmentMaintainScope),
    });
  }
  if (providerInstanceMutation !== undefined) {
    return yield* new EnvironmentAuthorizationError({
      message: "Only the environment owner may modify provider instances.",
      ...authScopeRequiredResponse(AuthProvidersManageScope),
    });
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!NON_OWNER_WRITABLE_SETTINGS_KEYS.has(key)) {
      return yield* new EnvironmentAuthorizationError({
        message: `Only the environment owner may update setting "${key}". Non-owners may only update projectSettingsOverrides and projectScriptOverrides for projects they administer.`,
        ...authScopeRequiredResponse(AuthEnvironmentMaintainScope),
      });
    }
  }
  if (containsSecretReference(patch)) {
    return yield* new EnvironmentAuthorizationError({
      message: "Only the environment owner may configure secret references.",
      ...authScopeRequiredResponse(AuthProvidersManageScope),
    });
  }
  const projectIds = new Set<string>([
    ...Object.keys(patch.projectSettingsOverrides ?? {}),
    ...Object.keys(patch.projectScriptOverrides ?? {}),
  ]);
  for (const projectId of projectIds) {
    yield* assertProject(actor, projectId, "project:settings");
  }
});

export const WS_CLOSE_CODE_UNAUTHORIZED = 4401;
const WS_CLOSE_CODE_FORBIDDEN = 4403;
export type RevocationCloseCode =
  | typeof WS_CLOSE_CODE_UNAUTHORIZED
  | typeof WS_CLOSE_CODE_FORBIDDEN;

export interface RpcAccessGate {
  readonly getActor: Effect.Effect<ProjectAccess.AccessActor>;
  readonly refresh: () => Effect.Effect<
    ProjectAccess.AccessActor,
    ProjectForbiddenError | EnvironmentAuthorizationError
  >;
  readonly refreshForStream: () => Effect.Effect<
    ProjectAccess.AccessActor,
    EnvironmentAuthorizationError
  >;
  readonly check: (
    method: string,
    payload: unknown,
    actor?: ProjectAccess.AccessActor,
  ) => Effect.Effect<void, ProjectForbiddenError | EnvironmentAuthorizationError>;
  readonly checkThreadStreamAccess: (
    threadId: string,
    knownProjectId?: string,
  ) => Effect.Effect<string | undefined, EnvironmentAuthorizationError>;
}

/**
 * Resolves the target project(s) and capability for an RPC call and asserts
 * project access. Owner and environment-binding actors pass without lookups;
 * missing threads pass through so snapshot handlers answer 404.
 */
export function makeAccessGate(
  input: (
    | { readonly actor: ProjectAccess.AccessActor; readonly actorRef?: undefined }
    | { readonly actorRef: Ref.Ref<ProjectAccess.AccessActor>; readonly actor?: undefined }
  ) & {
    readonly access: Pick<
      ProjectAccess.ProjectAccess["Service"],
      "accessibleProjectIds" | "assert" | "can"
    > & {
      readonly refresh?: ProjectAccess.ProjectAccess["Service"]["refresh"];
    };
    readonly resolver: Pick<
      ResourceResolver.ResourceResolver["Service"],
      "capabilityForRpcCall" | "resourcesForRpcCall" | "resolveThreadProject"
    >;
    readonly onRevoked?: (code: RevocationCloseCode, reason: string) => Effect.Effect<void>;
  },
): RpcAccessGate {
  const getActor: Effect.Effect<ProjectAccess.AccessActor> =
    input.actorRef !== undefined ? Ref.get(input.actorRef) : Effect.succeed(input.actor);
  let hadAccessibleProjects = false;

  const notifyRevoked = (code: RevocationCloseCode, reason: string): Effect.Effect<void> =>
    input.onRevoked === undefined ? Effect.void : input.onRevoked(code, reason);

  const refresh = Effect.fnUntraced(function* () {
    const current = yield* getActor;
    if (input.actorRef === undefined || input.access.refresh === undefined) {
      return current;
    }
    const prevAccessible = input.access.accessibleProjectIds(current);
    if (prevAccessible !== undefined && prevAccessible.size > 0) {
      hadAccessibleProjects = true;
    }
    const refreshed = yield* input.access.refresh(current).pipe(
      Effect.catchTags({
        AccessResolveError: (error) =>
          (error.reason === "repository_error"
            ? Effect.void
            : notifyRevoked(WS_CLOSE_CODE_UNAUTHORIZED, error.reason)
          ).pipe(
            Effect.andThen(
              Effect.fail(
                new EnvironmentAuthorizationError({
                  message: error.message,
                  ...authScopeRequiredResponse(AuthOrchestrationReadScope),
                }),
              ),
            ),
          ),
      }),
    );
    if (refreshed !== current) {
      yield* Ref.set(input.actorRef, refreshed);
    }
    const nextAccessible = input.access.accessibleProjectIds(refreshed);
    if (nextAccessible !== undefined && nextAccessible.size > 0) {
      hadAccessibleProjects = true;
    }
    if (hadAccessibleProjects && nextAccessible !== undefined && nextAccessible.size === 0) {
      yield* notifyRevoked(WS_CLOSE_CODE_FORBIDDEN, "project_access_revoked");
      return yield* new ProjectForbiddenError({
        message: "No accessible projects remain for this session.",
        projectId: ProjectId.make("environment"),
        requiredPermission: "project:read",
      });
    }
    return refreshed;
  });

  const refreshForStream = Effect.fnUntraced(function* () {
    return yield* refresh().pipe(
      Effect.catchTags({
        project_forbidden: (error) =>
          Effect.fail(
            new EnvironmentAuthorizationError({
              message: error.message,
              ...authScopeRequiredResponse(AuthOrchestrationReadScope),
            }),
          ),
      }),
    );
  });

  const checkThreadStreamAccess = Effect.fnUntraced(function* (
    threadId: string,
    knownProjectId?: string,
  ) {
    const actor = yield* refreshForStream();
    const accessibleIds = input.access.accessibleProjectIds(actor);
    if (accessibleIds === undefined) {
      return knownProjectId;
    }
    const projectId = knownProjectId ?? (yield* input.resolver.resolveThreadProject(threadId));
    if (projectId !== undefined && !input.access.can(actor, projectId, "project:read")) {
      yield* notifyRevoked(WS_CLOSE_CODE_FORBIDDEN, "resource_access_revoked");
      return yield* new EnvironmentAuthorizationError({
        message: "The authenticated session no longer has access to this thread.",
        ...authScopeRequiredResponse(AuthOrchestrationReadScope),
      });
    }
    return projectId;
  });

  const check = Effect.fnUntraced(function* (
    method: string,
    payload: unknown,
    actorOverride?: ProjectAccess.AccessActor,
  ) {
    const actor = actorOverride ?? (yield* getActor);
    if (method === WS_METHODS.serverUpdateSettings) {
      const { patch, providerInstanceMutation } = decodeSettingsUpdate(payload);
      yield* assertServerSettingsUpdateAuthorized({
        actor,
        patch,
        providerInstanceMutation,
        assertProject: input.access.assert,
      });
    }
    const capability = input.resolver.capabilityForRpcCall(method, payload);
    if (capability === undefined) return;
    const accessibleIds = input.access.accessibleProjectIds(actor);
    if (accessibleIds === undefined) return;
    const resources = input.resolver.resourcesForRpcCall(method, payload);

    if (capability === "project:create" && resources?.projectId === undefined) {
      const canCreate = Array.from(accessibleIds).some((projectId) =>
        input.access.can(actor, projectId, "project:create"),
      );
      if (!canCreate) {
        return yield* new ProjectForbiddenError({
          message: "Missing required capability project:create.",
          projectId: ProjectId.make("environment"),
          requiredPermission: "project:create",
        });
      }
      if (resources === undefined) return;
    }

    if (resources === undefined) return;

    if (resources.projectId !== undefined) {
      yield* input.access.assert(actor, resources.projectId, capability);
    }
    if (resources.projectIds !== undefined) {
      for (const projectId of resources.projectIds) {
        yield* input.access.assert(actor, projectId, capability);
      }
    }
    if (resources.threadId !== undefined) {
      const threadProjectId = yield* input.resolver.resolveThreadProject(resources.threadId);
      if (threadProjectId !== undefined && threadProjectId !== resources.projectId) {
        yield* input.access.assert(actor, threadProjectId, capability);
      }
    }
  });

  return {
    getActor,
    refresh,
    refreshForStream,
    check,
    checkThreadStreamAccess,
  };
}

/**
 * `onAuthorized` runs once after an authorized request succeeds; for a stream
 * RPC, that is when the stream completes. Every RPC passes through here, so it
 * is the one place to observe requests without wrapping each handler.
 */
export const layer = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  onAuthorized?: (method: string, payload: unknown) => Effect.Effect<void>,
  access?: RpcAccessGate,
) =>
  Layer.succeed(RpcScopeAuthorization)((effect, { rpc, payload }) => {
    const requiredScopes = requiredScopesForRpcCall(rpc._tag, payload);
    const authorize = Effect.gen(function* () {
      const actor = access === undefined ? undefined : yield* access.refresh();
      const effectiveScopes =
        actor === undefined || actor.isOwner || actor.ceiling === undefined
          ? scopes
          : intersectScopes(scopes, actor.ceiling);
      const requiredScope = requiredScopes.find((scope) => !effectiveScopes.includes(scope));
      if (requiredScope !== undefined) {
        return yield* rpcAuthorizationError(requiredScope);
      }
      if (access !== undefined) {
        yield* access.check(rpc._tag, payload, actor);
      }
    });
    const authorized = Effect.andThen(authorize, effect);
    return onAuthorized === undefined
      ? authorized
      : Effect.tap(authorized, () => onAuthorized(rpc._tag, payload));
  });

/** Retrying can install or restart tools even though ordinary listing is readable. */
export const requiredScopeForDeviceList = (input: DeviceListInput): AuthEnvironmentScope =>
  input.retryHostId || input.updateTool
    ? AuthOrchestrationOperateScope
    : AuthOrchestrationReadScope;
