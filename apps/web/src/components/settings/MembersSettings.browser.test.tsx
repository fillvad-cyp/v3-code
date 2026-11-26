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
  type AuthSessionState,
  type InvitationCreateInput,
  type InvitationCreateResult,
  type MemberLoginCodeResult,
  type MemberRemoveResult,
  type MemberWithMemberships,
  type Principal,
  type ProjectMembership,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import "~/index.css";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
type MembersResult = AsyncResult.AsyncResult<ReadonlyArray<MemberWithMemberships>, Error>;

const envId = EnvironmentId.make("env-1");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

const state = vi.hoisted(() => ({
  environmentId: null as EnvironmentId | null,
  sessionAtom: null as Atom.Writable<SessionResult> | null,
  membersAtom: null as Atom.Writable<MembersResult> | null,
  canReadMembersAtom: null as Atom.Writable<boolean> | null,
  canWriteMembersAtom: null as Atom.Writable<boolean> | null,
  canUpdateSettingsAtom: null as Atom.Writable<boolean> | null,
  multiUserSetting: false,
  projects: [] as Array<{
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
    readonly title: string;
  }>,
  updateMember:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: { principalId: PrincipalId; patch: Record<string, unknown> };
      }) => Promise<AsyncResult.Success<MemberWithMemberships> | AsyncResult.Failure<never, Error>>
    >(),
  removeMember:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: { principalId: PrincipalId; projectId?: ProjectId };
      }) => Promise<AsyncResult.Success<MemberRemoveResult> | AsyncResult.Failure<never, Error>>
    >(),
  createInvitation:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: InvitationCreateInput;
      }) => Promise<AsyncResult.Success<InvitationCreateResult> | AsyncResult.Failure<never, Error>>
    >(),
  issueMemberLoginCode:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: { principalId: PrincipalId };
      }) => Promise<AsyncResult.Success<MemberLoginCodeResult> | AsyncResult.Failure<never, Error>>
    >(),
  updateSettings:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: { patch: { multiUser?: boolean } };
      }) => Promise<AsyncResult.Success<unknown> | AsyncResult.Failure<never, Error>>
    >(),
  toast: vi.fn(),
}));

vi.mock(import("../../state/session"), async (original) => {
  const actual = await original();
  const { useAtomValue: readAtomValue } = await import("@effect/atom-react");
  const OptionModule = await import("effect/Option");
  const { AsyncResult: AsyncResultModule } = await import("effect/reactivity");
  return {
    ...actual,
    environmentSession: {
      ...actual.environmentSession,
      sessionStateAtom: (() => state.sessionAtom!) as never,
    },
    useEnvironmentSessionState: (() => {
      const result = readAtomValue(state.sessionAtom!);
      return {
        data: AsyncResultModule.getOrElse(result, () => null),
        hasError: result._tag === "Failure",
        isPending: result.waiting,
      };
    }) as never,
    usePreparedConnection: (() =>
      OptionModule.some({
        environmentId: state.environmentId!,
        httpBaseUrl: "https://hub.example.com",
        label: "Hub",
      })) as never,
  };
});

vi.mock(import("../../state/auth"), async (original) => {
  const actual = await original();
  const { Atom: AtomModule } = await import("effect/reactivity");
  const canIssueLoginCode = AtomModule.make(true).pipe(AtomModule.keepAlive);
  return {
    ...actual,
    authEnvironment: {
      ...actual.authEnvironment,
      listMembers: Object.assign(() => state.membersAtom!, {
        permissionAtom: () => state.canReadMembersAtom!,
      }),
      updateMember: {
        ...actual.authEnvironment.updateMember,
        label: "updateMember",
        permissionAtom: () => state.canWriteMembersAtom!,
      },
      removeMember: {
        ...actual.authEnvironment.removeMember,
        label: "removeMember",
        permissionAtom: () => state.canWriteMembersAtom!,
      },
      createInvitation: {
        ...actual.authEnvironment.createInvitation,
        label: "createInvitation",
        permissionAtom: () => state.canWriteMembersAtom!,
      },
      issueMemberLoginCode: {
        ...actual.authEnvironment.issueMemberLoginCode,
        label: "issueMemberLoginCode",
        permissionAtom: () => canIssueLoginCode,
      },
    } as never,
  };
});

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      updateSettings: {
        ...actual.serverEnvironment.updateSettings,
        label: "updateSettings",
        permissionAtom: () => state.canUpdateSettingsAtom!,
      },
    } as never,
  };
});

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) => {
    switch (command?.label) {
      case "updateMember":
        return state.updateMember;
      case "removeMember":
        return state.removeMember;
      case "createInvitation":
        return state.createInvitation;
      case "issueMemberLoginCode":
        return state.issueMemberLoginCode;
      case "updateSettings":
        return state.updateSettings;
      default:
        return vi.fn();
    }
  }) as never,
}));

vi.mock(import("../../state/environments"), async (original) => {
  const actual = await original();
  const { DEFAULT_SERVER_SETTINGS: defaultServerSettings } = await import("@t3tools/contracts");
  const { DEFAULT_RESOLVED_KEYBINDINGS: defaultResolvedKeybindings } =
    await import("@t3tools/shared/keybindings");
  return {
    ...actual,
    useEnvironment: (() => ({
      environmentId: state.environmentId!,
      label: "Work Hub",
      connection: { phase: "connected" },
      serverConfig: {
        keybindings: defaultResolvedKeybindings,
        settings: { ...defaultServerSettings, multiUser: state.multiUserSetting },
        environment: { platform: { machine: "server" }, capabilities: {} },
      },
    })) as never,
    usePrimaryEnvironment: (() => ({
      environmentId: state.environmentId!,
      label: "Work Hub",
    })) as never,
    usePrimaryEnvironmentId: () => state.environmentId!,
  };
});

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => state.projects) as never,
  useServerConfigs: (() => new Map()) as never,
}));

vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { MemberInviteDialog } from "./MemberInviteDialog";
import { MembersSettings } from "./MembersSettings";
import { ASSIGNABLE_PROJECT_ROLES } from "./MembersSettings.logic";
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

const sampleMembers = (): ReadonlyArray<MemberWithMemberships> => [
  { principal: ownerPrincipal, memberships: [] },
  {
    principal: adminPrincipal,
    memberships: [makeMembership(adminPrincipal.id, projectA, "admin")],
  },
  {
    principal: devPrincipal,
    memberships: [
      makeMembership(devPrincipal.id, projectA, "operator"),
      makeMembership(devPrincipal.id, projectB, "viewer"),
    ],
  },
];

function setup(
  options: {
    session?: AuthSessionState;
    members?: ReadonlyArray<MemberWithMemberships>;
    canReadMembers?: boolean;
    canWriteMembers?: boolean;
    canUpdateSettings?: boolean;
    multiUserSetting?: boolean;
  } = {},
) {
  vi.clearAllMocks();
  state.environmentId = envId;
  state.sessionAtom = Atom.make<SessionResult>(
    AsyncResult.success(options.session ?? ownerSession()),
  ).pipe(Atom.keepAlive);
  state.membersAtom = Atom.make<MembersResult>(
    AsyncResult.success(options.members ?? sampleMembers()),
  ).pipe(Atom.keepAlive);
  state.canReadMembersAtom = Atom.make(options.canReadMembers ?? true).pipe(Atom.keepAlive);
  state.canWriteMembersAtom = Atom.make(options.canWriteMembers ?? true).pipe(Atom.keepAlive);
  state.canUpdateSettingsAtom = Atom.make(options.canUpdateSettings ?? true).pipe(Atom.keepAlive);
  state.multiUserSetting = options.multiUserSetting ?? false;
  state.projects = [
    { id: projectA, environmentId: envId, title: "kotcrm" },
    { id: projectB, environmentId: envId, title: "billing" },
  ];
  state.updateMember.mockResolvedValue(
    AsyncResult.success({ principal: devPrincipal, memberships: [] }),
  );
  state.removeMember.mockResolvedValue(AsyncResult.success({ removed: true }));
  state.createInvitation.mockResolvedValue(
    AsyncResult.success({
      code: "INV1-CODE-2345",
      invitation: {
        id: InvitationId.make("inv-1"),
        email: null,
        kind: "staff",
        role: "developer",
        projectId: projectA,
        principalId: null,
        ceiling: [...ceilingScopes("staff")],
        createdBy: ownerPrincipal.id,
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-08T00:00:00.000Z",
        acceptedAt: null,
        revokedAt: null,
      },
    }),
  );
  state.issueMemberLoginCode.mockResolvedValue(
    AsyncResult.success({
      code: "LOG1-CODE-9876",
      expiresAt: "2099-01-01T00:15:00.000Z",
    }),
  );
  state.updateSettings.mockResolvedValue(AsyncResult.success(DEFAULT_SERVER_SETTINGS));
}

describe("ProjectMembersCard", () => {
  it("shows manage actions for owner and surfaces ceiling errors in plain words", async () => {
    setup();
    state.updateMember.mockResolvedValueOnce(
      AsyncResult.failure(
        Cause.fail(new Error("The developer role exceeds this member's scope ceiling.")),
      ),
    );

    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ProjectMembersCard environmentId={envId} projectId={projectA} projectTitle="kotcrm" />
      </RegistryContext.Provider>,
    );

    await expect.element(page.getByRole("button", { name: "Invite" })).toBeVisible();
    await expect.element(page.getByText("Alex Dev")).toBeVisible();
    await expect.element(page.getByText("Sam Admin")).toBeVisible();

    await userEvent.click(page.getByRole("combobox", { name: "Role for Alex Dev" }));
    await userEvent.click(page.getByRole("option", { name: "Developer" }));

    await vi.waitFor(() =>
      expect(state.updateMember).toHaveBeenCalledWith({
        environmentId: envId,
        input: {
          principalId: devPrincipal.id,
          patch: { projectId: projectA, role: "developer" },
        },
      }),
    );
    await expect
      .element(
        page.getByText(
          "This role needs more access than this member's ceiling allows. Raise their ceiling template in Sharing & access first.",
        ),
      )
      .toBeVisible();

    // Owner can issue a login code for an existing member and see the code dialog.
    await userEvent.click(page.getByRole("button", { name: "Login code" }).first());
    await expect.element(page.getByText("LOG1-CODE-9876")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Copy code" })).toBeVisible();
  });

  it("renders read-only view for a developer (no invite, role change, suspend, or remove)", async () => {
    setup({
      session: developerSession(),
      canReadMembers: true,
      canWriteMembers: false,
    });

    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ProjectMembersCard environmentId={envId} projectId={projectA} projectTitle="kotcrm" />
      </RegistryContext.Provider>,
    );

    await expect.element(page.getByText("Alex Dev")).toBeVisible();
    await expect.element(page.getByText("Sam Admin")).toBeVisible();
    expect(page.getByRole("button", { name: "Invite" }).query()).toBeNull();
    expect(page.getByRole("combobox", { name: "Role for Alex Dev" }).query()).toBeNull();
    expect(page.getByRole("button", { name: "Suspend" }).query()).toBeNull();
    expect(page.getByRole("button", { name: "Remove Alex Dev from project" }).query()).toBeNull();
    // Developer can still issue a login code only for themselves.
    expect(page.getByRole("button", { name: "Login code" }).elements()).toHaveLength(1);
  });
});

describe("MemberInviteDialog", () => {
  it("limits role choices to grantable roles, has no email field, and displays code and accept link", async () => {
    setup();
    const onOpenChange = vi.fn();

    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MemberInviteDialog
          environmentId={envId}
          open
          onOpenChange={onOpenChange}
          isOwner={false}
          grantableRoles={["viewer", "operator"]}
          fixedProject={{ id: projectA, label: "kotcrm" }}
        />
      </RegistryContext.Provider>,
    );

    expect(page.getByLabelText(/email/i).query()).toBeNull();
    await userEvent.click(page.getByRole("combobox", { name: "Invitation role" }));
    await expect.element(page.getByRole("option", { name: "Viewer" })).toBeVisible();
    await expect.element(page.getByRole("option", { name: "Operator" })).toBeVisible();
    expect(page.getByRole("option", { name: "Admin" }).query()).toBeNull();
    expect(page.getByRole("option", { name: "Owner" }).query()).toBeNull();
    await userEvent.click(page.getByRole("option", { name: "Operator" }));

    await userEvent.click(page.getByRole("button", { name: "Create invitation" }));

    await vi.waitFor(() =>
      expect(state.createInvitation).toHaveBeenCalledWith({
        environmentId: envId,
        input: { kind: "staff", role: "operator", projectId: projectA },
      }),
    );
    await expect.element(page.getByText("INV1-CODE-2345")).toBeVisible();
    await expect
      .element(page.getByText("https://hub.example.com/invite/INV1-CODE-2345"))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Copy code" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Copy link" })).toBeVisible();
  });

  it("disables creation when the actor has no grantable roles", async () => {
    setup();

    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MemberInviteDialog
          environmentId={envId}
          open
          onOpenChange={vi.fn()}
          isOwner={false}
          grantableRoles={[]}
          fixedProject={{ id: projectA, label: "kotcrm" }}
        />
      </RegistryContext.Provider>,
    );

    await expect
      .element(page.getByText("Your current permissions do not allow inviting new members."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Create invitation" })).toBeDisabled();
    expect(state.createInvitation).not.toHaveBeenCalled();
  });

  it("shows all assignable roles (never owner) when owner invites", async () => {
    setup();

    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MemberInviteDialog
          environmentId={envId}
          open
          onOpenChange={vi.fn()}
          isOwner
          grantableRoles={ASSIGNABLE_PROJECT_ROLES}
          projects={[{ id: projectA, label: "kotcrm" }]}
        />
      </RegistryContext.Provider>,
    );

    await userEvent.click(page.getByRole("combobox", { name: "Invitation role" }));
    await expect.element(page.getByRole("option", { name: "Admin" })).toBeVisible();
    await expect.element(page.getByRole("option", { name: "Developer" })).toBeVisible();
    expect(page.getByRole("option", { name: "Owner" }).query()).toBeNull();
  });
});

describe("MembersSettings (environment-level)", () => {
  it("shows multi-user switch, L0 host-access badge, ceiling choice, and whole-principal actions for owner", async () => {
    setup({
      session: ownerSession("single-owner"),
      multiUserSetting: false,
      canUpdateSettings: true,
    });

    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MembersSettings environmentId={envId} />
      </RegistryContext.Provider>,
    );

    await expect.element(page.getByText("Host access", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Disabled", { exact: true })).toBeVisible();
    await expect.element(page.getByText("kotcrm (Operator) · billing (Viewer)")).toBeVisible();

    const toggle = page.getByRole("switch", { name: "Multi-user mode" });
    await expect.element(toggle).toBeEnabled();
    await userEvent.click(toggle);

    await vi.waitFor(() =>
      expect(state.updateSettings).toHaveBeenCalledWith({
        environmentId: envId,
        input: { patch: { multiUser: true } },
      }),
    );

    // Owner changes a member's ceiling template.
    await userEvent.click(page.getByRole("combobox", { name: "Ceiling template for Alex Dev" }));
    await userEvent.click(page.getByRole("option", { name: /Staff/ }));
    await vi.waitFor(() =>
      expect(state.updateMember).toHaveBeenCalledWith({
        environmentId: envId,
        input: {
          principalId: devPrincipal.id,
          patch: { ceiling: "staff" },
        },
      }),
    );

    // Owner suspends a multi-project member via a single principal-level PATCH (no projectId loop).
    // environmentMembersList sorts non-owners alphabetically, so Alex Dev's row comes before Sam Admin's.
    state.updateMember.mockClear();
    await userEvent.click(page.getByRole("button", { name: "Suspend" }).first());
    await vi.waitFor(() => expect(state.updateMember).toHaveBeenCalledTimes(1));
    expect(state.updateMember).toHaveBeenCalledWith({
      environmentId: envId,
      input: {
        principalId: devPrincipal.id,
        patch: { state: "suspended" },
      },
    });

    // Owner removes whole principal without projectId.
    await userEvent.click(page.getByRole("button", { name: "Remove Alex Dev" }));
    await userEvent.click(page.getByRole("button", { name: "Remove", exact: true }));
    await vi.waitFor(() =>
      expect(state.removeMember).toHaveBeenCalledWith({
        environmentId: envId,
        input: { principalId: devPrincipal.id },
      }),
    );
  });

  it("hides the environment members screen completely for non-owner sessions", async () => {
    setup({
      session: developerSession(),
      canUpdateSettings: false,
      multiUserSetting: true,
    });

    await using screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MembersSettings environmentId={envId} />
      </RegistryContext.Provider>,
    );

    expect(screen.container.textContent?.trim()).toBe("");
    expect(page.getByRole("switch", { name: "Multi-user mode" }).query()).toBeNull();
  });

  it("disables the multi-user switch when permissionAtom denies serverUpdateSettings", async () => {
    setup({
      session: ownerSession("multi-user"),
      multiUserSetting: true,
      canUpdateSettings: false,
    });

    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MembersSettings environmentId={envId} />
      </RegistryContext.Provider>,
    );

    await expect.element(page.getByText("Enabled", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("switch", { name: "Multi-user mode" })).toBeDisabled();

    // Restoring permissionAtom enables the switch reactively.
    await act(async () => {
      appAtomRegistry.set(state.canUpdateSettingsAtom!, true);
    });
    await expect.element(page.getByRole("switch", { name: "Multi-user mode" })).toBeEnabled();
  });
});
