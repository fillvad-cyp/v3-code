import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  buildThreadPopoutRoutePath,
  buildThreadPopoutWebUrl,
  buildThreadPopoutWindowName,
  isPopoutWindowLocation,
  openThreadInPopoutWindow,
  shouldPopoutOnThreadClick,
} from "./threadPopout";

const sampleRef = {
  environmentId: EnvironmentId.make("env-local"),
  threadId: ThreadId.make("thread-42"),
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("threadPopout", () => {
  it("builds encoded pop-out route paths and web URLs", () => {
    const encodedRef = {
      environmentId: EnvironmentId.make("ssh:box/1"),
      threadId: ThreadId.make("thread 1/2"),
    };
    expect(buildThreadPopoutRoutePath(encodedRef)).toBe("/ssh%3Abox%2F1/thread%201%2F2");
    expect(buildThreadPopoutWebUrl("https://v3.local/", sampleRef)).toBe(
      "https://v3.local/env-local/thread-42?popout=1",
    );
    expect(buildThreadPopoutWindowName(encodedRef)).toBe("v3_thread_popout_ssh_box_1_thread_1_2");
  });

  it("detects pop-out mode from both browser search strings and desktop hash routes", () => {
    expect(isPopoutWindowLocation("?popout=1")).toBe(true);
    expect(isPopoutWindowLocation("?foo=bar&popout=1")).toBe(true);
    expect(isPopoutWindowLocation("", "#/env-local/thread-42?popout=1")).toBe(true);
    expect(isPopoutWindowLocation("", "#/env-local/thread-42?popout=1#anchor")).toBe(true);
    expect(isPopoutWindowLocation("?popout=0", "#/env-local/thread-42")).toBe(false);
    expect(isPopoutWindowLocation("")).toBe(false);
  });

  it("opens pop-out on Ctrl+Click (non-macOS) and Cmd+Click (macOS) outside multi-select", () => {
    expect(
      shouldPopoutOnThreadClick({
        isMac: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        hasSelection: false,
      }),
    ).toBe(true);
    expect(
      shouldPopoutOnThreadClick({
        isMac: true,
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        hasSelection: false,
      }),
    ).toBe(true);
    expect(
      shouldPopoutOnThreadClick({
        isMac: true,
        ctrlKey: true,
        metaKey: true,
        shiftKey: false,
        altKey: false,
        hasSelection: false,
      }),
    ).toBe(false);
    expect(
      shouldPopoutOnThreadClick({
        isMac: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        hasSelection: true,
      }),
    ).toBe(false);
    expect(
      shouldPopoutOnThreadClick({
        isMac: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
        altKey: false,
        hasSelection: false,
      }),
    ).toBe(false);
  });

  it("opens a named web popup window and handles popup blockers cleanly", async () => {
    const focus = vi.fn();
    const open = vi
      .fn()
      .mockReturnValueOnce({ focus } as unknown as Window)
      .mockReturnValueOnce(null);
    vi.stubGlobal("window", {
      location: { origin: "https://v3.local" },
      open,
    });

    expect(await openThreadInPopoutWindow(sampleRef, { title: "Demo" })).toBe(true);
    expect(open).toHaveBeenCalledWith(
      "https://v3.local/env-local/thread-42?popout=1",
      "v3_thread_popout_env_local_thread_42",
      expect.stringContaining("popup=yes"),
    );
    expect(focus).toHaveBeenCalledTimes(1);

    expect(await openThreadInPopoutWindow(sampleRef)).toBe(false);
  });
});
