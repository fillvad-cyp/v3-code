import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  PrincipalId,
  ProjectId,
  ceilingScopes,
  type AuthSessionState,
  type MemberWithMemberships,
  type Principal,
  type ProjectMembership,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ASSIGNABLE_PROJECT_ROLES,
  buildInviteAcceptUrl,
  deriveEnvironmentMembersGate,
  deriveProjectMemberPermissions,
  environmentMembersList,
  formatMembershipErrorMessage,
  grantableRolesForActor,
  inferCeilingTemplate,
  isSessionOwner,
  projectMembersForProject,
  validateInviteForm,
} from "./MembersSettings.logic";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

const makePrincipal = (overrides: Partial<Principal> = {}): Principal => ({
  id: PrincipalId.make("member-1"),
  kind: "member",
  displayName: "Alice",
  email: null,
  status: "active",
  ceiling: [...ceilingScopes("staff")],
  accessRevision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  removedAt: null,
  ...overrides,
});

const makeMembership = (overrides: Partial<ProjectMembership> = {}): ProjectMembership => ({
  projectId: projectA,
  principalId: PrincipalId.make("member-1"),
  role: "developer",
  state: "active",
  invitedBy: PrincipalId.make("owner"),
  expiresAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const baseAuth = {
  policy: "remote-reachable" as const,
  bootstrapMethods: ["one-time-token" as const],
  sessionMethods: ["bearer-access-token" as const],
  sessionCookieName: "t3_session",
};

const ownerPrincipal = makePrincipal({
  id: PrincipalId.make("owner"),
  kind: "owner",
  displayName: "Owner",
});

const devPrincipal = makePrincipal({
  id: PrincipalId.make("dev-1"),
  kind: "member",
  displayName: "Dev User",
});

const adminPrincipal = makePrincipal({
  id: PrincipalId.make("admin-1"),
  kind: "member",
  displayName: "Admin User",
});

const restrictedAdminPrincipal = makePrincipal({
  id: PrincipalId.make("admin-restricted"),
  kind: "member",
  displayName: "Restricted Admin",
  ceiling: [...ceilingScopes("restricted")],
});

const ownerSession = (authMode?: "single-owner" | "multi-user"): AuthSessionState => ({
  authenticated: true,
  auth: authMode ? { ...baseAuth, authMode } : baseAuth,
  scopes: [AuthAccessReadScope, AuthAccessWriteScope, AuthEnvironmentMaintainScope],
  permissions: [AuthAccessReadScope, AuthAccessWriteScope, AuthEnvironmentMaintainScope],
  principal: ownerPrincipal,
  binding_kind: "environment",
  binding: { _tag: "environment" },
  role: "owner",
});

const memberSession = (
  principal: Principal,
  role: "admin" | "developer" | "viewer",
  scopes: ReadonlyArray<typeof AuthAccessReadScope | typeof AuthAccessWriteScope>,
): AuthSessionState => ({
  authenticated: true,
  auth: { ...baseAuth, authMode: "multi-user" },
  scopes,
  permissions: scopes,
  principal,
  binding_kind: "principal",
  binding: { _tag: "principal" },
  role,
});

describe("isSessionOwner", () => {
  it("recognizes owner principals and rejects member principals and unauthenticated sessions", () => {
    expect(isSessionOwner(null)).toBe(false);
    expect(isSessionOwner({ authenticated: false, auth: baseAuth })).toBe(false);
    expect(isSessionOwner(ownerSession("multi-user"))).toBe(true);
    expect(
      isSessionOwner(
        memberSession(adminPrincipal, "admin", [AuthAccessReadScope, AuthAccessWriteScope]),
      ),
    ).toBe(false);
    expect(isSessionOwner(memberSession(devPrincipal, "developer", [AuthAccessReadScope]))).toBe(
      false,
    );
  });

  it("treats a legacy environment-bound session with maintain + access:write as owner, but not read-only pairing", () => {
    expect(
      isSessionOwner({
        authenticated: true,
        auth: baseAuth,
        scopes: [AuthEnvironmentMaintainScope, AuthAccessWriteScope],
        permissions: [AuthEnvironmentMaintainScope, AuthAccessWriteScope],
      }),
    ).toBe(true);
    expect(
      isSessionOwner({
        authenticated: true,
        auth: baseAuth,
        scopes: [AuthOrchestrationReadScope],
        permissions: [AuthOrchestrationReadScope],
      }),
    ).toBe(false);
  });
});

describe("grantableRolesForActor & deriveProjectMemberPermissions", () => {
  const members: ReadonlyArray<MemberWithMemberships> = [
    { principal: ownerPrincipal, memberships: [] },
    {
      principal: adminPrincipal,
      memberships: [makeMembership({ principalId: adminPrincipal.id, role: "admin" })],
    },
    {
      principal: restrictedAdminPrincipal,
      memberships: [makeMembership({ principalId: restrictedAdminPrincipal.id, role: "admin" })],
    },
    {
      principal: devPrincipal,
      memberships: [makeMembership({ principalId: devPrincipal.id, role: "developer" })],
    },
  ];

  it("grants owner all assignable roles and manage permissions on non-owner members", () => {
    const perms = deriveProjectMemberPermissions({
      session: ownerSession("multi-user"),
      canWriteAccess: true,
      projectId: projectA,
      members,
    });
    expect(perms.isOwner).toBe(true);
    expect(perms.canManage).toBe(true);
    expect(perms.canInvite).toBe(true);
    expect(perms.grantableRoles).toEqual(ASSIGNABLE_PROJECT_ROLES);
    expect(
      perms.canManageMember({
        principal: devPrincipal,
        membership: makeMembership({ principalId: devPrincipal.id, role: "developer" }),
      }),
    ).toBe(true);
    expect(
      perms.canManageMember({
        principal: ownerPrincipal,
        membership: makeMembership({ principalId: ownerPrincipal.id, role: "admin" }),
      }),
    ).toBe(false);
    expect(perms.canIssueLoginCode(devPrincipal)).toBe(true);
  });

  it("keeps developer read-only except issuing a login code for self", () => {
    const perms = deriveProjectMemberPermissions({
      session: memberSession(devPrincipal, "developer", [AuthAccessReadScope]),
      canWriteAccess: false,
      projectId: projectA,
      members,
    });
    expect(perms.isOwner).toBe(false);
    expect(perms.actorRole).toBe("developer");
    expect(perms.canManage).toBe(false);
    expect(perms.canInvite).toBe(false);
    expect(perms.grantableRoles).toEqual([]);
    expect(
      perms.canManageMember({
        principal: adminPrincipal,
        membership: makeMembership({ principalId: adminPrincipal.id, role: "admin" }),
      }),
    ).toBe(false);
    expect(perms.canIssueLoginCode(devPrincipal)).toBe(true);
    expect(perms.canIssueLoginCode(adminPrincipal)).toBe(false);
  });

  it("clamps admin grantable roles to their ceiling", () => {
    expect(
      grantableRolesForActor({
        isOwner: false,
        actorRole: "admin",
        actorCeiling: ceilingScopes("restricted"),
      }),
    ).toEqual(["viewer", "operator", "manager"]);

    expect(
      grantableRolesForActor({
        isOwner: false,
        actorRole: "admin",
        actorCeiling: ceilingScopes("client"),
      }),
    ).toEqual(["viewer"]);
  });
});

describe("deriveEnvironmentMembersGate", () => {
  it("shows environment settings only to owners and reflects authMode and permissionAtom", () => {
    expect(
      deriveEnvironmentMembersGate({
        session: ownerSession("single-owner"),
        canUpdateMultiUserSetting: true,
        settingsMultiUser: false,
      }),
    ).toEqual({
      visible: true,
      isOwner: true,
      authMode: "single-owner",
      multiUserEnabled: false,
      canToggleMultiUser: true,
    });

    expect(
      deriveEnvironmentMembersGate({
        session: ownerSession("multi-user"),
        canUpdateMultiUserSetting: false,
        settingsMultiUser: true,
      }),
    ).toEqual({
      visible: true,
      isOwner: true,
      authMode: "multi-user",
      multiUserEnabled: true,
      canToggleMultiUser: false,
    });

    expect(
      deriveEnvironmentMembersGate({
        session: memberSession(adminPrincipal, "admin", [
          AuthAccessReadScope,
          AuthAccessWriteScope,
        ]),
        canUpdateMultiUserSetting: true,
        settingsMultiUser: true,
      }).visible,
    ).toBe(false);
  });
});

describe("validateInviteForm", () => {
  it("rejects empty role, disallowed role, and environment-wide invite for non-owner", () => {
    expect(
      validateInviteForm({
        role: null,
        projectId: projectA,
        isOwner: true,
        grantableRoles: ASSIGNABLE_PROJECT_ROLES,
      }),
    ).toEqual({ valid: false, error: "Choose a role for this invitation." });

    expect(
      validateInviteForm({
        role: "owner",
        projectId: projectA,
        isOwner: true,
        grantableRoles: ASSIGNABLE_PROJECT_ROLES,
      }),
    ).toEqual({ valid: false, error: "You cannot grant the selected role." });

    expect(
      validateInviteForm({
        role: "developer",
        projectId: projectA,
        isOwner: false,
        grantableRoles: ["viewer", "operator"],
      }),
    ).toEqual({ valid: false, error: "You cannot grant the selected role." });

    expect(
      validateInviteForm({
        role: "developer",
        projectId: null,
        isOwner: false,
        grantableRoles: ASSIGNABLE_PROJECT_ROLES,
      }),
    ).toEqual({ valid: false, error: "Choose a project for this invitation." });

    expect(
      validateInviteForm({
        role: "developer",
        projectId: null,
        isOwner: true,
        grantableRoles: ASSIGNABLE_PROJECT_ROLES,
      }),
    ).toEqual({ valid: true, role: "developer", projectId: null });
  });
});

describe("helpers", () => {
  it("infers ceiling templates and builds invite URLs", () => {
    expect(inferCeilingTemplate(ceilingScopes("staff"))).toBe("staff");
    expect(inferCeilingTemplate(ceilingScopes("restricted"))).toBe("restricted");
    expect(inferCeilingTemplate(ceilingScopes("client"))).toBe("client");
    expect(inferCeilingTemplate([AuthAccessReadScope])).toBeNull();

    expect(buildInviteAcceptUrl("https://hub.example.com/api", "ABCD-1234")).toBe(
      "https://hub.example.com/invite/ABCD-1234",
    );
    expect(buildInviteAcceptUrl(null, "ABCD-1234", "http://localhost:3773")).toBe(
      "http://localhost:3773/invite/ABCD-1234",
    );
  });

  it("filters removed principals and memberships and sorts lists predictably", () => {
    const removedPrincipal = makePrincipal({
      id: PrincipalId.make("removed"),
      displayName: "Gone",
      status: "removed",
    });
    const rows: ReadonlyArray<MemberWithMemberships> = [
      {
        principal: devPrincipal,
        memberships: [
          makeMembership({ principalId: devPrincipal.id, projectId: projectA, role: "developer" }),
          makeMembership({
            principalId: devPrincipal.id,
            projectId: projectB,
            role: "viewer",
            state: "removed",
          }),
        ],
      },
      {
        principal: adminPrincipal,
        memberships: [
          makeMembership({ principalId: adminPrincipal.id, projectId: projectA, role: "admin" }),
        ],
      },
      {
        principal: removedPrincipal,
        memberships: [
          makeMembership({ principalId: removedPrincipal.id, projectId: projectA, role: "viewer" }),
        ],
      },
      { principal: ownerPrincipal, memberships: [] },
    ];

    expect(projectMembersForProject(rows, projectA).map((entry) => entry.principal.id)).toEqual([
      adminPrincipal.id,
      devPrincipal.id,
    ]);
    expect(environmentMembersList(rows).map((entry) => entry.principal.id)).toEqual([
      ownerPrincipal.id,
      adminPrincipal.id,
      devPrincipal.id,
    ]);
    expect(environmentMembersList(rows)[2]?.memberships).toHaveLength(1);
  });

  it("translates ceiling and rank errors into plain user-facing copy", () => {
    expect(
      formatMembershipErrorMessage(
        new Error("The developer role exceeds this member's scope ceiling."),
      ),
    ).toBe(
      "This role needs more access than this member's ceiling allows. Raise their ceiling template in Sharing & access first.",
    );
    expect(
      formatMembershipErrorMessage(
        new Error("You cannot assign the admin role because it exceeds your own project role."),
      ),
    ).toBe("You cannot assign a role higher than your own role on this project.");
    expect(
      formatMembershipErrorMessage(new Error("Invitation rate limit exceeded. Try again later.")),
    ).toBe("Too many invitations created recently. Wait a while and try again.");
  });
});
