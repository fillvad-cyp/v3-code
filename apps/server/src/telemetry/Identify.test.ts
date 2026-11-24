import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as Identify from "./Identify.ts";

const writeHomeFile = Effect.fn("test.writeHomeFile")(function* (
  homeDirectory: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(homeDirectory, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
  return filePath;
});

it.layer(NodeServices.layer)("telemetry identity (V3 Code zero-harvesting)", (it) => {
  it.effect("never reads ~/.codex/auth.json or ~/.claude.json and never writes anonymous-id", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = path.join(config.baseDir, "home");

      yield* writeHomeFile(
        homeDirectory,
        ".claude.json",
        JSON.stringify({
          userID: "claude-machine",
          oauthAccount: { accountUuid: "claude-person" },
        }),
      );
      yield* writeHomeFile(
        homeDirectory,
        ".codex/auth.json",
        JSON.stringify({
          tokens: {
            account_id: "ws-1",
            id_token: "e30.e30.sig",
          },
        }),
      );

      assert.deepEqual(yield* Identify.getTelemetryIdentityForHome(homeDirectory), {
        distinctId: null,
        installId: null,
      });
      assert.deepEqual(yield* Identify.getTelemetryIdentity, {
        distinctId: null,
        installId: null,
      });
      assert.deepEqual(yield* Identify.getServerOwnersForHome(homeDirectory), []);
      assert.deepEqual(yield* Identify.getServerOwners, []);
      assert.isFalse(yield* fileSystem.exists(config.anonymousIdPath));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "v3-telemetry-identify-disabled-" }),
      ),
    ),
  );
});
