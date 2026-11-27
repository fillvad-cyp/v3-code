import { useAtomValue } from "@effect/atom-react";
import {
  EnvironmentId,
  type MemberLoginCodeResult,
  type MemberWithMemberships,
  type MembershipState,
  type Principal,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Link, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { KeyRoundIcon, LogOutIcon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { signOutPrimaryEnvironment } from "../../environments/primary";
import { m as resolveMessage } from "../../i18n/messages";
import { notifyPopoutSignOut } from "../../lib/threadPopout";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useSyncAccessRevision } from "../../state/accessRevision";
import { authEnvironment } from "../../state/auth";
import { useProjects } from "../../state/entities";
import { useEnvironment, usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import {
  environmentSession,
  useEnvironmentSessionState,
  usePreparedConnection,
} from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { MemberLoginCodeDialog } from "./MemberLoginCodeDialog";
import { SetPasswordDialog } from "./SetPasswordDialog";
import {
  CEILING_TEMPLATE_LABELS,
  formatMembershipErrorMessage,
  inferCeilingTemplate,
  MEMBERSHIP_STATE_LABELS,
  PRINCIPAL_STATUS_LABELS,
  PROJECT_ROLE_LABELS,
  supportsMembersCapability,
} from "./MembersSettings.logic";
import {
  capabilityLabel,
  deriveMyAccessState,
  hasHostTerminalCapability,
  resolveMyProjectAccessEntries,
} from "./RolesAndAccess.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { useAccessEnvironment } from "./useAccessEnvironment";

const EMPTY_MEMBERS: ReadonlyArray<MemberWithMemberships> = [];

function statusBadgeVariant(status: Principal["status"] | MembershipState) {
  if (status === "active") return "success" as const;
  if (status === "suspended") return "warning" as const;
  return "secondary" as const;
}

export function MyAccessSection({
  environmentId,
  embedded = false,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly embedded?: boolean;
}) {
  const gt = useGT();
  if (environmentId === null) {
    if (embedded) return null;
    return (
      <SettingsSection id="my-access" title={gt("My access")}>
        <SettingsRow
          title={gt("No environment selected")}
          description={gt("Connect an environment to view your projects and permissions.")}
        />
      </SettingsSection>
    );
  }
  return (
    <MyAccessSectionContent key={environmentId} environmentId={environmentId} embedded={embedded} />
  );
}

function MyAccessSectionContent({
  environmentId,
  embedded,
}: {
  readonly environmentId: EnvironmentId;
  readonly embedded: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const router = useRouter();
  const navigate = useNavigate();
  const environment = useEnvironment(environmentId);
  const primaryEnvironment = usePrimaryEnvironment();
  const session = useEnvironmentSessionState(environmentId);
  const prepared = usePreparedConnection(environmentId);
  const allProjects = useProjects();

  const membersSupported = supportsMembersCapability(
    environment?.serverConfig?.environment.capabilities,
  );
  const canReadMembersCommand = useAtomValue(
    authEnvironment.listMembers.permissionAtom(environmentId),
  );
  const canIssueLoginCodeCommand = useAtomValue(
    authEnvironment.issueMemberLoginCode.permissionAtom(environmentId),
  );

  const accessState = deriveMyAccessState({
    environmentId,
    session: session.data,
    sessionPending: session.isPending,
    sessionHasError: session.hasError,
    membersSupported,
    canReadMembersCommand,
    canIssueLoginCodeCommand,
  });

  useSyncAccessRevision(environmentId, accessState.shouldFetchMembers);

  const membersQuery = useEnvironmentQuery(
    accessState.shouldFetchMembers
      ? authEnvironment.listMembers({ environmentId, input: null })
      : null,
    m,
  );

  const issueMemberLoginCode = useAtomCommand(authEnvironment.issueMemberLoginCode, {
    reportFailure: false,
  });
  const signOutCurrentSession = useAtomCommand(authEnvironment.signOutCurrentSession, {
    reportFailure: false,
  });

  const [loginCodeOpen, setLoginCodeOpen] = useState(false);
  const [loginCodeResult, setLoginCodeResult] = useState<MemberLoginCodeResult | null>(null);
  const [loginCodeLoading, setLoginCodeLoading] = useState(false);
  const [loginCodeError, setLoginCodeError] = useState<string | null>(null);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  if (embedded && accessState.mode !== "member") {
    return null;
  }

  const projectTitleById = new Map(
    allProjects
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.title] as const),
  );

  const entries = resolveMyProjectAccessEntries({
    session: session.data,
    members: membersQuery.data ?? EMPTY_MEMBERS,
    projectTitleById,
  });

  const isLoadingMembers =
    accessState.shouldFetchMembers && membersQuery.isPending && membersQuery.data === null;
  const isPrimary = primaryEnvironment?.environmentId === environmentId;

  const refreshMembers = () => {
    appAtomRegistry.refresh(authEnvironment.listMembers({ environmentId, input: null }));
  };

  const refreshSession = () => {
    appAtomRegistry.refresh(environmentSession.sessionStateAtom(environmentId));
  };

  const handleIssueLoginCode = async () => {
    const principal = accessState.principal;
    if (!accessState.canIssueLoginCode || principal === null) return;
    setLoginCodeOpen(true);
    setLoginCodeResult(null);
    setLoginCodeError(null);
    setLoginCodeLoading(true);
    const result = await issueMemberLoginCode({
      environmentId,
      input: { principalId: principal.id },
    });
    setLoginCodeLoading(false);
    if (result._tag === "Success") {
      setLoginCodeResult(result.value);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setLoginCodeError(formatMembershipErrorMessage(error, resolveMessage));
    }
  };

  const handleSignOut = async () => {
    if (!accessState.canSignOut || isSigningOut) return;
    setSignOutError(null);
    setIsSigningOut(true);
    if (isPrimary) {
      const error = await signOutPrimaryEnvironment().then(
        () => null,
        (cause) => (cause instanceof Error ? cause.message : String(cause)),
      );
      if (error !== null) {
        setIsSigningOut(false);
        setSignOutError(error);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not sign out"),
            description: error,
          }),
        );
        return;
      }
      router.history.replace("/login");
      router.history.flush();
      window.location.reload();
      return;
    }

    const result = await signOutCurrentSession({ environmentId, input: null });
    setIsSigningOut(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      const message =
        failure instanceof Error
          ? (thrownErrorMessage(failure, resolveMessage) ?? failure.message)
          : gt("Could not sign out.");
      setSignOutError(message);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not sign out"),
          description: message,
        }),
      );
      return;
    }
    notifyPopoutSignOut({ environmentId });
    const host = prepared._tag === "Some" ? prepared.value.httpBaseUrl : undefined;
    const label = prepared._tag === "Some" ? prepared.value.label : undefined;
    void navigate({
      to: "/login",
      search: {
        ...(host ? { host } : {}),
        environmentId,
        ...(label ? { label } : {}),
      },
    });
  };

  const ceilingTemplate = accessState.principal
    ? inferCeilingTemplate(accessState.principal.ceiling)
    : null;

  const canSetPassword =
    accessState.principal !== null && accessState.principal.status === "active";

  const headerActions = (
    <div className="flex flex-wrap items-center gap-1.5">
      {canSetPassword ? (
        <Button
          size="xs"
          variant="outline"
          type="button"
          onClick={() => setPasswordDialogOpen(true)}
        >
          <T>Password</T>
        </Button>
      ) : null}
      <Button size="xs" variant="outline" render={<Link to="/settings/api-tokens" />}>
        <T>API tokens</T>
      </Button>
      {accessState.canIssueLoginCode ? (
        <Button
          size="xs"
          variant="outline"
          type="button"
          disabled={loginCodeLoading}
          onClick={() => void handleIssueLoginCode()}
        >
          <KeyRoundIcon />
          <T>Login code</T>
        </Button>
      ) : null}
      {accessState.canSignOut ? (
        <Button
          size="xs"
          variant="outline"
          type="button"
          disabled={isSigningOut}
          onClick={() => void handleSignOut()}
        >
          <LogOutIcon />
          {isSigningOut ? gt("Signing out…") : gt("Sign out")}
        </Button>
      ) : null}
    </div>
  );

  return (
    <>
      <SettingsSection
        id={embedded ? undefined : "my-access"}
        title={gt("My access")}
        titleAction={
          accessState.mode === "owner" ? (
            <Badge variant="default" size="sm">
              {m(PROJECT_ROLE_LABELS.owner)}
            </Badge>
          ) : accessState.principal ? (
            <Badge variant={statusBadgeVariant(accessState.principal.status)} size="sm">
              {m(PRINCIPAL_STATUS_LABELS[accessState.principal.status])}
            </Badge>
          ) : undefined
        }
        headerAction={
          canSetPassword || accessState.canIssueLoginCode || accessState.canSignOut
            ? headerActions
            : undefined
        }
      >
        {signOutError ? (
          <div className="px-3 py-2 sm:px-4">
            <Alert variant="error">
              <AlertDescription>{signOutError}</AlertDescription>
            </Alert>
          </div>
        ) : null}

        {accessState.mode === "loading-session" ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              <T>Loading your access…</T>
            </p>
          </div>
        ) : accessState.mode === "session-error" ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <Alert variant="error">
              <AlertDescription>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <T>Could not load your session for this environment.</T>
                  </span>
                  <Button size="xs" variant="outline" type="button" onClick={refreshSession}>
                    <T>Try again</T>
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          </div>
        ) : accessState.mode === "unauthenticated" ? (
          <SettingsRow
            title={gt("Not signed in")}
            description={gt("Sign in to this environment to view your projects and capabilities.")}
            control={
              <Button size="sm" variant="outline" render={<Link to="/login" />}>
                <T>Sign in</T>
              </Button>
            }
          />
        ) : accessState.mode === "owner" ? (
          <>
            <div className="px-3 py-2.5 sm:px-4">
              <Alert variant="info">
                <ShieldCheckIcon aria-hidden />
                <AlertDescription>
                  <T>
                    Everything in this environment is yours. As the owner, you bypass project
                    membership checks and have full access to all projects, members, and settings.
                  </T>
                </AlertDescription>
              </Alert>
            </div>
            <SettingsRow
              title={gt("Roles & permissions")}
              description={gt(
                "Compare every project role, capability, and host security boundary.",
              )}
              control={
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" render={<Link to="/settings/roles" />}>
                    <T>View matrix</T>
                  </Button>
                  {!embedded ? (
                    <Button size="sm" variant="ghost-muted" render={<Link to="/settings/access" />}>
                      <T>Sharing &amp; access</T>
                    </Button>
                  ) : null}
                </div>
              }
            />
          </>
        ) : (
          <>
            <SettingsRow
              title={
                accessState.principal ? (
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <span>{accessState.principal.displayName}</span>
                    {ceilingTemplate ? (
                      <Badge variant="outline" size="sm">
                        {gt("Ceiling: {template}", {
                          template: m(CEILING_TEMPLATE_LABELS[ceilingTemplate]),
                        })}
                      </Badge>
                    ) : null}
                  </span>
                ) : (
                  gt("Member session")
                )
              }
              description={
                accessState.principal?.email ? (
                  accessState.principal.email
                ) : (
                  <T>
                    Your access is scoped to the projects listed below. Capabilities come from your
                    role on each project.
                  </T>
                )
              }
              control={
                <Button size="sm" variant="outline" render={<Link to="/settings/roles" />}>
                  <T>Roles &amp; permissions</T>
                </Button>
              }
            />

            {membersQuery.error ? (
              <div className="px-3 py-2 sm:px-4">
                <Alert variant="error">
                  <AlertDescription>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>{membersQuery.error}</span>
                      <Button size="xs" variant="outline" type="button" onClick={refreshMembers}>
                        <T>Try again</T>
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              </div>
            ) : !accessState.canReadMembers && session.data?.binding?._tag !== "projects" ? (
              <div className={ITEM_ROW_CLASSNAME}>
                <p className="text-xs text-muted-foreground">
                  <T>This connection lacks permission to view your project memberships.</T>
                </p>
              </div>
            ) : isLoadingMembers ? (
              <div className={ITEM_ROW_CLASSNAME}>
                <p className="text-xs text-muted-foreground">
                  <T>Loading your project access…</T>
                </p>
              </div>
            ) : entries.length === 0 ? (
              <div className={ITEM_ROW_CLASSNAME}>
                <p className="text-xs text-muted-foreground">
                  <T>
                    You do not belong to any projects in this environment yet. Ask the environment
                    owner or a project admin to invite you.
                  </T>
                </p>
              </div>
            ) : (
              entries.map((entry) => {
                const hasHostBoundary = hasHostTerminalCapability(entry.capabilities);
                return (
                  <div key={entry.projectId} className={ITEM_ROW_CLASSNAME}>
                    <div className={ITEM_ROW_INNER_CLASSNAME}>
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h3 className="truncate text-sm font-medium text-foreground">
                            {entry.projectTitle}
                          </h3>
                          <Badge variant="default" size="sm">
                            {m(PROJECT_ROLE_LABELS[entry.role])}
                          </Badge>
                          <Badge variant={statusBadgeVariant(entry.state)} size="sm">
                            {m(MEMBERSHIP_STATE_LABELS[entry.state])}
                          </Badge>
                          {hasHostBoundary ? (
                            <Badge variant="warning" size="sm">
                              <ShieldAlertIcon aria-hidden />
                              <T>L0 · Terminal sees host</T>
                            </Badge>
                          ) : null}
                        </div>

                        {entry.state === "suspended" ? (
                          <p className="text-xs text-warning-foreground">
                            <T>
                              Your membership in this project is suspended. Capabilities apply once
                              an admin reactivates it.
                            </T>
                          </p>
                        ) : null}

                        {entry.capabilities.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            <T>No capabilities granted by this role.</T>
                          </p>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {entry.capabilities.map((capability) => (
                              <Badge key={capability} variant="secondary" size="sm">
                                {capabilityLabel(capability, m)}
                              </Badge>
                            ))}
                          </div>
                        )}

                        {entry.expiresAt ? (
                          <p className="text-2xs text-muted-foreground">
                            <T>
                              Expires <Var>{entry.expiresAt}</Var>
                            </T>
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </>
        )}
      </SettingsSection>

      <MemberLoginCodeDialog
        open={loginCodeOpen}
        onOpenChange={(open) => {
          setLoginCodeOpen(open);
          if (!open) {
            setLoginCodeResult(null);
            setLoginCodeError(null);
          }
        }}
        memberName={accessState.principal?.displayName ?? ""}
        loginCode={loginCodeResult}
        isLoading={loginCodeLoading}
        errorMessage={loginCodeError}
      />
      <SetPasswordDialog
        open={passwordDialogOpen}
        onOpenChange={setPasswordDialogOpen}
        environmentId={environmentId}
      />
    </>
  );
}

export function MyAccessPage() {
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
    <SettingsPageContainer>
      {candidates.length > 1 && environmentId !== null ? (
        <div className="flex min-w-0 items-center gap-1.5 px-3 text-sm text-muted-foreground sm:px-4">
          <span className="shrink-0">
            <T>Showing access for</T>
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
            <SelectPopup alignItemWithTrigger={false}>
              {candidates.map((candidate) => (
                <SelectItem
                  hideIndicator
                  key={candidate.environmentId}
                  value={candidate.environmentId}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <EnvironmentMachineIcon
                      aria-hidden
                      kind={resolveEnvironmentMachineKind(candidate.serverConfig)}
                      className="size-3.5 shrink-0"
                    />
                    <span className="min-w-0 truncate">
                      {settingsScopeEnvironmentLabel(candidate, candidates)}
                    </span>
                    {candidate.connection.phase !== "connected" ? (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        <T>Offline</T>
                      </span>
                    ) : null}
                  </span>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}
      <MyAccessSection environmentId={environmentId} />
    </SettingsPageContainer>
  );
}
