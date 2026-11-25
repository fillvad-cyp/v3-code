import type { ScopedThreadRef } from "@t3tools/contracts";

import { isElectron } from "../env";

const POPOUT_QUERY_KEY = "popout";
const POPOUT_QUERY_VALUE = "1";
const POPOUT_WINDOW_FEATURES = "popup=yes,width=980,height=760,resizable=yes,scrollbars=yes";

let latchedPopoutWindow: boolean | null = null;

export function buildThreadPopoutRoutePath(ref: ScopedThreadRef): string {
  return `/${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.threadId)}`;
}

export function buildThreadPopoutWebUrl(origin: string, ref: ScopedThreadRef): string {
  const cleanOrigin = origin.replace(/\/+$/, "");
  return `${cleanOrigin}${buildThreadPopoutRoutePath(ref)}?${POPOUT_QUERY_KEY}=${POPOUT_QUERY_VALUE}`;
}

export function buildThreadPopoutWindowName(ref: ScopedThreadRef): string {
  const safeKey = `${ref.environmentId}_${ref.threadId}`.replace(/[^A-Za-z0-9_]/g, "_");
  return `v3_thread_popout_${safeKey.slice(0, 96)}`;
}

export function isPopoutWindowLocation(searchStr: string, hashStr = ""): boolean {
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
  latchedPopoutWindow = isPopoutWindowLocation(window.location.search, window.location.hash);
  return latchedPopoutWindow;
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

export async function openThreadInPopoutWindow(
  ref: ScopedThreadRef,
  options?: { readonly title?: string | undefined },
): Promise<boolean> {
  const routePath = buildThreadPopoutRoutePath(ref);
  const cleanTitle = options?.title?.trim();

  if (isElectron && typeof window.desktopBridge?.openThreadPopoutWindow === "function") {
    return window.desktopBridge.openThreadPopoutWindow({
      routePath,
      ...(cleanTitle ? { title: cleanTitle } : {}),
    });
  }

  if (typeof window === "undefined") {
    return false;
  }

  const popup = window.open(
    buildThreadPopoutWebUrl(window.location.origin, ref),
    buildThreadPopoutWindowName(ref),
    POPOUT_WINDOW_FEATURES,
  );
  if (popup === null) {
    return false;
  }
  popup.focus();
  return true;
}
