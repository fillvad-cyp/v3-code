import { RegistryContext } from "@effect/atom-react";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  InvitationId,
  PrincipalId,
  ProjectId,
  ceilingScopes,
  type AuthAccessStreamEvent,
  type AuthSessionState,
  type Invitation,
  type MemberWithMemberships,
  type Principal,
  type ProjectMembership,
} from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { GTProvider, initializeGT } from "gt-react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
type MembersResult = AsyncResult.AsyncResult<ReadonlyArray<MemberWithMemberships>, Error>;
type InvitationsResult = AsyncResult.AsyncResult<ReadonlyArray<Invitation>, Error>;
type AccessChangesResult = AsyncResult.AsyncResult<AuthAccessStreamEvent, Error>;

const envId = EnvironmentId.make("env-1");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

const state = vi.hoisted(() => ({
  sessionAtom: null as Atom.Writable<SessionResult> | null,
  membersAtom: null as Atom.Writable<MembersResult> | null,
  invitationsAtom: null as Atom.Writable<InvitationsResult> | null,
  accessChangesAtom: null as Atom.Writable<AccessChangesResult> | null,
  canReadMembersAtom: null as Atom.Writable<boolean> | null,
  canWriteMembersAtom: null as Atom.Writable<boolean> | null,
  canUpdateSettingsAtom: null as Atom.Writable<boolean> | null,
  multiUserSetting: false,
  membersCapability: true,
  projects: [] as Array<{
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
    readonly title: string;
  }>,
}));

vi.mock(import("../../state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSession: {
      ...actual.environmentSession,
      sessionStateAtom: (() => state.sessionAtom!) as never,
    },
    useEnvironmentSessionState: (() => {
      const result = appAtomRegistry.get(state.sessionAtom!);
      return {
        data: AsyncResult.getOrElse(result, () => null),
        hasError: result._tag === "Failure",
        isPending: result.waiting,
      };
    }) as never,
    usePreparedConnection: (() =>
      Option.some({
        environmentId: envId,
        httpBaseUrl: "https://hub.example.com",
        label: "Hub",
      })) as never,
  };
});

vi.mock(import("../../state/auth"), () => ({
  authEnvironment: {
    accessChanges: () => state.accessChangesAtom!,
    listMembers: Object.assign(() => state.membersAtom!, {
      permissionAtom: () => state.canReadMembersAtom!,
    }),
    updateMember: Object.assign("updateMember", {
      permissionAtom: () => state.canWriteMembersAtom!,
    }),
    removeMember: Object.assign("removeMember", {
      permissionAtom: () => state.canWriteMembersAtom!,
    }),
    createInvitation: Object.assign("createInvitation", {
      permissionAtom: () => state.canWriteMembersAtom!,
    }),
    listInvitations: Object.assign(() => state.invitationsAtom!, {
      permissionAtom: () => state.canWriteMembersAtom!,
    }),
    revokeInvitation: Object.assign("revokeInvitation", {
      permissionAtom: () => state.canWriteMembersAtom!,
    }),
    issueMemberLoginCode: Object.assign("issueMemberLoginCode", {
      permissionAtom: () => Atom.make(true),
    }),
  } as never,
}));

vi.mock(import("../../state/server"), () => ({
  serverEnvironment: {
    updateSettings: Object.assign("updateSettings", {
      permissionAtom: () => state.canUpdateSettingsAtom!,
    }),
  } as never,
}));

vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => vi.fn()) as never,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => ({
    environmentId: envId,
    label: "Work Hub",
    connection: { phase: "connected" },
    serverConfig: {
      keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      settings: { ...DEFAULT_SERVER_SETTINGS, multiUser: state.multiUserSetting },
      environment: {
        platform: { machine: "server" },
        capabilities: state.membersCapability ? { members: true } : {},
      },
    },
  })) as never,
  usePrimaryEnvironment: (() => ({
    environmentId: envId,
    label: "Work Hub",
  })) as never,
  usePrimaryEnvironmentId: () => envId,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => state.projects) as never,
  useServerConfigs: (() => new Map()) as never,
}));

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { MembersSettings } from "./MembersSettings";
import { ProjectMembersCard } from "./ProjectMembersSettings";

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

const adminPrincipal: Principal = {
  id: PrincipalId.make("admin-1"),
  kind: "member",
  displayName: "Sam Admin",
  email: null,
  status: "active",
  ceiling: [...ceilingScopes("staff")],
  accessRevision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  removedAt: null,
};

const devPrincipal: Principal = {
  id: PrincipalId.make("dev-1"),
  kind: "member",
  displayName: "Alex Dev",
  email: null,
  status: "active",
  ceiling: [...ceilingScopes("restricted")],
  accessRevision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  removedAt: null,
};

const makeMembership = (
  principalId: PrincipalId,
  projectId: ProjectId,
  role: ProjectMembership["role"],
  membershipState: ProjectMembership["state"] = "active",
): ProjectMembership => ({
  projectId,
  principalId,
  role,
  state: membershipState,
  invitedBy: ownerPrincipal.id,
  expiresAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const baseAuth = {
  policy: "remote-reachable" as const,
  bootstrapMethods: ["one-time-token" as const],
  sessionMethods: ["bearer-access-token" as const],
  sessionCookieName: "t3_session",
};

const ownerSession = (
  authMode: "single-owner" | "multi-user" = "multi-user",
): AuthSessionState => ({
  authenticated: true,
  auth: { ...baseAuth, authMode },
  scopes: [AuthAccessReadScope, AuthAccessWriteScope, AuthEnvironmentMaintainScope],
  permissions: [AuthAccessReadScope, AuthAccessWriteScope, AuthEnvironmentMaintainScope],
  principal: ownerPrincipal,
  binding_kind: "environment",
  binding: { _tag: "environment" },
  role: "owner",
});

const developerSession = (): AuthSessionState => ({
  authenticated: true,
  auth: { ...baseAuth, authMode: "multi-user" },
  scopes: [AuthAccessReadScope],
  permissions: [AuthAccessReadScope],
  principal: devPrincipal,
  binding_kind: "principal",
  binding: { _tag: "principal" },
  role: "developer",
});

const adminSession = (): AuthSessionState => ({
  authenticated: true,
  auth: { ...baseAuth, authMode: "multi-user" },
  scopes: [AuthAccessReadScope, AuthAccessWriteScope],
  permissions: [AuthAccessReadScope, AuthAccessWriteScope],
  principal: adminPrincipal,
  binding_kind: "principal",
  binding: { _tag: "principal" },
  role: "admin",
});

const sampleMembers = (): ReadonlyArray<MemberWithMemberships> => [
  { principal: ownerPrincipal, memberships: [] },
  {
    principal: adminPrincipal,
    memberships: [makeMembership(adminPrincipal.id, projectA, "admin")],
  },
  {
    principal: devPrincipal,
    memberships: [
      makeMembership(devPrincipal.id, projectA, "developer"),
      makeMembership(devPrincipal.id, projectB, "viewer"),
    ],
  },
];

function setup(
  options: {
    session?: AuthSessionState;
    members?: ReadonlyArray<MemberWithMemberships>;
    invitations?: ReadonlyArray<Invitation>;
    canReadMembers?: boolean;
    canWriteMembers?: boolean;
    canUpdateSettings?: boolean;
    multiUserSetting?: boolean;
    membersCapability?: boolean;
  } = {},
) {
  initializeGT({ defaultLocale: "en", locales: ["en"] });
  state.sessionAtom = Atom.make<SessionResult>(
    AsyncResult.success(options.session ?? ownerSession()),
  ).pipe(Atom.keepAlive);
  state.membersAtom = Atom.make<MembersResult>(
    AsyncResult.success(options.members ?? sampleMembers()),
  ).pipe(Atom.keepAlive);
  state.invitationsAtom = Atom.make<InvitationsResult>(
    AsyncResult.success(options.invitations ?? []),
  ).pipe(Atom.keepAlive);
  state.accessChangesAtom = Atom.make<AccessChangesResult>(
    AsyncResult.success<AuthAccessStreamEvent>({
      version: 1,
      revision: 1,
      type: "snapshot",
      payload: { pairingLinks: [], clientSessions: [], revision: 1 },
    }),
  ).pipe(Atom.keepAlive);
  state.canReadMembersAtom = Atom.make(options.canReadMembers ?? true).pipe(Atom.keepAlive);
  state.canWriteMembersAtom = Atom.make(options.canWriteMembers ?? true).pipe(Atom.keepAlive);
  state.canUpdateSettingsAtom = Atom.make(options.canUpdateSettings ?? true).pipe(Atom.keepAlive);
  state.multiUserSetting = options.multiUserSetting ?? false;
  state.membersCapability = options.membersCapability ?? true;
  state.projects = [
    { id: projectA, environmentId: envId, title: "kotcrm" },
    { id: projectB, environmentId: envId, title: "billing" },
  ];
}

function renderHtml(element: React.ReactNode): string {
  return renderToStaticMarkup(
    <RegistryContext.Provider value={appAtomRegistry}>
      <GTProvider locale="en" translations={{}}>
        {element}
      </GTProvider>
    </RegistryContext.Provider>,
  );
}

describe("ProjectMembersCard rendering and permissions", () => {
  it("renders manage actions (invite, role select, suspend, remove, login code) for owner", () => {
    setup();
    const html = renderHtml(
      <ProjectMembersCard environmentId={envId} projectId={projectA} projectTitle="kotcrm" />,
    );

    expect(html).toContain("Host access");
    expect(html).toContain("Invite");
    expect(html).toContain("Alex Dev");
    expect(html).toContain("Sam Admin");
    expect(html).toContain('aria-label="Role for Alex Dev"');
    expect(html).toContain("Suspend");
    expect(html).toContain('aria-label="Remove Alex Dev from project"');
    expect(html).toContain("Login code");
  });

  it("renders read-only member list for developer without invite or management controls", () => {
    setup({
      session: developerSession(),
      canReadMembers: true,
      canWriteMembers: false,
    });
    const html = renderHtml(
      <ProjectMembersCard environmentId={envId} projectId={projectA} projectTitle="kotcrm" />,
    );

    expect(html).toContain("Alex Dev");
    expect(html).toContain("Sam Admin");
    expect(html).not.toContain(">Invite<");
    expect(html).not.toContain('aria-label="Role for Alex Dev"');
    expect(html).not.toContain(">Suspend<");
    expect(html).not.toContain('aria-label="Remove Alex Dev from project"');
    // Developer still has a Login code button for their own active principal.
    expect(html.match(/Login code/g)?.length).toBe(1);
  });

  it("renders empty state when project has no members", () => {
    setup({ members: [{ principal: ownerPrincipal, memberships: [] }] });
    const html = renderHtml(
      <ProjectMembersCard environmentId={envId} projectId={projectA} projectTitle="kotcrm" />,
    );

    expect(html).toContain("No members on this project yet.");
  });

  it("hides the project members card when capabilities.members is absent even if authMode is multi-user", () => {
    setup({
      session: ownerSession("multi-user"),
      membersCapability: false,
      multiUserSetting: true,
    });
    const html = renderHtml(
      <ProjectMembersCard environmentId={envId} projectId={projectA} projectTitle="kotcrm" />,
    );

    expect(html).toBe("");
  });
});

describe("MembersSettings environment screen gating", () => {
  it("hides the environment members screen when capabilities.members is absent even for owner with authMode multi-user", () => {
    setup({
      session: ownerSession("multi-user"),
      membersCapability: false,
      multiUserSetting: true,
      canUpdateSettings: true,
    });
    expect(renderHtml(<MembersSettings environmentId={envId} />)).toBe("");
  });

  it("renders multi-user switch, status, L0 host-access badge, ceiling select, and remove for owner when capabilities.members is true", () => {
    setup({
      session: ownerSession("single-owner"),
      multiUserSetting: false,
      canUpdateSettings: true,
    });
    const html = renderHtml(<MembersSettings environmentId={envId} />);

    expect(html).toContain("Multi-user mode");
    expect(html).toContain("Disabled");
    expect(html).toContain("Host access");
    expect(html).toContain("Host access (L0):");
    expect(html).toContain('aria-label="Multi-user mode"');
    expect(html).toContain('aria-label="Ceiling template for Alex Dev"');
    expect(html).toContain("kotcrm (Developer) · billing (Viewer)");
    expect(html).toContain('aria-label="Remove Alex Dev"');
  });

  it("hides the entire screen for developer and project admin sessions", () => {
    setup({ session: developerSession(), canUpdateSettings: false, multiUserSetting: true });
    expect(renderHtml(<MembersSettings environmentId={envId} />)).toBe("");

    setup({ session: adminSession(), canUpdateSettings: true, multiUserSetting: true });
    expect(renderHtml(<MembersSettings environmentId={envId} />)).toBe("");
  });

  it("shows Enabled and disables the switch when permissionAtom denies serverUpdateSettings", () => {
    setup({
      session: ownerSession("multi-user"),
      multiUserSetting: true,
      canUpdateSettings: false,
    });
    const html = renderHtml(<MembersSettings environmentId={envId} />);

    expect(html).toContain("Enabled");
    expect(html).toMatch(/aria-label="Multi-user mode"[^>]*aria-disabled="true"|disabled=""/);
  });

  it("renders Suspend for active principals and Reactivate for suspended principals even with no project memberships", () => {
    setup({
      members: [
        { principal: ownerPrincipal, memberships: [] },
        { principal: devPrincipal, memberships: [] },
        {
          principal: { ...adminPrincipal, status: "suspended" },
          memberships: [],
        },
      ],
    });
    const html = renderHtml(<MembersSettings environmentId={envId} />);

    expect(html).toContain(">Suspend<");
    expect(html).toContain(">Reactivate<");
  });

  it("renders Share project (invite link) block with pending invitations", () => {
    setup({
      invitations: [
        {
          id: InvitationId.make("inv-pending"),
          email: null,
          kind: "staff",
          role: "developer",
          projectId: projectA,
          principalId: null,
          ceiling: [...ceilingScopes("staff")],
          createdBy: ownerPrincipal.id,
          createdAt: "2026-11-28T00:00:00.000Z",
          expiresAt: "2099-12-05T00:00:00.000Z",
          acceptedAt: null,
          revokedAt: null,
        },
      ],
    });
    const html = renderHtml(<MembersSettings environmentId={envId} />);

    expect(html).toContain("Share project (invite link)");
    expect(html).toContain("Create invite link");
    expect(html).toContain("kotcrm");
    expect(html).toContain('aria-label="Revoke invitation for kotcrm"');
  });
});
