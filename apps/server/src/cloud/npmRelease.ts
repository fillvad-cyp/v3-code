// V3 Code permanently disables npm registry release lookups.
import type {
  ServerNpmRelease,
  ServerNpmReleaseError,
  ServerNpmReleaseInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class NpmRelease extends Context.Service<
  NpmRelease,
  {
    readonly get: (
      input: ServerNpmReleaseInput,
    ) => Effect.Effect<ServerNpmRelease | null, ServerNpmReleaseError>;
  }
>()("v3code/cloud/npmRelease") {}

export const make = Effect.fn("NpmRelease.make")(function* () {
  return NpmRelease.of({
    get: Effect.fn("NpmRelease.get")(function* () {
      return null;
    }),
  });
});

export const layer = Layer.effect(NpmRelease, make());
