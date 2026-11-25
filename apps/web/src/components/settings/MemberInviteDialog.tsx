import {
  type EnvironmentId,
  type InvitationCreateResult,
  type ProjectId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowSecond } from "../../hooks/useNowSecond";
import { m as resolveMessage } from "../../i18n/messages";
import { authEnvironment } from "../../state/auth";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatExpiresInLabel } from "../../timestampFormat";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { formatAccessTimestamp } from "./ConnectionsSettings.logic";
import {
  buildInviteAcceptUrl,
  formatMembershipErrorMessage,
  isAssignableProjectRole,
  PROJECT_ROLE_LABELS,
  validateInviteForm,
  type AssignableProjectRole,
} from "./MembersSettings.logic";

const ENVIRONMENT_SCOPE_VALUE = "__environment__";

export interface InviteProjectOption {
  readonly id: ProjectId;
  readonly label: string;
}

export interface MemberInviteDialogProps {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly isOwner: boolean;
  readonly grantableRoles: ReadonlyArray<AssignableProjectRole>;
  readonly fixedProject?: InviteProjectOption | null;
  readonly projects?: ReadonlyArray<InviteProjectOption>;
  readonly onInvited?: () => void;
}

function defaultInviteRole(
  grantableRoles: ReadonlyArray<AssignableProjectRole>,
): AssignableProjectRole | null {
  if (grantableRoles.includes("developer")) return "developer";
  return grantableRoles[0] ?? null;
}

export function MemberInviteDialog({
  environmentId,
  open,
  onOpenChange,
  isOwner,
  grantableRoles,
  fixedProject = null,
  projects = [],
  onInvited,
}: MemberInviteDialogProps) {
  const gt = useGT();
  const m = useMessages();
  const nowMs = useNowSecond();
  const prepared = usePreparedConnection(environmentId);
  const createInvitation = useAtomCommand(authEnvironment.createInvitation, {
    reportFailure: false,
  });

  const [selectedRole, setSelectedRole] = useState<AssignableProjectRole | null>(() =>
    defaultInviteRole(grantableRoles),
  );
  const [selectedProjectValue, setSelectedProjectValue] = useState<string>(
    fixedProject ? fixedProject.id : ENVIRONMENT_SCOPE_VALUE,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [created, setCreated] = useState<InvitationCreateResult | null>(null);
  const [copiedTarget, setCopiedTarget] = useState<"code" | "link" | null>(null);
  const [manualCopyValue, setManualCopyValue] = useState<string | null>(null);

  const effectiveRole: AssignableProjectRole | null =
    selectedRole !== null && grantableRoles.includes(selectedRole)
      ? selectedRole
      : defaultInviteRole(grantableRoles);

  const effectiveProjectId: ProjectId | null =
    fixedProject !== null
      ? fixedProject.id
      : selectedProjectValue === ENVIRONMENT_SCOPE_VALUE
        ? null
        : (projects.find((project) => project.id === selectedProjectValue)?.id ?? null);

  const httpBaseUrl = prepared._tag === "Some" ? prepared.value.httpBaseUrl : null;
  const fallbackOrigin = typeof window !== "undefined" ? window.location.origin : undefined;
  const acceptUrl = created ? buildInviteAcceptUrl(httpBaseUrl, created.code, fallbackOrigin) : "";

  const { copyToClipboard } = useCopyToClipboard<{
    readonly target: "code" | "link";
    readonly value: string;
  }>({
    onCopy: ({ target }) => {
      setCopiedTarget(target);
      setManualCopyValue(null);
    },
    onError: (error, { target, value }) => {
      setManualCopyValue(value);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title:
            target === "link"
              ? gt("Could not copy invitation link")
              : gt("Could not copy invitation code"),
          description: error.message || gt("Copy the value manually instead."),
        }),
      );
    },
  });

  const resetDialogState = () => {
    setSelectedRole(defaultInviteRole(grantableRoles));
    setSelectedProjectValue(fixedProject ? fixedProject.id : ENVIRONMENT_SCOPE_VALUE);
    setErrorMessage(null);
    setCreated(null);
    setCopiedTarget(null);
    setManualCopyValue(null);
    setIsSubmitting(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetDialogState();
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async () => {
    if (isSubmitting) return;
    const validation = validateInviteForm(
      {
        role: effectiveRole,
        projectId: effectiveProjectId,
        isOwner,
        grantableRoles,
      },
      resolveMessage,
    );
    if (!validation.valid) {
      setErrorMessage(validation.error);
      return;
    }

    setErrorMessage(null);
    setIsSubmitting(true);
    const result = await createInvitation({
      environmentId,
      input: {
        kind: "staff",
        role: validation.role,
        projectId: validation.projectId,
      },
    });
    setIsSubmitting(false);

    if (result._tag === "Success") {
      setCreated(result.value);
      onInvited?.();
      return;
    }

    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setErrorMessage(formatMembershipErrorMessage(error, resolveMessage));
    }
  };

  const selectedProjectLabel =
    selectedProjectValue === ENVIRONMENT_SCOPE_VALUE
      ? gt("Environment-wide (no project assigned)")
      : (projects.find((project) => project.id === selectedProjectValue)?.label ??
        gt("Choose a project"));

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{created ? gt("Invitation created") : gt("Invite member")}</DialogTitle>
          <DialogDescription>
            {created
              ? gt("Share this one-time code or link. It can only be used once.")
              : fixedProject
                ? gt("Create a one-time invitation code for {project}.", {
                    project: fixedProject.label,
                  })
                : gt("Create a one-time invitation code for this environment.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {created ? (
              <>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-foreground">
                    <T>Invitation code</T>
                  </p>
                  <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-foreground">
                      {created.code}
                    </code>
                    <Button
                      size="xs"
                      variant="outline"
                      type="button"
                      onClick={() =>
                        copyToClipboard(created.code, { target: "code", value: created.code })
                      }
                    >
                      {copiedTarget === "code" ? <CheckIcon /> : <CopyIcon />}
                      {copiedTarget === "code" ? gt("Copied") : gt("Copy code")}
                    </Button>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-foreground">
                    <T>Accept link</T>
                  </p>
                  <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                      {acceptUrl}
                    </code>
                    <Button
                      size="xs"
                      variant="outline"
                      type="button"
                      onClick={() =>
                        copyToClipboard(acceptUrl, { target: "link", value: acceptUrl })
                      }
                    >
                      {copiedTarget === "link" ? <CheckIcon /> : <CopyIcon />}
                      {copiedTarget === "link" ? gt("Copied") : gt("Copy link")}
                    </Button>
                  </div>
                </div>

                {manualCopyValue !== null ? (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">
                      <T>Select and copy this value manually:</T>
                    </p>
                    <Textarea
                      readOnly
                      rows={2}
                      value={manualCopyValue}
                      onFocus={(event) => event.currentTarget.select()}
                      onClick={(event) => event.currentTarget.select()}
                    />
                  </div>
                ) : null}

                <p className="text-xs text-muted-foreground">
                  <T>
                    Role:{" "}
                    <strong className="font-medium text-foreground">
                      <Var>{m(PROJECT_ROLE_LABELS[created.invitation.role])}</Var>
                    </strong>
                    {" · "}
                    <Var>{formatExpiresInLabel(created.invitation.expiresAt, nowMs, m)}</Var> (
                    <Var>{formatAccessTimestamp(created.invitation.expiresAt)}</Var>)
                  </T>
                </p>
              </>
            ) : (
              <>
                {fixedProject === null && isOwner ? (
                  <div className="space-y-1.5">
                    <span className="block text-xs font-medium text-foreground">
                      <T>Project scope</T>
                    </span>
                    <Select
                      value={selectedProjectValue}
                      onValueChange={(value) => {
                        if (typeof value === "string") {
                          setSelectedProjectValue(value);
                          setErrorMessage(null);
                        }
                      }}
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label={gt("Invitation project scope")}
                        disabled={isSubmitting}
                      >
                        <SelectValue>{selectedProjectLabel}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="start" alignItemWithTrigger={false}>
                        <SelectItem hideIndicator value={ENVIRONMENT_SCOPE_VALUE}>
                          <T>Environment-wide (no project assigned)</T>
                        </SelectItem>
                        {projects.map((project) => (
                          <SelectItem hideIndicator key={project.id} value={project.id}>
                            {project.label}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                ) : null}

                <div className="space-y-1.5">
                  <span className="block text-xs font-medium text-foreground">
                    <T>Role</T>
                  </span>
                  {grantableRoles.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      <T>Your current permissions do not allow inviting new members.</T>
                    </p>
                  ) : (
                    <Select
                      value={effectiveRole ?? ""}
                      onValueChange={(value) => {
                        if (isAssignableProjectRole(value)) {
                          setSelectedRole(value);
                          setErrorMessage(null);
                        }
                      }}
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label={gt("Invitation role")}
                        disabled={isSubmitting}
                      >
                        <SelectValue>
                          {effectiveRole
                            ? m(PROJECT_ROLE_LABELS[effectiveRole])
                            : gt("Choose role")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="start" alignItemWithTrigger={false}>
                        {grantableRoles.map((role) => (
                          <SelectItem hideIndicator key={role} value={role}>
                            {m(PROJECT_ROLE_LABELS[role])}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  )}
                </div>

                <p className="text-xs text-muted-foreground">
                  <T>
                    No email is sent. The invited person opens the accept link or enters the code to
                    set their display name and start a session.
                  </T>
                </p>

                {errorMessage ? (
                  <Alert variant="error">
                    <AlertDescription>{errorMessage}</AlertDescription>
                  </Alert>
                ) : null}
              </>
            )}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          {created ? (
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
                disabled={isSubmitting || grantableRoles.length === 0}
                onClick={() => void handleSubmit()}
              >
                {isSubmitting ? gt("Creating…") : gt("Create invitation")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
