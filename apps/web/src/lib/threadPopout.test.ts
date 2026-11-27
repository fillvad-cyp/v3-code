import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __resetPopoutWindowRuntimeForTests,
  buildThreadPopoutRoutePath,
  buildThreadPopoutWebUrl,
  buildThreadPopoutWindowName,
  clearCachedPopoutThreadMeta,
  clearPersistedPopoutAuthSession,
  hasPersistedPopoutAuthSession,
  isPopoutRoutePathname,
  isPopoutWindowLocation,
  markPersistedPopoutAuthSession,
  notifyPopoutSignOut,
  openThreadInPopoutWindow,
  POPOUT_SIGNOUT_STORAGE_KEY,
  readCachedPopoutThreadMeta,
  shouldPopoutOnThreadClick,
  startPopoutWindowLifecycle,
  startPrimaryPopoutCoordinator,
  writeCachedPopoutThreadMeta,
} from "./threadPopout";

const sampleRef = {
  environmentId: EnvironmentId.make("env-local"),
  threadId: ThreadId.make("thread-42"),
};

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();
  readonly name: string;
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();

  constructor(name: string) {
    this.name = name;
    let group = FakeBroadcastChannel.channels.get(name);
    if (!group) {
      group = new Set();
      FakeBroadcastChannel.channels.set(name, group);
    }
    group.add(this);
  }

  addEventListener(_type: string, listener: (event: MessageEvent<unknown>) => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: (event: MessageEvent<unknown>) => void) {
    this.listeners.delete(listener);
  }

  postMessage(data: unknown) {
    const group = FakeBroadcastChannel.channels.get(this.name);
    if (!group) return;
    for (const peer of group) {
      if (peer === this) continue;
      for (const listener of peer.listeners) {
        listener({ data } as MessageEvent<unknown>);
      }
    }
  }

  close() {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

afterEach(() => {
  __resetPopoutWindowRuntimeForTests();
  FakeBroadcastChannel.channels.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("threadPopout", () => {
  it("builds dedicated pop-out route paths and web URLs", () => {
    const encodedRef = {
      environmentId: EnvironmentId.make("ssh:box/1"),
      threadId: ThreadId.make("thread 1/2"),
    };
    expect(buildThreadPopoutRoutePath(encodedRef)).toBe(
      "/popout/thread/thread%201%2F2?env=ssh%3Abox%2F1",
    );
    expect(buildThreadPopoutWebUrl("https://v3.local/", sampleRef)).toBe(
      "https://v3.local/popout/thread/thread-42?env=env-local",
    );
    expect(buildThreadPopoutWindowName(encodedRef)).toBe("v3_thread_popout_ssh_box_1_thread_1_2");
  });

  it("detects pop-out mode from dedicated paths, desktop hash routes, and legacy query strings", () => {
    expect(isPopoutRoutePathname("/popout/thread/thread-42")).toBe(true);
    expect(isPopoutRoutePathname("/popout")).toBe(true);
    expect(isPopoutRoutePathname("/env-local/thread-42")).toBe(false);

    expect(isPopoutWindowLocation("", "", "/popout/thread/thread-42")).toBe(true);
    expect(isPopoutWindowLocation("?env=env-local", "", "/popout/thread/thread-42")).toBe(true);
    expect(isPopoutWindowLocation("", "#/popout/thread/thread-42?env=env-local", "/")).toBe(true);
    expect(isPopoutWindowLocation("?popout=1")).toBe(true);
    expect(isPopoutWindowLocation("?foo=bar&popout=1")).toBe(true);
    expect(isPopoutWindowLocation("", "#/env-local/thread-42?popout=1")).toBe(true);
    expect(isPopoutWindowLocation("", "#/env-local/thread-42?popout=1#anchor")).toBe(true);
    expect(isPopoutWindowLocation("?popout=0", "#/env-local/thread-42", "/")).toBe(false);
    expect(isPopoutWindowLocation("", "", "/")).toBe(false);
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

  it("caches thread title metadata and persisted auth session hints for reload rehydration", () => {
    const storage = createMemoryStorage();
    expect(hasPersistedPopoutAuthSession(storage)).toBe(false);
    markPersistedPopoutAuthSession(storage);
    expect(hasPersistedPopoutAuthSession(storage)).toBe(true);

    writeCachedPopoutThreadMeta(
      sampleRef,
      { title: "Fix popout bootstrap", projectTitle: "v3-multiuser" },
      storage,
    );
    expect(readCachedPopoutThreadMeta(sampleRef, null, storage)).toMatchObject({
      title: "Fix popout bootstrap",
      projectTitle: "v3-multiuser",
      environmentId: sampleRef.environmentId,
      threadId: sampleRef.threadId,
    });
    expect(readCachedPopoutThreadMeta(null, sampleRef.threadId, storage)).toMatchObject({
      title: "Fix popout bootstrap",
      projectTitle: "v3-multiuser",
    });

    clearCachedPopoutThreadMeta(storage);
    expect(readCachedPopoutThreadMeta(sampleRef, null, storage)).toBeNull();
    clearPersistedPopoutAuthSession(storage);
    expect(hasPersistedPopoutAuthSession(storage)).toBe(false);
  });

  it("focuses an existing open popout window instead of reloading it on duplicate open", async () => {
    const storage = createMemoryStorage();
    const firstPopup = { closed: false, focus: vi.fn(), close: vi.fn() };
    const secondPopup = { closed: false, focus: vi.fn(), close: vi.fn() };
    const open = vi
      .fn()
      .mockReturnValueOnce(firstPopup as unknown as Window)
      .mockReturnValueOnce(secondPopup as unknown as Window)
      .mockReturnValueOnce(null);
    vi.stubGlobal("window", {
      location: { origin: "https://v3.local" },
      localStorage: storage,
      open,
    });

    expect(
      await openThreadInPopoutWindow(sampleRef, {
        title: "Demo thread",
        projectTitle: "Core",
      }),
    ).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      "https://v3.local/popout/thread/thread-42?env=env-local",
      "v3_thread_popout_env_local_thread_42",
      expect.stringContaining("popup=yes"),
    );
    expect(firstPopup.focus).toHaveBeenCalledTimes(1);
    expect(readCachedPopoutThreadMeta(sampleRef, null, storage)).toMatchObject({
      title: "Demo thread",
      projectTitle: "Core",
    });

    // Opening the same thread again focuses the existing window without calling window.open.
    expect(await openThreadInPopoutWindow(sampleRef, { title: "Demo thread" })).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(firstPopup.focus).toHaveBeenCalledTimes(2);

    // Once closed, a new open call creates a fresh popup window.
    firstPopup.closed = true;
    expect(await openThreadInPopoutWindow(sampleRef)).toBe(true);
    expect(open).toHaveBeenCalledTimes(2);
    expect(secondPopup.focus).toHaveBeenCalledTimes(1);

    // Popup blocker returns false cleanly.
    secondPopup.closed = true;
    expect(await openThreadInPopoutWindow(sampleRef)).toBe(false);
  });

  it("returns focus to the primary window on popout close and closes popouts on sign-out", async () => {
    const storage = createMemoryStorage();
    const listeners = new Map<string, Set<EventListener>>();
    const openerFocus = vi.fn();
    const primaryFocus = vi.fn();
    const popupWindow = { closed: false, focus: vi.fn(), close: vi.fn() };
    const open = vi.fn().mockReturnValue(popupWindow as unknown as Window);

    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    vi.stubGlobal("window", {
      location: { origin: "https://v3.local" },
      localStorage: storage,
      open,
      focus: primaryFocus,
      opener: { closed: false, focus: openerFocus },
      addEventListener: (type: string, listener: EventListener) => {
        let set = listeners.get(type);
        if (!set) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(listener);
      },
      removeEventListener: (type: string, listener: EventListener) => {
        listeners.get(type)?.delete(listener);
      },
    });

    markPersistedPopoutAuthSession(storage);
    await openThreadInPopoutWindow(sampleRef, { title: "Demo" });

    const disposePrimary = startPrimaryPopoutCoordinator();
    const onSignOut = vi.fn();
    const disposePopout = startPopoutWindowLifecycle({
      threadKey: scopedThreadKey(sampleRef),
      environmentId: sampleRef.environmentId,
      onSignOut,
    });

    // Sign-out in the main window closes tracked popouts, clears persisted session, and signals popouts.
    notifyPopoutSignOut();
    expect(popupWindow.close).toHaveBeenCalledTimes(1);
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(hasPersistedPopoutAuthSession(storage)).toBe(false);
    expect(readCachedPopoutThreadMeta(sampleRef, null, storage)).toBeNull();
    expect(storage.getItem(POPOUT_SIGNOUT_STORAGE_KEY)).not.toBeNull();

    // Closing the popout returns focus to opener and primary window.
    for (const listener of listeners.get("pagehide") ?? []) {
      listener(new Event("pagehide"));
    }
    expect(openerFocus).toHaveBeenCalledTimes(1);
    expect(primaryFocus).toHaveBeenCalledTimes(1);

    disposePopout();
    disposePrimary();
  });

  it("handles cross-tab storage sign-out events in popouts", () => {
    const storage = createMemoryStorage();
    const listeners = new Map<string, Set<EventListener>>();
    vi.stubGlobal("window", {
      location: { origin: "https://v3.local" },
      localStorage: storage,
      opener: null,
      addEventListener: (type: string, listener: EventListener) => {
        let set = listeners.get(type);
        if (!set) {
          set = new Set();
          listeners.set(type, set);
        }
        set.add(listener);
      },
      removeEventListener: (type: string, listener: EventListener) => {
        listeners.get(type)?.delete(listener);
      },
    });

    const onSignOut = vi.fn();
    const dispose = startPopoutWindowLifecycle({
      threadKey: scopedThreadKey(sampleRef),
      environmentId: sampleRef.environmentId,
      onSignOut,
    });

    // Sign-out for a different environment is ignored.
    for (const listener of listeners.get("storage") ?? []) {
      listener({
        key: POPOUT_SIGNOUT_STORAGE_KEY,
        newValue: JSON.stringify({ at: 1, environmentId: "env-other" }),
      } as StorageEvent);
    }
    expect(onSignOut).not.toHaveBeenCalled();

    // Sign-out for the popout's environment triggers onSignOut.
    for (const listener of listeners.get("storage") ?? []) {
      listener({
        key: POPOUT_SIGNOUT_STORAGE_KEY,
        newValue: JSON.stringify({ at: 2, environmentId: sampleRef.environmentId }),
      } as StorageEvent);
    }
    expect(onSignOut).toHaveBeenCalledTimes(1);

    dispose();
  });
});
