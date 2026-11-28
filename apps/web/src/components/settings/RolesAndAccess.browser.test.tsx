import { RegistryContext } from "@effect/atom-react";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthEnvironmentMaintainScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  PrincipalId,
  ProjectId,
  ceilingScopes,
  type AuthAccessStreamEvent,
  type AuthSessionState,
  type MemberLoginCodeResult,
  type MemberWithMemberships,
  type Principal,
  type ProjectMembership,
  type ProjectRole,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import "~/index.css";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
type MembersResult = AsyncResult.AsyncResult<ReadonlyArray<MemberWithMemberships>, Error>;
type AccessChangesResult = AsyncResult.AsyncResult<AuthAccessStreamEvent, Error>;

const envId = EnvironmentId.make("env-1");
const primaryEnvId = EnvironmentId.make("env-primary");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const projectC = ProjectId.make("project-c");

const state = vi.hoisted(() => ({
  environmentId: null as EnvironmentId | null,
  isPrimary: false,
  membersCapability: true,
  sessionAtom: null as Atom.Writable<SessionResult> | null,
  membersAtom: null as Atom.Writable<MembersResult> | null,
  accessChangesAtom: null as Atom.Writable<AccessChangesResult> | null,
  canReadMembersAtom: null as Atom.Writable<boolean> | null,
  canIssueLoginCodeAtom: null as Atom.Writable<boolean> | null,
  projects: [] as Array<{
    readonly id: ProjectId;
    readonly environmentId: EnvironmentId;
    readonly title: string;
  }>,
  issueMemberLoginCode:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: { principalId: PrincipalId };
      }) => Promise<AsyncResult.Success<MemberLoginCodeResult> | AsyncResult.Failure<never, Error>>
    >(),
  signOutCurrentSession:
    vi.fn<
      (request: {
        environmentId: EnvironmentId;
        input: null;
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
        label: "Work Hub",
      })) as never,
  };
});

vi.mock(import("../../state/auth"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    authEnvironment: {
      ...actual.authEnvironment,
      accessChanges: () => state.accessChangesAtom!,
      listMembers: Object.assign(() => state.membersAtom!, {
        permissionAtom: () => state.canReadMembersAtom!,
      }),
      issueMemberLoginCode: {
        ...actual.authEnvironment.issueMemberLoginCode,
        label: "issueMemberLoginCode",
        permissionAtom: () => state.canIssueLoginCodeAtom!,
      },
      signOutCurrentSession: {
        ...actual.authEnvironment.signOutCurrentSession,
        label: "signOutCurrentSession",
      },
    } as never,
  };
});

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { label?: string }) => {
    switch (command?.label) {
      case "issueMemberLoginCode":
        return state.issueMemberLoginCode;
      case "signOutCurrentSession":
        return state.signOutCurrentSession;
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
  const buildEnvironment = () => ({
    environmentId: state.environmentId!,
    label: "Work Hub",
    connection: { phase: "connected" as const },
    entry: { enabled: true },
    serverConfig: {
      keybindings: defaultResolvedKeybindings,
      settings: { ...defaultServerSettings, multiUser: state.membersCapability },
      environment: {
        platform: { machine: "server" as const },
        capabilities: state.membersCapability ? { members: true } : {},
      },
    },
  });
  return {
    ...actual,
    useEnvironment: (() => (state.environmentId === null ? null : buildEnvironment())) as never,
    useEnvironments: (() => ({
      environments: state.environmentId === null ? [] : [buildEnvironment()],
    })) as never,
    usePrimaryEnvironment: (() => ({
      environmentId: state.isPrimary ? state.environmentId! : primaryEnvId,
      label: "Primary",
    })) as never,
    usePrimaryEnvironmentId: () => (state.isPrimary ? state.environmentId! : primaryEnvId),
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
import { MyAccessSection } from "./MyAccessSettings";
import { RolesPermissionsPage } from "./RolesPermissionsSettings";

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
  email: "alex@example.com",
  status: "active",
  ceiling: [...ceilingScopes("staff")],
  accessRevision: 2,
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  removedAt: null,
};

const makeMembership = (
  principalId: PrincipalId,
  projectId: ProjectId,
  role: ProjectRole,
  membershipState: ProjectMembership["state"] = "active",
): ProjectMembership => ({
  projectId,
  principalId,
  role,
  state: membershipState,
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

const ownerSession = (): AuthSessionState => ({
  authenticated: true,
  auth: multiUserAuthDescriptor,
  scopes: [AuthAccessReadScope, AuthAccessWriteScope, AuthEnvironmentMaintainScope],
  principal: ownerPrincipal,
  binding: { _tag: "environment" },
  role: "owner",
});

const memberSession = (): AuthSessionState => ({
  authenticated: true,
  auth: multiUserAuthDescriptor,
  scopes: [AuthAccessReadScope],
  principal: devPrincipal,
  binding: { _tag: "principal" },
  role: "developer",
});

function setup(
  options: {
    readonly environmentId?: EnvironmentId | null;
    readonly isPrimary?: boolean;
    readonly session?: SessionResult;
    readonly members?: MembersResult;
    readonly canReadMembers?: boolean;
    readonly canIssueLoginCode?: boolean;
  } = {},
) {
  state.environmentId = options.environmentId === undefined ? envId : options.environmentId;
  state.isPrimary = options.isPrimary ?? false;
  state.membersCapability = true;
  state.projects = [
    { id: projectA, environmentId: envId, title: "Alpha App" },
    { id: projectB, environmentId: envId, title: "Client Portal" },
    { id: projectC, environmentId: envId, title: "Hidden Repo" },
  ];
  state.sessionAtom = Atom.make<SessionResult>(
    options.session ?? AsyncResult.success(memberSession()),
  ).pipe(Atom.keepAlive);
  state.membersAtom = Atom.make<MembersResult>(
    options.members ??
      AsyncResult.success<ReadonlyArray<MemberWithMemberships>>([
        {
          principal: devPrincipal,
          memberships: [
            makeMembership(devPrincipal.id, projectA, "developer", "active"),
            makeMembership(devPrincipal.id, projectB, "viewer", "active"),
            makeMembership(devPrincipal.id, projectC, "admin", "removed"),
          ],
        },
      ]),
  ).pipe(Atom.keepAlive);
  state.accessChangesAtom = Atom.make<AccessChangesResult>(
    AsyncResult.success<AuthAccessStreamEvent>({
      version: 1,
      revision: 1,
      type: "snapshot",
      payload: { pairingLinks: [], clientSessions: [] },
    }),
  ).pipe(Atom.keepAlive);
  state.canReadMembersAtom = Atom.make(options.canReadMembers ?? true).pipe(Atom.keepAlive);
  state.canIssueLoginCodeAtom = Atom.make(options.canIssueLoginCode ?? true).pipe(Atom.keepAlive);
  state.issueMemberLoginCode.mockReset();
  state.signOutCurrentSession.mockReset();
  state.toast.mockReset();
  void DEFAULT_SERVER_SETTINGS;
}

describe("RolesPermissionsPage browser rendering", () => {
  it("renders the grouped capability matrix with plain labels, single L0 warning, rules notes, and current role highlight", async () => {
    setup();
    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <RolesPermissionsPage />
      </RegistryContext.Provider>,
      { router: "/settings/roles" },
    );

    const table = page.getByRole("table", { name: "Role capability matrix" });
    await expect.element(table).toBeVisible();
    for (const column of ["Viewer", "Operator", "Developer", "Manager", "Admin", "Owner"]) {
      await expect
        .element(page.getByRole("columnheader", { name: new RegExp(column) }))
        .toBeVisible();
    }

    for (const heading of ["Reading", "Code & agents", "Project management", "CRM"]) {
      await expect.element(page.getByText(heading, { exact: true })).toBeVisible();
    }

    // Raw project:* codes are moved into tooltips instead of rendered inline in table cells.
    expect(page.getByText("project:read", { exact: true }).query()).toBeNull();
    expect(page.getByText("project:terminal.operate", { exact: true }).query()).toBeNull();

    // Single compact L0 warning line instead of repeated badges/banners.
    expect(page.getByText(/L0 host isolation:/).elements()).toHaveLength(1);
    expect(page.getByText("L0 · Terminal sees host").query()).toBeNull();

    await expect.element(page.getByText("Owner bypasses project checks")).toBeVisible();
    await expect.element(page.getByText("Creating a project: developer+")).toBeVisible();
    await expect.element(page.getByText("Deleting a project: owner only")).toBeVisible();
    await expect.element(page.getByText("Create projects")).toBeVisible();
    await expect.element(page.getByText("Delete projects")).toBeVisible();
    await expect.element(page.getByText("Your role").first()).toBeVisible();
  });
});

describe("MyAccessSection browser rendering", () => {
  it("renders a non-owner member's projects, roles, capabilities, login-code dialog, and sign-out", async () => {
    setup();
    state.issueMemberLoginCode.mockResolvedValue(
      AsyncResult.success({
        code: "SELF-LOGIN-99",
        expiresAt: "2026-12-01T00:00:00.000Z",
      }),
    );
    state.signOutCurrentSession.mockResolvedValue(AsyncResult.success(undefined));

    await using screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MyAccessSection environmentId={envId} />
      </RegistryContext.Provider>,
      { router: "/settings/my-access" },
    );

    await expect.element(page.getByText("Alpha App")).toBeVisible();
    await expect.element(page.getByText("Client Portal")).toBeVisible();
    expect(page.getByText("Hidden Repo").query()).toBeNull();
    await expect.element(page.getByText("Run terminal commands")).toBeVisible();
    await expect.element(page.getByText("Create projects")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Login code" }));
    expect(state.issueMemberLoginCode).toHaveBeenCalledWith({
      environmentId: envId,
      input: { principalId: devPrincipal.id },
    });
    await expect.element(page.getByText("SELF-LOGIN-99")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Done" }));

    await userEvent.click(page.getByRole("button", { name: "Sign out" }));
    expect(state.signOutCurrentSession).toHaveBeenCalledWith({
      environmentId: envId,
      input: null,
    });
    await vi.waitFor(() => {
      expect(screen.router?.state.location.pathname).toBe("/login");
    });
  });

  it("renders the owner note instead of a member project list for environment owners", async () => {
    setup({ session: AsyncResult.success(ownerSession()) });

    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MyAccessSection environmentId={envId} />
      </RegistryContext.Provider>,
      { router: "/settings/my-access" },
    );

    await expect.element(page.getByText(/Everything in this environment is yours/)).toBeVisible();
    expect(page.getByText("Alpha App").query()).toBeNull();
  });

  it("respects permissionAtom gating and renders empty and error states", async () => {
    setup({ canReadMembers: false, canIssueLoginCode: false });

    await using _screen = await render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <MyAccessSection environmentId={envId} />
      </RegistryContext.Provider>,
      { router: "/settings/my-access" },
    );

    await expect
      .element(page.getByText("This connection lacks permission to view your project memberships."))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Login code" }).query()).toBeNull();

    await act(() => {
      appAtomRegistry.set(state.canReadMembersAtom!, true);
      appAtomRegistry.set(state.membersAtom!, AsyncResult.success([]));
    });
    await expect
      .element(page.getByText(/You do not belong to any projects in this environment yet/))
      .toBeVisible();

    await act(() => {
      appAtomRegistry.set(
        state.membersAtom!,
        AsyncResult.failure<ReadonlyArray<MemberWithMemberships>, Error>(
          Cause.fail(new Error("Members endpoint unreachable")),
        ),
      );
    });
    await expect.element(page.getByText("Members endpoint unreachable")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });
});
