import {
  type AdvertisedEndpoint,
  type EnvironmentId,
  type InvitationCreateResult,
  type ProjectId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CheckIcon, ChevronRightIcon, CopyIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowSecond } from "../../hooks/useNowSecond";
import { m as resolveMessage } from "../../i18n/messages";
import { cn } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { authEnvironment } from "../../state/auth";
import { desktopNetworkAccessStateAtom } from "../../state/desktopNetworkAccess";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession, usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatExpiresInLabel } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
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
import { formatAccessTimestamp, isTailscaleHttpsEndpoint } from "./ConnectionsSettings.logic";
import {
  DEFAULT_INVITATION_EXPIRES_IN_HOURS,
  INVITATION_EXPIRY_OPTIONS,
  PROJECT_ROLE_DESCRIPTIONS,
  PROJECT_ROLE_LABELS,
  formatMembershipErrorMessage,
  isInvitationExpiryHours,
  partitionInviteRoles,
  resolveInviteAcceptLink,
  validateInviteForm,
  type AssignableProjectRole,
  type InvitationExpiryHours,
} from "./MembersSettings.logic";

const ENVIRONMENT_SCOPE_VALUE = "__environment__";
const EMPTY_ADVERTISED_ENDPOINTS: ReadonlyArray<AdvertisedEndpoint> = [];

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
  readonly crmEnabled?: boolean;
  readonly onInvited?: () => void;
}

function defaultInviteRole(
  availableRoles: ReadonlyArray<AssignableProjectRole>,
): AssignableProjectRole | null {
  if (availableRoles.includes("developer")) return "developer";
  return availableRoles[0] ?? null;
}

export function MemberInviteDialog({
  environmentId,
  open,
  onOpenChange,
  isOwner,
  grantableRoles,
  fixedProject = null,
  projects = [],
  crmEnabled,
  onInvited,
}: MemberInviteDialogProps) {
  const gt = useGT();
  const m = useMessages();
  const nowMs = useNowSecond();
  const prepared = usePreparedConnection(environmentId);
  const environment = useEnvironment(environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const desktopBridge = typeof window !== "undefined" ? window.desktopBridge : undefined;
  const isPrimary = primaryEnvironmentId !== null && primaryEnvironmentId === environmentId;
  const defaultAdvertisedEndpointKey = useUiStateStore(
    (state) => state.defaultAdvertisedEndpointKey,
  );
  const desktopNetworkAccess = useEnvironmentQuery(
    open && isPrimary && desktopBridge ? desktopNetworkAccessStateAtom : null,
    m,
  );
  const createInvitation = useAtomCommand(authEnvironment.createInvitation, {
    reportFailure: false,
  });

  const crmConfigured =
    crmEnabled ?? environment?.serverConfig?.environment.capabilities.crm === true;
  const { primaryRoles, moreRoles, allRoles } = partitionInviteRoles(grantableRoles, crmConfigured);

  const [selectedRole, setSelectedRole] = useState<AssignableProjectRole | null>(() =>
    defaultInviteRole(allRoles),
  );
  const [selectedProjectValue, setSelectedProjectValue] = useState<string | null>(
    fixedProject ? fixedProject.id : null,
  );
  const [expiresInHours, setExpiresInHours] = useState<InvitationExpiryHours>(
    DEFAULT_INVITATION_EXPIRES_IN_HOURS,
  );
  const [moreRolesExpanded, setMoreRolesExpanded] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [created, setCreated] = useState<InvitationCreateResult | null>(null);
  const [copiedTarget, setCopiedTarget] = useState<"code" | "link" | null>(null);
  const [manualCopyValue, setManualCopyValue] = useState<string | null>(null);

  const effectiveRole: AssignableProjectRole | null =
    selectedRole !== null && allRoles.includes(selectedRole)
      ? selectedRole
      : defaultInviteRole(allRoles);

  const isMoreRolesOpen =
    moreRolesExpanded || (effectiveRole !== null && moreRoles.includes(effectiveRole));

  const resolvedProjectValue: string =
    fixedProject !== null
      ? fixedProject.id
      : (selectedProjectValue ?? projects[0]?.id ?? (isOwner ? ENVIRONMENT_SCOPE_VALUE : ""));

  const effectiveProjectId: ProjectId | null =
    fixedProject !== null
      ? fixedProject.id
      : resolvedProjectValue === ENVIRONMENT_SCOPE_VALUE || resolvedProjectValue.length === 0
        ? null
        : (projects.find((project) => project.id === resolvedProjectValue)?.id ?? null);

  const desktopExposure = desktopNetworkAccess.data?.serverExposureState ?? null;
  const desktopAdvertisedEndpoints =
    desktopNetworkAccess.data?.advertisedEndpoints ?? EMPTY_ADVERTISED_ENDPOINTS;
  const tailscaleHttpsEndpoint = desktopAdvertisedEndpoints.find(isTailscaleHttpsEndpoint) ?? null;
  const visibleDesktopNetworkEndpoints =
    desktopExposure?.mode === "network-accessible"
      ? desktopAdvertisedEndpoints.filter((endpoint) => !isTailscaleHttpsEndpoint(endpoint))
      : [];
  const visibleDesktopAdvertisedEndpoints = tailscaleHttpsEndpoint
    ? [...visibleDesktopNetworkEndpoints, tailscaleHttpsEndpoint]
    : visibleDesktopNetworkEndpoints;

  const httpBaseUrl = prepared._tag === "Some" ? prepared.value.httpBaseUrl : null;
  const fallbackOrigin = typeof window !== "undefined" ? window.location.origin : undefined;
  const resolvedLink = created
    ? resolveInviteAcceptLink({
        code: created.code,
        advertisedEndpoints: visibleDesktopAdvertisedEndpoints,
        defaultAdvertisedEndpointKey,
        desktopEndpointUrl:
          desktopExposure?.mode === "network-accessible" ? desktopExposure.endpointUrl : null,
        directEndpoints: environment?.serverConfig?.directEndpoints,
        httpBaseUrl,
        fallbackOrigin,
      })
    : null;
  const acceptUrl = resolvedLink?.url ?? "";

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
    setSelectedRole(defaultInviteRole(allRoles));
    setSelectedProjectValue(fixedProject ? fixedProject.id : null);
    setExpiresInHours(DEFAULT_INVITATION_EXPIRES_IN_HOURS);
    setMoreRolesExpanded(false);
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
        grantableRoles: allRoles,
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
        expiresInHours,
      },
    });
    setIsSubmitting(false);

    if (result._tag === "Success") {
      setCreated(result.value);
      if (result.value.multiUserEnabled === true) {
        appAtomRegistry.refresh(environmentSession.sessionStateAtom(environmentId));
      }
      onInvited?.();
      return;
    }

    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setErrorMessage(formatMembershipErrorMessage(error, resolveMessage));
    }
  };

  const selectedProjectLabel =
    resolvedProjectValue === ENVIRONMENT_SCOPE_VALUE
      ? gt("Environment-wide (advanced: no project assigned)")
      : (projects.find((project) => project.id === resolvedProjectValue)?.label ??
        gt("Choose a project"));

  const createdProjectLabel = created
    ? created.invitation.projectId === null
      ? gt("Environment-wide")
      : fixedProject && fixedProject.id === created.invitation.projectId
        ? fixedProject.label
        : (projects.find((project) => project.id === created.invitation.projectId)?.label ??
          created.invitation.projectId)
    : null;

  const selectedExpiryOption =
    INVITATION_EXPIRY_OPTIONS.find((option) => option.hours === expiresInHours) ??
    INVITATION_EXPIRY_OPTIONS[1];

  const renderRoleOption = (role: AssignableProjectRole) => {
    const isSelected = effectiveRole === role;
    return (
      <button
        key={role}
        type="button"
        role="radio"
        aria-checked={isSelected}
        disabled={isSubmitting}
        onClick={() => {
          setSelectedRole(role);
          setErrorMessage(null);
        }}
        className={cn(
          "flex w-full items-start justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-60",
          isSelected ? "border-foreground/60 bg-muted/40" : "border-border/60 hover:bg-muted/20",
        )}
      >
        <span className="min-w-0 space-y-0.5">
          <span className="block text-xs font-medium text-foreground">
            {m(PROJECT_ROLE_LABELS[role])}
          </span>
          <span className="block text-xs text-muted-foreground">
            {m(PROJECT_ROLE_DESCRIPTIONS[role])}
          </span>
        </span>
        {isSelected ? (
          <CheckIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-foreground" />
        ) : null}
      </button>
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{created ? gt("Invite link ready") : gt("Invite member")}</DialogTitle>
          <DialogDescription>
            {created
              ? gt("Share this one-time link or code. It can only be used once.")
              : fixedProject
                ? gt("Create a one-time invite link for {project}.", {
                    project: fixedProject.label,
                  })
                : gt("Create a one-time invite link that grants access to one project.")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {created ? (
              <>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-foreground">
                    <T>Invite link</T>
                  </p>
                  <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                    <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                      {acceptUrl}
                    </code>
                    <Button
                      size="xs"
                      variant="default"
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

                {resolvedLink?.isLoopbackOnly ? (
                  <Alert variant="warning">
                    <TriangleAlertIcon aria-hidden />
                    <AlertDescription>
                      <T>
                        Only a local address (127.0.0.1) is available. Other devices cannot open
                        this link until you enable Network access or Tailscale HTTPS in Sharing
                        &amp; access.
                      </T>
                    </AlertDescription>
                  </Alert>
                ) : null}

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
                    Project:{" "}
                    <strong className="font-medium text-foreground">
                      <Var>{createdProjectLabel}</Var>
                    </strong>
                    {" · "}
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
                {fixedProject === null && (projects.length > 0 || isOwner) ? (
                  <div className="space-y-1.5">
                    <span className="block text-xs font-medium text-foreground">
                      <T>Project</T>
                    </span>
                    <Select
                      value={resolvedProjectValue}
                      onValueChange={(value) => {
                        if (typeof value === "string") {
                          setSelectedProjectValue(value);
                          setErrorMessage(null);
                        }
                      }}
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label={gt("Invitation project")}
                        disabled={isSubmitting}
                      >
                        <SelectValue>{selectedProjectLabel}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup align="start" alignItemWithTrigger={false}>
                        {projects.map((project) => (
                          <SelectItem hideIndicator key={project.id} value={project.id}>
                            {project.label}
                          </SelectItem>
                        ))}
                        {isOwner ? (
                          <SelectItem hideIndicator value={ENVIRONMENT_SCOPE_VALUE}>
                            <span className="text-muted-foreground">
                              <T>Environment-wide (advanced: no project assigned)</T>
                            </span>
                          </SelectItem>
                        ) : null}
                      </SelectPopup>
                    </Select>
                  </div>
                ) : null}

                <div className="space-y-1.5">
                  <span className="block text-xs font-medium text-foreground">
                    <T>Role</T>
                  </span>
                  {allRoles.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      <T>Your current permissions do not allow inviting new members.</T>
                    </p>
                  ) : (
                    <div className="space-y-2" role="radiogroup" aria-label={gt("Invitation role")}>
                      {primaryRoles.map(renderRoleOption)}
                      {moreRoles.length > 0 ? (
                        <div className="space-y-2 pt-0.5">
                          <button
                            type="button"
                            aria-expanded={isMoreRolesOpen}
                            disabled={isSubmitting}
                            onClick={() => setMoreRolesExpanded((current) => !current)}
                            className="inline-flex items-center gap-1 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                          >
                            <ChevronRightIcon
                              aria-hidden
                              className={cn(
                                "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                                isMoreRolesOpen && "rotate-90",
                              )}
                            />
                            <T>More roles</T>
                          </button>
                          {isMoreRolesOpen ? (
                            <div className="space-y-2">{moreRoles.map(renderRoleOption)}</div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>

                <div className="space-y-1.5">
                  <span className="block text-xs font-medium text-foreground">
                    <T>Expires in</T>
                  </span>
                  <Select
                    value={String(expiresInHours)}
                    onValueChange={(value) => {
                      const parsed = Number(value);
                      if (isInvitationExpiryHours(parsed)) {
                        setExpiresInHours(parsed);
                        setErrorMessage(null);
                      }
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label={gt("Invitation expiration")}
                      disabled={isSubmitting}
                    >
                      <SelectValue>{m(selectedExpiryOption.label)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="start" alignItemWithTrigger={false}>
                      {INVITATION_EXPIRY_OPTIONS.map((option) => (
                        <SelectItem hideIndicator key={option.hours} value={String(option.hours)}>
                          {m(option.label)}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>

                <p className="text-xs text-muted-foreground">
                  <T>
                    No email is sent. The invited person opens the link to join directly, or adds
                    this project to their existing account.
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
                disabled={isSubmitting || allRoles.length === 0}
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
