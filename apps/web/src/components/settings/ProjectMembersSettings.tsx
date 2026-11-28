import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type MemberLoginCodeResult,
  type MemberWithMemberships,
  type Principal,
  type ProjectId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { KeyRoundIcon, PlusIcon, ShieldAlertIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { T, useGT, useMessages } from "gt-react";

import { m as resolveMessage } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useSyncAccessRevision } from "../../state/accessRevision";
import { authEnvironment } from "../../state/auth";
import { useEnvironment, useEnvironments } from "../../state/environments";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { MemberInviteDialog } from "./MemberInviteDialog";
import { MemberLoginCodeDialog } from "./MemberLoginCodeDialog";
import {
  deriveProjectMemberPermissions,
  formatMembershipErrorMessage,
  isAssignableProjectRole,
  MEMBERSHIP_STATE_LABELS,
  PROJECT_ROLE_LABELS,
  projectMembersForProject,
  supportsMembersCapability,
  type ProjectMemberEntry,
} from "./MembersSettings.logic";
import { SettingsSection } from "./settingsLayout";

const EMPTY_MEMBERS: ReadonlyArray<MemberWithMemberships> = [];

function stateBadgeVariant(state: ProjectMemberEntry["membership"]["state"]) {
  if (state === "active") return "success" as const;
  if (state === "suspended") return "warning" as const;
  return "secondary" as const;
}

export interface ProjectMembersCardProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly environmentLabel?: string | null;
  readonly showEnvironmentSubtitle?: boolean;
  readonly sectionId?: string;
}

export function ProjectMembersCard({
  environmentId,
  projectId,
  projectTitle,
  environmentLabel = null,
  showEnvironmentSubtitle = false,
  sectionId,
}: ProjectMembersCardProps) {
  const gt = useGT();
  const m = useMessages();
  const environment = useEnvironment(environmentId);
  const membersSupported = supportsMembersCapability(
    environment?.serverConfig?.environment.capabilities,
  );
  const session = useEnvironmentSessionState(environmentId);
  const canReadMembers = useAtomValue(authEnvironment.listMembers.permissionAtom(environmentId));
  const canUpdateMembers = useAtomValue(authEnvironment.updateMember.permissionAtom(environmentId));
  const canInviteCommand = useAtomValue(
    authEnvironment.createInvitation.permissionAtom(environmentId),
  );
  useSyncAccessRevision(environmentId, membersSupported && canReadMembers);
  const membersQuery = useEnvironmentQuery(
    membersSupported && canReadMembers
      ? authEnvironment.listMembers({ environmentId, input: null })
      : null,
    m,
  );
  const updateMember = useAtomCommand(authEnvironment.updateMember, { reportFailure: false });
  const removeMember = useAtomCommand(authEnvironment.removeMember, { reportFailure: false });
  const issueMemberLoginCode = useAtomCommand(authEnvironment.issueMemberLoginCode, {
    reportFailure: false,
  });

  const [inviteOpen, setInviteOpen] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [busyPrincipalId, setBusyPrincipalId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<ProjectMemberEntry | null>(null);
  const [loginCodeTarget, setLoginCodeTarget] = useState<Principal | null>(null);
  const [loginCodeResult, setLoginCodeResult] = useState<MemberLoginCodeResult | null>(null);
  const [loginCodeLoading, setLoginCodeLoading] = useState(false);
  const [loginCodeError, setLoginCodeError] = useState<string | null>(null);

  if (!membersSupported) {
    return null;
  }

  const rawMembers = membersQuery.data ?? EMPTY_MEMBERS;
  const projectMembers = projectMembersForProject(rawMembers, projectId);
  const permissions = deriveProjectMemberPermissions({
    session: session.data,
    canWriteAccess: canUpdateMembers,
    projectId,
    members: rawMembers,
  });
  const canInvite = permissions.canInvite && canInviteCommand;

  const refreshMembers = () => {
    appAtomRegistry.refresh(authEnvironment.listMembers({ environmentId, input: null }));
  };

  const handleRoleChange = async (entry: ProjectMemberEntry, nextRole: string) => {
    if (!isAssignableProjectRole(nextRole) || nextRole === entry.membership.role) return;
    setMutationError(null);
    setBusyPrincipalId(entry.principal.id);
    const result = await updateMember({
      environmentId,
      input: {
        principalId: entry.principal.id,
        patch: { projectId, role: nextRole },
      },
    });
    setBusyPrincipalId(null);
    if (result._tag === "Success") {
      refreshMembers();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setMutationError(formatMembershipErrorMessage(error, resolveMessage));
    }
  };

  const handleToggleState = async (entry: ProjectMemberEntry) => {
    const nextState = entry.membership.state === "suspended" ? "active" : "suspended";
    setMutationError(null);
    setBusyPrincipalId(entry.principal.id);
    const result = await updateMember({
      environmentId,
      input: {
        principalId: entry.principal.id,
        patch: { projectId, state: nextState },
      },
    });
    setBusyPrincipalId(null);
    if (result._tag === "Success") {
      refreshMembers();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setMutationError(formatMembershipErrorMessage(error, resolveMessage));
    }
  };

  const handleConfirmRemoval = async () => {
    if (!pendingRemoval) return;
    const target = pendingRemoval;
    setMutationError(null);
    setBusyPrincipalId(target.principal.id);
    const result = await removeMember({
      environmentId,
      input: { principalId: target.principal.id, projectId },
    });
    setBusyPrincipalId(null);
    setPendingRemoval(null);
    if (result._tag === "Success") {
      refreshMembers();
      if (result.value.promotedOwner) {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: gt("Owner promoted to project admin"),
            description: gt(
              "The last project admin was removed, so the environment owner now manages this project.",
            ),
          }),
        );
      }
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setMutationError(formatMembershipErrorMessage(error, resolveMessage));
    }
  };

  const handleIssueLoginCode = async (principal: Principal) => {
    setLoginCodeTarget(principal);
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

  const isLoadingInitial = membersQuery.isPending && membersQuery.data === null;
  const activeError = mutationError ?? membersQuery.error;
  const sectionTitle =
    showEnvironmentSubtitle && environmentLabel
      ? gt("Members · {environment}", { environment: environmentLabel })
      : gt("Members");

  return (
    <>
      <SettingsSection
        id={sectionId}
        title={sectionTitle}
        titleAction={
          <Badge variant="warning" size="sm">
            <ShieldAlertIcon aria-hidden />
            <T>Host access</T>
          </Badge>
        }
        headerAction={
          canInvite ? (
            <Button size="xs" variant="default" type="button" onClick={() => setInviteOpen(true)}>
              <PlusIcon />
              <T>Invite</T>
            </Button>
          ) : undefined
        }
      >
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          <T>
            Logical project isolation (L0): members with terminal or agent access share this
            host&apos;s OS user boundary.
          </T>
        </p>

        {!canReadMembers ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              <T>This connection cannot view project members.</T>
            </p>
          </div>
        ) : (
          <>
            {activeError ? (
              <div className="px-3 py-2 sm:px-4">
                <Alert variant="error">
                  <AlertDescription>{activeError}</AlertDescription>
                </Alert>
              </div>
            ) : null}

            {isLoadingInitial ? (
              <div className={ITEM_ROW_CLASSNAME}>
                <p className="text-xs text-muted-foreground">
                  <T>Loading members…</T>
                </p>
              </div>
            ) : projectMembers.length === 0 ? (
              <div className={ITEM_ROW_CLASSNAME}>
                <p className="text-xs text-muted-foreground">
                  {canInvite
                    ? gt("No members on this project yet. Invite someone to grant access.")
                    : gt("No members on this project yet.")}
                </p>
              </div>
            ) : (
              projectMembers.map((entry) => {
                const isSelf = session.data?.principal?.id === entry.principal.id;
                const canManageTarget = permissions.canManageMember(entry);
                const canLoginCode = permissions.canIssueLoginCode(entry.principal);
                const isBusy = busyPrincipalId === entry.principal.id;
                const roleChoices = permissions.grantableRoles.includes(
                  entry.membership.role as (typeof permissions.grantableRoles)[number],
                )
                  ? permissions.grantableRoles
                  : ([entry.membership.role, ...permissions.grantableRoles] as const);

                return (
                  <div key={entry.principal.id} className={ITEM_ROW_CLASSNAME}>
                    <div className={ITEM_ROW_INNER_CLASSNAME}>
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h3 className="truncate text-sm font-medium text-foreground">
                            {entry.principal.displayName}
                          </h3>
                          {isSelf ? (
                            <Badge variant="outline" size="sm">
                              <T>You</T>
                            </Badge>
                          ) : null}
                          <Badge variant={stateBadgeVariant(entry.membership.state)} size="sm">
                            {m(MEMBERSHIP_STATE_LABELS[entry.membership.state])}
                          </Badge>
                        </div>
                        {!canManageTarget ? (
                          <p className="text-xs text-muted-foreground">
                            {m(PROJECT_ROLE_LABELS[entry.membership.role])}
                          </p>
                        ) : null}
                      </div>

                      <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                        {canManageTarget ? (
                          <Select
                            value={entry.membership.role}
                            onValueChange={(value) => {
                              if (typeof value === "string") {
                                void handleRoleChange(entry, value);
                              }
                            }}
                          >
                            <SelectTrigger
                              size="sm"
                              aria-label={gt("Role for {name}", {
                                name: entry.principal.displayName,
                              })}
                              disabled={isBusy}
                            >
                              <SelectValue>
                                {m(PROJECT_ROLE_LABELS[entry.membership.role])}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectPopup align="end" alignItemWithTrigger={false}>
                              {roleChoices.map((role) => (
                                <SelectItem hideIndicator key={role} value={role}>
                                  {m(PROJECT_ROLE_LABELS[role])}
                                </SelectItem>
                              ))}
                            </SelectPopup>
                          </Select>
                        ) : null}

                        {canLoginCode ? (
                          <Button
                            size="xs"
                            variant="outline"
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleIssueLoginCode(entry.principal)}
                          >
                            <KeyRoundIcon />
                            <T>Login code</T>
                          </Button>
                        ) : null}

                        {canManageTarget ? (
                          <>
                            <Button
                              size="xs"
                              variant="outline"
                              type="button"
                              disabled={isBusy}
                              onClick={() => void handleToggleState(entry)}
                            >
                              {entry.membership.state === "suspended"
                                ? gt("Reactivate")
                                : gt("Suspend", { $context: "verb, suspends a member" })}
                            </Button>
                            <Button
                              size="xs"
                              variant="destructive-outline"
                              type="button"
                              disabled={isBusy}
                              aria-label={gt("Remove {name} from project", {
                                name: entry.principal.displayName,
                              })}
                              onClick={() => setPendingRemoval(entry)}
                            >
                              <Trash2Icon />
                              {gt("Remove", { $context: "verb, removes a project member" })}
                            </Button>
                          </>
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

      <MemberInviteDialog
        environmentId={environmentId}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        isOwner={permissions.isOwner}
        grantableRoles={permissions.grantableRoles}
        fixedProject={{ id: projectId, label: projectTitle }}
        onInvited={refreshMembers}
      />

      <MemberLoginCodeDialog
        open={loginCodeTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setLoginCodeTarget(null);
            setLoginCodeResult(null);
            setLoginCodeError(null);
          }
        }}
        memberName={loginCodeTarget?.displayName ?? ""}
        loginCode={loginCodeResult}
        isLoading={loginCodeLoading}
        errorMessage={loginCodeError}
      />

      <AlertDialog
        open={pendingRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemoval(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingRemoval
                ? gt("Remove {name} from {project}?", {
                    name: pendingRemoval.principal.displayName,
                    project: projectTitle,
                  })
                : gt("Remove member?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                This member will immediately lose access to this project and its threads. Their
                authored threads remain in history.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              type="button"
              disabled={pendingRemoval === null || busyPrincipalId !== null}
              onClick={() => void handleConfirmRemoval()}
            >
              {gt("Remove", { $context: "verb, confirms removing a project member" })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

export function ProjectMembersSettings({
  members,
}: {
  readonly members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const { environments } = useEnvironments();
  const supportedEnvironmentIds = new Set(
    environments
      .filter((environment) =>
        supportsMembersCapability(environment.serverConfig?.environment.capabilities),
      )
      .map((environment) => environment.environmentId),
  );
  const supportedMembers = members.filter((member) =>
    supportedEnvironmentIds.has(member.environmentId),
  );
  if (supportedMembers.length === 0) return null;
  const showEnvironmentSubtitle = supportedMembers.length > 1;
  return (
    <>
      {supportedMembers.map((member, index) => (
        <ProjectMembersCard
          key={member.physicalProjectKey}
          environmentId={member.environmentId}
          projectId={member.id}
          projectTitle={member.title}
          environmentLabel={member.environmentLabel}
          showEnvironmentSubtitle={showEnvironmentSubtitle}
          {...(index === 0 ? { sectionId: "project-members" } : {})}
        />
      ))}
    </>
  );
}
