import { describe, expect, it } from "vite-plus/test";

import {
  installAppUpdateChecks,
  isAppUpdateCheckAvailable,
  registerHiddenUpdateTap,
  runAppUpdateCheck,
} from "./app-updates";

describe("app-updates (V3 Code disabled)", () => {
  it("permanently disables Expo OTA updates", async () => {
    expect(isAppUpdateCheckAvailable()).toBe(false);
    expect(registerHiddenUpdateTap(5)).toEqual({ nextCount: 0, shouldCheck: false });
    await expect(runAppUpdateCheck()).resolves.toBeUndefined();
    const dispose = installAppUpdateChecks();
    expect(() => dispose()).not.toThrow();
  });
});
