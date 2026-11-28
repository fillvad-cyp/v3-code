import { errorDisplayMessage, thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  AUDIT_LIST_DEFAULT_LIMIT,
  AuditAction,
  type AuditEvent,
  AuditOutcome,
  type AuditResourceType,
  type AuthSessionState,
  type EnvironmentId,
  type ListAuditEventsInput,
  MAX_AUDIT_RETENTION_DAYS,
  MIN_AUDIT_RETENTION_DAYS,
  type MemberWithMemberships,
  PrincipalId,
  ProjectId,
  roleHasCapability,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { isSessionOwner } from "./MembersSettings.logic";

export const AUDIT_PAGE_SIZE = AUDIT_LIST_DEFAULT_LIMIT;

export const AUDIT_ACTIONS: ReadonlyArray<AuditAction> = AuditAction.literals;
const AUDIT_ACTION_SET: ReadonlySet<string> = new Set(AUDIT_ACTIONS);

export const AUDIT_OUTCOME_LABELS: Readonly<Record<AuditOutcome, string>> = {
  allow: msg("Allowed", { $context: "audit event outcome" }),
  deny: msg("Denied", { $context: "audit event outcome" }),
  error: msg("Error", { $context: "audit event outcome" }),
};

export const AUDIT_ACTION_LABELS: Readonly<Record<AuditAction, string>> = {
  "login.succeeded": msg("Login succeeded"),
  "login.failed": msg("Login failed"),
  logout: msg("Signed out"),
  "invitation.created": msg("Invitation created"),
  "invitation.accepted": msg("Invitation accepted"),
  "invitation.revoked": msg("Invitation revoked"),
  "membership.role.changed": msg("Membership role changed"),
  "membership.suspended": msg("Membership suspended"),
  "membership.removed": msg("Membership removed"),
  "membership.expired": msg("Membership expired"),
  "member.suspended": msg("Member suspended"),
  "member.reactivated": msg("Member reactivated"),
  "member.removed": msg("Member removed"),
  "member.recovered": msg("Member recovered"),
  "owner.transferred": msg("Ownership transferred"),
  "session.issued": msg("Session issued"),
  "session.revoked": msg("Session revoked"),
  "token.created": msg("API token created"),
  "token.revoked": msg("API token revoked"),
  "terminal.opened": msg("Terminal opened"),
  "secret.read": msg("Secret read"),
  "project.secret.set": msg("Project secret updated"),
  "project.secret.deleted": msg("Project secret deleted"),
  "asset.url.issued": msg("Asset URL issued"),
  "preview.tunnel.opened": msg("Preview tunnel opened"),
  "authorization.denied": msg("Authorization denied"),
  "quota.exceeded": msg("Quota exceeded"),
  "crm.exported": msg("CRM exported"),
  "crm.purged": msg("CRM purged"),
};

const AUDIT_RESOURCE_TYPE_LABELS: Readonly<Record<AuditResourceType, string>> = {
  principal: msg("Member", { $context: "audit resource type" }),
  membership: msg("Membership", { $context: "audit resource type" }),
  invitation: msg("Invitation", { $context: "audit resource type" }),
  session: msg("Session", { $context: "audit resource type" }),
  api_token: msg("API token", { $context: "audit resource type" }),
  project: msg("Project", { $context: "audit resource type" }),
  thread: msg("Thread", { $context: "audit resource type" }),
  terminal: msg("Terminal", { $context: "audit resource type" }),
  secret: msg("Secret", { $context: "audit resource type" }),
  asset: msg("Asset", { $context: "audit resource type" }),
  preview: msg("Preview", { $context: "audit resource type" }),
  crm_client: msg("CRM client", { $context: "audit resource type" }),
  crm_contact: msg("CRM contact", { $context: "audit resource type" }),
};

export type AuditLogGateMode =
  | "no-environment"
  | "unsupported"
  | "session-error"
  | "loading-session"
  | "unauthenticated"
  | "loading-access"
  | "forbidden"
  | "ready";

export interface AuditLogGate {
  readonly mode: AuditLogGateMode;
  readonly visible: boolean;
  readonly isOwner: boolean;
  readonly shouldFetchMembers: boolean;
  /** `null` for owner (all projects + environment-wide); project list for project admins. */
  readonly adminProjectIds: ReadonlyArray<ProjectId> | null;
}

export function deriveAuditLogGate(input: {
  readonly environmentId: EnvironmentId | null;
  readonly session: AuthSessionState | null;
  readonly sessionPending: boolean;
  readonly sessionHasError: boolean;
  readonly auditSupported: boolean;
  readonly canReadAccess: boolean;
  readonly members: ReadonlyArray<MemberWithMemberships>;
  readonly membersPending: boolean;
}): AuditLogGate {
  const base: AuditLogGate = {
    mode: "no-environment",
    visible: false,
    isOwner: false,
    shouldFetchMembers: false,
    adminProjectIds: null,
  };

  if (input.environmentId === null) {
    return base;
  }
  if (!input.auditSupported) {
    return { ...base, mode: "unsupported" };
  }
  if (input.sessionHasError && input.session === null) {
    return { ...base, mode: "session-error" };
  }
  if (input.sessionPending && input.session === null) {
    return { ...base, mode: "loading-session" };
  }
  if (!input.session?.authenticated) {
    return { ...base, mode: "unauthenticated" };
  }
  if (!input.canReadAccess) {
    return { ...base, mode: "forbidden" };
  }

  if (isSessionOwner(input.session)) {
    return {
      mode: "ready",
      visible: true,
      isOwner: true,
      shouldFetchMembers: true,
      adminProjectIds: null,
    };
  }

  if (input.session.binding?._tag === "projects") {
    const adminProjectIds = input.session.binding.projects
      .filter((entry) => roleHasCapability(entry.role, "project:members"))
      .map((entry) => entry.projectId);
    if (adminProjectIds.length === 0) {
      return { ...base, mode: "forbidden" };
    }
    return {
      mode: "ready",
      visible: true,
      isOwner: false,
      shouldFetchMembers: true,
      adminProjectIds,
    };
  }

  const principalId = input.session.principal?.id;
  if (principalId === undefined) {
    return { ...base, mode: "forbidden" };
  }

  const self = input.members.find((entry) => entry.principal.id === principalId);
  if (self === undefined && input.membersPending) {
    return {
      ...base,
      mode: "loading-access",
      shouldFetchMembers: true,
    };
  }

  const adminProjectIds = (self?.memberships ?? [])
    .filter((entry) => entry.state === "active" && roleHasCapability(entry.role, "project:members"))
    .map((entry) => entry.projectId);
  if (adminProjectIds.length === 0) {
    return { ...base, mode: "forbidden", shouldFetchMembers: true };
  }

  return {
    mode: "ready",
    visible: true,
    isOwner: false,
    shouldFetchMembers: true,
    adminProjectIds,
  };
}

export interface AuditFilterDraft {
  readonly projectId: string;
  readonly actorPrincipalId: string;
  readonly action: string;
  readonly from: string;
  readonly to: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilterDraft = {
  projectId: "",
  actorPrincipalId: "",
  action: "",
  from: "",
  to: "",
};

export type AuditLogLoadStatus = "idle" | "loading" | "loading-more" | "ready" | "error";

export interface AuditLogState {
  readonly filters: AuditFilterDraft;
  readonly events: ReadonlyArray<AuditEvent>;
  readonly nextCursor: number | null;
  readonly status: AuditLogLoadStatus;
  readonly error: string | null;
  readonly requestId: number;
}

export type AuditLogAction =
  | { readonly type: "setFilter"; readonly field: keyof AuditFilterDraft; readonly value: string }
  | { readonly type: "resetFilters" }
  | { readonly type: "refresh" }
  | { readonly type: "fetchStart"; readonly requestId: number; readonly append: boolean }
  | {
      readonly type: "fetchSuccess";
      readonly requestId: number;
      readonly append: boolean;
      readonly events: ReadonlyArray<AuditEvent>;
      readonly nextCursor: number | null;
    }
  | { readonly type: "fetchError"; readonly requestId: number; readonly message: string };

export function createInitialAuditLogState(
  initialFilters?: Partial<AuditFilterDraft>,
): AuditLogState {
  return {
    filters: { ...EMPTY_AUDIT_FILTERS, ...initialFilters },
    events: [],
    nextCursor: null,
    status: "idle",
    error: null,
    requestId: 1,
  };
}

export function auditLogReducer(state: AuditLogState, action: AuditLogAction): AuditLogState {
  switch (action.type) {
    case "setFilter": {
      if (state.filters[action.field] === action.value) {
        return state;
      }
      return {
        filters: { ...state.filters, [action.field]: action.value },
        events: [],
        nextCursor: null,
        status: "idle",
        error: null,
        requestId: state.requestId + 1,
      };
    }
    case "resetFilters": {
      if (!hasActiveAuditFilters(state.filters) && state.error === null) {
        return state;
      }
      return {
        filters: EMPTY_AUDIT_FILTERS,
        events: [],
        nextCursor: null,
        status: "idle",
        error: null,
        requestId: state.requestId + 1,
      };
    }
    case "refresh": {
      return {
        ...state,
        events: [],
        nextCursor: null,
        status: "idle",
        error: null,
        requestId: state.requestId + 1,
      };
    }
    case "fetchStart": {
      if (action.requestId !== state.requestId) {
        return state;
      }
      return {
        ...state,
        status: action.append ? "loading-more" : "loading",
        error: null,
      };
    }
    case "fetchSuccess": {
      if (action.requestId !== state.requestId) {
        return state;
      }
      if (!action.append) {
        return {
          ...state,
          events: action.events,
          nextCursor: action.nextCursor,
          status: "ready",
          error: null,
        };
      }
      const seen = new Set(state.events.map((event) => event.id));
      const merged = [...state.events, ...action.events.filter((event) => !seen.has(event.id))];
      return {
        ...state,
        events: merged,
        nextCursor: action.nextCursor,
        status: "ready",
        error: null,
      };
    }
    case "fetchError": {
      if (action.requestId !== state.requestId) {
        return state;
      }
      return {
        ...state,
        status: "error",
        error: action.message,
      };
    }
  }
}

export function hasActiveAuditFilters(filters: AuditFilterDraft): boolean {
  return (
    filters.projectId.trim().length > 0 ||
    filters.actorPrincipalId.trim().length > 0 ||
    filters.action.trim().length > 0 ||
    filters.from.trim().length > 0 ||
    filters.to.trim().length > 0
  );
}

function parseFilterDateToIso(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

export type AuditQueryBuildResult =
  | { readonly ok: true; readonly input: ListAuditEventsInput }
  | { readonly ok: false; readonly error: string };

export function buildAuditQueryInput(
  filters: AuditFilterDraft,
  options?: {
    readonly cursor?: number | null;
    readonly limit?: number;
  },
  resolve: MessageResolver = m,
): AuditQueryBuildResult {
  const projectId = filters.projectId.trim();
  const actorPrincipalId = filters.actorPrincipalId.trim();
  const action = filters.action.trim();
  const rawFrom = filters.from.trim();
  const rawTo = filters.to.trim();

  if (action.length > 0 && !AUDIT_ACTION_SET.has(action)) {
    return { ok: false, error: resolve(msg("Unknown audit action filter.")) };
  }

  let fromIso: string | undefined;
  if (rawFrom.length > 0) {
    const parsed = parseFilterDateToIso(rawFrom);
    if (parsed === null) {
      return { ok: false, error: resolve(msg("Enter a valid start date.")) };
    }
    fromIso = parsed;
  }

  let toIso: string | undefined;
  if (rawTo.length > 0) {
    const parsed = parseFilterDateToIso(rawTo);
    if (parsed === null) {
      return { ok: false, error: resolve(msg("Enter a valid end date.")) };
    }
    toIso = parsed;
  }

  if (fromIso !== undefined && toIso !== undefined && Date.parse(fromIso) > Date.parse(toIso)) {
    return {
      ok: false,
      error: resolve(msg("The start date must be earlier than the end date.")),
    };
  }

  const cursor = options?.cursor ?? undefined;
  const limit = options?.limit ?? AUDIT_PAGE_SIZE;

  return {
    ok: true,
    input: {
      ...(projectId.length > 0 ? { projectId: ProjectId.make(projectId) } : {}),
      ...(actorPrincipalId.length > 0
        ? { actorPrincipalId: PrincipalId.make(actorPrincipalId) }
        : {}),
      ...(action.length > 0 ? { action: action as AuditAction } : {}),
      ...(fromIso !== undefined ? { from: fromIso } : {}),
      ...(toIso !== undefined ? { to: toIso } : {}),
      ...(cursor !== undefined && cursor !== null ? { cursor } : {}),
      limit,
    },
  };
}

export function validateAuditRetentionDays(
  raw: string,
  resolve: MessageResolver = m,
): { readonly ok: true; readonly days: number } | { readonly ok: false; readonly error: string } {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      error: resolve(
        msg("Enter a whole number of days between {min} and {max}.", {
          min: MIN_AUDIT_RETENTION_DAYS,
          max: MAX_AUDIT_RETENTION_DAYS,
        }),
      ),
    };
  }
  const days = Number(trimmed);
  if (
    !Number.isInteger(days) ||
    days < MIN_AUDIT_RETENTION_DAYS ||
    days > MAX_AUDIT_RETENTION_DAYS
  ) {
    return {
      ok: false,
      error: resolve(
        msg("Enter a whole number of days between {min} and {max}.", {
          min: MIN_AUDIT_RETENTION_DAYS,
          max: MAX_AUDIT_RETENTION_DAYS,
        }),
      ),
    };
  }
  return { ok: true, days };
}

export function auditOutcomeBadgeVariant(outcome: AuditOutcome) {
  switch (outcome) {
    case "allow":
      return "success" as const;
    case "deny":
      return "warning" as const;
    case "error":
      return "error" as const;
  }
}

export function formatAuditResource(
  event: Pick<AuditEvent, "resourceType" | "resourceId">,
  resolve: MessageResolver = m,
): string | null {
  const typeLabel =
    event.resourceType !== null ? resolve(AUDIT_RESOURCE_TYPE_LABELS[event.resourceType]) : null;
  if (typeLabel !== null && event.resourceId !== null) {
    return `${typeLabel} · ${event.resourceId}`;
  }
  return typeLabel ?? event.resourceId;
}

export function formatAuditErrorMessage(error: unknown, resolve: MessageResolver = m): string {
  const raw =
    thrownErrorMessage(error, resolve) ??
    errorDisplayMessage(error, resolve) ??
    (typeof error === "string" && error.trim().length > 0 ? error.trim() : null);

  if (raw !== null) {
    if (/only the environment owner or a project admin/i.test(raw)) {
      return resolve(msg("Only the environment owner or a project admin can view the audit log."));
    }
    if (/do not have permission to read audit events for this project/i.test(raw)) {
      return resolve(msg("You do not have permission to view audit events for this project."));
    }
    if (/only the environment owner/i.test(raw)) {
      return resolve(msg("Only the environment owner can change audit retention."));
    }
    return raw;
  }

  return resolve(msg("Could not load audit events. Try again."));
}
