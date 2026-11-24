// V3 Code permanently disables automatic and remote CLI updates.
import { CLI_RELEASE_CHANNELS, type CliReleaseChannel } from "@t3tools/shared/cliRelease";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/cli";

import { projectLocationFlags } from "./config.ts";

const UPDATES_DISABLED_REASON =
  "Automatic updates are permanently disabled in V3 Code. Rebuild or install from your own source.";

export class CliUpdateError extends Schema.TaggedError<CliUpdateError>()("CliUpdateError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

export const resolveNewestVersion = Effect.fn("cli.update.resolve_newest")(function* (
  _channel: CliReleaseChannel,
) {
  return yield* new CliUpdateError({ reason: UPDATES_DISABLED_REASON });
});

export const resolveMirrorVersion = Effect.fn("cli.update.resolve_mirror")(function* (
  _mirror: { readonly organization: string; readonly feedUrl: string },
  _channel: CliReleaseChannel,
) {
  return yield* new CliUpdateError({ reason: UPDATES_DISABLED_REASON });
});

export const repointLauncher = Effect.fn("cli.update.repoint_launcher")(function* (_input: {
  readonly launchedAs: string | undefined;
  readonly baseDir: string;
  readonly targetEntryPath: string;
}) {
  return Option.none<string>();
});

export const findWindowsShim = Effect.fn("cli.update.find_windows_shim")(function* (
  _executablePath: string,
  _versionsDir?: string,
) {
  return undefined as string | undefined;
});

const updateFlags = {
  ...projectLocationFlags,
  channel: Flag.Literals("channel", CLI_RELEASE_CHANNELS).pipe(
    Flag.withDescription("Automatic updates are disabled in V3 Code."),
    Flag.optional,
  ),
  allowDowngrade: Flag.Boolean("allow-downgrade").pipe(
    Flag.withDescription("Automatic updates are disabled in V3 Code."),
    Flag.withDefault(false),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription("Automatic updates are disabled in V3 Code."),
    Flag.withDefault(false),
  ),
};

const versionArgument = Argument.String("version").pipe(
  Argument.withDescription("Automatic updates are disabled in V3 Code."),
  Argument.optional,
);

export const updateCommand = Command.make("update", {
  ...updateFlags,
  version: versionArgument,
}).pipe(
  Command.withDescription("Automatic updates are permanently disabled in V3 Code."),
  Command.withHandler(() =>
    Console.error(UPDATES_DISABLED_REASON).pipe(
      Effect.andThen(Effect.fail(new CliUpdateError({ reason: UPDATES_DISABLED_REASON }))),
    ),
  ),
);

export const runUpdate = Effect.fn("cli.update.run")(function* (_input: {
  readonly baseDir: string;
  readonly logsDir: string;
  readonly databasePath: string;
  readonly serverRuntimeStatePath: string;
  readonly channel: CliReleaseChannel | undefined;
  readonly requestedVersion: string | undefined;
  readonly allowDowngrade: boolean;
  readonly assumeYes: boolean;
}) {
  return yield* new CliUpdateError({ reason: UPDATES_DISABLED_REASON });
});
