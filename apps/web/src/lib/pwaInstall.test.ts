import { describe, expect, it } from "vite-plus/test";

import {
  assessPwaConnectionSecurity,
  clearPwaDismissal,
  detectPwaInstallPlatform,
  PWA_INSTALL_DISMISS_STORAGE_KEY,
  readPwaDismissal,
  sanitizeInstallShareUrl,
  shouldAutoOpenPwaInstallPrompt,
  writePwaDismissal,
} from "./pwaInstall";

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("detectPwaInstallPlatform", () => {
  it("detects iPhone Safari", () => {
    expect(
      detectPwaInstallPlatform({
        isElectronApp: false,
        isStandalone: false,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1",
        platform: "iPhone",
        maxTouchPoints: 5,
        hasNativeInstallPrompt: false,
      }),
    ).toBe("ios-safari");
  });

  it("detects iPadOS desktop-mode Safari", () => {
    expect(
      detectPwaInstallPlatform({
        isElectronApp: false,
        isStandalone: false,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 5,
        hasNativeInstallPrompt: false,
      }),
    ).toBe("ios-safari");
  });

  it("distinguishes iOS Chrome and in-app browsers from iOS Safari", () => {
    expect(
      detectPwaInstallPlatform({
        isElectronApp: false,
        isStandalone: false,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/136.0.0.0 Mobile/15E148 Safari/604.1",
        platform: "iPhone",
        maxTouchPoints: 5,
        hasNativeInstallPrompt: false,
      }),
    ).toBe("ios-other-browser");
  });

  it("never prompts inside Electron or an already installed standalone PWA", () => {
    expect(
      detectPwaInstallPlatform({
        isElectronApp: true,
        isStandalone: false,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) Safari/604.1",
        platform: "iPhone",
        maxTouchPoints: 5,
        hasNativeInstallPrompt: true,
      }),
    ).toBe("desktop-app");

    expect(
      detectPwaInstallPlatform({
        isElectronApp: false,
        isStandalone: true,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) Safari/604.1",
        platform: "iPhone",
        maxTouchPoints: 5,
        hasNativeInstallPrompt: false,
      }),
    ).toBe("installed");
  });

  it("detects Chromium native install prompt and Android browser fallback", () => {
    expect(
      detectPwaInstallPlatform({
        isElectronApp: false,
        isStandalone: false,
        userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/136.0.0.0 Mobile Safari/537.36",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
        hasNativeInstallPrompt: true,
      }),
    ).toBe("chromium-prompt");

    expect(
      detectPwaInstallPlatform({
        isElectronApp: false,
        isStandalone: false,
        userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) Firefox/138.0",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
        hasNativeInstallPrompt: false,
      }),
    ).toBe("android-browser");
  });
});

describe("assessPwaConnectionSecurity", () => {
  it("classifies HTTPS, loopback, and plain LAN HTTP accurately", () => {
    expect(
      assessPwaConnectionSecurity({ protocol: "https:", hostname: "mac.tailnet.ts.net" }),
    ).toBe("https");
    expect(assessPwaConnectionSecurity({ protocol: "http:", hostname: "127.0.0.1" })).toBe(
      "loopback",
    );
    expect(assessPwaConnectionSecurity({ protocol: "http:", hostname: "localhost" })).toBe(
      "loopback",
    );
    expect(assessPwaConnectionSecurity({ protocol: "http:", hostname: "192.168.1.42" })).toBe(
      "lan-http",
    );
  });
});

describe("dismissal storage and auto-open rules", () => {
  it("respects 24h snooze, permanent dismissal, and clear", () => {
    const storage = makeMemoryStorage();
    expect(readPwaDismissal(storage, 1000)).toBe("active");

    writePwaDismissal("later", storage, 1000);
    expect(storage.getItem(PWA_INSTALL_DISMISS_STORAGE_KEY)).toBeTruthy();
    expect(readPwaDismissal(storage, 1000 + 60_000)).toBe("snoozed");
    expect(readPwaDismissal(storage, 1000 + 25 * 60 * 60 * 1000)).toBe("active");

    writePwaDismissal("never", storage, 1000);
    expect(readPwaDismissal(storage, 1000 + 999 * 60 * 60 * 1000)).toBe("never");

    clearPwaDismissal(storage);
    expect(readPwaDismissal(storage, 1000)).toBe("active");
  });

  it("auto-opens on iPhone Safari, skips guest links, in-flight pairing tokens, and desktop browsers", () => {
    expect(
      shouldAutoOpenPwaInstallPrompt({
        platform: "ios-safari",
        isTouchDevice: true,
        dismissal: "active",
        pathname: "/",
        hasPairingTokenInUrl: false,
      }),
    ).toBe(true);

    expect(
      shouldAutoOpenPwaInstallPrompt({
        platform: "ios-safari",
        isTouchDevice: true,
        dismissal: "active",
        pathname: "/pair",
        hasPairingTokenInUrl: false,
      }),
    ).toBe(false);

    expect(
      shouldAutoOpenPwaInstallPrompt({
        platform: "ios-safari",
        isTouchDevice: true,
        dismissal: "active",
        pathname: "/connect",
        hasPairingTokenInUrl: false,
      }),
    ).toBe(false);

    expect(
      shouldAutoOpenPwaInstallPrompt({
        platform: "ios-safari",
        isTouchDevice: true,
        dismissal: "active",
        pathname: "/guest",
        hasPairingTokenInUrl: false,
      }),
    ).toBe(false);

    expect(
      shouldAutoOpenPwaInstallPrompt({
        platform: "desktop-browser",
        isTouchDevice: false,
        dismissal: "active",
        pathname: "/",
        hasPairingTokenInUrl: false,
      }),
    ).toBe(false);
  });

  it("strips query tokens, hashes, and internal paths before sharing or copying the Home Screen URL", () => {
    expect(
      sanitizeInstallShareUrl("https://mac.tailnet.ts.net:3873/env/thread-1?token=secret-123#frag"),
    ).toBe("https://mac.tailnet.ts.net:3873/");
  });
});
