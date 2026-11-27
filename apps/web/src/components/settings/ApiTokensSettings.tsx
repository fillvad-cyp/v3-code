import { useAtomValue } from "@effect/atom-react";
import {
  type ApiTokenBindingInput,
  type ApiTokenCreateResult,
  type ApiTokenListItem,
  type AuthGrantScope,
  EnvironmentId,
  type MemberWithMemberships,
  type PrincipalId,
  type ProjectId,
  type ProjectRole,
} from "@t3tools/contracts";
import { AUTH_SCOPE_OPTIONS } from "@t3tools/shared/authScopeOptions";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Link, useSearch } from "@tanstack/react-router";
import {
  CheckIcon,
  CopyIcon,
  KeyRoundIcon,
  PlusIcon,
  ShieldAlertIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowSecond } from "../../hooks/useNowSecond";
import { m as resolveMessage } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { authEnvironment } from "../../state/auth";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  API_TOKEN_EXPIRATION_PRESETS,
  API_TOKEN_STATUS_LABELS,
  type ApiTokenExpirationPreset,
  type ApiTokenStatus,
  canBindToPrincipal,
  computeExpiresAtIso,
  deriveApiTokenStatus,
  deriveApiTokensGate,
  formatApiTokenErrorMessage,
  resolveBindableProjects,
  resolveEffectiveScopesForToken,
  sortApiTokens,
} from "./ApiTokensSettings.logic";
import { formatAccessTimestamp } from "./ConnectionsSettings.logic";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { type AssignableProjectRole, PROJECT_ROLE_LABELS } from "./MembersSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { useAccessEnvironment } from "./useAccessEnvironment";

const EMPTY_TOKENS: ReadonlyArray<ApiTokenListItem> = [];
const EMPTY_MEMBERS: ReadonlyArray<MemberWithMemberships> = [];

const SCOPE_TITLE_BY_KEY = new Map(
  AUTH_SCOPE_OPTIONS.map((option) => [option.scope, option.title] as const),
);

function tokenStatusBadgeVariant(status: ApiTokenStatus) {
  if (status === "active") return "success" as const;
  if (status === "expired") return "warning" as const;
  return "secondary" as const;
}

interface CreateApiTokenDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly isOwner: boolean;
  readonly members: ReadonlyArray<MemberWithMemberships>;
  readonly onCreated: () => void;
}

function CreateApiTokenDialog({
  open,
  onOpenChange,
  environmentId,
  isOwner,
  members,
  onCreated,
}: CreateApiTokenDialogProps) {
  const gt = useGT();
  const m = useMessages();
  const session = useEnvironmentSessionState(environmentId);
  const allProjects = useProjects();
  const createApiToken = useAtomCommand(authEnvironment.createApiToken, {
    reportFailure: false,
  });

  const envProjects = allProjects
    .filter((project) => project.environmentId === environmentId)
    .map((project) => ({ id: project.id, title: project.title }));

  const activeMembers = members.filter((entry) => entry.principal.status === "active");
  const selfPrincipalId = session.data?.authenticated ? (session.data.principal?.id ?? null) : null;
  const allowPrincipalBinding = canBindToPrincipal(session.data);

  const [targetPrincipalId, setTargetPrincipalId] = useState<PrincipalId | null>(null);
  const [bindingMode, setBindingMode] = useState<"principal" | "projects">(
    allowPrincipalBinding ? "principal" : "projects",
  );
  const [selectedProjects, setSelectedProjects] = useState<
    Readonly<Record<string, AssignableProjectRole>>
  >({});
  const [selectedScopes, setSelectedScopes] = useState<ReadonlySet<AuthGrantScope>>(
    () => new Set(),
  );
  const [expirationPreset, setExpirationPreset] = useState<ApiTokenExpirationPreset>("90d");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createdResult, setCreatedResult] = useState<ApiTokenCreateResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [manualCopyValue, setManualCopyValue] = useState<string | null>(null);

  const { copyToClipboard } = useCopyToClipboard<string>({
    onCopy: () => {
      setCopied(true);
      setManualCopyValue(null);
    },
    onError: (error, value) => {
      setManualCopyValue(value);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not copy API token"),
          description: error.message || gt("Copy the token manually instead."),
        }),
      );
    },
  });

  const effectiveTargetId = targetPrincipalId ?? selfPrincipalId;
  const effectiveBindingMode = allowPrincipalBinding ? bindingMode : "projects";

  const bindableProjects = resolveBindableProjects({
    session: session.data,
    isOwner,
    targetPrincipalId: effectiveTargetId,
    members,
    projects: envProjects,
  });

  const validSelectedProjectEntries = bindableProjects.flatMap((option) => {
    const role = selectedProjects[option.projectId];
    if (role === undefined) return [];
    const safeRole = option.assignableRoles.includes(role) ? role : option.defaultRole;
    return [{ projectId: option.projectId, role: safeRole }];
  });

  const effectiveScopes = resolveEffectiveScopesForToken({
    session: session.data,
    isOwner,
    targetPrincipalId: effectiveTargetId,
    members,
    bindingMode: effectiveBindingMode,
    selectedProjectRoles: validSelectedProjectEntries.map((entry) => entry.role),
  });

  const effectiveScopeSet = new Set<AuthGrantScope>(effectiveScopes);
  const activeSelectedScopes = effectiveScopes.filter((scope) => selectedScopes.has(scope));

  const scopeOptions = AUTH_SCOPE_OPTIONS.filter((option) => effectiveScopeSet.has(option.scope));

  const resetDialog = () => {
    setTargetPrincipalId(null);
    setBindingMode(allowPrincipalBinding ? "principal" : "projects");
    setSelectedProjects({});
    setSelectedScopes(new Set());
    setExpirationPreset("90d");
    setIsSubmitting(false);
    setErrorMessage(null);
    setCreatedResult(null);
    setCopied(false);
    setManualCopyValue(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetDialog();
    }
    onOpenChange(nextOpen);
  };

  const toggleProject = (projectId: ProjectId, defaultRole: AssignableProjectRole) => {
    setSelectedProjects((prev) => {
      if (projectId in prev) {
        const next = { ...prev };
        delete next[projectId];
        return next;
      }
      return { ...prev, [projectId]: defaultRole };
    });
  };

  const setProjectRole = (projectId: ProjectId, role: AssignableProjectRole) => {
    setSelectedProjects((prev) => ({ ...prev, [projectId]: role }));
  };

  const toggleScope = (scope: AuthGrantScope) => {
    setSelectedScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) {
        next.delete(scope);
      } else {
        next.add(scope);
      }
      return next;
    });
  };

  const handleSelectAllScopes = () => {
    setSelectedScopes(new Set(effectiveScopes));
  };

  const handleClearScopes = () => {
    setSelectedScopes(new Set());
  };

  const handleCreate = async () => {
    if (isSubmitting) return;
    if (effectiveBindingMode === "projects" && validSelectedProjectEntries.length === 0) {
      setErrorMessage(gt("Select at least one project for a project-bound token."));
      return;
    }
    if (activeSelectedScopes.length === 0) {
      setErrorMessage(gt("Select at least one scope for the API token."));
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);

    const binding: ApiTokenBindingInput =
      effectiveBindingMode === "projects"
        ? { _tag: "projects", projects: validSelectedProjectEntries }
        : { _tag: "principal" };
    const expiresAt = computeExpiresAtIso(expirationPreset);

    const result = await createApiToken({
      environmentId,
      input: {
        ...(isOwner && targetPrincipalId !== null && targetPrincipalId !== selfPrincipalId
          ? { principalId: targetPrincipalId }
          : {}),
        scopes: activeSelectedScopes,
        binding,
        expiresAt,
      },
    });
    setIsSubmitting(false);

    if (result._tag === "Success") {
      setCreatedResult(result.value);
      onCreated();
      return;
    }

    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setErrorMessage(formatApiTokenErrorMessage(failure, resolveMessage));
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {createdResult ? <T>API token created</T> : <T>Create API token</T>}
          </DialogTitle>
          <DialogDescription>
            {createdResult ? (
              <T>Copy this token now. For security, it will not be shown again.</T>
            ) : (
              <T>
                Generate a personal access token with explicit scopes and optional project
                restrictions.
              </T>
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          {createdResult ? (
            <div className="space-y-4">
              <Alert variant="warning">
                <AlertDescription>
                  <T>
                    Store this token in a secure location. Once you close this dialog, the full
                    secret cannot be viewed again.
                  </T>
                </AlertDescription>
              </Alert>
              <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                <code
                  data-testid="created-api-token-value"
                  className="min-w-0 flex-1 break-all font-mono text-xs font-medium text-foreground select-all"
                >
                  {createdResult.token}
                </code>
                <Button
                  size="xs"
                  variant="outline"
                  type="button"
                  onClick={() => copyToClipboard(createdResult.token, createdResult.token)}
                >
                  {copied ? <CheckIcon /> : <CopyIcon />}
                  {copied ? gt("Copied") : gt("Copy token")}
                </Button>
              </div>
              {manualCopyValue !== null ? (
                <Textarea
                  readOnly
                  rows={2}
                  value={manualCopyValue}
                  onFocus={(event) => event.currentTarget.select()}
                  onClick={(event) => event.currentTarget.select()}
                />
              ) : null}
            </div>
          ) : (
            <div className="space-y-4">
              {errorMessage ? (
                <Alert variant="error">
                  <AlertDescription>{errorMessage}</AlertDescription>
                </Alert>
              ) : null}

              {isOwner && activeMembers.length > 1 ? (
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="api-token-principal">
                    <T>Member</T>
                  </label>
                  <Select
                    value={effectiveTargetId ?? ""}
                    onValueChange={(next) => {
                      if (typeof next === "string" && next.length > 0) {
                        setTargetPrincipalId(next as PrincipalId);
                        setSelectedProjects({});
                        setSelectedScopes(new Set());
                      }
                    }}
                  >
                    <SelectTrigger id="api-token-principal" size="sm">
                      <SelectValue>
                        {(value: string) => {
                          const found = activeMembers.find((entry) => entry.principal.id === value);
                          return found ? found.principal.displayName : gt("Current account");
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {activeMembers.map((entry) => (
                        <SelectItem key={entry.principal.id} value={entry.principal.id}>
                          {entry.principal.displayName}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}

              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="api-token-binding-mode">
                  <T>Project access</T>
                </label>
                <Select
                  value={effectiveBindingMode}
                  onValueChange={(next) => {
                    if (next === "principal" || next === "projects") {
                      setBindingMode(next);
                      setErrorMessage(null);
                    }
                  }}
                >
                  <SelectTrigger id="api-token-binding-mode" size="sm">
                    <SelectValue>
                      {(value: string) =>
                        value === "projects"
                          ? gt("Selected projects only")
                          : gt("All accessible projects (follows memberships)")
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {allowPrincipalBinding ? (
                      <SelectItem value="principal">
                        <T>All accessible projects (follows memberships)</T>
                      </SelectItem>
                    ) : null}
                    <SelectItem value="projects">
                      <T>Selected projects only</T>
                    </SelectItem>
                  </SelectPopup>
                </Select>
              </div>

              {effectiveBindingMode === "projects" ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      <T>Projects</T>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {gt("{count, plural, one {{count} selected} other {{count} selected}}", {
                        count: validSelectedProjectEntries.length,
                      })}
                    </span>
                  </div>
                  {bindableProjects.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      <T>No accessible projects are available for binding.</T>
                    </p>
                  ) : (
                    <div className="rounded-lg border border-border/60">
                      <ScrollArea className="max-h-44">
                        <div className="divide-y divide-border/50">
                          {bindableProjects.map((option) => {
                            const checked = option.projectId in selectedProjects;
                            const selectedRole =
                              selectedProjects[option.projectId] ?? option.defaultRole;
                            return (
                              <div
                                key={option.projectId}
                                className="flex items-center justify-between gap-2 px-3 py-2"
                              >
                                <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                                  <Checkbox
                                    checked={checked}
                                    onCheckedChange={() =>
                                      toggleProject(option.projectId, option.defaultRole)
                                    }
                                  />
                                  <span className="truncate text-sm text-foreground">
                                    {option.title}
                                  </span>
                                </label>
                                {checked ? (
                                  <Select
                                    value={selectedRole}
                                    onValueChange={(next) => {
                                      if (
                                        typeof next === "string" &&
                                        option.assignableRoles.includes(
                                          next as AssignableProjectRole,
                                        )
                                      ) {
                                        setProjectRole(
                                          option.projectId,
                                          next as AssignableProjectRole,
                                        );
                                      }
                                    }}
                                  >
                                    <SelectTrigger
                                      size="sm"
                                      className="w-32"
                                      aria-label={gt("Role for {project}", {
                                        project: option.title,
                                      })}
                                    >
                                      <SelectValue>
                                        {(value: string) =>
                                          m(
                                            PROJECT_ROLE_LABELS[value as ProjectRole] ??
                                              PROJECT_ROLE_LABELS.viewer,
                                          )
                                        }
                                      </SelectValue>
                                    </SelectTrigger>
                                    <SelectPopup>
                                      {option.assignableRoles.map((role) => (
                                        <SelectItem key={role} value={role}>
                                          {m(PROJECT_ROLE_LABELS[role])}
                                        </SelectItem>
                                      ))}
                                    </SelectPopup>
                                  </Select>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </ScrollArea>
                    </div>
                  )}
                </div>
              ) : null}

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    <T>Scopes</T>
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost-muted"
                      disabled={scopeOptions.length === 0}
                      onClick={handleSelectAllScopes}
                    >
                      <T>Select all</T>
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost-muted"
                      disabled={activeSelectedScopes.length === 0}
                      onClick={handleClearScopes}
                    >
                      <T>Clear</T>
                    </Button>
                  </div>
                </div>
                {scopeOptions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {effectiveBindingMode === "projects" &&
                    validSelectedProjectEntries.length === 0 ? (
                      <T>Select at least one project to see available scopes.</T>
                    ) : (
                      <T>No scopes are available for the selected access configuration.</T>
                    )}
                  </p>
                ) : (
                  <div className="rounded-lg border border-border/60">
                    <ScrollArea className="max-h-52">
                      <div className="divide-y divide-border/50">
                        {scopeOptions.map((option) => {
                          const checked = selectedScopes.has(option.scope);
                          return (
                            <label
                              key={option.scope}
                              className="flex cursor-pointer items-start gap-2.5 px-3 py-2"
                            >
                              <Checkbox
                                className="mt-0.5"
                                checked={checked}
                                onCheckedChange={() => toggleScope(option.scope)}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="flex flex-wrap items-center gap-1.5">
                                  <span className="text-sm font-medium text-foreground">
                                    {m(option.title)}
                                  </span>
                                  <code className="font-mono text-2xs text-muted-foreground">
                                    {option.scope}
                                  </code>
                                </span>
                                <span className="block text-xs text-muted-foreground">
                                  {m(option.description)}
                                </span>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </ScrollArea>
                  </div>
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="api-token-expiration">
                  <T>Expiration</T>
                </label>
                <Select
                  value={expirationPreset}
                  onValueChange={(next) => {
                    if (
                      next === "never" ||
                      next === "7d" ||
                      next === "30d" ||
                      next === "90d" ||
                      next === "365d"
                    ) {
                      setExpirationPreset(next);
                    }
                  }}
                >
                  <SelectTrigger id="api-token-expiration" size="sm">
                    <SelectValue>
                      {(value: string) => {
                        const preset = API_TOKEN_EXPIRATION_PRESETS.find(
                          (item) => item.value === value,
                        );
                        return preset ? m(preset.label) : gt("90 days");
                      }}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {API_TOKEN_EXPIRATION_PRESETS.map((preset) => (
                      <SelectItem key={preset.value} value={preset.value}>
                        {m(preset.label)}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>
          )}
        </DialogPanel>

        <DialogFooter variant="bare">
          {createdResult ? (
            <Button type="button" variant="default" onClick={() => handleOpenChange(false)}>
              <T>Done</T>
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={isSubmitting}
                onClick={() => handleOpenChange(false)}
              >
                <T>Cancel</T>
              </Button>
              <Button
                type="button"
                variant="default"
                disabled={
                  isSubmitting ||
                  activeSelectedScopes.length === 0 ||
                  (effectiveBindingMode === "projects" && validSelectedProjectEntries.length === 0)
                }
                onClick={() => void handleCreate()}
              >
                {isSubmitting ? gt("Creating…") : gt("Create token")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ApiTokensSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const m = useMessages();
  const nowMs = useNowSecond();
  const session = useEnvironmentSessionState(environmentId);
  const allProjects = useProjects();

  const gate = deriveApiTokensGate({
    environmentId,
    session: session.data,
    sessionPending: session.isPending,
    sessionHasError: session.hasError,
  });

  const canReadMembers = useAtomValue(authEnvironment.listMembers.permissionAtom(environmentId));
  const shouldFetchMembers = gate.visible && canReadMembers;

  const tokensQuery = useEnvironmentQuery(
    gate.visible ? authEnvironment.listApiTokens({ environmentId, input: null }) : null,
    m,
  );
  const membersQuery = useEnvironmentQuery(
    shouldFetchMembers ? authEnvironment.listMembers({ environmentId, input: null }) : null,
    m,
  );

  const revokeApiToken = useAtomCommand(authEnvironment.revokeApiToken, {
    reportFailure: false,
  });

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<ApiTokenListItem | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  const projectTitleById = new Map(
    allProjects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.title] as const),
  );

  const tokens = sortApiTokens(tokensQuery.data ?? EMPTY_TOKENS, nowMs);
  const isLoading = gate.visible && tokensQuery.isPending && tokensQuery.data === null;

  const refreshTokens = () => {
    appAtomRegistry.refresh(authEnvironment.listApiTokens({ environmentId, input: null }));
  };

  const handleConfirmRevoke = async () => {
    if (pendingRevoke === null || isRevoking) return;
    setIsRevoking(true);
    const result = await revokeApiToken({
      environmentId,
      input: { id: pendingRevoke.id },
    });
    setIsRevoking(false);
    if (result._tag === "Success") {
      setPendingRevoke(null);
      refreshTokens();
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: gt("API token revoked"),
          description: gt("This token can no longer authenticate requests."),
        }),
      );
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not revoke API token"),
          description: formatApiTokenErrorMessage(failure, resolveMessage),
        }),
      );
    }
  };

  return (
    <>
      <SettingsSection
        id="api-tokens"
        title={gt("API tokens")}
        headerAction={
          gate.visible ? (
            <Button
              size="xs"
              variant="default"
              type="button"
              onClick={() => setCreateDialogOpen(true)}
            >
              <PlusIcon />
              <T>Create token</T>
            </Button>
          ) : undefined
        }
      >
        {gate.mode === "loading-session" ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              <T>Loading session…</T>
            </p>
          </div>
        ) : gate.mode === "session-error" ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <Alert variant="error">
              <AlertDescription>
                <T>Could not verify your session for this environment.</T>
              </AlertDescription>
            </Alert>
          </div>
        ) : gate.mode === "unauthenticated" ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              <T>Sign in to this environment to manage API tokens.</T>
            </p>
          </div>
        ) : tokensQuery.error !== null && tokensQuery.data === null ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <Alert variant="error">
              <AlertDescription>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{formatApiTokenErrorMessage(tokensQuery.error, m)}</span>
                  <Button size="xs" variant="outline" type="button" onClick={refreshTokens}>
                    <T>Retry</T>
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          </div>
        ) : isLoading ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              <T>Loading API tokens…</T>
            </p>
          </div>
        ) : tokens.length === 0 ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              <T>No API tokens yet. Create one to authenticate scripts or automation.</T>
            </p>
          </div>
        ) : (
          tokens.map((token) => {
            const status = deriveApiTokenStatus(token, nowMs);
            const principalLabel = token.principalDisplayName ?? token.principalId;
            return (
              <div key={token.id} className={ITEM_ROW_CLASSNAME}>
                <div className={ITEM_ROW_INNER_CLASSNAME}>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <KeyRoundIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <code className="font-mono text-xs font-medium text-foreground">
                        {token.id.slice(0, 8)}
                      </code>
                      <Badge variant={tokenStatusBadgeVariant(status)} size="sm">
                        {m(API_TOKEN_STATUS_LABELS[status])}
                      </Badge>
                      {gate.isOwner ? (
                        <Badge variant="outline" size="sm">
                          {principalLabel}
                        </Badge>
                      ) : null}
                      <Badge variant="secondary" size="sm">
                        {token.binding._tag === "projects"
                          ? gt("{count, plural, one {{count} project} other {{count} projects}}", {
                              count: token.binding.projects.length,
                            })
                          : token.binding._tag === "environment"
                            ? gt("Environment")
                            : gt("All accessible projects")}
                      </Badge>
                    </div>

                    {token.binding._tag === "projects" && token.binding.projects.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                        {token.binding.projects.map((entry) => (
                          <span
                            key={entry.projectId}
                            className="rounded bg-muted/60 px-1.5 py-0.5 text-2xs text-foreground"
                          >
                            {projectTitleById.get(entry.projectId) ?? entry.projectId} ·{" "}
                            {m(PROJECT_ROLE_LABELS[entry.role])}
                          </span>
                        ))}
                      </div>
                    ) : null}

                    <div className="flex flex-wrap gap-1">
                      {token.scopes.map((scope) => {
                        const title = SCOPE_TITLE_BY_KEY.get(scope as AuthGrantScope);
                        return (
                          <span
                            key={scope}
                            className="rounded border border-border/60 px-1.5 py-0.5 font-mono text-2xs text-muted-foreground"
                          >
                            {title ? m(title) : scope}
                          </span>
                        );
                      })}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      <span>
                        <T>
                          Created <Var>{formatAccessTimestamp(token.createdAt)}</Var>
                        </T>
                      </span>
                      <span>
                        {token.lastUsedAt !== null ? (
                          <T>
                            Last used <Var>{formatAccessTimestamp(token.lastUsedAt)}</Var>
                          </T>
                        ) : (
                          <T>Never used</T>
                        )}
                      </span>
                      <span>
                        {token.expiresAt !== null ? (
                          <T>
                            Expires <Var>{formatAccessTimestamp(token.expiresAt)}</Var>
                          </T>
                        ) : (
                          <T>No expiration</T>
                        )}
                      </span>
                    </div>
                  </div>

                  {status === "active" ? (
                    <Button
                      size="xs"
                      variant="outline"
                      type="button"
                      onClick={() => setPendingRevoke(token)}
                    >
                      <Trash2Icon />
                      <T>Revoke</T>
                    </Button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </SettingsSection>

      <CreateApiTokenDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        environmentId={environmentId}
        isOwner={gate.isOwner}
        members={membersQuery.data ?? EMPTY_MEMBERS}
        onCreated={refreshTokens}
      />

      <AlertDialog
        open={pendingRevoke !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !isRevoking) {
            setPendingRevoke(null);
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>Revoke API token?</T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingRevoke ? (
                <T>
                  Requests using token{" "}
                  <code className="font-mono">
                    <Var>{pendingRevoke.id.slice(0, 8)}</Var>
                  </code>{" "}
                  will immediately stop working. This cannot be undone.
                </T>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={isRevoking} />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={isRevoking}
              onClick={() => void handleConfirmRevoke()}
            >
              {isRevoking ? gt("Revoking…") : gt("Revoke token")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

export function ApiTokensAccessRow({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const gt = useGT();
  if (environmentId === null) return null;
  return (
    <SettingsRow
      title={gt("API tokens")}
      description={gt("Create and revoke personal access tokens for scripts, CLI, and automation.")}
      control={
        <Button size="sm" variant="outline" render={<Link to="/settings/api-tokens" />}>
          <T>Manage tokens</T>
        </Button>
      }
    />
  );
}

export function ApiTokensPage() {
  const gt = useGT();
  const linkedEnvironmentId = useSearch({
    strict: false,
    select: (search) =>
      typeof search.machine === "string" ? EnvironmentId.make(search.machine) : null,
  });
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(linkedEnvironmentId);
  const { candidates, environment } = useAccessEnvironment(selectedEnvironmentId);
  const environmentId = environment?.environmentId ?? null;

  return (
    <SettingsPageContainer width="wide">
      {candidates.length > 1 && environmentId !== null ? (
        <div className="flex min-w-0 items-center gap-1.5 px-3 text-sm text-muted-foreground sm:px-4">
          <span className="shrink-0">
            <T>Showing API tokens for</T>
          </span>
          <Select
            value={environmentId}
            onValueChange={(next) => {
              if (next !== null) setSelectedEnvironmentId(next);
            }}
          >
            <SelectTrigger size="sm" className="w-auto max-w-72" aria-label={gt("Environment")}>
              <SelectValue>
                {(value: EnvironmentId) => {
                  const candidate = candidates.find((item) => item.environmentId === value);
                  return candidate ? settingsScopeEnvironmentLabel(candidate, candidates) : null;
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {candidates.map((candidate) => (
                <SelectItem key={candidate.environmentId} value={candidate.environmentId}>
                  {settingsScopeEnvironmentLabel(candidate, candidates)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}

      {environmentId === null ? (
        <SettingsSection id="api-tokens" title={gt("API tokens")}>
          <div className={ITEM_ROW_CLASSNAME}>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldAlertIcon className="size-4 shrink-0" />
              <span>
                <T>Connect an environment to manage API tokens.</T>
              </span>
            </div>
          </div>
        </SettingsSection>
      ) : (
        <ApiTokensSection key={environmentId} environmentId={environmentId} />
      )}
    </SettingsPageContainer>
  );
}
