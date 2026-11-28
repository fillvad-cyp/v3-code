import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import { AuditChainVerificationResult, PrincipalId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Command } from "effect/cli";
import * as TestConsole from "effect/testing/TestConsole";

import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import * as AuditEvents from "../persistence/AuditEvents.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);
const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(layerCliRuntime));

const decodeVerificationJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AuditChainVerificationResult),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("t3 audit CLI", (it) => {
  it.effect("exposes verify subcommand and --json flag", () =>
    Effect.gen(function* () {
      yield* runCli(["audit", "--help"]);
      const auditHelp = (yield* TestConsole.logLines).join("\n");
      expect(auditHelp).toContain("verify");

      yield* runCli(["audit", "verify", "--help"]);
      const verifyHelp = (yield* TestConsole.logLines).join("\n");
      expect(verifyHelp).toContain("--json");
    }).pipe(Effect.provide(Layer.fresh(TestConsole.layer))),
  );

  it.effect(
    "verifies intact audit hash chain and reports the first broken id after tampering",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-audit-cli-" });
        const { dbPath } = yield* ServerConfig.deriveServerPaths(baseDir, undefined, {
          baseDirIsExplicit: true,
        });

        const tamperedId = yield* Effect.gen(function* () {
          const repo = yield* AuditEvents.AuditEventRepository;
          yield* repo.append({
            at: "2026-11-26T12:00:01.000Z",
            actorPrincipalId: PrincipalId.make("owner"),
            actorSessionId: null,
            action: "login.succeeded",
            resourceType: "session",
            resourceId: "sess-1",
            projectId: null,
            ip: "127.0.0.1",
            userAgent: null,
            outcome: "allow",
            metadata: null,
          });
          const secondId = yield* repo.append({
            at: "2026-11-26T12:00:02.000Z",
            actorPrincipalId: PrincipalId.make("owner"),
            actorSessionId: null,
            action: "token.created",
            resourceType: "api_token",
            resourceId: "tok-1",
            projectId: null,
            ip: "127.0.0.1",
            userAgent: null,
            outcome: "allow",
            metadata: { note: "first" },
          });
          yield* repo.append({
            at: "2026-11-26T12:00:03.000Z",
            actorPrincipalId: PrincipalId.make("owner"),
            actorSessionId: null,
            action: "logout",
            resourceType: "session",
            resourceId: "sess-1",
            projectId: null,
            ip: "127.0.0.1",
            userAgent: null,
            outcome: "allow",
            metadata: null,
          });
          return secondId;
        }).pipe(
          Effect.provide(
            AuditEvents.layer.pipe(Layer.provide(SqlitePersistence.layerFromPath(dbPath))),
          ),
        );

        // Intact chain passes in both human and JSON modes.
        yield* runCli(["audit", "verify", "--base-dir", baseDir]);
        const okOutput = (yield* TestConsole.logLines).join("\n");
        expect(okOutput).toContain("Audit hash chain OK (3 events verified).");

        yield* runCli(["audit", "verify", "--base-dir", baseDir, "--json"]);
        const okLines = yield* TestConsole.logLines;
        const okJson = yield* decodeVerificationJson(okLines.at(-1) ?? "");
        expect(okJson).toEqual({
          valid: true,
          checked: 3,
          firstBrokenId: null,
          reason: null,
        });

        // Tamper with the second row directly in SQLite.
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE audit_events SET action = 'member.removed' WHERE id = ${tamperedId}`;
        }).pipe(Effect.provide(SqlitePersistence.layerFromPath(dbPath)));

        // Verify fails and reports the tampered row id.
        const exit = yield* runCli(["audit", "verify", "--base-dir", baseDir, "--json"]).pipe(
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const brokenLines = yield* TestConsole.logLines;
        const brokenJson = yield* decodeVerificationJson(brokenLines.at(-1) ?? "");
        expect(brokenJson).toEqual({
          valid: false,
          checked: 1,
          firstBrokenId: tamperedId,
          reason: "hash_mismatch",
        });
      }).pipe(Effect.provide(Layer.fresh(TestConsole.layer))),
  );
});
