import { errorDisplayMessage, thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type AdvertisedEndpoint,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthEnvironmentScope,
  type AuthSessionState,
  type ExecutionEnvironmentCapabilities,
  type Invitation,
  type MemberWithMemberships,
  type MembershipState,
  type Principal,
  type PrincipalCeilingTemplate,
  type PrincipalStatus,
  type ProjectId,
  type ProjectMembership,
  type ProjectRole,
  type ServerDirectEndpoint,
  boundProjectRole,
  ceilingScopes,
  passesProjectChecks,
  roleAtLeast,
  roleFitsCeiling,
  roleHasCapability,
  sessionGrantsScope,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { isLoopbackHostname } from "~/environments/primary";
import { m, type MessageResolver } from "../../i18n/messages";
import { selectPairingEndpoint } from "./ConnectionsSettings.logic";

export const ASSIGNABLE_PROJECT_ROLES = [
  "viewer",
  "operator",
  "developer",
  "manager",
  "admin",
] as const satisfies ReadonlyArray<Exclude<ProjectRole, "owner">>;

export type AssignableProjectRole = (typeof ASSIGNABLE_PROJECT_ROLES)[number];

const PRIMARY_INVITE_ROLES = [
  "viewer",
  "developer",
  "admin",
] as const satisfies ReadonlyArray<AssignableProjectRole>;

const MORE_INVITE_ROLES = [
  "operator",
  "manager",
] as const satisfies ReadonlyArray<AssignableProjectRole>;

export const PROJECT_ROLE_DESCRIPTIONS: Readonly<Record<AssignableProjectRole, string>> = {
  viewer: msg("Read-only access"),
  developer: msg("Code, terminal, and agents"),
  admin: msg("Members and project settings"),
  operator: msg("Run agents, terminal, and previews"),
  manager: msg("Operate threads and manage CRM clients"),
};

export const INVITATION_EXPIRY_OPTIONS = [
  { hours: 24, label: msg("24 hours") },
  { hours: 168, label: msg("7 days") },
  { hours: 720, label: msg("30 days") },
] as const;

export type InvitationExpiryHours = (typeof INVITATION_EXPIRY_OPTIONS)[number]["hours"];
export const DEFAULT_INVITATION_EXPIRES_IN_HOURS: InvitationExpiryHours = 168;

export function isInvitationExpiryHours(value: number): value is InvitationExpiryHours {
  return value === 24 || value === 168 || value === 720;
}

export function partitionInviteRoles(
  grantableRoles: ReadonlyArray<AssignableProjectRole>,
  crmConfigured: boolean,
): {
  readonly primaryRoles: ReadonlyArray<AssignableProjectRole>;
  readonly moreRoles: ReadonlyArray<AssignableProjectRole>;
  readonly allRoles: ReadonlyArray<AssignableProjectRole>;
} {
  const primaryRoles = PRIMARY_INVITE_ROLES.filter((role) => grantableRoles.includes(role));
  const moreRoles = MORE_INVITE_ROLES.filter(
    (role) => grantableRoles.includes(role) && (role !== "manager" || crmConfigured),
  );
  return {
    primaryRoles,
    moreRoles,
    allRoles: [...primaryRoles, ...moreRoles],
  };
}

export function pendingInvitationsList(
  invitations: ReadonlyArray<Invitation>,
  nowMs?: number,
): ReadonlyArray<Invitation> {
  return invitations
    .filter((invitation) => {
      if (invitation.principalId != null) return false;
      if (invitation.acceptedAt !== null || invitation.revokedAt !== null) return false;
      if (nowMs !== undefined) {
        const expiresAtMs = Date.parse(invitation.expiresAt);
        if (Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs) return false;
      }
      return true;
    })
    .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export const CEILING_TEMPLATES = [
  "staff",
  "restricted",
  "client",
] as const satisfies ReadonlyArray<PrincipalCeilingTemplate>;

export const PROJECT_ROLE_LABELS: Readonly<Record<ProjectRole, string>> = {
  viewer: msg("Viewer", { $context: "project membership role" }),
  operator: msg("Operator", { $context: "project membership role" }),
  developer: msg("Developer", { $context: "project membership role" }),
  manager: msg("Manager", { $context: "project membership role" }),
  admin: msg("Admin", { $context: "project membership role" }),
  owner: msg("Owner", { $context: "environment owner role" }),
};

export const MEMBERSHIP_STATE_LABELS: Readonly<Record<MembershipState, string>> = {
  invited: msg("Invited", { $context: "member state" }),
  active: msg("Active", { $context: "member state" }),
  suspended: msg("Suspended", { $context: "member state" }),
  removed: msg("Removed", { $context: "member state" }),
};

export const PRINCIPAL_STATUS_LABELS: Readonly<Record<PrincipalStatus, string>> = {
  invited: msg("Invited", { $context: "member state" }),
  active: msg("Active", { $context: "member state" }),
  suspended: msg("Suspended", { $context: "member state" }),
  removed: msg("Removed", { $context: "member state" }),
};

export const CEILING_TEMPLATE_LABELS: Readonly<Record<PrincipalCeilingTemplate, string>> = {
  staff: msg("Staff", { $context: "member permission ceiling template" }),
  restricted: msg("Restricted", { $context: "member permission ceiling template" }),
  client: msg("Client", { $context: "member permission ceiling template" }),
};

export const CEILING_TEMPLATE_DESCRIPTIONS: Readonly<Record<PrincipalCeilingTemplate, string>> = {
  staff: msg("Full project roles up to admin"),
  restricted: msg("Read and operate only (no file or git writes)"),
  client: msg("Read-only project access"),
};

const ROLE_DISPLAY_ORDER: Readonly<Record<ProjectRole, number>> = {
  owner: 0,
  admin: 1,
  developer: 2,
  operator: 3,
  manager: 4,
  viewer: 5,
};

const STATUS_DISPLAY_ORDER: Readonly<Record<PrincipalStatus, number>> = {
  active: 0,
  invited: 1,
  suspended: 2,
  removed: 3,
};

const isAuthEnvironmentScope = Schema.is(AuthEnvironmentScope);

export interface ProjectMemberEntry {
  readonly principal: Principal;
  readonly membership: ProjectMembership;
}

export function isAssignableProjectRole(value: unknown): value is AssignableProjectRole {
  return (
    typeof value === "string" && (ASSIGNABLE_PROJECT_ROLES as ReadonlyArray<string>).includes(value)
  );
}

export function isCeilingTemplate(value: unknown): value is PrincipalCeilingTemplate {
  return typeof value === "string" && (CEILING_TEMPLATES as ReadonlyArray<string>).includes(value);
}

/**
 * Mirrors ProjectAccess owner detection on the client: an explicit principal is authoritative,
 * otherwise a legacy environment-bound session with maintenance and access-write grants is owner.
 */
export function isSessionOwner(session: AuthSessionState | null): boolean {
  if (!session?.authenticated) return false;
  if (session.principal !== undefined) return session.principal.kind === "owner";
  if (session.role !== undefined) return session.role === "owner";
  return (
    passesProjectChecks(session.binding) &&
    sessionGrantsScope(session, AuthEnvironmentMaintainScope) &&
    sessionGrantsScope(session, AuthAccessWriteScope)
  );
}

function resolveActorProjectRole(input: {
  readonly session: AuthSessionState | null;
  readonly projectId: ProjectId;
  readonly members: ReadonlyArray<MemberWithMemberships>;
}): ProjectRole | undefined {
  const { session, projectId, members } = input;
  if (!session?.authenticated) return undefined;
  if (isSessionOwner(session)) return "owner";
  if (session.binding?._tag === "projects") {
    return boundProjectRole(session.binding, projectId);
  }
  const principalId = session.principal?.id;
  if (principalId !== undefined) {
    const self = members.find((entry) => entry.principal.id === principalId);
    const membership = self?.memberships.find(
      (entry) => entry.projectId === projectId && entry.state === "active",
    );
    if (membership !== undefined) return membership.role;
  }
  return undefined;
}

export function grantableRolesForActor(input: {
  readonly isOwner: boolean;
  readonly actorRole: ProjectRole | undefined;
  readonly actorCeiling?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<AssignableProjectRole> {
  if (input.isOwner) return ASSIGNABLE_PROJECT_ROLES;
  if (input.actorRole === undefined || !roleHasCapability(input.actorRole, "project:members")) {
    return [];
  }
  const actorRole = input.actorRole;
  const ceiling = input.actorCeiling?.filter(isAuthEnvironmentScope);
  return ASSIGNABLE_PROJECT_ROLES.filter(
    (role) =>
      roleAtLeast(actorRole, role) && (ceiling === undefined || roleFitsCeiling(ceiling, role)),
  );
}

export function deriveProjectMemberPermissions(input: {
  readonly session: AuthSessionState | null;
  readonly canWriteAccess: boolean;
  readonly projectId: ProjectId;
  readonly members: ReadonlyArray<MemberWithMemberships>;
}) {
  const isOwner = isSessionOwner(input.session);
  const actorRole = resolveActorProjectRole({
    session: input.session,
    projectId: input.projectId,
    members: input.members,
  });
  const canManage =
    input.canWriteAccess &&
    (isOwner || (actorRole !== undefined && roleHasCapability(actorRole, "project:members")));
  const grantableRoles = canManage
    ? grantableRolesForActor({
        isOwner,
        actorRole,
        actorCeiling: isOwner ? undefined : input.session?.principal?.ceiling,
      })
    : [];

  return {
    isOwner,
    actorRole,
    canManage,
    canInvite: canManage && grantableRoles.length > 0,
    grantableRoles,
    canManageMember: (target: ProjectMemberEntry) =>
      canManage &&
      target.principal.kind !== "owner" &&
      (isOwner || (actorRole !== undefined && roleAtLeast(actorRole, target.membership.role))),
    canIssueLoginCode: (principal: Principal) =>
      input.session?.authenticated === true &&
      principal.status === "active" &&
      (isOwner || input.session.principal?.id === principal.id),
  };
}

export function supportsMembersCapability(
  capabilities: ExecutionEnvironmentCapabilities | null | undefined,
): boolean {
  return capabilities?.members === true;
}

export function supportsAuditCapability(
  capabilities: ExecutionEnvironmentCapabilities | null | undefined,
): boolean {
  return capabilities?.audit === true;
}

export function deriveEnvironmentMembersGate(input: {
  readonly session: AuthSessionState | null;
  readonly canUpdateMultiUserSetting: boolean;
  readonly membersSupported: boolean;
  readonly settingsMultiUser?: boolean | undefined;
}) {
  const isOwner = isSessionOwner(input.session);
  const multiUserEnabled = input.settingsMultiUser ?? input.membersSupported;
  return {
    visible: isOwner && input.membersSupported,
    isOwner,
    multiUserEnabled,
    canToggleMultiUser: isOwner && input.membersSupported && input.canUpdateMultiUserSetting,
  };
}

export function inferCeilingTemplate(
  ceiling: ReadonlyArray<string>,
): PrincipalCeilingTemplate | null {
  const current = new Set(ceiling);
  for (const template of CEILING_TEMPLATES) {
    const scopes = ceilingScopes(template);
    if (scopes.length === current.size && scopes.every((scope) => current.has(scope))) {
      return template;
    }
  }
  return null;
}

export function projectMembersForProject(
  members: ReadonlyArray<MemberWithMemberships>,
  projectId: ProjectId,
): ReadonlyArray<ProjectMemberEntry> {
  const entries: ProjectMemberEntry[] = [];
  for (const member of members) {
    if (member.principal.status === "removed") continue;
    const membership = member.memberships.find(
      (row) => row.projectId === projectId && row.state !== "removed",
    );
    if (membership !== undefined) {
      entries.push({ principal: member.principal, membership });
    }
  }
  return entries.toSorted((left, right) => {
    const roleDiff =
      ROLE_DISPLAY_ORDER[left.membership.role] - ROLE_DISPLAY_ORDER[right.membership.role];
    if (roleDiff !== 0) return roleDiff;
    return left.principal.displayName.localeCompare(right.principal.displayName);
  });
}

export function environmentMembersList(
  members: ReadonlyArray<MemberWithMemberships>,
): ReadonlyArray<MemberWithMemberships> {
  return members
    .filter((member) => member.principal.status !== "removed")
    .map((member) => ({
      principal: member.principal,
      memberships: member.memberships.filter((row) => row.state !== "removed"),
    }))
    .toSorted((left, right) => {
      const leftOwner = left.principal.kind === "owner" ? 0 : 1;
      const rightOwner = right.principal.kind === "owner" ? 0 : 1;
      if (leftOwner !== rightOwner) return leftOwner - rightOwner;
      const statusDiff =
        STATUS_DISPLAY_ORDER[left.principal.status] - STATUS_DISPLAY_ORDER[right.principal.status];
      if (statusDiff !== 0) return statusDiff;
      return left.principal.displayName.localeCompare(right.principal.displayName);
    });
}

export function validateInviteForm(
  input: {
    readonly role: string | null;
    readonly projectId: ProjectId | null;
    readonly isOwner: boolean;
    readonly grantableRoles: ReadonlyArray<AssignableProjectRole>;
  },
  resolve: MessageResolver = m,
):
  | {
      readonly valid: true;
      readonly role: AssignableProjectRole;
      readonly projectId: ProjectId | null;
    }
  | { readonly valid: false; readonly error: string } {
  if (input.role === null || input.role.trim().length === 0) {
    return { valid: false, error: resolve(msg("Choose a role for this invitation.")) };
  }
  if (!isAssignableProjectRole(input.role) || !input.grantableRoles.includes(input.role)) {
    return { valid: false, error: resolve(msg("You cannot grant the selected role.")) };
  }
  if (!input.isOwner && input.projectId === null) {
    return { valid: false, error: resolve(msg("Choose a project for this invitation.")) };
  }
  return { valid: true, role: input.role, projectId: input.projectId };
}

export function buildInviteAcceptUrl(
  httpBaseUrl: string | null | undefined,
  code: string,
  fallbackOrigin?: string,
): string {
  const path = `/invite/${encodeURIComponent(code.trim())}`;
  const base = httpBaseUrl?.trim() || fallbackOrigin?.trim() || "";
  if (!base) return path;
  try {
    return new URL(path, base).toString();
  } catch {
    return path;
  }
}

function parseHttpBaseUrl(value: string | null | undefined): URL | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function isNonLoopbackHttpUrl(value: string | null | undefined): boolean {
  const parsed = parseHttpBaseUrl(value);
  return parsed !== null && !isLoopbackHostname(parsed.hostname);
}

export interface ResolvedInviteAcceptLink {
  readonly url: string;
  readonly isLoopbackOnly: boolean;
  readonly endpointLabel: string | null;
}

/**
 * Resolves the best shareable `/invite/<code>` URL, preferring reachable advertised endpoints
 * (matching pairing links) before falling back to direct endpoints, the prepared base URL, or
 * the current origin. Flags loopback-only URLs so the UI can warn the owner.
 */
export function resolveInviteAcceptLink(input: {
  readonly code: string;
  readonly advertisedEndpoints?: ReadonlyArray<AdvertisedEndpoint> | undefined;
  readonly defaultAdvertisedEndpointKey?: string | null | undefined;
  readonly desktopEndpointUrl?: string | null | undefined;
  readonly directEndpoints?: ReadonlyArray<ServerDirectEndpoint> | undefined;
  readonly httpBaseUrl?: string | null | undefined;
  readonly fallbackOrigin?: string | undefined;
}): ResolvedInviteAcceptLink {
  const { code } = input;
  const nonLoopbackAdvertised = (input.advertisedEndpoints ?? []).filter(
    (endpoint) =>
      endpoint.status !== "unavailable" &&
      endpoint.reachability !== "loopback" &&
      isNonLoopbackHttpUrl(endpoint.httpBaseUrl),
  );
  const selectedAdvertised = selectPairingEndpoint(
    nonLoopbackAdvertised,
    input.defaultAdvertisedEndpointKey,
  );
  if (selectedAdvertised !== null) {
    return {
      url: buildInviteAcceptUrl(selectedAdvertised.httpBaseUrl, code),
      isLoopbackOnly: false,
      endpointLabel: selectedAdvertised.label,
    };
  }

  if (isNonLoopbackHttpUrl(input.desktopEndpointUrl)) {
    return {
      url: buildInviteAcceptUrl(input.desktopEndpointUrl, code),
      isLoopbackOnly: false,
      endpointLabel: null,
    };
  }

  const nonLoopbackDirect = (input.directEndpoints ?? []).filter((endpoint) =>
    isNonLoopbackHttpUrl(endpoint.httpBaseUrl),
  );
  const preferredDirect =
    nonLoopbackDirect.find(
      (endpoint) => endpoint.kind === "tailnet" && endpoint.httpBaseUrl.startsWith("https://"),
    ) ??
    nonLoopbackDirect.find((endpoint) => endpoint.kind === "tailnet") ??
    nonLoopbackDirect[0] ??
    null;
  if (preferredDirect !== null) {
    return {
      url: buildInviteAcceptUrl(preferredDirect.httpBaseUrl, code),
      isLoopbackOnly: false,
      endpointLabel: null,
    };
  }

  if (isNonLoopbackHttpUrl(input.httpBaseUrl)) {
    return {
      url: buildInviteAcceptUrl(input.httpBaseUrl, code),
      isLoopbackOnly: false,
      endpointLabel: null,
    };
  }

  if (isNonLoopbackHttpUrl(input.fallbackOrigin)) {
    return {
      url: buildInviteAcceptUrl(input.fallbackOrigin, code),
      isLoopbackOnly: false,
      endpointLabel: null,
    };
  }

  const loopbackAdvertised = (input.advertisedEndpoints ?? []).find(
    (endpoint) =>
      endpoint.status !== "unavailable" && parseHttpBaseUrl(endpoint.httpBaseUrl) !== null,
  );
  const fallbackBase =
    (parseHttpBaseUrl(input.httpBaseUrl) !== null ? input.httpBaseUrl : null) ??
    loopbackAdvertised?.httpBaseUrl ??
    (parseHttpBaseUrl(input.fallbackOrigin) !== null ? input.fallbackOrigin : null);
  return {
    url: buildInviteAcceptUrl(fallbackBase, code),
    isLoopbackOnly: true,
    endpointLabel: loopbackAdvertised?.label ?? null,
  };
}

export function formatMembershipErrorMessage(error: unknown, resolve: MessageResolver = m): string {
  const raw =
    thrownErrorMessage(error, resolve) ??
    errorDisplayMessage(error, resolve) ??
    (typeof error === "string" && error.trim().length > 0 ? error.trim() : null);

  if (raw !== null) {
    if (/exceeds this member's scope ceiling/i.test(raw)) {
      return resolve(
        msg(
          "This role needs more access than this member's ceiling allows. Raise their ceiling template in Sharing & access first.",
        ),
      );
    }
    if (/exceeds your scope ceiling/i.test(raw)) {
      return resolve(msg("This role needs more access than your own permission ceiling allows."));
    }
    if (/exceeds your own project role|higher role than your own/i.test(raw)) {
      return resolve(msg("You cannot assign a role higher than your own role on this project."));
    }
    if (/cannot modify a member holding/i.test(raw)) {
      return resolve(msg("You cannot change a member whose role is higher than yours."));
    }
    if (/rate limit/i.test(raw)) {
      return resolve(msg("Too many invitations created recently. Wait a while and try again."));
    }
    if (/owner principal cannot be modified/i.test(raw)) {
      return resolve(msg("The environment owner cannot be modified or removed here."));
    }
    if (/account is not active/i.test(raw)) {
      return resolve(msg("Login codes can only be created for active members."));
    }
    if (/only the owner/i.test(raw)) {
      return resolve(msg("Only the environment owner can make this change."));
    }
    return raw;
  }

  return resolve(msg("The membership change failed. Try again."));
}
