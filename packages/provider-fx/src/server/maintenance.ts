import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import {
  homebrewOwnershipFromCommandPath,
  isNixStoreCommandPath,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  resolveHomebrewProviderMaintenance,
  resolveMacPortsOwner,
  resolveMiseProviderMaintenance,
  type ProviderMaintenanceCapabilitiesResolver,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { FX_DRIVER_KIND } from "./acpSupport.ts";

/** V3 Code: automatic remote CLI version checks are disabled. */
export const fetchLatestFxVersion = Effect.fn("fetchLatestFxVersion")(function* () {
  return null as string | null;
});

// fx after 0.0.13 needs Darwin 24, but its updater does not check the host version.
export const makeFxMaintenance = (
  lookupLatestVersion: Effect.Effect<string | null>,
): ProviderMaintenanceCapabilitiesResolver => ({
  resolve: Effect.fn("FxMaintenance.resolve")(function* (context) {
    const input = { provider: FX_DRIVER_KIND, packageName: null };
    const manualOnly = makeManualOnlyProviderMaintenanceCapabilities(input);
    if (
      context === null ||
      (context.platform === "darwin" && Number.parseInt(yield* HostProcess.KernelRelease, 10) < 24)
    ) {
      return manualOnly;
    }
    // fx has no mise registry tool, so a mise-owned install stays manual-only.
    if (yield* resolveMiseProviderMaintenance(input, undefined, context)) {
      return makeManualOnlyProviderMaintenanceCapabilities({
        ...input,
        installPath: context.realCommandPath,
        lookupLatestVersion,
      });
    }
    if ([context.resolvedCommandPath, context.realCommandPath].some(isNixStoreCommandPath)) {
      return makeManualOnlyProviderMaintenanceCapabilities({
        ...input,
        installPath: context.realCommandPath,
      });
    }
    const macPortsName = yield* resolveMacPortsOwner(context);
    if (macPortsName !== null) {
      return makeManualOnlyProviderMaintenanceCapabilities({
        ...input,
        installPath: context.realCommandPath,
        ...(macPortsName ? { manualCommand: `sudo port upgrade ${macPortsName}` } : {}),
      });
    }
    const homebrew = homebrewOwnershipFromCommandPath(context.realCommandPath);
    if (homebrew) {
      if (homebrew.kind !== "formula" || homebrew.name !== "fx-agent") return manualOnly;
      return (yield* resolveHomebrewProviderMaintenance(input, homebrew, context)) ?? manualOnly;
    }
    return makeProviderMaintenanceCapabilities({
      ...input,
      updateExecutable: context.resolvedCommandPath,
      updateArgs: ["upgrade"],
      updateLockKey: `fx:${context.realCommandPath}`,
      platform: context.platform,
      env: context.env,
      lookupLatestVersion,
    });
  }),
});
