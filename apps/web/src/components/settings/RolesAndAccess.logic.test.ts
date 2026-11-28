import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  EnvironmentId,
  PrincipalId,
  ProjectCapability,
  ProjectId,
  capabilitiesForRole,
  ceilingScopes,
  type AuthSessionState,
  type MemberWithMemberships,
  type Principal,
  type ProjectMembership,
  type ProjectRole,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PROJECT_CAPABILITY_LABELS,
  ROLE_MATRIX_COLUMNS,
  buildRoleMatrix,
  capabilityLabel,
  deriveMyAccessState,
  hasHostTerminalCapability,
  resolveHighlightedRoles,
  resolveMyProjectAccessEntries,
} from "./RolesAndAccess.logic";

const envId = EnvironmentId.make("env-1");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const projectC = ProjectId.make("project-c");

const ownerPrincipal: Principal = {
  id: PrincipalId.make("owner"),
  kind: "owner",
  displayName: "Hub Owner",
  email: null,
  status: "active",
  ceiling: [...ceilingScopes("staff")],
  accessRevision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  removedAt: null,
};

const memberPrincipal = (status: Principal["status"] = "active"): Principal => ({
  id: PrincipalId.make("member-1"),
  kind: "member",
  displayName: "Alex Dev",
  email: "alex@example.com",
  status,
  ceiling: [...ceilingScopes("staff")],
  accessRevision: 2,
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  removedAt: null,
});

const otherPrincipal: Principal = {
  id: PrincipalId.make("member-2"),
  kind: "member",
  displayName: "Sam Ops",
  email: null,
  status: "active",
  ceiling: [...ceilingScopes("restricted")],
  accessRevision: 1,
  createdAt: "2026-01-03T00:00:00.000Z",
  updatedAt: "2026-01-03T00:00:00.000Z",
  removedAt: null,
};

const makeMembership = (
  principalId: PrincipalId,
  projectId: ProjectId,
  role: ProjectRole,
  state: ProjectMembership["state"] = "active",
): ProjectMembership => ({
  projectId,
  principalId,
  role,
  state,
  invitedBy: ownerPrincipal.id,
  expiresAt: null,
  createdAt: "2026-01-04T00:00:00.000Z",
  updatedAt: "2026-01-04T00:00:00.000Z",
});

const multiUserAuthDescriptor: AuthSessionState["auth"] = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie", "bearer-access-token"],
  sessionCookieName: "t3_session",
  authMode: "multi-user",
};

const ownerSession = (withPrincipal = true): AuthSessionState => ({
  authenticated: true,
  auth: multiUserAuthDescriptor,
  scopes: [AuthAccessReadScope, AuthAccessWriteScope, AuthEnvironmentMaintainScope],
  ...(withPrincipal ? { principal: ownerPrincipal, role: "owner" as const } : {}),
  binding: { _tag: "environment" },
});

const memberSession = (overrides: Partial<AuthSessionState> = {}): AuthSessionState => ({
  authenticated: true,
  auth: multiUserAuthDescriptor,
  scopes: [AuthAccessReadScope],
  principal: memberPrincipal("active"),
  binding: { _tag: "principal" },
  role: "developer",
  ...overrides,
});

describe("buildRoleMatrix", () => {
  it("derives every row and tick directly from ProjectCapability and capabilitiesForRole", () => {
    const matrix = buildRoleMatrix();

    expect(matrix.roles).toEqual(["viewer", "operator", "developer", "manager", "admin", "owner"]);
    expect(matrix.roles).toEqual(ROLE_MATRIX_COLUMNS);
    expect(matrix.rows.map((row) => row.capability)).toEqual(ProjectCapability.literals);

    for (const row of matrix.rows) {
      expect(row.label.length).toBeGreaterThan(0);
      expect(PROJECT_CAPABILITY_LABELS[row.capability as ProjectCapability]).toBeDefined();
      for (const role of matrix.roles) {
        expect(row.roles[role], `${row.capability} for ${role}`).toBe(
          capabilitiesForRole(role).includes(row.capability as ProjectCapability),
        );
      }
    }

    const createRow = matrix.rows.find((row) => row.capability === "project:create")!;
    expect(createRow.roles).toEqual({
      viewer: false,
      operator: false,
      developer: true,
      manager: false,
      admin: true,
      owner: true,
    });

    const deleteRow = matrix.rows.find((row) => row.capability === "project:delete")!;
    expect(deleteRow.roles).toEqual({
      viewer: false,
      operator: false,
      developer: false,
      manager: false,
      admin: false,
      owner: true,
    });
  });

  it("reflects newly added capabilities returned by capabilitiesForRole automatically", () => {
    const extendedCapabilitiesForRole = (role: ProjectRole): ReadonlyArray<string> => {
      const base: ReadonlyArray<string> = capabilitiesForRole(role);
      if (role === "admin") {
        return [...base, "project:delete", "project:audit.export"];
      }
      if (role === "owner") {
        return [...base, "project:audit.export"];
      }
      return base;
    };

    const matrix = buildRoleMatrix({ getCapabilitiesForRole: extendedCapabilitiesForRole });

    const addedRow = matrix.rows.find((row) => row.capability === "project:audit.export");
    expect(addedRow).toEqual({
      capability: "project:audit.export",
      label: "project:audit.export",
      roles: {
        viewer: false,
        operator: false,
        developer: false,
        manager: false,
        admin: true,
        owner: true,
      },
    });

    const deleteRow = matrix.rows.find((row) => row.capability === "project:delete")!;
    expect(deleteRow.roles.admin).toBe(true);
    expect(deleteRow.roles.owner).toBe(true);
    expect(deleteRow.roles.developer).toBe(false);
  });

  it("returns fallback label for unknown capabilities and detects host terminal capabilities", () => {
    expect(capabilityLabel("project:read")).toBe("Read project & threads");
    expect(capabilityLabel("project:custom.action")).toBe("project:custom.action");

    expect(hasHostTerminalCapability(capabilitiesForRole("viewer"))).toBe(false);
    expect(hasHostTerminalCapability(capabilitiesForRole("operator"))).toBe(true);
    expect(hasHostTerminalCapability(capabilitiesForRole("developer"))).toBe(true);
    expect(hasHostTerminalCapability(capabilitiesForRole("manager"))).toBe(true);
  });

  it("groups all 17 capabilities into Reading, Code & agents, Project management, and CRM sections", () => {
    const matrix = buildRoleMatrix();
    expect(matrix.sections.map((section) => ({ id: section.id, label: section.label }))).toEqual([
      { id: "reading", label: "Reading" },
      { id: "code_and_agents", label: "Code & agents" },
      { id: "project_management", label: "Project management" },
      { id: "crm", label: "CRM" },
    ]);
    const groupedCapabilities = matrix.sections.flatMap((section) =>
      section.rows.map((row) => row.capability),
    );
    expect(groupedCapabilities).toHaveLength(ProjectCapability.literals.length);
    expect(new Set(groupedCapabilities)).toEqual(new Set(ProjectCapability.literals));
  });
});

describe("deriveMyAccessState", () => {
  it("handles missing environment, loading, error, and unauthenticated states", () => {
    expect(
      deriveMyAccessState({
        environmentId: null,
        session: null,
        sessionPending: false,
        sessionHasError: false,
        membersSupported: true,
        canReadMembersCommand: false,
        canIssueLoginCodeCommand: false,
      }).mode,
    ).toBe("no-environment");

    expect(
      deriveMyAccessState({
        environmentId: envId,
        session: null,
        sessionPending: true,
        sessionHasError: false,
        membersSupported: true,
        canReadMembersCommand: false,
        canIssueLoginCodeCommand: false,
      }).mode,
    ).toBe("loading-session");

    expect(
      deriveMyAccessState({
        environmentId: envId,
        session: null,
        sessionPending: false,
        sessionHasError: true,
        membersSupported: true,
        canReadMembersCommand: false,
        canIssueLoginCodeCommand: false,
      }).mode,
    ).toBe("session-error");

    expect(
      deriveMyAccessState({
        environmentId: envId,
        session: {
          authenticated: false,
          auth: multiUserAuthDescriptor,
        },
        sessionPending: false,
        sessionHasError: false,
        membersSupported: true,
        canReadMembersCommand: false,
        canIssueLoginCodeCommand: false,
      }),
    ).toMatchObject({
      mode: "unauthenticated",
      shouldFetchMembers: false,
      canIssueLoginCode: false,
      canSignOut: false,
    });
  });

  it("treats owner sessions as owner without fetching project memberships", () => {
    const state = deriveMyAccessState({
      environmentId: envId,
      session: ownerSession(true),
      sessionPending: false,
      sessionHasError: false,
      membersSupported: true,
      canReadMembersCommand: true,
      canIssueLoginCodeCommand: true,
    });

    expect(state).toMatchObject({
      mode: "owner",
      isOwner: true,
      shouldFetchMembers: false,
      canIssueLoginCode: true,
      canSignOut: true,
      sessionRole: "owner",
    });

    const singleOwnerLegacy = deriveMyAccessState({
      environmentId: envId,
      session: ownerSession(false),
      sessionPending: false,
      sessionHasError: false,
      membersSupported: false,
      canReadMembersCommand: true,
      canIssueLoginCodeCommand: true,
    });
    expect(singleOwnerLegacy).toMatchObject({
      mode: "owner",
      isOwner: true,
      shouldFetchMembers: false,
      canIssueLoginCode: false,
      canSignOut: false,
    });
  });

  it("gates member queries and actions by permissionAtom outputs and principal status", () => {
    const denied = deriveMyAccessState({
      environmentId: envId,
      session: memberSession(),
      sessionPending: false,
      sessionHasError: false,
      membersSupported: true,
      canReadMembersCommand: false,
      canIssueLoginCodeCommand: false,
    });
    expect(denied).toMatchObject({
      mode: "member",
      isOwner: false,
      canReadMembers: false,
      shouldFetchMembers: false,
      canIssueLoginCode: false,
      canSignOut: true,
    });

    const allowed = deriveMyAccessState({
      environmentId: envId,
      session: memberSession(),
      sessionPending: false,
      sessionHasError: false,
      membersSupported: true,
      canReadMembersCommand: true,
      canIssueLoginCodeCommand: true,
    });
    expect(allowed).toMatchObject({
      mode: "member",
      canReadMembers: true,
      shouldFetchMembers: true,
      canIssueLoginCode: true,
      canSignOut: true,
    });

    const suspended = deriveMyAccessState({
      environmentId: envId,
      session: memberSession({ principal: memberPrincipal("suspended") }),
      sessionPending: false,
      sessionHasError: false,
      membersSupported: true,
      canReadMembersCommand: true,
      canIssueLoginCodeCommand: true,
    });
    expect(suspended.canIssueLoginCode).toBe(false);

    const projectBound = deriveMyAccessState({
      environmentId: envId,
      session: memberSession({
        binding: { _tag: "projects", projects: [{ projectId: projectA, role: "viewer" }] },
      }),
      sessionPending: false,
      sessionHasError: false,
      membersSupported: true,
      canReadMembersCommand: true,
      canIssueLoginCodeCommand: true,
    });
    expect(projectBound.shouldFetchMembers).toBe(false);
  });
});

describe("resolveMyProjectAccessEntries and resolveHighlightedRoles", () => {
  const projectTitles = new Map<ProjectId, string>([
    [projectA, "Alpha App"],
    [projectB, "Beta Portal"],
  ]);

  const members: ReadonlyArray<MemberWithMemberships> = [
    {
      principal: memberPrincipal("active"),
      memberships: [
        makeMembership(PrincipalId.make("member-1"), projectB, "viewer", "suspended"),
        makeMembership(PrincipalId.make("member-1"), projectA, "developer", "active"),
        makeMembership(PrincipalId.make("member-1"), projectC, "admin", "removed"),
      ],
    },
    {
      principal: otherPrincipal,
      memberships: [makeMembership(otherPrincipal.id, projectC, "admin", "active")],
    },
  ];

  it("lists only the signed-in member's non-removed projects with capabilities from capabilitiesForRole", () => {
    const entries = resolveMyProjectAccessEntries({
      session: memberSession(),
      members,
      projectTitleById: projectTitles,
    });

    expect(entries).toEqual([
      {
        projectId: projectA,
        projectTitle: "Alpha App",
        role: "developer",
        state: "active",
        capabilities: capabilitiesForRole("developer"),
        expiresAt: null,
      },
      {
        projectId: projectB,
        projectTitle: "Beta Portal",
        role: "viewer",
        state: "suspended",
        capabilities: capabilitiesForRole("viewer"),
        expiresAt: null,
      },
    ]);
  });

  it("stays strictly inside project-bound sessions and returns empty for owners", () => {
    const bound = resolveMyProjectAccessEntries({
      session: memberSession({
        binding: { _tag: "projects", projects: [{ projectId: projectC, role: "manager" }] },
      }),
      members,
      projectTitleById: projectTitles,
    });
    expect(bound).toEqual([
      {
        projectId: projectC,
        projectTitle: "project-c",
        role: "manager",
        state: "active",
        capabilities: capabilitiesForRole("manager"),
        expiresAt: null,
      },
    ]);

    expect(
      resolveMyProjectAccessEntries({
        session: ownerSession(true),
        members,
        projectTitleById: projectTitles,
      }),
    ).toEqual([]);
  });

  it("highlights active roles for members and owner for owners", () => {
    expect([...resolveHighlightedRoles({ session: ownerSession(true), members })]).toEqual([
      "owner",
    ]);
    expect([...resolveHighlightedRoles({ session: memberSession(), members })]).toEqual([
      "developer",
    ]);
    expect([
      ...resolveHighlightedRoles({
        session: memberSession({
          binding: {
            _tag: "projects",
            projects: [
              { projectId: projectA, role: "operator" },
              { projectId: projectB, role: "manager" },
            ],
          },
        }),
        members: [],
      }),
    ]).toEqual(["operator", "manager"]);
  });
});
