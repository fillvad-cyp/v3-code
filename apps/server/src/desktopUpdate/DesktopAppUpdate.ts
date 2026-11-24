// V3 Code permanently disables desktop app update orchestration.
import {
  ServerSelfUpdateError,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

const DESKTOP_UPDATES_DISABLED = "Automatic desktop updates are permanently disabled in V3 Code.";

export class DesktopAppUpdate extends Context.Service<
  DesktopAppUpdate,
  {
    readonly available: boolean;
    readonly run: (
      reportProgress: (
        stage: ServerSelfUpdateProgressStage,
      ) => Effect.Effect<void, ServerSelfUpdateError>,
      trackSwitch?: DesktopTelemetryReceiver.DesktopTrackSwitch,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
    readonly commit: (
      requestId: string,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<never, ServerSelfUpdateError>;
  }
>()("v3code/desktopUpdate/DesktopAppUpdate") {}

export const make = Effect.fn("desktopUpdate.desktopAppUpdate.make")(function* () {
  return DesktopAppUpdate.of({
    available: false,
    run: Effect.fn("DesktopAppUpdate.run")(function* () {
      return yield* new ServerSelfUpdateError({ reason: DESKTOP_UPDATES_DISABLED });
    }),
    commit: Effect.fn("DesktopAppUpdate.commit")(function* () {
      return yield* new ServerSelfUpdateError({ reason: DESKTOP_UPDATES_DISABLED });
    }),
  });
});

export const layer = Layer.effect(DesktopAppUpdate, make());
