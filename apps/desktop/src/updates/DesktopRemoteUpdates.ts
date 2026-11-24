import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopTelemetryPublisher from "../telemetry/DesktopTelemetryPublisher.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

const DISABLED_REASON = "Automatic updates are disabled in V3 Code.";

export const listen: Effect.Effect<
  void,
  never,
  | DesktopUpdates.DesktopUpdates
  | DesktopTelemetryPublisher.DesktopTelemetryPublisher
  | DesktopBackendPool.DesktopBackendPool
  | Scope.Scope
> = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const publisher = yield* DesktopTelemetryPublisher.DesktopTelemetryPublisher;
  const state = yield* updates.getState;

  yield* publisher.publishUpdateReport({
    version: 1,
    type: "desktopUpdateStatus",
    state,
  });

  yield* Stream.runForEach(publisher.updateRequests, (request) =>
    publisher.publishUpdateReport({
      version: 1,
      type: "desktopUpdateStatus",
      requestId: request.requestId,
      outcome: "failed",
      reason: DISABLED_REASON,
      state,
    }),
  ).pipe(Effect.forkScoped);

  yield* Stream.runForEach(publisher.updateCommits, (commit) =>
    publisher.publishUpdateReport({
      version: 1,
      type: "desktopUpdateStatus",
      requestId: commit.requestId,
      outcome: "failed",
      reason: DISABLED_REASON,
      state,
    }),
  ).pipe(Effect.forkScoped);
});
