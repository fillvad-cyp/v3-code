import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import { MemberLoginCodeResult, PrincipalId, ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";

import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);
const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(layerCliRuntime));

const decodeLoginCodeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(MemberLoginCodeResult),
);
const decodeServerSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));
const decodeToggleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      multiUser: Schema.Boolean,
      authMode: Schema.Literals(["single-owner", "multi-user"]),
    }),
  ),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))((it) => {
  it.effect("exposes login-code, enable, and disable subcommands and flags", () =>
    Effect.gen(function* () {
      yield* runCli(["members", "--help"]);
      const membersHelp = (yield* TestConsole.logLines).join("\n");
      expect(membersHelp).toContain("login-code");
      expect(membersHelp).toContain("enable");
      expect(membersHelp).toContain("disable");

      yield* runCli(["members", "login-code", "--help"]);
      const loginCodeHelp = (yield* TestConsole.logLines).join("\n");
      expect(loginCodeHelp).toContain("--principal");
      expect(loginCodeHelp).toContain("--json");
    }).pipe(Effect.provide(Layer.fresh(TestConsole.layer))),
  );

  it.effect(
    "t3 members enable/disable toggles settings.multiUser and prints the resulting authMode",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-members-cli-toggle-" });
        const { settingsPath } = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
          baseDirIsExplicit: true,
        });

        yield* runCli(["members", "enable", "--base-dir", baseDir]);
        const enableLines = (yield* TestConsole.logLines).join("\n");
        expect(enableLines).toContain("multi-user");
        expect(
          (yield* decodeServerSettingsJson(yield* fs.readFileString(settingsPath))).multiUser,
        ).toBe(true);

        yield* runCli(["members", "disable", "--base-dir", baseDir, "--json"]);
        const allLines = yield* TestConsole.logLines;
        const disableJson = yield* decodeToggleJson(allLines.at(-1) ?? "");
        expect(disableJson).toEqual({ multiUser: false, authMode: "single-owner" });
        expect(
          (yield* decodeServerSettingsJson(yield* fs.readFileString(settingsPath))).multiUser,
        ).toBe(false);
      }).pipe(Effect.provide(Layer.fresh(TestConsole.layer))),
  );

  it.effect("t3 members login-code mints a code for owner by default and accepts --principal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-members-cli-login-" });

      yield* runCli(["members", "login-code", "--base-dir", baseDir]);
      const humanOutput = (yield* TestConsole.logLines).join("\n");
      expect(humanOutput).toContain("Login code:");
      expect(humanOutput).toContain("Expires:");

      yield* runCli([
        "members",
        "login-code",
        "--base-dir",
        baseDir,
        "--principal",
        PrincipalId.make("owner"),
        "--json",
      ]);
      const lines = yield* TestConsole.logLines;
      const parsed = yield* decodeLoginCodeJson(lines.at(-1) ?? "");
      expect(parsed.code).toBeTruthy();
      expect(parsed.expiresAt).toBeTruthy();
    }).pipe(Effect.provide(Layer.fresh(TestConsole.layer))),
  );
});
