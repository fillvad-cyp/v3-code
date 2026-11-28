import {
  type AuthSessionState,
  type EnvironmentId,
  type MemberWithMemberships,
  type MembershipState,
  type Principal,
  ProjectCapability,
  type ProjectId,
  ProjectRole,
  capabilitiesForRole,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";
import { isSessionOwner } from "./MembersSettings.logic";

export const ROLE_MATRIX_COLUMNS: ReadonlyArray<ProjectRole> = ProjectRole.literals;

export const PROJECT_CAPABILITY_LABELS: Readonly<Record<ProjectCapability, string>> = {
  "project:read": msg("Read project & threads"),
  "project:thread.operate": msg("Send messages & run agents"),
  "project:terminal.read": msg("View terminals"),
  "project:terminal.operate": msg("Run terminal commands"),
  "project:preview.operate": msg("Operate browser & device previews"),
  "project:file.write": msg("Edit project files"),
  "project:source.write": msg("Git & source control writes"),
  "project:thread.manage": msg("Create, archive & delete threads"),
  "project:settings": msg("Change project settings"),
  "project:members": msg("Manage project members"),
  "project:secrets": msg("Manage project secrets"),
  "project:webhooks": msg("Manage webhooks & schedules"),
  "project:crm.read": msg("View CRM records"),
  "project:crm.write": msg("Edit CRM records"),
  "project:crm.invite_client": msg("Invite CRM clients"),
  "project:create": msg("Create projects"),
  "project:delete": msg("Delete projects"),
};

export type RoleMatrixGroupId = "reading" | "code_and_agents" | "project_management" | "crm";

const ROLE_MATRIX_GROUP_ORDER: ReadonlyArray<RoleMatrixGroupId> = [
  "reading",
  "code_and_agents",
  "project_management",
  "crm",
];

const ROLE_MATRIX_GROUP_LABELS: Readonly<Record<RoleMatrixGroupId, string>> = {
  reading: msg("Reading", { $context: "role capability matrix section" }),
  code_and_agents: msg("Code & agents", { $context: "role capability matrix section" }),
  project_management: msg("Project management", { $context: "role capability matrix section" }),
  crm: msg("CRM", { $context: "role capability matrix section" }),
};

const CAPABILITY_GROUP_MAP: Readonly<Record<ProjectCapability, RoleMatrixGroupId>> = {
  "project:read": "reading",
  "project:terminal.read": "reading",
  "project:thread.operate": "code_and_agents",
  "project:terminal.operate": "code_and_agents",
  "project:preview.operate": "code_and_agents",
  "project:file.write": "code_and_agents",
  "project:source.write": "code_and_agents",
  "project:thread.manage": "code_and_agents",
  "project:settings": "project_management",
  "project:members": "project_management",
  "project:secrets": "project_management",
  "project:webhooks": "project_management",
  "project:create": "project_management",
  "project:delete": "project_management",
  "project:crm.read": "crm",
  "project:crm.write": "crm",
  "project:crm.invite_client": "crm",
};

export interface RoleMatrixRow {
  readonly capability: string;
  readonly label: string;
  readonly roles: Readonly<Record<ProjectRole, boolean>>;
}

export interface RoleMatrixSection {
  readonly id: RoleMatrixGroupId;
  readonly label: string;
  readonly rows: ReadonlyArray<RoleMatrixRow>;
}

export interface RoleMatrixData {
  readonly roles: ReadonlyArray<ProjectRole>;
  readonly rows: ReadonlyArray<RoleMatrixRow>;
  readonly sections: ReadonlyArray<RoleMatrixSection>;
}

function capabilityGroup(capability: string): RoleMatrixGroupId {
  if (Object.hasOwn(CAPABILITY_GROUP_MAP, capability)) {
    return CAPABILITY_GROUP_MAP[capability as ProjectCapability];
  }
  return "project_management";
}

export function capabilityLabel(capability: string, resolve: MessageResolver = m): string {
  if (Object.hasOwn(PROJECT_CAPABILITY_LABELS, capability)) {
    return resolve(PROJECT_CAPABILITY_LABELS[capability as ProjectCapability]);
  }
  return capability;
}

export function buildRoleMatrix(input?: {
  readonly capabilities?: ReadonlyArray<string>;
  readonly roles?: ReadonlyArray<ProjectRole>;
  readonly getCapabilitiesForRole?: (role: ProjectRole) => ReadonlyArray<string>;
  readonly resolve?: MessageResolver;
}): RoleMatrixData {
  const roles = input?.roles ?? ROLE_MATRIX_COLUMNS;
  const getCapabilities = input?.getCapabilitiesForRole ?? capabilitiesForRole;
  const resolve = input?.resolve ?? m;
  const baseCapabilities = input?.capabilities ?? ProjectCapability.literals;

  const capsByRole = new Map<ProjectRole, ReadonlySet<string>>();
  const orderedCapabilities: string[] = [];
  const seenCapabilities = new Set<string>();

  for (const capability of baseCapabilities) {
    if (!seenCapabilities.has(capability)) {
      seenCapabilities.add(capability);
      orderedCapabilities.push(capability);
    }
  }

  for (const role of roles) {
    const roleCaps = getCapabilities(role);
    capsByRole.set(role, new Set(roleCaps));
    for (const capability of roleCaps) {
      if (!seenCapabilities.has(capability)) {
        seenCapabilities.add(capability);
        orderedCapabilities.push(capability);
      }
    }
  }

  const rows: RoleMatrixRow[] = orderedCapabilities.map((capability) => {
    const ticks = {} as Record<ProjectRole, boolean>;
    for (const role of roles) {
      ticks[role] = capsByRole.get(role)?.has(capability) ?? false;
    }
    return {
      capability,
      label: capabilityLabel(capability, resolve),
      roles: ticks,
    };
  });

  const rowsByGroup = new Map<RoleMatrixGroupId, Array<RoleMatrixRow>>(
    ROLE_MATRIX_GROUP_ORDER.map((groupId) => [groupId, []]),
  );
  for (const row of rows) {
    rowsByGroup.get(capabilityGroup(row.capability))!.push(row);
  }
  const sections: ReadonlyArray<RoleMatrixSection> = ROLE_MATRIX_GROUP_ORDER.flatMap((groupId) => {
    const groupRows = rowsByGroup.get(groupId) ?? [];
    if (groupRows.length === 0) return [];
    return [
      {
        id: groupId,
        label: resolve(ROLE_MATRIX_GROUP_LABELS[groupId]),
        rows: groupRows,
      },
    ];
  });

  return { roles, rows, sections };
}

export function hasHostTerminalCapability(capabilities: ReadonlyArray<string>): boolean {
  return (
    capabilities.includes("project:terminal.operate") ||
    capabilities.includes("project:terminal.read") ||
    capabilities.includes("project:thread.operate")
  );
}

export type MyAccessMode =
  | "no-environment"
  | "loading-session"
  | "session-error"
  | "unauthenticated"
  | "owner"
  | "member";

export interface MyAccessState {
  readonly mode: MyAccessMode;
  readonly isOwner: boolean;
  readonly canReadMembers: boolean;
  readonly shouldFetchMembers: boolean;
  readonly canIssueLoginCode: boolean;
  readonly canSignOut: boolean;
  readonly principal: Principal | null;
  readonly sessionRole: ProjectRole | null;
}

export function deriveMyAccessState(input: {
  readonly environmentId: EnvironmentId | null;
  readonly session: AuthSessionState | null;
  readonly sessionPending: boolean;
  readonly sessionHasError: boolean;
  readonly membersSupported: boolean;
  readonly canReadMembersCommand: boolean;
  readonly canIssueLoginCodeCommand: boolean;
}): MyAccessState {
  const base: MyAccessState = {
    mode: "no-environment",
    isOwner: false,
    canReadMembers: false,
    shouldFetchMembers: false,
    canIssueLoginCode: false,
    canSignOut: false,
    principal: null,
    sessionRole: null,
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

  const principal = input.session.principal ?? null;
  const isOwner = isSessionOwner(input.session);
  const canSignOut = input.membersSupported || principal !== null;
  const canIssueLoginCode =
    input.canIssueLoginCodeCommand && principal !== null && principal.status === "active";

  if (isOwner) {
    return {
      mode: "owner",
      isOwner: true,
      canReadMembers: input.canReadMembersCommand,
      shouldFetchMembers: false,
      canIssueLoginCode: canIssueLoginCode && input.membersSupported,
      canSignOut,
      principal,
      sessionRole: "owner",
    };
  }

  const isProjectBoundSession = input.session.binding?._tag === "projects";
  return {
    mode: "member",
    isOwner: false,
    canReadMembers: input.canReadMembersCommand,
    shouldFetchMembers: input.canReadMembersCommand && !isProjectBoundSession,
    canIssueLoginCode,
    canSignOut,
    principal,
    sessionRole: input.session.role ?? null,
  };
}

export interface MyProjectAccessEntry {
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly role: ProjectRole;
  readonly state: MembershipState;
  readonly capabilities: ReadonlyArray<string>;
  readonly expiresAt: string | null;
}

const MEMBERSHIP_STATE_SORT_ORDER: Readonly<Record<MembershipState, number>> = {
  active: 0,
  invited: 1,
  suspended: 2,
  removed: 3,
};

export function resolveMyProjectAccessEntries(input: {
  readonly session: AuthSessionState | null;
  readonly members: ReadonlyArray<MemberWithMemberships>;
  readonly projectTitleById: ReadonlyMap<ProjectId, string>;
  readonly getCapabilitiesForRole?: (role: ProjectRole) => ReadonlyArray<string>;
}): ReadonlyArray<MyProjectAccessEntry> {
  const { session, members, projectTitleById } = input;
  if (!session?.authenticated || isSessionOwner(session)) {
    return [];
  }

  const getCapabilities = input.getCapabilitiesForRole ?? capabilitiesForRole;

  if (session.binding?._tag === "projects") {
    return session.binding.projects
      .map((bound): MyProjectAccessEntry => ({
        projectId: bound.projectId,
        projectTitle: projectTitleById.get(bound.projectId) ?? bound.projectId,
        role: bound.role,
        state: "active",
        capabilities: getCapabilities(bound.role),
        expiresAt: null,
      }))
      .toSorted((left, right) => left.projectTitle.localeCompare(right.projectTitle));
  }

  const principalId = session.principal?.id;
  if (principalId === undefined) {
    return [];
  }

  const self = members.find((entry) => entry.principal.id === principalId);
  if (self === undefined) {
    return [];
  }

  return self.memberships
    .filter((entry) => entry.state !== "removed")
    .map((entry): MyProjectAccessEntry => ({
      projectId: entry.projectId,
      projectTitle: projectTitleById.get(entry.projectId) ?? entry.projectId,
      role: entry.role,
      state: entry.state,
      capabilities: getCapabilities(entry.role),
      expiresAt: entry.expiresAt,
    }))
    .toSorted((left, right) => {
      const stateDiff =
        MEMBERSHIP_STATE_SORT_ORDER[left.state] - MEMBERSHIP_STATE_SORT_ORDER[right.state];
      if (stateDiff !== 0) return stateDiff;
      return left.projectTitle.localeCompare(right.projectTitle);
    });
}

export function resolveHighlightedRoles(input: {
  readonly session: AuthSessionState | null;
  readonly members: ReadonlyArray<MemberWithMemberships>;
}): ReadonlySet<ProjectRole> {
  const { session, members } = input;
  if (!session?.authenticated) {
    return new Set();
  }
  if (isSessionOwner(session)) {
    return new Set<ProjectRole>(["owner"]);
  }
  if (session.binding?._tag === "projects") {
    return new Set(session.binding.projects.map((project) => project.role));
  }
  const principalId = session.principal?.id;
  if (principalId !== undefined) {
    const self = members.find((entry) => entry.principal.id === principalId);
    const activeRoles =
      self?.memberships.filter((entry) => entry.state === "active").map((entry) => entry.role) ??
      [];
    if (activeRoles.length > 0) {
      return new Set(activeRoles);
    }
  }
  return session.role ? new Set<ProjectRole>([session.role]) : new Set();
}
