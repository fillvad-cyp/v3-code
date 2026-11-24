import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveMiseProviderMaintenance,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { parseGenericCliVersion } from "@t3tools/provider-core/server/snapshotProbe";

const DRIVER = ProviderDriverKind.make("muse");

export function parseMuseVersion(output: string): string | null {
  return output.match(/\b\d+\.\d+\.\d+-R\d+(?:\.\d+)?\b/)?.[0] ?? parseGenericCliVersion(output);
}

function comparableMuseVersion(version: string): string {
  return version.replace(/-R(\d+)(?:\.(\d+))?$/, "-release.$1.$2").replace(/\.$/, ".0");
}

const MUSE_REVISION = /-R\d+(?:\.\d+)?$/;

export const compareMuseVersions = (current: string, latest: string) =>
  MUSE_REVISION.test(current) === MUSE_REVISION.test(latest)
    ? compareSemverVersions(comparableMuseVersion(current), comparableMuseVersion(latest))
    : compareSemverVersions(current.replace(MUSE_REVISION, ""), latest.replace(MUSE_REVISION, ""));

/**
 * Mise upgrades a binary it installed. Otherwise only the official launcher owns
 * an update channel; a standalone binary cannot update itself.
 */
export const museMaintenance: ProviderMaintenanceCapabilitiesResolver = {
  resolve: Effect.fn("MuseMaintenance.resolve")(function* (context) {
    const manual = {
      ...makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER, packageName: null }),
      compareVersions: compareMuseVersions,
    };
    if (!context || context.platform === "win32") return manual;
    const mise = yield* resolveMiseProviderMaintenance(
      { provider: DRIVER, packageName: null },
      { tool: "muse" },
      context,
    );
    if (mise) return { ...mise, compareVersions: compareMuseVersions };
    const fs = yield* FileSystem.FileSystem;
    const isLauncher = yield* Effect.gen(function* () {
      const stat = yield* fs.stat(context.realCommandPath);
      if (Number(stat.size) > 128 * 1_024) return false;
      const source = yield* fs.readFileString(context.realCommandPath);
      return source.includes("muse-code/launcher-") && source.includes("MUSE_SYNC_UPDATE");
    }).pipe(Effect.orElseSucceed(() => false));
    if (!isLauncher) return manual;
    // The launcher has no `update` subcommand. Its documented launch environment
    // forces a synchronous refresh of this executable's own installation.
    const updateEnv = {
      ...(context.env.MUSE_CHANNEL ? { MUSE_CHANNEL: context.env.MUSE_CHANNEL } : {}),
      MUSE_NO_AUTO_UPDATE: "0",
      MUSE_SYNC_UPDATE: "1",
      MUSE_UPDATE_INTERVAL_SECONDS: "0",
    };
    return {
      ...makeProviderMaintenanceCapabilities({
        provider: DRIVER,
        packageName: null,
        updateExecutable: context.resolvedCommandPath,
        updateArgs: ["--version"],
        updateCommand: [
          ...Object.entries(updateEnv).map(([key, value]) => `${key}=${shellQuote(value)}`),
          shellQuote(context.resolvedCommandPath),
          "--version",
        ].join(" "),
        updateLockKey: `muse:${context.realCommandPath}`,
        platform: context.platform,
        env: { ...context.env, ...updateEnv },
      }),
      compareVersions: compareMuseVersions,
    };
  }),
};

function shellQuote(word: string) {
  return /^[\w./:@=-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** V3 Code: automatic remote Muse CLI version checks are disabled. */
export const latestMuseVersion = Effect.fn("latestMuseVersion")(function* (
  _environment: NodeJS.ProcessEnv,
  _options?: { readonly fresh?: boolean },
) {
  return null as string | null;
});

export const enrichMuseSnapshot = Effect.fn("enrichMuseSnapshot")(function* (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks: boolean;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const { snapshot } = input;
  const options = { enableProviderUpdateChecks: input.enableProviderUpdateChecks };
  // Mise names the version it would install, so its answer alone counts.
  if (input.maintenanceCapabilities.lookupLatestVersion) {
    return yield* enrichProviderSnapshotWithVersionAdvisory(
      snapshot,
      input.maintenanceCapabilities,
      options,
    );
  }
  const latestVersion =
    input.enableProviderUpdateChecks && snapshot.enabled && snapshot.installed && snapshot.version
      ? yield* latestMuseVersion(input.environment)
      : null;
  return yield* enrichProviderSnapshotWithVersionAdvisory(
    snapshot,
    { ...input.maintenanceCapabilities, latestVersion },
    options,
  );
});
