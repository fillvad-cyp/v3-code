/** V3 Code: Expo EAS OTA updates are permanently disabled. */

export type AppUpdateCheckState =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "restarting"
  | "current";

export interface AppUpdateClient {
  readonly isEnabled: boolean;
  readonly checkForUpdateAsync: () => Promise<{
    readonly isAvailable: boolean;
    readonly isRollBackToEmbedded: boolean;
  }>;
  readonly fetchUpdateAsync: () => Promise<{
    readonly isNew: boolean;
    readonly isRollBackToEmbedded: boolean;
  }>;
  readonly reloadAsync: () => Promise<void>;
}

export interface AppUpdateEnvironment {
  readonly confirmInstallNow: () => Promise<boolean>;
  readonly flushPendingWrites: () => Promise<void>;
  readonly isSafeToRestartInBackground: () => Promise<boolean>;
  readonly onNextBackground: (apply: () => void, includeCurrent: boolean) => void;
  readonly onForegroundStay: (apply: () => void) => void;
}

export interface AppUpdateDeferral {
  pendingInstall: boolean;
  installInProgress: boolean;
}

export function createAppUpdateDeferral(): AppUpdateDeferral {
  return { pendingInstall: false, installInProgress: false };
}

export function isAppUpdateCheckAvailable(_client?: Pick<AppUpdateClient, "isEnabled">): boolean {
  return false;
}

export function registerHiddenUpdateTap(_count: number): {
  readonly nextCount: number;
  readonly shouldCheck: boolean;
} {
  return { nextCount: 0, shouldCheck: false };
}

export async function runAppUpdateCheck(_options?: Record<string, unknown>): Promise<void> {}

export function installAppUpdateChecks(
  _client?: AppUpdateClient,
  _deferral?: AppUpdateDeferral,
): () => void {
  return () => undefined;
}
