import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  InvitationId,
  PrincipalId,
  ProjectId,
  ceilingScopes,
  type AdvertisedEndpoint,
  type AuthSessionState,
  type Invitation,
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
  partitionInviteRoles,
  pendingInvitationsList,
  projectMembersForProject,
  resolveInviteAcceptLink,
  supportsAuditCapability,
  supportsMembersCapability,
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
  it("gates environment settings by capabilities.members rather than authMode", () => {
    expect(supportsMembersCapability(undefined)).toBe(false);
    expect(supportsMembersCapability({ repositoryIdentity: true })).toBe(false);
    expect(supportsMembersCapability({ repositoryIdentity: true, members: false })).toBe(false);
    expect(supportsMembersCapability({ repositoryIdentity: true, members: true })).toBe(true);
    expect(supportsAuditCapability(undefined)).toBe(false);
    expect(supportsAuditCapability({ repositoryIdentity: true, audit: false })).toBe(false);
    expect(supportsAuditCapability({ repositoryIdentity: true, audit: true })).toBe(true);

    // Flag off hides the screen even when session.auth.authMode says "multi-user".
    expect(
      deriveEnvironmentMembersGate({
        session: ownerSession("multi-user"),
        canUpdateMultiUserSetting: true,
        membersSupported: false,
        settingsMultiUser: true,
      }),
    ).toEqual({
      visible: false,
      isOwner: true,
      multiUserEnabled: true,
      canToggleMultiUser: false,
    });

    // Flag on shows the screen for owner even when authMode is single-owner.
    expect(
      deriveEnvironmentMembersGate({
        session: ownerSession("single-owner"),
        canUpdateMultiUserSetting: true,
        membersSupported: true,
        settingsMultiUser: false,
      }),
    ).toEqual({
      visible: true,
      isOwner: true,
      multiUserEnabled: false,
      canToggleMultiUser: true,
    });

    expect(
      deriveEnvironmentMembersGate({
        session: ownerSession("multi-user"),
        canUpdateMultiUserSetting: false,
        membersSupported: true,
        settingsMultiUser: true,
      }),
    ).toEqual({
      visible: true,
      isOwner: true,
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
        membersSupported: true,
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

  it("partitions invite roles into primary and More roles, hiding Manager without CRM", () => {
    expect(partitionInviteRoles(ASSIGNABLE_PROJECT_ROLES, false)).toEqual({
      primaryRoles: ["viewer", "developer", "admin"],
      moreRoles: ["operator"],
      allRoles: ["viewer", "developer", "admin", "operator"],
    });
    expect(partitionInviteRoles(ASSIGNABLE_PROJECT_ROLES, true)).toEqual({
      primaryRoles: ["viewer", "developer", "admin"],
      moreRoles: ["operator", "manager"],
      allRoles: ["viewer", "developer", "admin", "operator", "manager"],
    });
  });

  it("filters login codes, revoked, accepted, and expired entries from pendingInvitationsList", () => {
    const baseInvite: Invitation = {
      id: InvitationId.make("inv-1"),
      email: null,
      kind: "staff",
      role: "developer",
      projectId: projectA,
      principalId: null,
      ceiling: [...ceilingScopes("staff")],
      createdBy: ownerPrincipal.id,
      createdAt: "2026-11-28T10:00:00.000Z",
      expiresAt: "2026-12-05T10:00:00.000Z",
      acceptedAt: null,
      revokedAt: null,
    };
    const nowMs = Date.parse("2026-11-28T12:00:00.000Z");
    const result = pendingInvitationsList(
      [
        { ...baseInvite, id: InvitationId.make("older"), createdAt: "2026-11-28T09:00:00.000Z" },
        { ...baseInvite, id: InvitationId.make("newer"), createdAt: "2026-11-28T11:00:00.000Z" },
        { ...baseInvite, id: InvitationId.make("login"), principalId: devPrincipal.id },
        { ...baseInvite, id: InvitationId.make("used"), acceptedAt: "2026-11-28T11:30:00.000Z" },
        { ...baseInvite, id: InvitationId.make("revoked"), revokedAt: "2026-11-28T11:30:00.000Z" },
        { ...baseInvite, id: InvitationId.make("expired"), expiresAt: "2026-11-28T11:00:00.000Z" },
      ],
      nowMs,
    );
    expect(result.map((item) => item.id)).toEqual(["newer", "older"]);
  });

  it("resolves invite accept links preferring reachable advertised and direct endpoints over 127.0.0.1", () => {
    const lanEndpoint: AdvertisedEndpoint = {
      id: "desktop-lan:192.168.1.50",
      provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
      label: "Local network",
      httpBaseUrl: "http://192.168.1.50:3773",
      wsBaseUrl: "ws://192.168.1.50:3773",
      reachability: "lan",
      source: "desktop-core",
      status: "available",
      isDefault: false,
      compatibility: { desktopApp: "compatible", hostedHttpsApp: "mixed-content-blocked" },
    };
    const tailscaleEndpoint: AdvertisedEndpoint = {
      id: "tailscale-magicdns:box.ts.net",
      provider: {
        id: "tailscale",
        label: "Tailscale",
        kind: "private-network",
        isAddon: true,
      },
      label: "Tailscale HTTPS",
      httpBaseUrl: "https://box.tail123.ts.net",
      wsBaseUrl: "wss://box.tail123.ts.net",
      reachability: "private-network",
      source: "desktop-addon",
      status: "available",
      isDefault: true,
      compatibility: { desktopApp: "compatible", hostedHttpsApp: "compatible" },
    };

    expect(
      resolveInviteAcceptLink({
        code: "ABCD-1234-5678",
        advertisedEndpoints: [lanEndpoint, tailscaleEndpoint],
        httpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toEqual({
      url: "https://box.tail123.ts.net/invite/ABCD-1234-5678",
      isLoopbackOnly: false,
      endpointLabel: "Tailscale HTTPS",
    });

    expect(
      resolveInviteAcceptLink({
        code: "ABCD-1234-5678",
        directEndpoints: [
          { kind: "lan", httpBaseUrl: "http://192.168.1.50:3773/" },
          { kind: "tailnet", httpBaseUrl: "https://box.tail123.ts.net/" },
        ],
        httpBaseUrl: "http://127.0.0.1:3773",
      }),
    ).toEqual({
      url: "https://box.tail123.ts.net/invite/ABCD-1234-5678",
      isLoopbackOnly: false,
      endpointLabel: null,
    });

    expect(
      resolveInviteAcceptLink({
        code: "ABCD-1234-5678",
        httpBaseUrl: "http://127.0.0.1:3773",
        fallbackOrigin: "http://localhost:5173",
      }),
    ).toEqual({
      url: "http://127.0.0.1:3773/invite/ABCD-1234-5678",
      isLoopbackOnly: true,
      endpointLabel: null,
    });
  });
});
