import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import { resolveServerEnvironmentLabel } from "./ServerEnvironmentLabel.ts";

it.effect("defaults to anonymous 'V3 Code' without probing hostname or WSL metadata", () =>
  Effect.gen(function* () {
    const label = yield* resolveServerEnvironmentLabel({ cwdBaseName: "secret-project" }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    );
    assert.equal(label, "V3 Code");
  }),
);

it.effect("respects an explicit V3CODE_ENVIRONMENT_LABEL override", () =>
  Effect.gen(function* () {
    const label = yield* resolveServerEnvironmentLabel({ cwdBaseName: "project" }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            V3CODE_ENVIRONMENT_LABEL: "  My Private Lab  ",
          }),
        ),
      ),
    );
    assert.equal(label, "My Private Lab");
  }),
);

it.effect("ignores blank V3CODE_ENVIRONMENT_LABEL and upstream T3CODE_ENVIRONMENT_LABEL", () =>
  Effect.gen(function* () {
    const label = yield* resolveServerEnvironmentLabel({ cwdBaseName: "project" }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            V3CODE_ENVIRONMENT_LABEL: "   ",
            T3CODE_ENVIRONMENT_LABEL: "Upstream Host",
          }),
        ),
      ),
    );
    assert.equal(label, "V3 Code");
  }),
);
