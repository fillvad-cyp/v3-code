import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";
import { render } from "../../../test/render";

import {
  clearPwaDismissal,
  openPwaInstallPrompt,
  readPwaDismissal,
  usePwaInstallStore,
  type PwaInstallPlatform,
} from "../../lib/pwaInstall";
import { HomeScreenInstallPromptHost } from "./HomeScreenInstallPrompt";

function createHostRouter() {
  const rootRoute = createRootRoute({
    component: HomeScreenInstallPromptHost,
  });
  return createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
}

function usePwaPromptFixture(platform: PwaInstallPlatform = "ios-safari"): Disposable {
  clearPwaDismissal();
  usePwaInstallStore.setState({
    open: false,
    installed: false,
    platform,
    deferredPrompt: null,
    installing: false,
    autoPromptAttempted: true,
  });
  return {
    [Symbol.dispose]() {
      clearPwaDismissal();
      usePwaInstallStore.setState({
        open: false,
        installed: false,
        platform: "desktop-browser",
        deferredPrompt: null,
        installing: false,
        autoPromptAttempted: false,
      });
    },
  };
}

describe("HomeScreenInstallPromptHost", () => {
  it("renders iPhone Safari Home Screen instructions and persists permanent dismissal", async () => {
    using _fixture = usePwaPromptFixture("ios-safari");
    const router = createHostRouter();
    await router.load();
    await using screen = await render(<RouterProvider router={router} />);

    usePwaInstallStore.setState({
      open: true,
      platform: "ios-safari",
    });

    await expect.element(screen.getByText(/Add to Home Screen/i).first()).toBeVisible();
    await expect.element(screen.getByText(/HttpOnly cookie/i)).toBeVisible();

    await screen.getByRole("button", { name: "Don't show again" }).click();

    expect(usePwaInstallStore.getState().open).toBe(false);
    expect(readPwaDismissal()).toBe("never");
  });

  it("can always be reopened manually even after Don't show again", async () => {
    using _fixture = usePwaPromptFixture("ios-safari");
    const router = createHostRouter();
    await router.load();
    await using screen = await render(<RouterProvider router={router} />);

    usePwaInstallStore.setState({ open: true, platform: "ios-safari" });
    await screen.getByRole("button", { name: "Don't show again" }).click();
    expect(usePwaInstallStore.getState().open).toBe(false);

    openPwaInstallPrompt();
    await expect.element(screen.getByText(/Add .* to Home Screen/i).first()).toBeVisible();
  });
});
