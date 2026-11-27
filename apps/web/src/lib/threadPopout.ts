import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { isElectron } from "../env";

const POPOUT_QUERY_KEY = "popout";
const POPOUT_QUERY_VALUE = "1";
const POPOUT_ENV_QUERY_KEY = "env";
const POPOUT_THREAD_ROUTE_PREFIX = "/popout/thread/";
const POPOUT_WINDOW_FEATURES = "popup=yes,width=980,height=760,resizable=yes,scrollbars=yes";

const POPOUT_THREAD_CACHE_STORAGE_KEY = "v3code:popout-thread-cache:v1";
const POPOUT_AUTH_SESSION_STORAGE_KEY = "v3code:popout-auth-session:v1";
export const POPOUT_SIGNOUT_STORAGE_KEY = "v3code:popout-signout-at:v1";
const POPOUT_BROADCAST_CHANNEL_NAME = "v3code:popout-sync:v1";
const POPOUT_THREAD_CACHE_LIMIT = 48;

export interface PopoutThreadCacheEntry {
  readonly title: string;
  readonly projectTitle?: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly updatedAt: number;
}

type PopoutBroadcastMessage =
  | { readonly type: "sign-out"; readonly environmentId?: EnvironmentId }
  | { readonly type: "popout-closed"; readonly key: string | null };

interface TrackedPopoutWindow {
  readonly window: Window;
  readonly environmentId: EnvironmentId;
}

let latchedPopoutWindow: boolean | null = null;
const openPopoutWindowsByKey = new Map<string, TrackedPopoutWindow>();
let sharedPostChannel: BroadcastChannel | null = null;

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function createPopoutBroadcastChannel(): BroadcastChannel | null {
  try {
    if (typeof BroadcastChannel !== "function") return null;
    return new BroadcastChannel(POPOUT_BROADCAST_CHANNEL_NAME);
  } catch {
    return null;
  }
}

function postPopoutBroadcast(message: PopoutBroadcastMessage): void {
  // Keeping one sender channel open avoids Chromium dropping messages sent right before close().
  sharedPostChannel ??= createPopoutBroadcastChannel();
  if (!sharedPostChannel) return;
  try {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel.postMessage takes only a message argument
    sharedPostChannel.postMessage(message);
  } catch {
    try {
      sharedPostChannel.close();
    } catch {
      // Ignore close errors.
    }
    sharedPostChannel = null;
  }
}

export function isPopoutRoutePathname(pathname: string): boolean {
  return pathname === "/popout" || pathname.startsWith("/popout/");
}

export function buildThreadPopoutRoutePath(ref: ScopedThreadRef): string {
  return `${POPOUT_THREAD_ROUTE_PREFIX}${encodeURIComponent(ref.threadId)}?${POPOUT_ENV_QUERY_KEY}=${encodeURIComponent(ref.environmentId)}`;
}

export function buildThreadPopoutWebUrl(origin: string, ref: ScopedThreadRef): string {
  const cleanOrigin = origin.replace(/\/+$/, "");
  return `${cleanOrigin}${buildThreadPopoutRoutePath(ref)}`;
}

export function buildThreadPopoutWindowName(ref: ScopedThreadRef): string {
  const safeKey = `${ref.environmentId}_${ref.threadId}`.replace(/[^A-Za-z0-9_]/g, "_");
  return `v3_thread_popout_${safeKey.slice(0, 96)}`;
}

function parseHashPathname(hashStr: string): string {
  if (!hashStr.startsWith("#")) return "";
  const withoutHash = hashStr.slice(1);
  const queryIndex = withoutHash.indexOf("?");
  const fragmentIndex = withoutHash.indexOf("#");
  const end =
    queryIndex === -1
      ? fragmentIndex
      : fragmentIndex === -1
        ? queryIndex
        : Math.min(queryIndex, fragmentIndex);
  return end === -1 ? withoutHash : withoutHash.slice(0, end);
}

export function isPopoutWindowLocation(searchStr: string, hashStr = "", pathname = ""): boolean {
  if (isPopoutRoutePathname(pathname) || isPopoutRoutePathname(parseHashPathname(hashStr))) {
    return true;
  }
  if (searchStr.length > 0) {
    const query = searchStr.startsWith("?") ? searchStr.slice(1) : searchStr;
    if (new URLSearchParams(query).get(POPOUT_QUERY_KEY) === POPOUT_QUERY_VALUE) {
      return true;
    }
  }
  const hashQueryIndex = hashStr.indexOf("?");
  if (hashQueryIndex !== -1) {
    const rawHashQuery = hashStr.slice(hashQueryIndex + 1);
    const fragmentIndex = rawHashQuery.indexOf("#");
    const hashQuery = fragmentIndex === -1 ? rawHashQuery : rawHashQuery.slice(0, fragmentIndex);
    if (new URLSearchParams(hashQuery).get(POPOUT_QUERY_KEY) === POPOUT_QUERY_VALUE) {
      return true;
    }
  }
  return false;
}

/** Latches whether this browser/Electron window was launched as a popped-out chat window. */
export function isPopoutWindowRuntime(): boolean {
  if (latchedPopoutWindow !== null) {
    return latchedPopoutWindow;
  }
  if (typeof window === "undefined") {
    return false;
  }
  latchedPopoutWindow = isPopoutWindowLocation(
    window.location.search,
    window.location.hash,
    window.location.pathname,
  );
  return latchedPopoutWindow;
}

export function __resetPopoutWindowRuntimeForTests(): void {
  latchedPopoutWindow = null;
  openPopoutWindowsByKey.clear();
  if (sharedPostChannel !== null) {
    try {
      sharedPostChannel.close();
    } catch {
      // Ignore close errors.
    }
    sharedPostChannel = null;
  }
}

export function shouldPopoutOnThreadClick(input: {
  readonly isMac: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly hasSelection: boolean;
}): boolean {
  const isModClick = input.isMac
    ? input.metaKey && !input.ctrlKey
    : input.ctrlKey && !input.metaKey;
  return isModClick && !input.shiftKey && !input.altKey && !input.hasSelection;
}

function readPopoutThreadCacheRecord(
  storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): Record<string, PopoutThreadCacheEntry> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(POPOUT_THREAD_CACHE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, PopoutThreadCacheEntry> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (
        typeof entry.title !== "string" ||
        typeof entry.environmentId !== "string" ||
        typeof entry.threadId !== "string" ||
        typeof entry.updatedAt !== "number"
      ) {
        continue;
      }
      result[key] = {
        title: entry.title,
        ...(typeof entry.projectTitle === "string" && entry.projectTitle.length > 0
          ? { projectTitle: entry.projectTitle }
          : {}),
        environmentId: entry.environmentId as EnvironmentId,
        threadId: entry.threadId as ThreadId,
        updatedAt: entry.updatedAt,
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function writeCachedPopoutThreadMeta(
  ref: ScopedThreadRef,
  meta: {
    readonly title: string;
    readonly projectTitle?: string | undefined;
  },
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeLocalStorage(),
): void {
  const cleanTitle = meta.title.trim();
  if (!storage || cleanTitle.length === 0) return;
  const cleanProjectTitle = meta.projectTitle?.trim();
  try {
    const current = readPopoutThreadCacheRecord(storage);
    const key = scopedThreadKey(ref);
    current[key] = {
      title: cleanTitle,
      ...(cleanProjectTitle ? { projectTitle: cleanProjectTitle } : {}),
      environmentId: ref.environmentId,
      threadId: ref.threadId,
      updatedAt: Date.now(),
    };
    const entries = Object.entries(current);
    const trimmed =
      entries.length > POPOUT_THREAD_CACHE_LIMIT
        ? Object.fromEntries(
            entries
              .toSorted(([, a], [, b]) => b.updatedAt - a.updatedAt)
              .slice(0, POPOUT_THREAD_CACHE_LIMIT),
          )
        : current;
    storage.setItem(POPOUT_THREAD_CACHE_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Private browsing or storage quota errors must not interrupt opening a popout.
  }
}

export function readCachedPopoutThreadMeta(
  ref: ScopedThreadRef | null,
  fallbackThreadId: ThreadId | null = null,
  storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): PopoutThreadCacheEntry | null {
  const record = readPopoutThreadCacheRecord(storage);
  if (ref !== null) {
    const exact = record[scopedThreadKey(ref)];
    if (exact) return exact;
  }
  const targetThreadId = ref?.threadId ?? fallbackThreadId;
  if (targetThreadId === null) return null;
  let newest: PopoutThreadCacheEntry | null = null;
  for (const entry of Object.values(record)) {
    if (entry.threadId !== targetThreadId) continue;
    if (newest === null || entry.updatedAt > newest.updatedAt) {
      newest = entry;
    }
  }
  return newest;
}

export function clearCachedPopoutThreadMeta(
  storage: Pick<Storage, "removeItem"> | null = safeLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(POPOUT_THREAD_CACHE_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

export function markPersistedPopoutAuthSession(
  storage: Pick<Storage, "setItem"> | null = safeLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      POPOUT_AUTH_SESSION_STORAGE_KEY,
      JSON.stringify({ authenticatedAt: Date.now() }),
    );
  } catch {
    // Ignore storage errors.
  }
}

export function clearPersistedPopoutAuthSession(
  storage: Pick<Storage, "removeItem"> | null = safeLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(POPOUT_AUTH_SESSION_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

export function hasPersistedPopoutAuthSession(
  storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(POPOUT_AUTH_SESSION_STORAGE_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { authenticatedAt?: unknown }).authenticatedAt === "number" &&
      Number.isFinite((parsed as { authenticatedAt: number }).authenticatedAt)
    );
  } catch {
    return false;
  }
}

export async function openThreadInPopoutWindow(
  ref: ScopedThreadRef,
  options?: {
    readonly title?: string | undefined;
    readonly projectTitle?: string | undefined;
  },
): Promise<boolean> {
  const routePath = buildThreadPopoutRoutePath(ref);
  const cleanTitle = options?.title?.trim();
  if (cleanTitle) {
    writeCachedPopoutThreadMeta(ref, {
      title: cleanTitle,
      projectTitle: options?.projectTitle,
    });
  }

  if (isElectron && typeof window.desktopBridge?.openThreadPopoutWindow === "function") {
    return window.desktopBridge.openThreadPopoutWindow({
      routePath,
      ...(cleanTitle ? { title: cleanTitle } : {}),
    });
  }

  if (typeof window === "undefined") {
    return false;
  }

  const key = scopedThreadKey(ref);
  const existing = openPopoutWindowsByKey.get(key);
  if (existing !== undefined) {
    if (!existing.window.closed) {
      existing.window.focus();
      return true;
    }
    openPopoutWindowsByKey.delete(key);
  }

  const popup = window.open(
    buildThreadPopoutWebUrl(window.location.origin, ref),
    buildThreadPopoutWindowName(ref),
    POPOUT_WINDOW_FEATURES,
  );
  if (popup === null) {
    return false;
  }
  openPopoutWindowsByKey.set(key, {
    window: popup,
    environmentId: ref.environmentId,
  });
  popup.focus();
  return true;
}

export function notifyPopoutSignOut(options?: { readonly environmentId?: EnvironmentId }): void {
  const targetEnvironmentId = options?.environmentId;
  if (targetEnvironmentId === undefined) {
    clearPersistedPopoutAuthSession();
    clearCachedPopoutThreadMeta();
  }

  for (const [key, tracked] of openPopoutWindowsByKey.entries()) {
    if (targetEnvironmentId !== undefined && tracked.environmentId !== targetEnvironmentId) {
      continue;
    }
    openPopoutWindowsByKey.delete(key);
    try {
      if (!tracked.window.closed) {
        tracked.window.close();
      }
    } catch {
      // Ignore cross-window close errors.
    }
  }

  postPopoutBroadcast({
    type: "sign-out",
    ...(targetEnvironmentId !== undefined ? { environmentId: targetEnvironmentId } : {}),
  });

  const storage = safeLocalStorage();
  if (storage) {
    try {
      storage.setItem(
        POPOUT_SIGNOUT_STORAGE_KEY,
        JSON.stringify({
          at: Date.now(),
          ...(targetEnvironmentId !== undefined ? { environmentId: targetEnvironmentId } : {}),
        }),
      );
    } catch {
      // Ignore storage errors.
    }
  }
}

/** Keeps the primary window's popout registry clean and re-focuses it when a popout closes. */
export function startPrimaryPopoutCoordinator(): () => void {
  const channel = createPopoutBroadcastChannel();
  if (!channel) return () => {};

  const onMessage = (event: MessageEvent<unknown>) => {
    const data = event.data as PopoutBroadcastMessage | null;
    if (!data || data.type !== "popout-closed") return;
    if (data.key) {
      const tracked = openPopoutWindowsByKey.get(data.key);
      if (tracked && tracked.window.closed) {
        openPopoutWindowsByKey.delete(data.key);
      }
    }
    try {
      window.focus();
    } catch {
      // Ignore browser focus restrictions.
    }
  };
  channel.addEventListener("message", onMessage);

  return () => {
    channel.removeEventListener("message", onMessage);
    channel.close();
  };
}

function parseSignOutStorageEventValue(
  raw: string | null,
): { readonly environmentId?: EnvironmentId } | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const environmentId = (parsed as { environmentId?: unknown }).environmentId;
    return typeof environmentId === "string"
      ? { environmentId: environmentId as EnvironmentId }
      : {};
  } catch {
    return {};
  }
}

/**
 * Coordinates reverse states inside a popout window:
 * - returning focus to the primary window on close,
 * - closing or re-authenticating the popout when the main window signs out.
 */
export function startPopoutWindowLifecycle(options: {
  readonly threadKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly onSignOut: () => void;
}): () => void {
  if (typeof window === "undefined") return () => {};

  let notifiedClose = false;
  const notifyClosing = () => {
    if (notifiedClose) return;
    notifiedClose = true;
    postPopoutBroadcast({ type: "popout-closed", key: options.threadKey });
    try {
      const opener = window.opener as Window | null;
      if (opener && !opener.closed) {
        opener.focus();
      }
    } catch {
      // Ignore cross-origin opener access or focus restrictions.
    }
  };

  let handledSignOut = false;
  const handleSignOut = (targetEnvironmentId?: EnvironmentId) => {
    if (handledSignOut) return;
    if (
      targetEnvironmentId !== undefined &&
      options.environmentId !== null &&
      targetEnvironmentId !== options.environmentId
    ) {
      return;
    }
    handledSignOut = true;
    options.onSignOut();
  };

  const channel = createPopoutBroadcastChannel();
  const onBroadcastMessage = (event: MessageEvent<unknown>) => {
    const data = event.data as PopoutBroadcastMessage | null;
    if (!data || data.type !== "sign-out") return;
    handleSignOut(data.environmentId);
  };
  channel?.addEventListener("message", onBroadcastMessage);

  const onStorage = (event: StorageEvent) => {
    if (event.key !== POPOUT_SIGNOUT_STORAGE_KEY || event.newValue === null) return;
    const payload = parseSignOutStorageEventValue(event.newValue);
    if (payload === null) return;
    handleSignOut(payload.environmentId);
  };

  window.addEventListener("pagehide", notifyClosing);
  window.addEventListener("beforeunload", notifyClosing);
  window.addEventListener("storage", onStorage);

  return () => {
    window.removeEventListener("pagehide", notifyClosing);
    window.removeEventListener("beforeunload", notifyClosing);
    window.removeEventListener("storage", onStorage);
    if (channel) {
      channel.removeEventListener("message", onBroadcastMessage);
      channel.close();
    }
  };
}
