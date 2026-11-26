import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_AUDIT_RETENTION_DAYS,
  EnvironmentId,
  MAX_AUDIT_RETENTION_DAYS,
  MIN_AUDIT_RETENTION_DAYS,
  type MemberWithMemberships,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Link, useSearch } from "@tanstack/react-router";
import { RefreshCwIcon, RotateCcwIcon, ShieldAlertIcon } from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import { T, useGT, useMessages } from "gt-react";

import { useClientSettings } from "../../hooks/useSettings";
import { m as resolveMessage } from "../../i18n/messages";
import { authEnvironment } from "../../state/auth";
import { useProjects } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatDateTimeTimestamp, formatFullTimestamp } from "../../timestampFormat";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ACTIONS,
  AUDIT_OUTCOME_LABELS,
  AUDIT_PAGE_SIZE,
  auditLogReducer,
  auditOutcomeBadgeVariant,
  buildAuditQueryInput,
  createInitialAuditLogState,
  deriveAuditLogGate,
  formatAuditErrorMessage,
  formatAuditResource,
  hasActiveAuditFilters,
  validateAuditRetentionDays,
} from "./AuditLogSettings.logic";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { supportsAuditCapability } from "./MembersSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { useAccessEnvironment } from "./useAccessEnvironment";

const EMPTY_MEMBERS: ReadonlyArray<MemberWithMemberships> = [];
const ALL_FILTER_VALUE = "__all__";

function AuditRetentionSection({
  environmentId,
  currentDays,
}: {
  readonly environmentId: EnvironmentId;
  readonly currentDays: number;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState(String(currentDays));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedDays, setSavedDays] = useState<number | null>(null);

  const canUpdateRetention = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId, {
      patch: { auditRetentionDays: currentDays },
    }),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });

  const validation = validateAuditRetentionDays(draft, resolveMessage);
  const isDirty = validation.ok && validation.days !== currentDays;

  const handleSave = async () => {
    if (!canUpdateRetention || saving) return;
    if (!validation.ok) {
      setSaveError(validation.error);
      return;
    }
    setSaveError(null);
    setSavedDays(null);
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { auditRetentionDays: validation.days } },
    });
    setSaving(false);
    if (result._tag === "Success") {
      setSavedDays(validation.days);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setSaveError(formatAuditErrorMessage(error, resolveMessage));
    }
  };

  return (
    <SettingsSection id="audit-retention" title={gt("Audit retention")}>
      <SettingsRow
        title={gt("Retention period")}
        description={gt(
          "Audit events older than this are pruned hourly. Only the environment owner can change this setting.",
        )}
        control={
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-24">
              <Input
                size="sm"
                font="mono"
                type="number"
                min={MIN_AUDIT_RETENTION_DAYS}
                max={MAX_AUDIT_RETENTION_DAYS}
                value={draft}
                disabled={!canUpdateRetention || saving}
                aria-label={gt("Audit retention in days")}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setSaveError(null);
                  setSavedDays(null);
                }}
              />
            </div>
            <span className="text-xs text-muted-foreground">
              <T>days</T>
            </span>
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={!canUpdateRetention || saving || !isDirty}
              onClick={() => void handleSave()}
            >
              {saving ? gt("Saving…") : gt("Save")}
            </Button>
          </div>
        }
      />
      {!validation.ok && draft.trim().length > 0 ? (
        <div className="px-3 pb-2.5 sm:px-4">
          <p className="text-xs text-destructive-foreground">{validation.error}</p>
        </div>
      ) : null}
      {saveError ? (
        <div className="px-3 pb-2.5 sm:px-4">
          <Alert variant="error">
            <AlertDescription>{saveError}</AlertDescription>
          </Alert>
        </div>
      ) : null}
      {savedDays !== null ? (
        <div className="px-3 pb-2.5 sm:px-4">
          <p className="text-xs text-muted-foreground">
            {gt("Audit retention updated to {days} days.", { days: savedDays })}
          </p>
        </div>
      ) : null}
    </SettingsSection>
  );
}

function AuditLogContent({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const m = useMessages();
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const environment = useEnvironment(environmentId);
  const session = useEnvironmentSessionState(environmentId);
  const allProjects = useProjects();

  const auditSupported = supportsAuditCapability(
    environment?.serverConfig?.environment.capabilities,
  );
  const canReadAccess = useAtomValue(authEnvironment.listAuditEvents.permissionAtom(environmentId));
  const canReadMembers = useAtomValue(authEnvironment.listMembers.permissionAtom(environmentId));

  const shouldPreFetchMembers =
    auditSupported && canReadMembers && session.data?.authenticated === true;
  const membersQuery = useEnvironmentQuery(
    shouldPreFetchMembers ? authEnvironment.listMembers({ environmentId, input: null }) : null,
    m,
  );

  const members = membersQuery.data ?? EMPTY_MEMBERS;
  const gate = deriveAuditLogGate({
    environmentId,
    session: session.data,
    sessionPending: session.isPending,
    sessionHasError: session.hasError,
    auditSupported,
    canReadAccess,
    members,
    membersPending: shouldPreFetchMembers && membersQuery.isPending && membersQuery.data === null,
  });

  const [state, dispatch] = useReducer(auditLogReducer, undefined, () =>
    createInitialAuditLogState(),
  );
  const listAuditEvents = useAtomCommand(authEnvironment.listAuditEvents, {
    reportFailure: false,
  });

  const environmentProjects = allProjects
    .filter((project) => project.environmentId === environmentId)
    .map((project) => ({ id: project.id, label: project.title }));
  const projectTitleById = new Map(
    environmentProjects.map((project) => [project.id, project.label] as const),
  );
  const visibleProjects =
    gate.adminProjectIds === null
      ? environmentProjects
      : gate.adminProjectIds.map((id) => ({
          id,
          label: projectTitleById.get(id) ?? id,
        }));

  const actorNameById = new Map(
    members.map((member) => [member.principal.id, member.principal.displayName] as const),
  );

  const queryValidation = buildAuditQueryInput(state.filters, { limit: AUDIT_PAGE_SIZE }, m);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the active audit log page from the environment HTTP API whenever the environment, gate, or filter request changes
  useEffect(() => {
    if (!gate.visible) return;
    const built = buildAuditQueryInput(state.filters, { limit: AUDIT_PAGE_SIZE }, resolveMessage);
    if (!built.ok) {
      dispatch({ type: "fetchError", requestId: state.requestId, message: built.error });
      return;
    }

    let cancelled = false;
    const requestId = state.requestId;
    dispatch({ type: "fetchStart", requestId, append: false });
    void listAuditEvents({ environmentId, input: built.input }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") {
        dispatch({
          type: "fetchSuccess",
          requestId,
          append: false,
          events: result.value.events,
          nextCursor: result.value.nextCursor,
        });
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        dispatch({
          type: "fetchError",
          requestId,
          message: formatAuditErrorMessage(error, resolveMessage),
        });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [environmentId, gate.visible, listAuditEvents, state.filters, state.requestId]);

  const handleLoadMore = async () => {
    if (
      !gate.visible ||
      state.nextCursor === null ||
      state.status === "loading" ||
      state.status === "loading-more"
    ) {
      return;
    }
    const built = buildAuditQueryInput(
      state.filters,
      { cursor: state.nextCursor, limit: AUDIT_PAGE_SIZE },
      resolveMessage,
    );
    if (!built.ok) {
      dispatch({ type: "fetchError", requestId: state.requestId, message: built.error });
      return;
    }
    const requestId = state.requestId;
    dispatch({ type: "fetchStart", requestId, append: true });
    const result = await listAuditEvents({ environmentId, input: built.input });
    if (result._tag === "Success") {
      dispatch({
        type: "fetchSuccess",
        requestId,
        append: true,
        events: result.value.events,
        nextCursor: result.value.nextCursor,
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      dispatch({
        type: "fetchError",
        requestId,
        message: formatAuditErrorMessage(error, resolveMessage),
      });
    }
  };

  const retentionDays =
    environment?.serverConfig?.settings.auditRetentionDays ?? DEFAULT_AUDIT_RETENTION_DAYS;
  const filtersActive = hasActiveAuditFilters(state.filters);
  const isInitialLoading =
    (state.status === "idle" || state.status === "loading") && state.events.length === 0;
  const isLoadingMore = state.status === "loading-more";

  if (gate.mode !== "ready") {
    return (
      <SettingsSection
        id="audit-log"
        title={gt("Audit log")}
        headerAction={
          <Button size="xs" variant="ghost-muted" render={<Link to="/settings/access" />}>
            <T>Sharing &amp; access</T>
          </Button>
        }
      >
        {gate.mode === "unsupported" ? (
          <SettingsRow
            title={gt("Audit log unavailable")}
            description={gt(
              "Enable multi-user mode on a supporting environment to view audit events.",
            )}
          />
        ) : gate.mode === "loading-session" || gate.mode === "loading-access" ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              <T>Loading audit access…</T>
            </p>
          </div>
        ) : gate.mode === "session-error" ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <Alert variant="error">
              <AlertDescription>
                <T>Could not load your session for this environment.</T>
              </AlertDescription>
            </Alert>
          </div>
        ) : gate.mode === "unauthenticated" ? (
          <SettingsRow
            title={gt("Not signed in")}
            description={gt("Sign in to this environment to view the audit log.")}
            control={
              <Button size="sm" variant="outline" render={<Link to="/login" />}>
                <T>Sign in</T>
              </Button>
            }
          />
        ) : (
          <div className="px-3 py-2.5 sm:px-4">
            <Alert variant="warning">
              <ShieldAlertIcon aria-hidden />
              <AlertDescription>
                <T>Only the environment owner or a project admin can view the audit log.</T>
              </AlertDescription>
            </Alert>
          </div>
        )}
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection
        id="audit-log"
        title={gt("Audit log")}
        titleAction={
          gate.isOwner ? (
            <Badge variant="default" size="sm">
              <T>All projects</T>
            </Badge>
          ) : (
            <Badge variant="outline" size="sm">
              <T>Your administered projects</T>
            </Badge>
          )
        }
        headerAction={
          <div className="flex flex-wrap items-center gap-1.5">
            {filtersActive ? (
              <Button
                size="xs"
                variant="ghost-muted"
                type="button"
                onClick={() => dispatch({ type: "resetFilters" })}
              >
                <RotateCcwIcon />
                <T>Reset filters</T>
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              type="button"
              disabled={state.status === "loading" || isLoadingMore}
              onClick={() => dispatch({ type: "refresh" })}
            >
              <RefreshCwIcon />
              <T>Refresh</T>
            </Button>
            <Button size="xs" variant="ghost-muted" render={<Link to="/settings/access" />}>
              <T>Sharing &amp; access</T>
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-2 px-3 py-3 sm:grid-cols-2 sm:px-4 lg:grid-cols-5">
          <Select
            value={state.filters.projectId || ALL_FILTER_VALUE}
            onValueChange={(value) => {
              if (typeof value === "string") {
                dispatch({
                  type: "setFilter",
                  field: "projectId",
                  value: value === ALL_FILTER_VALUE ? "" : value,
                });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Filter by project")}>
              <SelectValue>
                {state.filters.projectId
                  ? (projectTitleById.get(state.filters.projectId as never) ??
                    state.filters.projectId)
                  : gt("All projects")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={ALL_FILTER_VALUE}>
                <T>All projects</T>
              </SelectItem>
              {visibleProjects.map((project) => (
                <SelectItem hideIndicator key={project.id} value={project.id}>
                  {project.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>

          <Select
            value={state.filters.actorPrincipalId || ALL_FILTER_VALUE}
            onValueChange={(value) => {
              if (typeof value === "string") {
                dispatch({
                  type: "setFilter",
                  field: "actorPrincipalId",
                  value: value === ALL_FILTER_VALUE ? "" : value,
                });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Filter by actor")}>
              <SelectValue>
                {state.filters.actorPrincipalId
                  ? (actorNameById.get(state.filters.actorPrincipalId as never) ??
                    state.filters.actorPrincipalId)
                  : gt("All actors")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={ALL_FILTER_VALUE}>
                <T>All actors</T>
              </SelectItem>
              {members.map((member) => (
                <SelectItem hideIndicator key={member.principal.id} value={member.principal.id}>
                  {member.principal.displayName}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>

          <Select
            value={state.filters.action || ALL_FILTER_VALUE}
            onValueChange={(value) => {
              if (typeof value === "string") {
                dispatch({
                  type: "setFilter",
                  field: "action",
                  value: value === ALL_FILTER_VALUE ? "" : value,
                });
              }
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Filter by action")}>
              <SelectValue>
                {state.filters.action
                  ? m(AUDIT_ACTION_LABELS[state.filters.action as keyof typeof AUDIT_ACTION_LABELS])
                  : gt("All actions")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={ALL_FILTER_VALUE}>
                <T>All actions</T>
              </SelectItem>
              {AUDIT_ACTIONS.map((action) => (
                <SelectItem hideIndicator key={action} value={action}>
                  {m(AUDIT_ACTION_LABELS[action])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>

          <Input
            size="sm"
            type="datetime-local"
            value={state.filters.from}
            aria-label={gt("From date and time")}
            onChange={(event) =>
              dispatch({ type: "setFilter", field: "from", value: event.target.value })
            }
          />

          <Input
            size="sm"
            type="datetime-local"
            value={state.filters.to}
            aria-label={gt("To date and time")}
            onChange={(event) =>
              dispatch({ type: "setFilter", field: "to", value: event.target.value })
            }
          />
        </div>

        {!queryValidation.ok ? (
          <div className="px-3 pb-2 sm:px-4">
            <Alert variant="error">
              <AlertDescription>{queryValidation.error}</AlertDescription>
            </Alert>
          </div>
        ) : state.error ? (
          <div className="px-3 pb-2 sm:px-4">
            <Alert variant="error">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          </div>
        ) : null}

        {isInitialLoading ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              <T>Loading audit events…</T>
            </p>
          </div>
        ) : state.events.length === 0 ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              {filtersActive ? (
                <T>No audit events match the active filters.</T>
              ) : (
                <T>No audit events recorded yet.</T>
              )}
            </p>
          </div>
        ) : (
          <div className="px-1 py-1 sm:px-2">
            <Table aria-label={gt("Audit events")}>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">
                    <T>Time</T>
                  </TableHead>
                  <TableHead scope="col">
                    <T>Actor</T>
                  </TableHead>
                  <TableHead scope="col">
                    <T>Action</T>
                  </TableHead>
                  <TableHead scope="col">
                    <T>Resource</T>
                  </TableHead>
                  <TableHead scope="col">
                    <T>Project</T>
                  </TableHead>
                  <TableHead scope="col">
                    <T>Outcome</T>
                  </TableHead>
                  <TableHead scope="col">
                    <T>IP</T>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.events.map((event) => {
                  const actorLabel =
                    event.actorPrincipalId !== null
                      ? (actorNameById.get(event.actorPrincipalId) ?? event.actorPrincipalId)
                      : null;
                  const resourceLabel = formatAuditResource(event, m);
                  const projectLabel =
                    event.projectId !== null
                      ? (projectTitleById.get(event.projectId) ?? event.projectId)
                      : null;

                  return (
                    <TableRow key={event.id}>
                      <TableCell>
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <time
                                dateTime={event.at}
                                className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground"
                              />
                            }
                          >
                            {formatDateTimeTimestamp(event.at, timestampFormat)}
                          </TooltipTrigger>
                          <TooltipPopup>
                            {formatFullTimestamp(event.at, timestampFormat)}
                          </TooltipPopup>
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        <span className="block max-w-36 truncate text-xs text-foreground">
                          {actorLabel ?? "-"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-xs font-medium text-foreground">
                            {m(AUDIT_ACTION_LABELS[event.action])}
                          </span>
                          <code className="font-mono text-2xs text-muted-foreground">
                            {event.action}
                          </code>
                        </div>
                      </TableCell>
                      <TableCell>
                        {resourceLabel !== null ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span className="block max-w-44 truncate font-mono text-xs text-muted-foreground" />
                              }
                            >
                              {resourceLabel}
                            </TooltipTrigger>
                            <TooltipPopup>{resourceLabel}</TooltipPopup>
                          </Tooltip>
                        ) : (
                          <span className="font-mono text-xs text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {projectLabel !== null ? (
                          <span className="block max-w-36 truncate text-xs text-foreground">
                            {projectLabel}
                          </span>
                        ) : (
                          <Badge variant="secondary" size="sm">
                            <T>Environment</T>
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant={auditOutcomeBadgeVariant(event.outcome)} size="sm">
                          {m(AUDIT_OUTCOME_LABELS[event.outcome])}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="whitespace-nowrap font-mono text-xs tabular-nums text-muted-foreground">
                          {event.ip ?? "-"}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {state.nextCursor !== null ? (
          <div className="flex justify-center border-t px-3 py-3 sm:px-4">
            <Button
              size="sm"
              variant="outline"
              type="button"
              disabled={isLoadingMore || state.status === "loading"}
              onClick={() => void handleLoadMore()}
            >
              {isLoadingMore ? gt("Loading…") : gt("Load more")}
            </Button>
          </div>
        ) : null}
      </SettingsSection>

      {gate.isOwner ? (
        <AuditRetentionSection
          key={`${environmentId}:${retentionDays}`}
          environmentId={environmentId}
          currentDays={retentionDays}
        />
      ) : null}
    </>
  );
}

export function AuditLogAccessRow({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  if (environmentId === null) return null;
  return <AuditLogAccessRowContent environmentId={environmentId} />;
}

function AuditLogAccessRowContent({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const gt = useGT();
  const m = useMessages();
  const environment = useEnvironment(environmentId);
  const session = useEnvironmentSessionState(environmentId);
  const auditSupported = supportsAuditCapability(
    environment?.serverConfig?.environment.capabilities,
  );
  const canReadAccess = useAtomValue(authEnvironment.listAuditEvents.permissionAtom(environmentId));
  const canReadMembers = useAtomValue(authEnvironment.listMembers.permissionAtom(environmentId));
  const shouldFetchMembers =
    auditSupported && canReadMembers && session.data?.authenticated === true;
  const membersQuery = useEnvironmentQuery(
    shouldFetchMembers ? authEnvironment.listMembers({ environmentId, input: null }) : null,
    m,
  );
  const gate = deriveAuditLogGate({
    environmentId,
    session: session.data,
    sessionPending: session.isPending,
    sessionHasError: session.hasError,
    auditSupported,
    canReadAccess,
    members: membersQuery.data ?? EMPTY_MEMBERS,
    membersPending: shouldFetchMembers && membersQuery.isPending && membersQuery.data === null,
  });

  if (!gate.visible) {
    return null;
  }

  return (
    <SettingsRow
      title={gt("Audit log")}
      description={
        gate.isOwner
          ? gt("Review security events, logins, invitations, and membership changes.")
          : gt("Review audit events for the projects you administer.")
      }
      control={
        <Button size="sm" variant="outline" render={<Link to="/settings/audit" />}>
          <T>View audit log</T>
        </Button>
      }
    />
  );
}

export function AuditLogPage() {
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
            <T>Showing audit log for</T>
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

      {environmentId === null ? (
        <SettingsSection id="audit-log" title={gt("Audit log")}>
          <SettingsRow
            title={gt("No environment selected")}
            description={gt("Connect an environment to view its audit log.")}
          />
        </SettingsSection>
      ) : (
        <AuditLogContent key={environmentId} environmentId={environmentId} />
      )}
    </SettingsPageContainer>
  );
}
