import {
  PRIVACY_PANIC_LOGOUT_PATH,
  PRIVACY_STATUS_PATH,
  type PrivacyShieldStatus,
} from "@t3tools/shared/privacyShield";
import { create } from "zustand";
import { isElectron } from "../env";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { isLocalEnvironmentDisabled } from "../localEnvironment";

export type AutoLockMinutes = 0 | 1 | 5 | 15 | 30;

export interface PrivacyPreferences {
  readonly exifScrubEnabled: boolean;
  readonly hideInAppSwitcher: boolean;
  readonly autoLockMinutes: AutoLockMinutes;
  readonly passcodeSalt: string | null;
  readonly passcodeHash: string | null;
}

export const PRIVACY_PREFERENCES_STORAGE_KEY = "v3code:privacy-preferences:v1";
const PRIVACY_LOCKED_STORAGE_KEY = "v3code:privacy-locked:v1";
const PBKDF2_ITERATIONS = 120_000;
const FAILED_BACKOFF_STEPS_MS = [0, 2_000, 4_000, 8_000, 15_000, 30_000] as const;

const VALID_AUTO_LOCK_MINUTES = new Set<number>([0, 1, 5, 15, 30]);

function isTouchDeviceDefault(): boolean {
  if (typeof window === "undefined") return false;
  if ((window.navigator.maxTouchPoints ?? 0) > 0) return true;
  if (typeof window.matchMedia === "function") {
    return window.matchMedia("(pointer: coarse)").matches;
  }
  return false;
}

export function defaultPrivacyPreferences(isTouch = isTouchDeviceDefault()): PrivacyPreferences {
  return {
    exifScrubEnabled: true,
    hideInAppSwitcher: isTouch,
    autoLockMinutes: 0,
    passcodeSalt: null,
    passcodeHash: null,
  };
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function readPrivacyPreferences(
  storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): PrivacyPreferences {
  const defaults = defaultPrivacyPreferences();
  if (!storage) return defaults;
  try {
    const raw = storage.getItem(PRIVACY_PREFERENCES_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<PrivacyPreferences>;
    const autoLock =
      typeof parsed.autoLockMinutes === "number" &&
      VALID_AUTO_LOCK_MINUTES.has(parsed.autoLockMinutes)
        ? (parsed.autoLockMinutes as AutoLockMinutes)
        : defaults.autoLockMinutes;
    return {
      exifScrubEnabled:
        typeof parsed.exifScrubEnabled === "boolean"
          ? parsed.exifScrubEnabled
          : defaults.exifScrubEnabled,
      hideInAppSwitcher:
        typeof parsed.hideInAppSwitcher === "boolean"
          ? parsed.hideInAppSwitcher
          : defaults.hideInAppSwitcher,
      autoLockMinutes: autoLock,
      passcodeSalt: typeof parsed.passcodeSalt === "string" ? parsed.passcodeSalt : null,
      passcodeHash: typeof parsed.passcodeHash === "string" ? parsed.passcodeHash : null,
    };
  } catch {
    return defaults;
  }
}

function writePrivacyPreferences(
  preferences: PrivacyPreferences,
  storage: Pick<Storage, "setItem"> | null = safeLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PRIVACY_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Private browsing or storage quota errors must not crash the UI.
  }
}

function readPersistedLockedState(preferences: PrivacyPreferences): boolean {
  try {
    if (safeSessionStorage()?.getItem(PRIVACY_LOCKED_STORAGE_KEY) === "1") return true;
    if (
      hasPrivacyPasscode(preferences) &&
      safeLocalStorage()?.getItem(PRIVACY_LOCKED_STORAGE_KEY) === "1"
    ) {
      return true;
    }
  } catch {}
  return false;
}

function writePersistedLockedState(locked: boolean, withPasscode: boolean): void {
  try {
    const ss = safeSessionStorage();
    const ls = safeLocalStorage();
    if (locked) {
      ss?.setItem(PRIVACY_LOCKED_STORAGE_KEY, "1");
      if (withPasscode) ls?.setItem(PRIVACY_LOCKED_STORAGE_KEY, "1");
    } else {
      ss?.removeItem(PRIVACY_LOCKED_STORAGE_KEY);
      ls?.removeItem(PRIVACY_LOCKED_STORAGE_KEY);
    }
  } catch {}
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomSaltHex(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytesToHex(bytes);
}

export function isStrongPasscodeCryptoAvailable(): boolean {
  return (
    typeof crypto !== "undefined" &&
    crypto.subtle !== undefined &&
    typeof crypto.subtle.importKey === "function" &&
    typeof crypto.subtle.deriveBits === "function"
  );
}

export async function hashPrivacyPasscode(passcode: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  if (isStrongPasscodeCryptoAvailable()) {
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      encoder.encode(passcode),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const derived = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: encoder.encode(`v3code:lock:v2:${salt}`),
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      keyMaterial,
      256,
    );
    return `pbkdf2:${bytesToHex(new Uint8Array(derived))}`;
  }
  // Fallback for non-secure HTTP LAN origins where Web Crypto subtle is restricted.
  const payload = encoder.encode(`v3code:lock:v1:${salt}:${passcode}`);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let round = 0; round < 2048; round += 1) {
    for (const byte of payload) {
      h1 = Math.imul(h1 ^ byte ^ round, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ byte ^ (round >>> 1), 0x85ebca6b) >>> 0;
    }
  }
  return `fallback:${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

export function isExifMetadataScrubEnabled(): boolean {
  return usePrivacyShieldStore.getState().preferences.exifScrubEnabled;
}

interface PrivacyShieldStoreState {
  readonly preferences: PrivacyPreferences;
  readonly locked: boolean;
  readonly curtainVisible: boolean;
  readonly wiped: boolean;
  readonly lastWipeServerRevoked: boolean | null;
  readonly failedUnlockAttempts: number;
  readonly lockoutUntilMs: number;
  readonly panicInProgress: boolean;
  readonly serverStatus: PrivacyShieldStatus | null;
  readonly serverStatusLoading: boolean;
}

const initialPreferences = readPrivacyPreferences();

export const usePrivacyShieldStore = create<PrivacyShieldStoreState>(() => ({
  preferences: initialPreferences,
  locked: readPersistedLockedState(initialPreferences),
  curtainVisible: false,
  wiped: false,
  lastWipeServerRevoked: null,
  failedUnlockAttempts: 0,
  lockoutUntilMs: 0,
  panicInProgress: false,
  serverStatus: null,
  serverStatusLoading: false,
}));

export function updatePrivacyPreferences(patch: Partial<PrivacyPreferences>): void {
  const current = usePrivacyShieldStore.getState().preferences;
  const next: PrivacyPreferences = { ...current, ...patch };
  writePrivacyPreferences(next);
  usePrivacyShieldStore.setState({ preferences: next });
}

export async function setPrivacyPasscode(passcode: string): Promise<boolean> {
  const trimmed = passcode.trim();
  if (trimmed.length < 4) return false;
  const salt = randomSaltHex();
  const hash = await hashPrivacyPasscode(trimmed, salt);
  updatePrivacyPreferences({ passcodeSalt: salt, passcodeHash: hash });
  return true;
}

export function clearPrivacyPasscode(): void {
  updatePrivacyPreferences({ passcodeSalt: null, passcodeHash: null });
}

export function hasPrivacyPasscode(preferences: PrivacyPreferences): boolean {
  return preferences.passcodeSalt !== null && preferences.passcodeHash !== null;
}

export function lockPrivacyScreen(): void {
  const { preferences } = usePrivacyShieldStore.getState();
  writePersistedLockedState(true, hasPrivacyPasscode(preferences));
  usePrivacyShieldStore.setState({ locked: true, curtainVisible: false });
}

export async function lockAndHideAllWindows(): Promise<void> {
  lockPrivacyScreen();
  if (isElectron && typeof window.desktopBridge?.hideAllWindows === "function") {
    await window.desktopBridge.hideAllWindows().catch(() => undefined);
  }
}

export type UnlockPrivacyResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "wiped" | "wrong-passcode" | "cooldown";
      readonly retryAfterMs?: number;
    };

export async function unlockPrivacyScreen(
  candidatePasscode?: string,
  nowMs = Date.now(),
): Promise<UnlockPrivacyResult> {
  const { preferences, wiped, failedUnlockAttempts, lockoutUntilMs } =
    usePrivacyShieldStore.getState();
  if (wiped) return { ok: false, reason: "wiped" };
  if (!hasPrivacyPasscode(preferences)) {
    writePersistedLockedState(false, false);
    usePrivacyShieldStore.setState({
      locked: false,
      curtainVisible: false,
      failedUnlockAttempts: 0,
      lockoutUntilMs: 0,
    });
    return { ok: true };
  }
  if (lockoutUntilMs > nowMs) {
    return { ok: false, reason: "cooldown", retryAfterMs: lockoutUntilMs - nowMs };
  }
  const candidate = (candidatePasscode ?? "").trim();
  if (candidate.length === 0) return { ok: false, reason: "wrong-passcode" };
  const candidateHash = await hashPrivacyPasscode(candidate, preferences.passcodeSalt!);
  if (candidateHash !== preferences.passcodeHash) {
    const nextFailures = failedUnlockAttempts + 1;
    const stepIndex = Math.min(nextFailures, FAILED_BACKOFF_STEPS_MS.length - 1);
    const delayMs = FAILED_BACKOFF_STEPS_MS[stepIndex] ?? 0;
    usePrivacyShieldStore.setState({
      failedUnlockAttempts: nextFailures,
      lockoutUntilMs: delayMs > 0 ? nowMs + delayMs : 0,
    });
    return {
      ok: false,
      reason: "wrong-passcode",
      ...(delayMs > 0 ? { retryAfterMs: delayMs } : {}),
    };
  }
  writePersistedLockedState(false, true);
  usePrivacyShieldStore.setState({
    locked: false,
    curtainVisible: false,
    failedUnlockAttempts: 0,
    lockoutUntilMs: 0,
  });
  return { ok: true };
}

function isSameOriginBrowserPrimary(): boolean {
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }
  try {
    return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin;
  } catch {
    return false;
  }
}

export async function buildPrimaryPrivacyFetchInit(init: {
  readonly method: "GET" | "POST";
  readonly headers?: Record<string, string>;
  readonly body?: string;
}): Promise<RequestInit> {
  const sameOrigin = isSameOriginBrowserPrimary();
  const bearerToken = sameOrigin ? null : await readDesktopPrimaryBearerToken().catch(() => null);
  const headers: Record<string, string> = { ...init.headers };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }
  return {
    method: init.method,
    // Packaged Desktop CORS uses wildcard origin; never send credentials: "include" off-origin.
    credentials: sameOrigin ? "include" : "omit",
    cache: "no-store",
    headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
  };
}

export async function refreshServerPrivacyStatus(): Promise<PrivacyShieldStatus | null> {
  if (isLocalEnvironmentDisabled()) {
    return null;
  }
  usePrivacyShieldStore.setState({ serverStatusLoading: true });
  try {
    const url = resolvePrimaryEnvironmentHttpUrl(PRIVACY_STATUS_PATH);
    const response = await fetch(url, await buildPrimaryPrivacyFetchInit({ method: "GET" }));
    if (!response.ok) {
      usePrivacyShieldStore.setState({ serverStatusLoading: false });
      return null;
    }
    const status = (await response.json()) as PrivacyShieldStatus;
    usePrivacyShieldStore.setState({ serverStatus: status, serverStatusLoading: false });
    return status;
  } catch {
    usePrivacyShieldStore.setState({ serverStatusLoading: false });
    return null;
  }
}

async function clearIndexedDatabases(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const dbNames = new Set<string>(["v3code:cloud-auth"]);
  try {
    if (typeof indexedDB.databases === "function") {
      const list = await indexedDB.databases();
      for (const entry of list) {
        if (entry.name) dbNames.add(entry.name);
      }
    }
  } catch {}
  await Promise.all(
    [...dbNames].map(
      (name) =>
        new Promise<void>((resolve) => {
          try {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          } catch {
            resolve();
          }
        }),
    ),
  );
}

export async function executePanicWipe(options?: {
  readonly revokeAll?: boolean;
}): Promise<{ readonly ok: boolean; readonly revokedSessions: number }> {
  // Cover screen contents immediately before any async network or storage calls.
  usePrivacyShieldStore.setState({
    locked: true,
    curtainVisible: true,
    panicInProgress: true,
  });

  let revokedSessions = 0;
  let serverOk = false;
  if (!isLocalEnvironmentDisabled()) {
    try {
      const url = resolvePrimaryEnvironmentHttpUrl(PRIVACY_PANIC_LOGOUT_PATH);
      // On Electron Desktop, keep the embedded IPC bearer token alive while revoking all
      // paired external devices so reloading the window does not brick the local backend.
      const keepCurrentSession = isElectron;
      const response = await fetch(
        url,
        await buildPrimaryPrivacyFetchInit({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-V3-Panic-Confirm": "1",
          },
          body: JSON.stringify({
            revokeAll: options?.revokeAll === true || isElectron,
            keepCurrentSession,
          }),
        }),
      );
      if (response.ok) {
        serverOk = true;
        const body = (await response.json().catch(() => null)) as {
          readonly revokedSessions?: number;
        } | null;
        if (typeof body?.revokedSessions === "number") {
          revokedSessions = body.revokedSessions;
        }
      }
    } catch {
      // Still clear all local browser artifacts even if the server is already unreachable.
    }
  }

  try {
    window.localStorage.clear();
  } catch {}
  try {
    window.sessionStorage.clear();
  } catch {}
  try {
    if (typeof window !== "undefined" && "caches" in window && window.caches) {
      const keys = await window.caches.keys();
      await Promise.all(keys.map((key) => window.caches.delete(key)));
    }
  } catch {}
  await clearIndexedDatabases();
  try {
    if (
      typeof window !== "undefined" &&
      window.history &&
      (window.location.search || window.location.hash)
    ) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  } catch {}

  usePrivacyShieldStore.setState({
    preferences: defaultPrivacyPreferences(),
    locked: true,
    curtainVisible: false,
    wiped: true,
    lastWipeServerRevoked: serverOk,
    failedUnlockAttempts: 0,
    lockoutUntilMs: 0,
    panicInProgress: false,
    serverStatus: null,
  });

  return { ok: serverOk, revokedSessions };
}

let privacyServiceStarted = false;

export function startPrivacyShieldService(): void {
  if (privacyServiceStarted || typeof window === "undefined") return;
  privacyServiceStarted = true;

  let lastActivityAt = Date.now();
  const touchActivity = () => {
    lastActivityAt = Date.now();
  };

  const handleVisibilityChange = () => {
    const state = usePrivacyShieldStore.getState();
    if (!state.preferences.hideInAppSwitcher || state.wiped) return;
    if (document.hidden) {
      usePrivacyShieldStore.setState({ curtainVisible: true });
    } else if (!state.locked) {
      usePrivacyShieldStore.setState({ curtainVisible: false });
      touchActivity();
    }
  };

  const handlePageHide = () => {
    const state = usePrivacyShieldStore.getState();
    if (state.preferences.hideInAppSwitcher) {
      usePrivacyShieldStore.setState({ curtainVisible: true });
    }
  };

  const handlePageShow = () => {
    const state = usePrivacyShieldStore.getState();
    if (!state.locked && !state.wiped && state.curtainVisible && !document.hidden) {
      usePrivacyShieldStore.setState({ curtainVisible: false });
    }
    touchActivity();
  };

  const handleFocus = () => {
    const state = usePrivacyShieldStore.getState();
    if (!state.locked && !state.wiped && state.curtainVisible && !document.hidden) {
      usePrivacyShieldStore.setState({ curtainVisible: false });
    }
    touchActivity();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    touchActivity();
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (event.key.toLowerCase() === "l" || event.code === "KeyL") {
        event.preventDefault();
        lockPrivacyScreen();
      }
    }
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pagehide", handlePageHide);
  window.addEventListener("pageshow", handlePageShow);
  window.addEventListener("focus", handleFocus);
  window.addEventListener("pointerdown", touchActivity, { passive: true });
  window.addEventListener("touchstart", touchActivity, { passive: true });
  window.addEventListener("keydown", handleKeyDown);

  window.setInterval(() => {
    const state = usePrivacyShieldStore.getState();
    if (state.locked || state.wiped || state.preferences.autoLockMinutes <= 0) return;
    const idleMs = Date.now() - lastActivityAt;
    if (idleMs >= state.preferences.autoLockMinutes * 60_000) {
      lockPrivacyScreen();
    }
  }, 15_000);
}
