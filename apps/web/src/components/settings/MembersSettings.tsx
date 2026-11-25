import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type MemberLoginCodeResult,
  type MemberWithMemberships,
  type Principal,
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
import { authEnvironment } from "../../state/auth";
import { useProjects } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentSession, useEnvironmentSessionState } from "../../state/session";
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
import { Switch } from "../ui/switch";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { MemberInviteDialog } from "./MemberInviteDialog";
import { MemberLoginCodeDialog } from "./MemberLoginCodeDialog";
import {
  ASSIGNABLE_PROJECT_ROLES,
  CEILING_TEMPLATE_DESCRIPTIONS,
  CEILING_TEMPLATE_LABELS,
  CEILING_TEMPLATES,
  deriveEnvironmentMembersGate,
  environmentMembersList,
  formatMembershipErrorMessage,
  inferCeilingTemplate,
  isCeilingTemplate,
  MEMBERSHIP_STATE_LABELS,
  PRINCIPAL_STATUS_LABELS,
  PROJECT_ROLE_LABELS,
} from "./MembersSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const EMPTY_MEMBERS: ReadonlyArray<MemberWithMemberships> = [];

function principalStatusVariant(status: Principal["status"]) {
  if (status === "active") return "success" as const;
  if (status === "suspended") return "warning" as const;
  return "secondary" as const;
}

export function MembersSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  if (environmentId === null) return null;
  return <MembersSettingsContent key={environmentId} environmentId={environmentId} />;
}

function MembersSettingsContent({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const m = useMessages();
  const session = useEnvironmentSessionState(environmentId);
  const environment = useEnvironment(environmentId);
  const allProjects = useProjects();
  const environmentProjects = allProjects
    .filter((project) => project.environmentId === environmentId)
    .map((project) => ({ id: project.id, label: project.title }));
  const projectTitleById = new Map(
    environmentProjects.map((project) => [project.id, project.label]),
  );

  const currentMultiUser = environment?.serverConfig?.settings.multiUser;
  const nextMultiUserValue = !(currentMultiUser ?? session.data?.auth.authMode === "multi-user");
  const canUpdateMultiUserSetting = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId, {
      patch: { multiUser: nextMultiUserValue },
    }),
  );
  const gate = deriveEnvironmentMembersGate({
    session: session.data,
    canUpdateMultiUserSetting,
    settingsMultiUser: currentMultiUser,
  });

  const canReadMembers = useAtomValue(authEnvironment.listMembers.permissionAtom(environmentId));
  const canUpdateMembers = useAtomValue(authEnvironment.updateMember.permissionAtom(environmentId));
  const canRemoveMembers = useAtomValue(authEnvironment.removeMember.permissionAtom(environmentId));
  const canCreateInvitation = useAtomValue(
    authEnvironment.createInvitation.permissionAtom(environmentId),
  );

  const membersQuery = useEnvironmentQuery(
    gate.visible && canReadMembers
      ? authEnvironment.listMembers({ environmentId, input: null })
      : null,
    m,
  );

  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const updateMember = useAtomCommand(authEnvironment.updateMember, { reportFailure: false });
  const removeMember = useAtomCommand(authEnvironment.removeMember, { reportFailure: false });
  const issueMemberLoginCode = useAtomCommand(authEnvironment.issueMemberLoginCode, {
    reportFailure: false,
  });

  const [isUpdatingMultiUser, setIsUpdatingMultiUser] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [busyPrincipalId, setBusyPrincipalId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<MemberWithMemberships | null>(null);
  const [loginCodeTarget, setLoginCodeTarget] = useState<Principal | null>(null);
  const [loginCodeResult, setLoginCodeResult] = useState<MemberLoginCodeResult | null>(null);
  const [loginCodeLoading, setLoginCodeLoading] = useState(false);
  const [loginCodeError, setLoginCodeError] = useState<string | null>(null);

  if (!gate.visible) {
    return null;
  }

  const members = environmentMembersList(membersQuery.data ?? EMPTY_MEMBERS);
  const isLoadingInitial = membersQuery.isPending && membersQuery.data === null;
  const activeError = mutationError ?? membersQuery.error;

  const refreshMembers = () => {
    appAtomRegistry.refresh(authEnvironment.listMembers({ environmentId, input: null }));
  };

  const handleToggleMultiUser = async (enabled: boolean) => {
    if (!gate.canToggleMultiUser || isUpdatingMultiUser) return;
    setMutationError(null);
    setIsUpdatingMultiUser(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { multiUser: enabled } },
    });
    setIsUpdatingMultiUser(false);
    if (result._tag === "Success") {
      appAtomRegistry.refresh(environmentSession.sessionStateAtom(environmentId));
      refreshMembers();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setMutationError(formatMembershipErrorMessage(error, resolveMessage));
    }
  };

  const handleCeilingChange = async (member: MemberWithMemberships, nextCeiling: string) => {
    if (!canUpdateMembers || !isCeilingTemplate(nextCeiling)) return;
    setMutationError(null);
    setBusyPrincipalId(member.principal.id);
    const result = await updateMember({
      environmentId,
      input: {
        principalId: member.principal.id,
        patch: { ceiling: nextCeiling },
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

  const handleTogglePrincipalSuspend = async (member: MemberWithMemberships) => {
    if (!canUpdateMembers) return;
    if (member.principal.status !== "active" && member.principal.status !== "suspended") return;
    const nextState = member.principal.status === "suspended" ? "active" : "suspended";
    setMutationError(null);
    setBusyPrincipalId(member.principal.id);
    const result = await updateMember({
      environmentId,
      input: {
        principalId: member.principal.id,
        patch: { state: nextState },
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

  const handleConfirmRemovePrincipal = async () => {
    if (!pendingRemoval || !canRemoveMembers) return;
    const target = pendingRemoval;
    setMutationError(null);
    setBusyPrincipalId(target.principal.id);
    const result = await removeMember({
      environmentId,
      input: { principalId: target.principal.id },
    });
    setBusyPrincipalId(null);
    setPendingRemoval(null);
    if (result._tag === "Success") {
      refreshMembers();
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

  return (
    <>
      <SettingsSection
        id="environment-members"
        title={gt("Members")}
        titleAction={
          <Badge variant="warning" size="sm">
            <ShieldAlertIcon aria-hidden />
            <T>Host access</T>
          </Badge>
        }
        headerAction={
          canCreateInvitation ? (
            <Button size="xs" variant="default" type="button" onClick={() => setInviteOpen(true)}>
              <PlusIcon />
              <T>Invite</T>
            </Button>
          ) : undefined
        }
      >
        <SettingsRow
          id="multi-user-mode"
          title={
            <span className="inline-flex items-center gap-2">
              <T>Multi-user mode</T>
              <Badge variant={gate.multiUserEnabled ? "success" : "secondary"} size="sm">
                {gate.multiUserEnabled
                  ? gt("Enabled", { $context: "multi-user auth mode status" })
                  : gt("Disabled", { $context: "multi-user auth mode status" })}
              </Badge>
            </span>
          }
          description={gt(
            "Let invited members sign in with one-time codes and scoped project roles. Only the environment owner can change this setting.",
          )}
          control={
            <Switch
              checked={gate.multiUserEnabled}
              disabled={!gate.canToggleMultiUser || isUpdatingMultiUser}
              onCheckedChange={(checked) => void handleToggleMultiUser(checked)}
              aria-label={gt("Multi-user mode")}
            />
          }
        />

        <div className="px-3 py-2.5 sm:px-4">
          <Alert variant="warning">
            <ShieldAlertIcon aria-hidden />
            <AlertDescription>
              <T>
                Host access (L0): projects are filtered logically inside T3 Code, but members with
                terminal or agent access run under this host&apos;s OS user and share the host
                boundary.
              </T>
            </AlertDescription>
          </Alert>
        </div>

        {activeError ? (
          <div className="px-3 py-2 sm:px-4">
            <Alert variant="error">
              <AlertDescription>{activeError}</AlertDescription>
            </Alert>
          </div>
        ) : null}

        {!canReadMembers ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              <T>This connection cannot view environment members.</T>
            </p>
          </div>
        ) : isLoadingInitial ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              <T>Loading members…</T>
            </p>
          </div>
        ) : members.length === 0 ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              <T>No members yet. Create an invitation to add someone to this environment.</T>
            </p>
          </div>
        ) : (
          members.map((member) => {
            const isOwnerPrincipal = member.principal.kind === "owner";
            const isSelf = session.data?.principal?.id === member.principal.id;
            const isBusy = busyPrincipalId === member.principal.id;
            const ceilingTemplate = inferCeilingTemplate(member.principal.ceiling);
            const isSuspended = member.principal.status === "suspended";
            const canToggleSuspend =
              canUpdateMembers &&
              !isOwnerPrincipal &&
              (member.principal.status === "active" || isSuspended);
            const suspendActionIsSuspend = !isSuspended;

            return (
              <div key={member.principal.id} className={ITEM_ROW_CLASSNAME}>
                <div className={ITEM_ROW_INNER_CLASSNAME}>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="truncate text-sm font-medium text-foreground">
                        {member.principal.displayName}
                      </h3>
                      {isOwnerPrincipal ? (
                        <Badge variant="default" size="sm">
                          {m(PROJECT_ROLE_LABELS.owner)}
                        </Badge>
                      ) : null}
                      {isSelf ? (
                        <Badge variant="outline" size="sm">
                          <T>You</T>
                        </Badge>
                      ) : null}
                      <Badge variant={principalStatusVariant(member.principal.status)} size="sm">
                        {m(PRINCIPAL_STATUS_LABELS[member.principal.status])}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {member.memberships.length === 0
                        ? isOwnerPrincipal
                          ? gt("Full access to all projects and environment settings")
                          : gt("No project memberships")
                        : member.memberships
                            .map((entry) => {
                              const projectLabel =
                                projectTitleById.get(entry.projectId) ?? entry.projectId;
                              const roleLabel = m(PROJECT_ROLE_LABELS[entry.role]);
                              return entry.state === "active"
                                ? `${projectLabel} (${roleLabel})`
                                : `${projectLabel} (${roleLabel}, ${m(MEMBERSHIP_STATE_LABELS[entry.state])})`;
                            })
                            .join(" · ")}
                    </p>
                  </div>

                  <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
                    {!isOwnerPrincipal ? (
                      <Select
                        value={ceilingTemplate ?? ""}
                        onValueChange={(value) => {
                          if (typeof value === "string") {
                            void handleCeilingChange(member, value);
                          }
                        }}
                      >
                        <SelectTrigger
                          size="sm"
                          aria-label={gt("Ceiling template for {name}", {
                            name: member.principal.displayName,
                          })}
                          disabled={!canUpdateMembers || isBusy}
                        >
                          <SelectValue>
                            {ceilingTemplate
                              ? m(CEILING_TEMPLATE_LABELS[ceilingTemplate])
                              : gt("Custom ceiling")}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectPopup align="end" alignItemWithTrigger={false}>
                          {CEILING_TEMPLATES.map((template) => (
                            <SelectItem hideIndicator key={template} value={template}>
                              <span>
                                <span className="block font-medium">
                                  {m(CEILING_TEMPLATE_LABELS[template])}
                                </span>
                                <span className="block text-xs text-muted-foreground">
                                  {m(CEILING_TEMPLATE_DESCRIPTIONS[template])}
                                </span>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectPopup>
                      </Select>
                    ) : null}

                    {member.principal.status === "active" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        type="button"
                        disabled={isBusy}
                        onClick={() => void handleIssueLoginCode(member.principal)}
                      >
                        <KeyRoundIcon />
                        <T>Login code</T>
                      </Button>
                    ) : null}

                    {!isOwnerPrincipal ? (
                      <>
                        <Button
                          size="xs"
                          variant="outline"
                          type="button"
                          disabled={!canToggleSuspend || isBusy}
                          onClick={() => void handleTogglePrincipalSuspend(member)}
                        >
                          {suspendActionIsSuspend
                            ? gt("Suspend", { $context: "verb, suspends a member" })
                            : gt("Reactivate")}
                        </Button>
                        <Button
                          size="xs"
                          variant="destructive-outline"
                          type="button"
                          disabled={!canRemoveMembers || isBusy}
                          aria-label={gt("Remove {name}", {
                            name: member.principal.displayName,
                          })}
                          onClick={() => setPendingRemoval(member)}
                        >
                          <Trash2Icon />
                          {gt("Remove", {
                            $context: "verb, removes a member from the environment",
                          })}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </SettingsSection>

      <MemberInviteDialog
        environmentId={environmentId}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        isOwner
        grantableRoles={ASSIGNABLE_PROJECT_ROLES}
        projects={environmentProjects}
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
                ? gt("Remove {name} from this environment?", {
                    name: pendingRemoval.principal.displayName,
                  })
                : gt("Remove member?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                This removes the member from every project and immediately revokes all of their
                sessions and tokens. Their authored threads remain in history.
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
              onClick={() => void handleConfirmRemovePrincipal()}
            >
              {gt("Remove", { $context: "verb, confirms removing a member" })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
