import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

export type ElectronUpdaterFeedUrl = unknown;

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedError<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Automatic updates are disabled in V3 Code.";
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedError<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Automatic updates are disabled in V3 Code.";
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedError<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Automatic updates are disabled in V3 Code.";
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronUpdater") {}

/** @public */
export const make = ElectronUpdater.of({
  setFeedURL: Effect.fn("ElectronUpdater.setFeedURL")((_options) => Effect.void),
  setAutoDownload: Effect.fn("ElectronUpdater.setAutoDownload")((_value) => Effect.void),
  setAutoInstallOnAppQuit: Effect.fn("ElectronUpdater.setAutoInstallOnAppQuit")(
    (_value) => Effect.void,
  ),
  setChannel: Effect.fn("ElectronUpdater.setChannel")((_channel) => Effect.void),
  setAllowPrerelease: Effect.fn("ElectronUpdater.setAllowPrerelease")((_value) => Effect.void),
  allowDowngrade: Effect.succeed(false),
  setAllowDowngrade: Effect.fn("ElectronUpdater.setAllowDowngrade")((_value) => Effect.void),
  setFullChangelog: Effect.fn("ElectronUpdater.setFullChangelog")((_value) => Effect.void),
  setDisableDifferentialDownload: Effect.fn("ElectronUpdater.setDisableDifferentialDownload")(
    (_value) => Effect.void,
  ),
  checkForUpdates: Effect.fail(
    new ElectronUpdaterCheckForUpdatesError({
      channel: null,
      cause: "Automatic updates are disabled in V3 Code.",
    }),
  ),
  downloadUpdate: Effect.fail(
    new ElectronUpdaterDownloadUpdateError({
      channel: null,
      cause: "Automatic updates are disabled in V3 Code.",
    }),
  ),
  quitAndInstall: Effect.fn("ElectronUpdater.quitAndInstall")(({ isSilent, isForceRunAfter }) =>
    Effect.fail(
      new ElectronUpdaterQuitAndInstallError({
        channel: null,
        isSilent,
        isForceRunAfter,
        cause: "Automatic updates are disabled in V3 Code.",
      }),
    ),
  ),
  on: Effect.fn("ElectronUpdater.on")((_eventName, _listener) => Effect.void),
});

export const layer = Layer.succeed(ElectronUpdater, make);
