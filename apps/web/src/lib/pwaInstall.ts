import { create } from "zustand";
import { isElectron } from "../env";
import { peekPairingTokenFromUrl } from "../environments/primary";

export type PwaInstallPlatform =
  | "desktop-app"
  | "installed"
  | "ios-safari"
  | "ios-other-browser"
  | "chromium-prompt"
  | "android-browser"
  | "desktop-browser";

export type PwaConnectionSecurity = "https" | "loopback" | "lan-http";

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: ReadonlyArray<string>;
  readonly userChoice: Promise<{
    readonly outcome: "accepted" | "dismissed";
    readonly platform: string;
  }>;
  prompt: () => Promise<void>;
}

export const PWA_INSTALL_DISMISS_STORAGE_KEY = "v3code:pwa-install-prompt:v1";
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;

interface StoredDismissal {
  readonly mode: "later" | "never";
  readonly until?: number;
}

export interface PwaEnvironmentInput {
  readonly isElectronApp: boolean;
  readonly isStandalone: boolean;
  readonly userAgent: string;
  readonly platform: string;
  readonly maxTouchPoints: number;
  readonly hasNativeInstallPrompt: boolean;
}

const IOS_DEVICE_UA = /iPhone|iPad|iPod/i;
const IOS_NON_SAFARI_UA =
  /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|Instagram|FBAN|FBAV|Telegram|WhatsApp|Line\/|MicroMessenger/i;
const ANDROID_UA = /Android/i;

function isIosUserAgent(input: {
  readonly userAgent: string;
  readonly platform: string;
  readonly maxTouchPoints: number;
}): boolean {
  if (IOS_DEVICE_UA.test(input.userAgent)) return true;
  // iPadOS Safari reports MacIntel while exposing multi-touch.
  return input.platform === "MacIntel" && input.maxTouchPoints > 1;
}

export function detectPwaInstallPlatform(input: PwaEnvironmentInput): PwaInstallPlatform {
  if (input.isElectronApp) return "desktop-app";
  if (input.isStandalone) return "installed";

  if (isIosUserAgent(input)) {
    const isSafari = /Safari/i.test(input.userAgent) && !IOS_NON_SAFARI_UA.test(input.userAgent);
    return isSafari ? "ios-safari" : "ios-other-browser";
  }

  if (input.hasNativeInstallPrompt) return "chromium-prompt";
  if (ANDROID_UA.test(input.userAgent)) return "android-browser";
  return "desktop-browser";
}

export function isMobilePwaTarget(platform: PwaInstallPlatform): boolean {
  return (
    platform === "ios-safari" || platform === "ios-other-browser" || platform === "android-browser"
  );
}

function isLoopbackOriginHost(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
}

export function assessPwaConnectionSecurity(location: {
  readonly protocol: string;
  readonly hostname: string;
}): PwaConnectionSecurity {
  if (location.protocol === "https:") return "https";
  if (isLoopbackOriginHost(location.hostname)) return "loopback";
  return "lan-http";
}

export function isStandaloneDisplayMode(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as Navigator & { standalone?: boolean };
  if (nav.standalone === true) return true;
  if (typeof window.matchMedia !== "function") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.matchMedia("(display-mode: fullscreen)").matches
  );
}

export function readPwaDismissal(
  storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
  now = Date.now(),
): "active" | "snoozed" | "never" {
  if (!storage) return "active";
  try {
    const raw = storage.getItem(PWA_INSTALL_DISMISS_STORAGE_KEY);
    if (!raw) return "active";
    const parsed = JSON.parse(raw) as Partial<StoredDismissal>;
    if (parsed.mode === "never") return "never";
    if (parsed.mode === "later" && typeof parsed.until === "number" && parsed.until > now) {
      return "snoozed";
    }
    return "active";
  } catch {
    return "active";
  }
}

export function writePwaDismissal(
  mode: "later" | "never",
  storage: Pick<Storage, "setItem"> | null = safeLocalStorage(),
  now = Date.now(),
): void {
  if (!storage) return;
  try {
    const payload: StoredDismissal =
      mode === "never" ? { mode: "never" } : { mode: "later", until: now + SNOOZE_DURATION_MS };
    storage.setItem(PWA_INSTALL_DISMISS_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Private browsing or quota errors must not break dismissal.
  }
}

export function clearPwaDismissal(
  storage: Pick<Storage, "removeItem"> | null = safeLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(PWA_INSTALL_DISMISS_STORAGE_KEY);
  } catch {
    // Ignore storage removal errors.
  }
}

const EXCLUDED_AUTO_OPEN_PATHS = new Set([
  "/guest",
  "/pair",
  "/connect",
  "/connect-agent",
  "/approve-agent",
]);

export function shouldAutoOpenPwaInstallPrompt(input: {
  readonly platform: PwaInstallPlatform;
  readonly isTouchDevice: boolean;
  readonly dismissal: "active" | "snoozed" | "never";
  readonly pathname: string;
  readonly hasPairingTokenInUrl: boolean;
}): boolean {
  if (input.dismissal !== "active") return false;
  if (input.hasPairingTokenInUrl) return false;
  if (EXCLUDED_AUTO_OPEN_PATHS.has(input.pathname)) return false;
  if (isMobilePwaTarget(input.platform)) return true;
  if (input.platform === "chromium-prompt" && input.isTouchDevice) return true;
  return false;
}

export function sanitizeInstallShareUrl(href: string): string {
  try {
    const url = new URL(href);
    // Normalize to origin root so pairing tokens, hashes, and internal thread IDs are never shared.
    return `${url.origin}/`;
  } catch {
    return href;
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function readLiveEnvironment(hasNativeInstallPrompt: boolean): PwaInstallPlatform {
  if (typeof window === "undefined") return "desktop-browser";
  return detectPwaInstallPlatform({
    isElectronApp: isElectron,
    isStandalone: isStandaloneDisplayMode(),
    userAgent: window.navigator.userAgent ?? "",
    platform: window.navigator.platform ?? "",
    maxTouchPoints: window.navigator.maxTouchPoints ?? 0,
    hasNativeInstallPrompt,
  });
}

function readLiveIsTouchDevice(): boolean {
  if (typeof window === "undefined") return false;
  if ((window.navigator.maxTouchPoints ?? 0) > 0) return true;
  if (typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

interface PwaInstallStoreState {
  readonly open: boolean;
  readonly installed: boolean;
  readonly platform: PwaInstallPlatform;
  readonly deferredPrompt: BeforeInstallPromptEvent | null;
  readonly installing: boolean;
  readonly autoPromptAttempted: boolean;
}

export const usePwaInstallStore = create<PwaInstallStoreState>(() => ({
  open: false,
  installed: isStandaloneDisplayMode(),
  platform: readLiveEnvironment(false),
  deferredPrompt: null,
  installing: false,
  autoPromptAttempted: false,
}));

export function openPwaInstallPrompt(): void {
  const state = usePwaInstallStore.getState();
  if (isElectron) return;
  usePwaInstallStore.setState({
    open: true,
    platform: readLiveEnvironment(state.deferredPrompt !== null),
  });
}

export function closePwaInstallPrompt(mode?: "later" | "never"): void {
  if (mode) {
    writePwaDismissal(mode);
  }
  usePwaInstallStore.setState({ open: false });
}

export function maybeAutoOpenPwaInstallPrompt(input: {
  readonly pathname: string;
  readonly hasPairingTokenInUrl: boolean;
}): void {
  const state = usePwaInstallStore.getState();
  if (state.autoPromptAttempted || state.open || isElectron) return;

  const platform = readLiveEnvironment(state.deferredPrompt !== null);
  const shouldOpen = shouldAutoOpenPwaInstallPrompt({
    platform,
    isTouchDevice: readLiveIsTouchDevice(),
    dismissal: readPwaDismissal(),
    pathname: input.pathname,
    hasPairingTokenInUrl: input.hasPairingTokenInUrl,
  });

  usePwaInstallStore.setState({
    platform,
    autoPromptAttempted: true,
    ...(shouldOpen ? { open: true } : {}),
  });
}

export async function triggerNativePwaInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const promptEvent = usePwaInstallStore.getState().deferredPrompt;
  if (!promptEvent) return "unavailable";

  usePwaInstallStore.setState({ installing: true });
  try {
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice.outcome === "accepted") {
      usePwaInstallStore.setState({
        open: false,
        installed: true,
        deferredPrompt: null,
        platform: "installed",
        installing: false,
      });
      return "accepted";
    }
    writePwaDismissal("later");
    usePwaInstallStore.setState({
      open: false,
      deferredPrompt: null,
      platform: readLiveEnvironment(false),
      installing: false,
    });
    return "dismissed";
  } catch {
    usePwaInstallStore.setState({
      deferredPrompt: null,
      platform: readLiveEnvironment(false),
      installing: false,
    });
    return "unavailable";
  }
}

let pwaServiceStarted = false;

export function startPwaInstallService(): void {
  if (pwaServiceStarted || typeof window === "undefined" || isElectron) return;
  pwaServiceStarted = true;

  const handleBeforeInstallPrompt = (event: Event) => {
    const installEvent = event as BeforeInstallPromptEvent;
    if (typeof installEvent.prompt !== "function") return;
    installEvent.preventDefault();
    const nextPlatform = readLiveEnvironment(true);
    const shouldOpen = shouldAutoOpenPwaInstallPrompt({
      platform: nextPlatform,
      isTouchDevice: readLiveIsTouchDevice(),
      dismissal: readPwaDismissal(),
      pathname: window.location.pathname,
      hasPairingTokenInUrl: peekPairingTokenFromUrl() !== null,
    });
    usePwaInstallStore.setState((current) => ({
      deferredPrompt: installEvent,
      platform: nextPlatform,
      open: current.open || shouldOpen,
    }));
  };

  const handleAppInstalled = () => {
    clearPwaDismissal();
    usePwaInstallStore.setState({
      open: false,
      installed: true,
      deferredPrompt: null,
      platform: "installed",
      installing: false,
    });
  };

  window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
  window.addEventListener("appinstalled", handleAppInstalled);

  // Register our zero-API-cache service worker only in secure browser contexts.
  const security = assessPwaConnectionSecurity(window.location);
  if (
    (security === "https" || security === "loopback") &&
    "serviceWorker" in window.navigator &&
    typeof window.navigator.serviceWorker.register === "function"
  ) {
    void window.navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }
}
