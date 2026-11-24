import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";

import * as AnalyticsService from "./AnalyticsService.ts";

it.effect("permanently disables analytics recording and makes zero outbound HTTP requests", () =>
  Effect.gen(function* () {
    let outboundRequests = 0;
    const trappingClient = HttpClient.make(() =>
      Effect.sync(() => {
        outboundRequests += 1;
      }).pipe(
        Effect.andThen(Effect.die("V3 Code AnalyticsService must never perform HTTP requests")),
      ),
    );

    const runtimeLayer = AnalyticsService.layer.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            T3CODE_TELEMETRY_ENABLED: true,
            V3CODE_TELEMETRY_ENABLED: true,
            T3CODE_POSTHOG_KEY: "phc_should_never_be_used",
            T3CODE_POSTHOG_HOST: "https://ingest.t3.codes",
          }),
        ),
      ),
      Layer.provide(Layer.succeed(HttpClient.HttpClient, trappingClient)),
    );

    yield* Effect.gen(function* () {
      const analytics = yield* AnalyticsService.AnalyticsService;
      const recorded = yield* analytics.record("server.started", { test: true });
      assert.isFalse(recorded);
      yield* analytics.recordOwners([{ source: "connect", ownerId: "a".repeat(64) }], "server");
      yield* analytics.flush;
    }).pipe(Effect.provide(runtimeLayer));

    assert.equal(outboundRequests, 0);
  }),
);
