import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  clearPrivacyPasscode,
  defaultPrivacyPreferences,
  hashPrivacyPasscode,
  hasPrivacyPasscode,
  lockPrivacyScreen,
  PRIVACY_PREFERENCES_STORAGE_KEY,
  readPrivacyPreferences,
  setPrivacyPasscode,
  unlockPrivacyScreen,
  updatePrivacyPreferences,
  usePrivacyShieldStore,
} from "./privacyShield";

function makeMemoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("privacyShield client state", () => {
  beforeEach(() => {
    usePrivacyShieldStore.setState({
      preferences: defaultPrivacyPreferences(false),
      locked: false,
      curtainVisible: false,
      wiped: false,
      lastWipeServerRevoked: null,
      failedUnlockAttempts: 0,
      lockoutUntilMs: 0,
      panicInProgress: false,
      serverStatus: null,
      serverStatusLoading: false,
    });
  });

  it("defaults to EXIF scrubbing enabled and reads valid persisted preferences", () => {
    const storage = makeMemoryStorage();
    expect(readPrivacyPreferences(storage).exifScrubEnabled).toBe(true);

    storage.setItem(
      PRIVACY_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        exifScrubEnabled: false,
        hideInAppSwitcher: true,
        autoLockMinutes: 5,
      }),
    );
    const loaded = readPrivacyPreferences(storage);
    expect(loaded.exifScrubEnabled).toBe(false);
    expect(loaded.hideInAppSwitcher).toBe(true);
    expect(loaded.autoLockMinutes).toBe(5);

    storage.setItem(PRIVACY_PREFERENCES_STORAGE_KEY, JSON.stringify({ autoLockMinutes: 999 }));
    expect(readPrivacyPreferences(storage).autoLockMinutes).toBe(0);
  });

  it("locks and unlocks with PBKDF2-SHA256 passcode and enforces failed-attempt cooldown", async () => {
    lockPrivacyScreen();
    expect(usePrivacyShieldStore.getState().locked).toBe(true);
    expect((await unlockPrivacyScreen()).ok).toBe(true);
    expect(usePrivacyShieldStore.getState().locked).toBe(false);

    expect(await setPrivacyPasscode("123")).toBe(false);
    expect(await setPrivacyPasscode("9482")).toBe(true);
    const prefs = usePrivacyShieldStore.getState().preferences;
    expect(hasPrivacyPasscode(prefs)).toBe(true);
    expect(prefs.passcodeHash).not.toBe("9482");
    expect(prefs.passcodeHash).toBe(await hashPrivacyPasscode("9482", prefs.passcodeSalt!));

    lockPrivacyScreen();
    const t0 = 1_000_000;
    const wrong = await unlockPrivacyScreen("0000", t0);
    expect(wrong.ok).toBe(false);
    expect(usePrivacyShieldStore.getState().locked).toBe(true);

    // Immediate retry during cooldown is blocked.
    const cooled = await unlockPrivacyScreen("9482", t0 + 500);
    expect(cooled).toMatchObject({ ok: false, reason: "cooldown" });

    // After cooldown expires, correct passcode unlocks cleanly.
    const unlocked = await unlockPrivacyScreen("9482", t0 + 5_000);
    expect(unlocked).toEqual({ ok: true });
    expect(usePrivacyShieldStore.getState().locked).toBe(false);

    clearPrivacyPasscode();
    expect(hasPrivacyPasscode(usePrivacyShieldStore.getState().preferences)).toBe(false);
    updatePrivacyPreferences({ exifScrubEnabled: false });
    expect(usePrivacyShieldStore.getState().preferences.exifScrubEnabled).toBe(false);
  });
});
