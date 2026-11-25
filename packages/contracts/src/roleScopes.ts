import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  AuthProvidersManageScope,
  AuthRelayConfigureScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type AuthEnvironmentScope,
  type AuthGrantScope,
} from "./auth.ts";
import type { PrincipalCeilingTemplate, ProjectCapability, ProjectRole } from "./membership.ts";

/**
 * The scopes a project capability expands to. Several capabilities share scopes, so a role's set
 * is deduplicated. CRM capabilities have no scope of their own yet; they gate their own resources.
 */
const capabilityScopes: Record<ProjectCapability, ReadonlyArray<AuthGrantScope>> = {
  "project:read": [AuthOrchestrationReadScope, AuthFilesystemReadScope],
  "project:thread.operate": [AuthOrchestrationOperateScope],
  "project:terminal.read": [AuthTerminalReadScope],
  "project:terminal.operate": [AuthTerminalReadScope, AuthTerminalOperateScope],
  "project:preview.operate": [AuthPreviewOperateScope],
  "project:file.write": [AuthFilesystemWriteScope, AuthOrchestrationOperateScope],
  "project:source.write": [AuthSourceControlWriteScope],
  "project:thread.manage": [AuthOrchestrationOperateScope],
  "project:settings": [AuthSettingsWriteScope, AuthOrchestrationOperateScope],
  "project:members": [AuthAccessWriteScope],
  "project:secrets": [AuthProvidersManageScope],
  "project:webhooks": [AuthSettingsWriteScope],
  "project:crm.read": [],
  "project:crm.write": [],
  "project:crm.invite_client": [],
  "project:create": [],
  "project:delete": [],
};

const viewerCapabilities = ["project:read", "project:crm.read"] as const;

/**
 * What each role may do on a project, per the role matrix. `manager` is a CRM branch: it operates
 * threads but gets no terminal, files or settings; `owner` adds project deletion and the
 * environment-wide scopes on top of `admin`.
 */
const roleCapabilities: Record<ProjectRole, ReadonlyArray<ProjectCapability>> = {
  viewer: viewerCapabilities,
  operator: [
    ...viewerCapabilities,
    "project:thread.operate",
    "project:terminal.read",
    "project:terminal.operate",
    "project:preview.operate",
  ],
  developer: [
    ...viewerCapabilities,
    "project:thread.operate",
    "project:terminal.read",
    "project:terminal.operate",
    "project:preview.operate",
    "project:file.write",
    "project:source.write",
    "project:thread.manage",
    "project:create",
  ],
  manager: [
    ...viewerCapabilities,
    "project:thread.operate",
    "project:crm.write",
    "project:crm.invite_client",
  ],
  admin: [
    ...viewerCapabilities,
    "project:thread.operate",
    "project:terminal.read",
    "project:terminal.operate",
    "project:preview.operate",
    "project:file.write",
    "project:source.write",
    "project:thread.manage",
    "project:settings",
    "project:members",
    "project:secrets",
    "project:webhooks",
    "project:create",
  ],
  owner: [
    ...viewerCapabilities,
    "project:thread.operate",
    "project:terminal.read",
    "project:terminal.operate",
    "project:preview.operate",
    "project:file.write",
    "project:source.write",
    "project:thread.manage",
    "project:settings",
    "project:members",
    "project:secrets",
    "project:webhooks",
    "project:create",
    "project:delete",
  ],
};

/** The environment scopes only the owner holds, on top of every project role. */
const ownerEnvironmentScopes = [
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthRelayConfigureScope,
] as const;

export function capabilitiesForRole(role: ProjectRole): ReadonlyArray<ProjectCapability> {
  return roleCapabilities[role];
}

export function roleHasCapability(role: ProjectRole, capability: ProjectCapability): boolean {
  return roleCapabilities[role].includes(capability);
}

function scopesForCapabilities(
  capabilities: ReadonlyArray<ProjectCapability>,
): ReadonlyArray<AuthGrantScope> {
  // Everyone on a project may see who else is on it; only `project:members` adds the write.
  return [
    ...new Set([
      AuthAccessReadScope,
      ...capabilities.flatMap((capability) => capabilityScopes[capability]),
    ]),
  ].sort();
}

/**
 * The scopes a role expands to, for the scope gate. The project check still runs separately, so a
 * scope here never reaches another project's resource.
 */
export const ROLE_SCOPES: Record<ProjectRole, ReadonlyArray<AuthGrantScope>> = {
  viewer: scopesForCapabilities(roleCapabilities.viewer),
  operator: scopesForCapabilities(roleCapabilities.operator),
  developer: scopesForCapabilities(roleCapabilities.developer),
  manager: scopesForCapabilities(roleCapabilities.manager),
  admin: scopesForCapabilities(roleCapabilities.admin),
  owner: [
    ...new Set([...scopesForCapabilities(roleCapabilities.owner), ...ownerEnvironmentScopes]),
  ].sort(),
};

export function roleScopes(role: ProjectRole): ReadonlyArray<AuthGrantScope> {
  return ROLE_SCOPES[role];
}

/** Rank of each role for "nobody grants more than they hold". Owner ranks above every project role. */
const ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  operator: 2,
  manager: 2,
  developer: 3,
  admin: 4,
  owner: 5,
};

export function roleAtLeast(actor: ProjectRole, role: ProjectRole): boolean {
  return ROLE_RANK[actor] >= ROLE_RANK[role];
}

/**
 * The ceiling templates an owner sets on a principal. `staff` covers every project role, so an
 * admin may hand out any role inside it; `restricted` and `client` are read-and-operate only.
 * Owning the environment is never inside a ceiling: only the owner holds those scopes.
 */
const CEILING_SCOPES: Record<PrincipalCeilingTemplate, ReadonlyArray<AuthGrantScope>> = {
  staff: [...ROLE_SCOPES.admin, AuthRelayReadScope],
  restricted: [
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
    AuthTerminalReadScope,
    AuthTerminalOperateScope,
    AuthPreviewOperateScope,
    AuthFilesystemReadScope,
    AuthAccessReadScope,
  ],
  client: [AuthOrchestrationReadScope, AuthFilesystemReadScope, AuthAccessReadScope],
};

export function ceilingScopes(template: PrincipalCeilingTemplate): ReadonlyArray<AuthGrantScope> {
  return CEILING_SCOPES[template];
}

export function intersectScopes(
  left: ReadonlyArray<AuthEnvironmentScope>,
  right: ReadonlyArray<AuthEnvironmentScope>,
): ReadonlyArray<AuthEnvironmentScope> {
  const rightSet = new Set<string>(right);
  return left.filter((scope) => rightSet.has(scope));
}

export function scopesFitCeiling(
  ceiling: ReadonlyArray<AuthEnvironmentScope>,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): boolean {
  const ceilingSet = new Set<string>(ceiling);
  return scopes.every((scope) => ceilingSet.has(scope));
}

/** Whether a ceiling can hold every scope a role expands to. */
export function roleFitsCeiling(
  ceiling: ReadonlyArray<AuthEnvironmentScope>,
  role: ProjectRole,
): boolean {
  return scopesFitCeiling(ceiling, ROLE_SCOPES[role]);
}
