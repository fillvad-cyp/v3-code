import { Connection } from "@t3tools/client-runtime/connection";
import { ShellSnapshotLoader } from "@t3tools/client-runtime/state/shell";
import {
  BoundedThreadSnapshotLoader,
  ThreadHistoryController,
} from "@t3tools/client-runtime/state/threads";
import { PullRequestDiffLoader } from "@t3tools/client-runtime/state/pull-requests";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom } from "effect/reactivity";

import { isGuestPage } from "../guestPage";
import { isPopoutWindowRuntime } from "../lib/threadPopout";

import * as Runtime from "../lib/runtime";
import * as BackgroundActivityReporter from "../lib/backgroundActivityReporter";
import * as ConnectionPlatform from "./platform";

const layerProvidedConnectionPlatform = ConnectionPlatform.layer.pipe(Layer.provide(Runtime.layer));

const layerSnapshotLoader = Layer.mergeAll(
  BoundedThreadSnapshotLoader.layer,
  ShellSnapshotLoader.layer,
  ThreadHistoryController.layer,
  PullRequestDiffLoader.layer,
);

type ConnectionLayerSource =
  | typeof Connection.layer
  | typeof layerSnapshotLoader
  | typeof Runtime.layer
  | typeof ConnectionPlatform.layer
  | typeof BackgroundActivityReporter.layerObserver
  | typeof BackgroundActivityReporter.layer;

function makeConnectionLayer(options: {
  readonly environmentThemes: boolean;
  readonly usageLimitSources: boolean;
  readonly usageLimitsCommand: boolean;
}) {
  const layerProvidedClientConnection = layerSnapshotLoader.pipe(
    Layer.provideMerge(Connection.layerWithOptions(options)),
    Layer.provideMerge(
      Layer.mergeAll(
        Runtime.layer,
        layerProvidedConnectionPlatform,
        BackgroundActivityReporter.layerObserver,
      ),
    ),
  );
  return BackgroundActivityReporter.layer.pipe(Layer.provideMerge(layerProvidedClientConnection));
}

const layerConnection = makeConnectionLayer({
  environmentThemes: true,
  usageLimitSources: true,
  usageLimitsCommand: true,
});

// Popouts reuse persisted connection credentials and streams without subscribing to theme or usage feeds.
const layerPopoutConnection = makeConnectionLayer({
  environmentThemes: false,
  usageLimitSources: false,
  usageLimitsCommand: false,
});

/**
 * A guest has no session here. Building the connection would open the page origin's environment
 * with whatever cookie this browser holds, plus every environment saved in it, so on the guest
 * page the runtime fails to build and every atom on it keeps its empty value.
 */
const layerForPage = Layer.unwrap(
  Effect.suspend((): Effect.Effect<typeof layerConnection> =>
    isGuestPage()
      ? Effect.die(new Error("The guest page has no environment connection."))
      : Effect.succeed(isPopoutWindowRuntime() ? layerPopoutConnection : layerConnection),
  ),
);

export const connectionAtomRuntime: Atom.AtomRuntime<
  Layer.Success<ConnectionLayerSource>,
  Layer.Error<ConnectionLayerSource>
> = Atom.runtime(layerForPage);
