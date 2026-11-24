import { assert, describe, it } from "@effect/vitest";
import { TrimmedNonEmptyString } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CloudLink from "../cloud/CloudLink.ts";
import * as ConnectReachability from "../cloud/ConnectReachability.ts";
import * as NpmRelease from "../cloud/npmRelease.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import { detectServerEnvironmentMachineKind } from "../environment/ServerEnvironmentMachine.ts";
import * as FeedbackService from "../feedback/FeedbackService.ts";
import * as FeedbackStore from "../feedback/FeedbackStore.ts";

describe("V3 Code privacy & anti-update guards", () => {
  it.effect(
    "does not fingerprint hardware or VM chassis by default, respects V3CODE override",
    () =>
      Effect.gen(function* () {
        const defaultKind = yield* detectServerEnvironmentMachineKind().pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
        );
        assert.isNull(defaultKind);

        const ignoredUpstream = yield* detectServerEnvironmentMachineKind().pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ T3CODE_ENVIRONMENT_MACHINE_KIND: "laptop" }),
            ),
          ),
        );
        assert.isNull(ignoredUpstream);

        const explicitOverride = yield* detectServerEnvironmentMachineKind().pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ V3CODE_ENVIRONMENT_MACHINE_KIND: "server" }),
            ),
          ),
        );
        assert.equal(explicitOverride, "server");
      }),
  );

  it.effect("permanently disables npm registry release lookups", () =>
    Effect.gen(function* () {
      const releases = yield* NpmRelease.NpmRelease;
      assert.isNull(yield* releases.get({ spec: "latest" }));
      assert.isNull(yield* releases.get({ spec: "nightly" }));
    }).pipe(Effect.provide(NpmRelease.layer)),
  );

  it.effect("permanently disables server self-updates and desktop update commits", () =>
    Effect.gen(function* () {
      assert.isNull(
        ServerSelfUpdate.resolveServerSelfUpdateCapability({
          desktopManaged: true,
          launcherManaged: true,
        }),
      );
      const updater = yield* ServerSelfUpdate.ServerSelfUpdate;
      const updateErr = yield* updater
        .update({ targetVersion: TrimmedNonEmptyString.make("9.9.9") })
        .pipe(Effect.flip);
      assert.equal(updateErr._tag, "ServerSelfUpdateError");

      const commitErr = yield* updater.commitDesktopUpdate("req-1").pipe(Effect.flip);
      assert.equal(commitErr._tag, "ServerSelfUpdateError");
    }).pipe(Effect.provide(ServerSelfUpdate.layer)),
  );

  it.effect("permanently disables agent feedback submission and storage", () =>
    Effect.gen(function* () {
      const service = yield* FeedbackService.FeedbackService;
      const store = yield* FeedbackStore.FeedbackStore;

      const submitErr = yield* service
        .submit(
          {
            kind: "bug",
            subject: "general",
            expected: "expected",
            actual: "actual",
            workaround: "",
            userRequested: true,
            turns: 1,
          },
          { source: "mcp" },
        )
        .pipe(Effect.flip);
      assert.equal(submitErr._tag, "FeedbackOffError");

      const storeErr = yield* store
        .store({
          id: "report-1",
          preview: {
            kind: "bug",
            subject: "general",
            expected: "expected",
            actual: "actual",
            workaround: "",
            trace: null,
          },
          source: "mcp",
          threadId: null,
          runId: null,
          dimensions: {},
        })
        .pipe(Effect.flip);
      assert.equal(storeErr._tag, "FeedbackOffError");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          FeedbackService.layer(() => []),
          FeedbackStore.layer,
        ),
      ),
    ),
  );

  it.effect("permanently disables cloud reachability probes and DoH lookups", () =>
    Effect.gen(function* () {
      const reachability = yield* ConnectReachability.ConnectReachability;
      const check = yield* reachability.check;
      assert.equal(check.status, "unreachable");
      if (check.status === "unreachable") {
        assert.equal(check.cause, "not_linked");
      }
      assert.isTrue(Option.isNone(yield* reachability.latest));
    }).pipe(Effect.provide(ConnectReachability.layer)),
  );

  it.effect("permanently disables cloud relay linking and managed tunnels", () =>
    Effect.gen(function* () {
      const cloud = yield* CloudLink.CloudLink;
      const state = yield* cloud.linkState();
      assert.isFalse(state.linked);
      assert.isNull(state.relayUrl);
      assert.isNull(state.cloudUserId);
      assert.isFalse(state.publishAgentActivity);
      assert.isFalse(state.managedTunnelActive);

      const unlinked = yield* cloud.unlink();
      assert.isTrue(unlinked.ok);

      const prefErr = yield* cloud
        .updatePreferences({ publishAgentActivity: true })
        .pipe(Effect.flip);
      assert.equal(prefErr._tag, "CloudLinkNotLinkedError");

      const tunnelReg = yield* cloud.registerManagedTunnelRecovery("http://127.0.0.1:3873");
      assert.equal(tunnelReg.status, "not_linked");
      assert.isFalse(yield* cloud.recoverManagedTunnel("http://127.0.0.1:3873"));
    }).pipe(Effect.provide(CloudLink.layer)),
  );
});
