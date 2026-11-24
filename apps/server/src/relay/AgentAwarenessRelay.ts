// V3 Code permanently disables outbound cloud relay agent-activity publishing.
import type { EnvironmentId, Project, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";

export class AgentAwarenessRelay extends Context.Service<
  AgentAwarenessRelay,
  {
    readonly publishThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
    readonly requestCatchUp: () => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("v3code/relay/AgentAwarenessRelay") {}

export const makeAgentAwarenessPublishWorker = Effect.fnUntraced(function* <R>(
  publish: (threadId: ThreadId) => Effect.Effect<void, never, R>,
) {
  const queued = new Set<ThreadId>();
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    Effect.sync(() => queued.delete(threadId)).pipe(Effect.andThen(publish(threadId))),
  );
  const enqueue = (threadId: ThreadId) =>
    Effect.suspend(() => {
      if (queued.has(threadId)) return Effect.void;
      queued.add(threadId);
      return worker.enqueue(threadId);
    }).pipe(Effect.uninterruptible);
  return { enqueue, drain: worker.drain };
});

export function resolveAgentAwarenessRelayActiveThreadIds(_input: {
  readonly environmentId: EnvironmentId;
  readonly startedAt: number;
  readonly projects: ReadonlyArray<Pick<Project, "id" | "title">>;
  readonly threads: ReadonlyArray<AgentAwarenessThread>;
}): ReadonlyArray<ThreadId> {
  return [];
}

/** @public */
export const make = Effect.succeed(
  AgentAwarenessRelay.of({
    publishThread: Effect.fn("AgentAwarenessRelay.publishThread")(function* () {}),
    drain: Effect.void,
    requestCatchUp: Effect.fn("AgentAwarenessRelay.requestCatchUp")(function* () {}),
    start: Effect.fn("AgentAwarenessRelay.start")(function* () {}),
  }),
);

export const layer = Layer.effect(AgentAwarenessRelay, make);
