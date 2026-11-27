import { errorDisplayMessage, thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  type ApiToken,
  type ApiTokenListItem,
  AuthEnvironmentScope,
  type AuthGrantScope,
  type AuthSessionState,
  type EnvironmentId,
  type MemberWithMemberships,
  type PrincipalId,
  type ProjectId,
  type ProjectRole,
  capabilitiesForRole,
  intersectScopes,
  roleAtLeast,
  roleHasCapability,
  roleScopes,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { AUTH_SCOPE_OPTIONS } from "@t3tools/shared/authScopeOptions";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import {
  ASSIGNABLE_PROJECT_ROLES,
  type AssignableProjectRole,
  isSessionOwner,
} from "./MembersSettings.logic";

const isAuthEnvironmentScope = Schema.is(AuthEnvironmentScope);

export type ApiTokenStatus = "active" | "expired" | "revoked";

export type ApiTokenExpirationPreset = "never" | "7d" | "30d" | "90d" | "365d";

export const API_TOKEN_EXPIRATION_PRESETS: ReadonlyArray<{
  readonly value: ApiTokenExpirationPreset;
  readonly label: string;
}> = [
  { value: "never", label: msg("No expiration") },
  { value: "7d", label: msg("7 days") },
  { value: "30d", label: msg("30 days") },
  { value: "90d", label: msg("90 days") },
  { value: "365d", label: msg("1 year") },
];

export const API_TOKEN_STATUS_LABELS: Readonly<Record<ApiTokenStatus, string>> = {
  active: msg("Active", { $context: "API token state" }),
  expired: msg("Expired", { $context: "API token state" }),
  revoked: msg("Revoked", { $context: "API token state" }),
};

export type ApiTokensGateMode =
  | "no-environment"
  | "session-error"
  | "loading-session"
  | "unauthenticated"
  | "ready";

export interface ApiTokensGate {
  readonly mode: ApiTokensGateMode;
  readonly visible: boolean;
  readonly isOwner: boolean;
  readonly principalId: PrincipalId | null;
}

export function deriveApiTokensGate(input: {
  readonly environmentId: EnvironmentId | null;
  readonly session: AuthSessionState | null;
  readonly sessionPending: boolean;
  readonly sessionHasError: boolean;
}): ApiTokensGate {
  const base: ApiTokensGate = {
    mode: "no-environment",
    visible: false,
    isOwner: false,
    principalId: null,
  };
  if (input.environmentId === null) {
    return base;
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
  return {
    mode: "ready",
    visible: true,
    isOwner: isSessionOwner(input.session),
    principalId: input.session.principal?.id ?? null,
  };
}

export function deriveApiTokenStatus(token: ApiToken, nowMs: number): ApiTokenStatus {
  if (token.revokedAt !== null) {
    return "revoked";
  }
  if (token.expiresAt !== null && Date.parse(token.expiresAt) <= nowMs) {
    return "expired";
  }
  return "active";
}

const STATUS_SORT_ORDER: Readonly<Record<ApiTokenStatus, number>> = {
  active: 0,
  expired: 1,
  revoked: 2,
};

export function sortApiTokens(
  tokens: ReadonlyArray<ApiTokenListItem>,
  nowMs: number,
): ReadonlyArray<ApiTokenListItem> {
  return tokens.toSorted((left, right) => {
    const leftStatus = STATUS_SORT_ORDER[deriveApiTokenStatus(left, nowMs)];
    const rightStatus = STATUS_SORT_ORDER[deriveApiTokenStatus(right, nowMs)];
    if (leftStatus !== rightStatus) {
      return leftStatus - rightStatus;
    }
    return Date.parse(right.createdAt) - Date.parse(left.createdAt);
  });
}

export function assignableRolesForGrantedRole(
  grantedRole: ProjectRole,
): ReadonlyArray<AssignableProjectRole> {
  return ASSIGNABLE_PROJECT_ROLES.filter(
    (candidate) =>
      roleAtLeast(grantedRole, candidate) &&
      capabilitiesForRole(candidate).every((capability) =>
        roleHasCapability(grantedRole, capability),
      ),
  );
}

export interface BindableProjectOption {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly maxRole: ProjectRole;
  readonly assignableRoles: ReadonlyArray<AssignableProjectRole>;
  readonly defaultRole: AssignableProjectRole;
}

export function resolveBindableProjects(input: {
  readonly session: AuthSessionState | null;
  readonly isOwner: boolean;
  readonly targetPrincipalId: PrincipalId | null;
  readonly members: ReadonlyArray<MemberWithMemberships>;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
}): ReadonlyArray<BindableProjectOption> {
  const { session, isOwner, targetPrincipalId, members, projects } = input;
  if (!session?.authenticated) {
    return [];
  }

  const projectTitleById = new Map(projects.map((project) => [project.id, project.title] as const));
  const actorPrincipalId = session.principal?.id ?? null;
  const targetingSelf = targetPrincipalId === null || targetPrincipalId === actorPrincipalId;

  if (isOwner && targetingSelf) {
    return projects
      .map((project): BindableProjectOption => ({
        projectId: project.id,
        title: project.title,
        maxRole: "owner",
        assignableRoles: ASSIGNABLE_PROJECT_ROLES,
        defaultRole: "developer",
      }))
      .toSorted((left, right) => left.title.localeCompare(right.title));
  }

  if (session.binding?._tag === "projects" && targetingSelf) {
    return session.binding.projects
      .flatMap((entry): ReadonlyArray<BindableProjectOption> => {
        const assignableRoles = assignableRolesForGrantedRole(entry.role);
        if (assignableRoles.length === 0) return [];
        const defaultRole = assignableRoles[assignableRoles.length - 1]!;
        return [
          {
            projectId: entry.projectId,
            title: projectTitleById.get(entry.projectId) ?? entry.projectId,
            maxRole: entry.role,
            assignableRoles,
            defaultRole,
          },
        ];
      })
      .toSorted((left, right) => left.title.localeCompare(right.title));
  }

  const resolvedPrincipalId = targetPrincipalId ?? actorPrincipalId;
  const member =
    resolvedPrincipalId === null
      ? undefined
      : members.find((entry) => entry.principal.id === resolvedPrincipalId);
  if (member === undefined) {
    return [];
  }

  if (member.principal.kind === "owner") {
    return projects
      .map((project): BindableProjectOption => ({
        projectId: project.id,
        title: project.title,
        maxRole: "owner",
        assignableRoles: ASSIGNABLE_PROJECT_ROLES,
        defaultRole: "developer",
      }))
      .toSorted((left, right) => left.title.localeCompare(right.title));
  }

  return member.memberships
    .filter((membership) => membership.state === "active")
    .flatMap((membership): ReadonlyArray<BindableProjectOption> => {
      const assignableRoles = assignableRolesForGrantedRole(membership.role);
      if (assignableRoles.length === 0) return [];
      const defaultRole = assignableRoles.includes(membership.role as AssignableProjectRole)
        ? (membership.role as AssignableProjectRole)
        : assignableRoles[assignableRoles.length - 1]!;
      return [
        {
          projectId: membership.projectId,
          title: projectTitleById.get(membership.projectId) ?? membership.projectId,
          maxRole: membership.role,
          assignableRoles,
          defaultRole,
        },
      ];
    })
    .toSorted((left, right) => left.title.localeCompare(right.title));
}

export function resolveEffectiveScopesForToken(input: {
  readonly session: AuthSessionState | null;
  readonly isOwner: boolean;
  readonly targetPrincipalId: PrincipalId | null;
  readonly members: ReadonlyArray<MemberWithMemberships>;
  readonly bindingMode: "principal" | "projects";
  readonly selectedProjectRoles: ReadonlyArray<ProjectRole>;
}): ReadonlyArray<AuthGrantScope> {
  const { session, isOwner, targetPrincipalId, members, bindingMode, selectedProjectRoles } = input;
  if (!session?.authenticated) {
    return [];
  }

  const allGrantScopes = AUTH_SCOPE_OPTIONS.map((option) => option.scope);
  const sessionScopes = allGrantScopes.filter((scope) => sessionGrantsScope(session, scope));
  const actorPrincipalId = session.principal?.id ?? null;
  const targetingSelf = targetPrincipalId === null || targetPrincipalId === actorPrincipalId;
  const resolvedPrincipalId = targetPrincipalId ?? actorPrincipalId;
  const targetMember =
    resolvedPrincipalId === null
      ? undefined
      : members.find((entry) => entry.principal.id === resolvedPrincipalId);

  const targetIsOwner =
    targetMember !== undefined ? targetMember.principal.kind === "owner" : isOwner && targetingSelf;

  let allowed: ReadonlyArray<AuthEnvironmentScope>;
  if (targetIsOwner) {
    if (bindingMode === "projects") {
      allowed = [...new Set(selectedProjectRoles.flatMap((role) => roleScopes(role)))];
    } else {
      allowed = allGrantScopes;
    }
  } else {
    const rawCeiling =
      targetMember?.principal.ceiling ?? (targetingSelf ? session.principal?.ceiling : undefined);
    const ceiling = rawCeiling?.filter(isAuthEnvironmentScope);

    let roleScopeUnion: ReadonlyArray<AuthEnvironmentScope>;
    if (bindingMode === "projects") {
      roleScopeUnion = [...new Set(selectedProjectRoles.flatMap((role) => roleScopes(role)))];
    } else if (targetMember !== undefined) {
      roleScopeUnion = [
        ...new Set(
          targetMember.memberships
            .filter((membership) => membership.state === "active")
            .flatMap((membership) => roleScopes(membership.role)),
        ),
      ];
    } else if (targetingSelf && session.binding?._tag === "projects") {
      roleScopeUnion = [
        ...new Set(session.binding.projects.flatMap((entry) => roleScopes(entry.role))),
      ];
    } else {
      roleScopeUnion = sessionScopes;
    }

    allowed = ceiling === undefined ? roleScopeUnion : intersectScopes(roleScopeUnion, ceiling);
  }

  if (!isOwner || targetingSelf) {
    allowed = intersectScopes(allowed, sessionScopes);
  }

  const allowedSet = new Set<string>(allowed);
  return allGrantScopes.filter((scope) => allowedSet.has(scope));
}

export function canBindToPrincipal(session: AuthSessionState | null): boolean {
  if (!session?.authenticated) return false;
  return session.binding?._tag !== "projects";
}

export function computeExpiresAtIso(
  preset: ApiTokenExpirationPreset,
  nowMs: number = Date.now(),
): string | null {
  const dayMs = 86_400_000;
  switch (preset) {
    case "never":
      return null;
    case "7d":
      return new Date(nowMs + 7 * dayMs).toISOString();
    case "30d":
      return new Date(nowMs + 30 * dayMs).toISOString();
    case "90d":
      return new Date(nowMs + 90 * dayMs).toISOString();
    case "365d":
      return new Date(nowMs + 365 * dayMs).toISOString();
  }
}

export function formatApiTokenErrorMessage(error: unknown, resolve: MessageResolver = m): string {
  const message =
    error instanceof Error
      ? (thrownErrorMessage(error, resolve) ?? error.message)
      : errorDisplayMessage(error, resolve);
  if (message) {
    if (message.includes("limit reached") || message.includes("Too Many Requests")) {
      return resolve(
        msg("API token limit reached. Revoke an existing token before creating another."),
      );
    }
    return message;
  }
  return resolve(msg("The API token request failed."));
}
