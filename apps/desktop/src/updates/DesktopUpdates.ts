import {
  DesktopUpdateChannelSchema,
  type DesktopUpdateActionResult,
  type DesktopUpdateChannel,
  type DesktopUpdateCheckResult,
  type DesktopUpdateState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

export const DESKTOP_UPDATE_INSTALL_RECORD_FILE = "desktop-update-install.json";

const UPDATES_DISABLED_MESSAGE = "Automatic updates are disabled in V3 Code.";

interface DesktopPreparedUpdateInstallResult extends DesktopUpdateActionResult {
  readonly failed: boolean;
}

export class DesktopUpdateActionInProgressError extends Schema.TaggedError<DesktopUpdateActionInProgressError>()(
  "DesktopUpdateActionInProgressError",
  {
    action: Schema.Literals(["check", "download", "install", "channel"]),
    requestedChannel: DesktopUpdateChannelSchema,
  },
) {
  override get message(): string {
    return UPDATES_DISABLED_MESSAGE;
  }
}

export class DesktopUpdateChannelPersistenceError extends Schema.TaggedError<DesktopUpdateChannelPersistenceError>()(
  "DesktopUpdateChannelPersistenceError",
  {
    channel: DesktopUpdateChannelSchema,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return UPDATES_DISABLED_MESSAGE;
  }
}

export class DesktopUpdatePollerError extends Schema.TaggedError<DesktopUpdatePollerError>()(
  "DesktopUpdatePollerError",
  {
    poller: Schema.Literals(["startup", "poll"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return UPDATES_DISABLED_MESSAGE;
  }
}

export class DesktopUpdateEventHandlingError extends Schema.TaggedError<DesktopUpdateEventHandlingError>()(
  "DesktopUpdateEventHandlingError",
  {
    event: Schema.Literals(["update-available", "download-progress", "update-downloaded"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return UPDATES_DISABLED_MESSAGE;
  }
}

export class DesktopUpdaterReportedError extends Schema.TaggedError<DesktopUpdaterReportedError>()(
  "DesktopUpdaterReportedError",
  {
    operation: Schema.Literals(["check", "download", "install", "channel", "background"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return UPDATES_DISABLED_MESSAGE;
  }
}

export class DesktopUpdateUnexpectedActionError extends Schema.TaggedError<DesktopUpdateUnexpectedActionError>()(
  "DesktopUpdateUnexpectedActionError",
  {
    action: Schema.Literals(["download", "install"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return UPDATES_DISABLED_MESSAGE;
  }
}

export class DesktopUpdateChannelManagedError extends Schema.TaggedError<DesktopUpdateChannelManagedError>()(
  "DesktopUpdateChannelManagedError",
  {
    channel: DesktopUpdateChannelSchema,
    policyMessage: Schema.String,
  },
) {
  override get message(): string {
    return UPDATES_DISABLED_MESSAGE;
  }
}

export const DesktopUpdateSetChannelError = Schema.Union([
  DesktopUpdateActionInProgressError,
  DesktopUpdateChannelPersistenceError,
  DesktopUpdateChannelManagedError,
]);
export type DesktopUpdateSetChannelError = typeof DesktopUpdateSetChannelError.Type;

export class DesktopUpdates extends Context.Service<
  DesktopUpdates,
  {
    readonly getState: Effect.Effect<DesktopUpdateState>;
    readonly isActionActive: Effect.Effect<boolean>;
    readonly isInstallActive: Effect.Effect<boolean>;
    readonly subscribe: Effect.Effect<
      {
        readonly latest: DesktopUpdateState;
        readonly changes: Stream.Stream<DesktopUpdateState>;
      },
      never,
      Scope.Scope
    >;
    readonly emitState: Effect.Effect<void>;
    readonly disabledReason: Effect.Effect<Option.Option<string>>;
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
    readonly setChannel: (
      channel: DesktopUpdateChannel,
      options?: { readonly minimumVersion?: string | undefined },
    ) => Effect.Effect<DesktopUpdateState, DesktopUpdateSetChannelError>;
    readonly check: (
      reason: string,
      options?: { readonly allowDowngrade?: boolean },
    ) => Effect.Effect<DesktopUpdateCheckResult>;
    readonly download: Effect.Effect<DesktopUpdateActionResult>;
    readonly install: Effect.Effect<DesktopUpdateActionResult>;
    readonly installPrepared: (
      expectedVersion: string,
    ) => Effect.Effect<DesktopPreparedUpdateInstallResult>;
  }
>()("@t3tools/desktop/updates/DesktopUpdates") {}

export function describeUpdateErrorCause(_cause: unknown): string {
  return UPDATES_DISABLED_MESSAGE;
}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const disabledState: DesktopUpdateState = {
    ...createInitialDesktopUpdateState(
      environment.appVersion,
      environment.runtimeInfo,
      environment.defaultDesktopSettings.updateChannel,
    ),
    enabled: false,
    status: "disabled",
    message: UPDATES_DISABLED_MESSAGE,
  };

  return DesktopUpdates.of({
    getState: Effect.succeed(disabledState),
    isActionActive: Effect.succeed(false),
    isInstallActive: Effect.succeed(false),
    subscribe: Effect.succeed({
      latest: disabledState,
      changes: Stream.empty,
    }),
    emitState: Effect.void,
    disabledReason: Effect.succeedSome(UPDATES_DISABLED_MESSAGE),
    configure: Effect.void,
    setChannel: Effect.fn("DesktopUpdates.setChannel")((_channel, _options) =>
      Effect.succeed(disabledState),
    ),
    check: Effect.fn("DesktopUpdates.check")((_reason, _options) =>
      Effect.succeed({ checked: false, state: disabledState }),
    ),
    download: Effect.succeed({ accepted: false, completed: false, state: disabledState }),
    install: Effect.succeed({ accepted: false, completed: false, state: disabledState }),
    installPrepared: Effect.fn("DesktopUpdates.installPrepared")((_expectedVersion) =>
      Effect.succeed({ accepted: false, completed: false, failed: true, state: disabledState }),
    ),
  });
});

export const layer = Layer.effect(DesktopUpdates, make);
