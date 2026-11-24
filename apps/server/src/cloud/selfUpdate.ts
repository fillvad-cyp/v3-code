// V3 Code permanently disables server self-updates.
import {
  ServerSelfUpdateError,
  type ServerSelfUpdateCapability,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateProgressEvent,
  type ServerSelfUpdateProgressStage,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

const SELF_UPDATE_DISABLED_REASON = "Automatic server updates are permanently disabled in V3 Code.";

export function resolveServerSelfUpdateCapability(_input: {
  readonly desktopManaged: boolean;
  readonly launcherManaged: boolean;
}): ServerSelfUpdateCapability | null {
  return null;
}

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    readonly update: (
      input: ServerSelfUpdateInput,
      reportProgress?: (
        stage: ServerSelfUpdateProgressStage,
      ) => Effect.Effect<void, ServerSelfUpdateError>,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
    readonly commitDesktopUpdate: (
      requestId: string,
      onHandoffAccepted?: () => Effect.Effect<void>,
    ) => Effect.Effect<never, ServerSelfUpdateError>;
  }
>()("v3code/cloud/selfUpdate/ServerSelfUpdate") {}

export const pruneRuntimesOnStart = Effect.fn("cloud.server_self_update.prune_on_start")(
  function* (_input: { readonly baseDir: string; readonly managed: boolean }) {
    return [] as Array<string>;
  },
);

export function trackSwitchBlockReason(_input: {
  readonly serverVersion: string;
  readonly targetVersion: string;
  readonly targetDatabaseMigration: number | undefined;
  readonly databaseMigration: () => number | undefined;
}): string | null {
  return SELF_UPDATE_DISABLED_REASON;
}

export const make = Effect.fn("cloud.server_self_update.make")(function* () {
  return ServerSelfUpdate.of({
    update: Effect.fn("ServerSelfUpdate.update")(function* () {
      return yield* new ServerSelfUpdateError({ reason: SELF_UPDATE_DISABLED_REASON });
    }),
    commitDesktopUpdate: Effect.fn("ServerSelfUpdate.commitDesktopUpdate")(function* () {
      return yield* new ServerSelfUpdateError({ reason: SELF_UPDATE_DISABLED_REASON });
    }),
  });
});

export const layer = Layer.effect(ServerSelfUpdate, make());

export const updateProgressStream = (
  selfUpdate: ServerSelfUpdate["Service"],
  input: ServerSelfUpdateInput,
) =>
  Stream.callback<ServerSelfUpdateProgressEvent, ServerSelfUpdateError>((queue) => {
    const offer = (event: ServerSelfUpdateProgressEvent) =>
      Queue.offer(queue, event).pipe(Effect.ignore);

    return selfUpdate
      .update(input, (stage) => offer({ type: "progress", stage }))
      .pipe(
        Effect.flatMap((result) => offer({ type: "complete", result })),
        Effect.catchTags({
          ServerSelfUpdateError: (error) => Queue.fail(queue, error).pipe(Effect.ignore),
        }),
        Effect.andThen(Queue.end(queue).pipe(Effect.ignore)),
        Effect.forkDetach,
      );
  });
