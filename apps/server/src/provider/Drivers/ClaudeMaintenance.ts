// V3 Code disables background Claude CLI release polling.
import { ProviderDriverKind } from "@t3tools/contracts";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
  type ProviderMaintenanceResolverServices,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";

const update = makePackageManagedProviderMaintenanceResolver({
  provider: ProviderDriverKind.make("claudeAgent"),
  npmPackageName: "@anthropic-ai/claude-code",
  mise: { tool: "claude" },
  nativeUpdate: {
    args: ["update"],
    isCommandPath: (commandPath) => {
      const normalized = normalizeCommandPath(commandPath);
      return (
        normalized.endsWith("/.local/bin/claude.exe") ||
        normalized.includes("/.local/share/claude/") ||
        normalized.includes("/claude/versions/")
      );
    },
    requiresCommandPath: true,
  },
});

export const makeClaudeMaintenanceResolution = Effect.fn("ClaudeMaintenance.make")(function* (
  options: Parameters<typeof resolveProviderMaintenanceCapabilitiesEffect>[1],
) {
  const services = yield* Effect.context<
    ProviderMaintenanceResolverServices | HttpClient.HttpClient
  >();
  return yield* makeCachedProviderMaintenanceResolution(
    resolveProviderMaintenanceCapabilitiesEffect(update, options).pipe(
      Effect.provideContext(services),
    ),
  );
});
