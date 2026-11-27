import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { createMemoryHistory } from "@tanstack/react-router";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";

import { AppRoot } from "~/AppRoot";
import { __resetServerAuthBootstrapForTests } from "~/environments/primary";
import {
  __resetPopoutWindowRuntimeForTests,
  buildThreadPopoutRoutePath,
  clearCachedPopoutThreadMeta,
  clearPersistedPopoutAuthSession,
  markPersistedPopoutAuthSession,
  notifyPopoutSignOut,
  writeCachedPopoutThreadMeta,
} from "~/lib/threadPopout";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

vi.mock(import("~/components/ChatView"), () => ({
  default: ({
    environmentId,
    threadId,
    routeKind,
  }: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly routeKind: string;
  }) => (
    <div
      data-testid="popout-chat-view"
      data-environment-id={environmentId}
      data-thread-id={threadId}
      data-route-kind={routeKind}
    >
      Popout thread {threadId}
    </div>
  ),
}));

const POPOUT_THREAD = threadWithHistory("thread-popout-live", 2);
const POPOUT_REF = scopeThreadRef(ENVIRONMENT_ID, POPOUT_THREAD.id);
const PENDING_THREAD_ID = ThreadId.make("thread-popout-pending");
const PENDING_REF = scopeThreadRef(ENVIRONMENT_ID, PENDING_THREAD_ID);

installFakeEnvironment([POPOUT_THREAD]);

const sessionControl: {
  override: (() => Promise<Response>) | null;
} = { override: null };

// PrimaryEnvironmentHttpClient captures globalThis.fetch once; install a single delegate here.
const baseFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (url.pathname === "/api/auth/session" && sessionControl.override !== null) {
    return sessionControl.override();
  }
  return baseFetch(input, init);
};

function unauthenticatedMultiUserSessionResponse() {
  return new Response(
    JSON.stringify({
      authenticated: false,
      auth: {
        policy: "loopback-browser",
        authMode: "multi-user",
        bootstrapMethods: [],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function setup() {
  sessionControl.override = null;
  __resetServerAuthBootstrapForTests();
  __resetPopoutWindowRuntimeForTests();
  clearCachedPopoutThreadMeta();
  clearPersistedPopoutAuthSession();
}

async function mountPopoutApp(path: string) {
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "height: 800px; width: 1000px;";
  // The app owns its router, as main.tsx does, so render() adds none.
  const screen = await render(<AppRoot router={router} />, { container, router: false });
  return { screen, router };
}

it("renders the minimal popout shell without app splash or sidebar and delivers threadId to the view", async () => {
  setup();
  markPersistedPopoutAuthSession();
  writeCachedPopoutThreadMeta(POPOUT_REF, {
    title: "Cached popout title",
    projectTitle: "Render project",
  });

  const { screen, router } = await mountPopoutApp(buildThreadPopoutRoutePath(POPOUT_REF));
  await using _screen = screen;

  const shell = screen.container.querySelector("[data-popout-shell='true']");
  expect(shell).not.toBeNull();
  expect(shell?.getAttribute("data-popout-thread-id")).toBe(POPOUT_THREAD.id);

  // No logo splash, no sidebar navigation shell, and no command palette chrome.
  expect(document.querySelector("#boot-shell-logo")).toBeNull();
  expect(document.querySelector("[aria-label='V3 Code splash screen']")).toBeNull();
  expect(screen.container.querySelector("[data-app-sidebar]")).toBeNull();
  expect(screen.container.querySelector("[data-sidebar-control]")).toBeNull();

  // Thread ID and environment ID reach ChatView without redirecting through login.
  const chatView = screen.getByTestId("popout-chat-view");
  await expect.element(chatView).toBeVisible();
  await expect.element(chatView).toHaveAttribute("data-thread-id", POPOUT_THREAD.id);
  await expect.element(chatView).toHaveAttribute("data-environment-id", ENVIRONMENT_ID);
  expect(router.state.location.pathname).toBe(`/popout/thread/${POPOUT_THREAD.id}`);
  expect(screen.container.querySelector("[data-app-sidebar]")).toBeNull();
});

it("paints the cached header title and message skeleton immediately before the thread snapshot resolves", async () => {
  setup();
  markPersistedPopoutAuthSession();
  writeCachedPopoutThreadMeta(PENDING_REF, {
    title: "Cached skeleton title",
    projectTitle: "Workspace",
  });

  // Hold /api/auth/session open while the unlisted thread snapshot also stays pending.
  let resolveAuth: ((response: Response) => void) | null = null;
  const authGate = new Promise<Response>((resolve) => {
    resolveAuth = resolve;
  });
  sessionControl.override = () => authGate;
  using _releaseAuth = {
    [Symbol.dispose]: () => {
      sessionControl.override = null;
      resolveAuth?.(
        new Response(
          JSON.stringify({
            authenticated: true,
            auth: {
              policy: "loopback-browser",
              bootstrapMethods: ["one-time-token"],
              sessionMethods: ["browser-session-cookie"],
              sessionCookieName: "t3_session",
            },
            scopes: [],
            sessionMethod: "browser-session-cookie",
            expiresAt: "2099-01-01T00:00:00.000Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    },
  };

  const { screen } = await mountPopoutApp(buildThreadPopoutRoutePath(PENDING_REF));
  await using _screen = screen;

  expect(screen.container.querySelector("[data-popout-shell='true']")).not.toBeNull();
  expect(screen.container.querySelector("[data-popout-skeleton='messages']")).not.toBeNull();
  expect(screen.container.querySelector("[data-popout-skeleton='composer']")).not.toBeNull();
  await expect.element(screen.getByText("Cached skeleton title")).toBeVisible();
  await expect.element(screen.getByText("Workspace")).toBeVisible();
});

it("rehydrates across reload when stored credentials remain valid and handles sign-out", async () => {
  setup();
  markPersistedPopoutAuthSession();
  writeCachedPopoutThreadMeta(POPOUT_REF, { title: "Reloadable popout" });

  // Simulate a reload: fresh router on the popout route with valid server session cookie.
  {
    const firstMount = await mountPopoutApp(buildThreadPopoutRoutePath(POPOUT_REF));
    await using _firstScreen = firstMount.screen;
    await expect
      .element(firstMount.screen.getByTestId("popout-chat-view"))
      .toHaveAttribute("data-thread-id", POPOUT_THREAD.id);
    expect(firstMount.router.state.location.pathname).toBe(`/popout/thread/${POPOUT_THREAD.id}`);
  }

  __resetServerAuthBootstrapForTests();
  const secondMount = await mountPopoutApp(buildThreadPopoutRoutePath(POPOUT_REF));
  await using _screen = secondMount.screen;
  await expect
    .element(secondMount.screen.getByTestId("popout-chat-view"))
    .toHaveAttribute("data-thread-id", POPOUT_THREAD.id);
  expect(secondMount.router.state.location.pathname).toBe(`/popout/thread/${POPOUT_THREAD.id}`);

  // Main-window sign-out revokes the session cookie and signals popouts to close or re-authenticate.
  sessionControl.override = async () => unauthenticatedMultiUserSessionResponse();
  using _closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
  notifyPopoutSignOut();
  await vi.waitFor(() => {
    expect(secondMount.router.state.location.pathname).toBe("/login");
  });
});

it("redirects to /login when background auth validation reports requires-auth in multi-user mode", async () => {
  setup();
  markPersistedPopoutAuthSession();
  writeCachedPopoutThreadMeta(PENDING_REF, { title: "Expired session thread" });
  sessionControl.override = async () => unauthenticatedMultiUserSessionResponse();

  const { screen, router } = await mountPopoutApp(buildThreadPopoutRoutePath(PENDING_REF));
  await using _screen = screen;

  await vi.waitFor(() => {
    expect(router.state.location.pathname).toBe("/login");
  });
});
