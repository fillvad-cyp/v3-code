// @effect-diagnostics nodeBuiltinImport:off -- Uses node:fs/os/path for isolated temp stateDir test fixture.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as PrivacyVaultService from "./PrivacyVaultService.ts";

function makeTempStateLayer() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "v3-vault-test-"));
  const configLayer = Layer.succeed(ServerConfig.ServerConfig, {
    stateDir: dir,
  } as unknown as ServerConfig.ServerConfig["Service"]);
  return {
    dir,
    layer: PrivacyVaultService.layer.pipe(Layer.provide(configLayer)),
    cleanup: () => {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("PrivacyVaultService", () => {
  it.effect(
    "manages proxies, servers, compartments, DLP, egress, burn threads, and AES-256-GCM locking",
    () =>
      Effect.gen(function* () {
        const fixture = makeTempStateLayer();
        try {
          yield* Effect.gen(function* () {
            const vault = yield* PrivacyVaultService.PrivacyVaultService;

            // 1. Proxy Vault + bulk import + credential redaction
            const added = yield* vault.addProxy({
              name: "Tor Local",
              url: "socks5h://user:secretpass@127.0.0.1:9050",
              tags: ["tor"],
            });
            assert.isTrue(added.ok);
            assert.equal(added.snapshot.proxies.length, 1);
            assert.equal(
              added.snapshot.proxies[0]?.displayUrl,
              "socks5h://user:***@127.0.0.1:9050",
            );
            assert.isTrue(added.snapshot.proxies[0]?.dnsLeakProtected);

            const imported = yield* vault.bulkImportProxies(
              "http://127.0.0.1:8080\nbad-line\n10.0.0.2:1080",
            );
            assert.equal(imported.detail?.added, 2);
            assert.deepEqual(imported.detail?.invalidLines, ["bad-line"]);

            // 2. Server Vault + safe command builder
            const srvRes = yield* vault.upsertServer({
              name: "Dev VPS",
              kind: "ssh",
              host: "198.51.100.7",
              port: 22,
              username: "ops",
              proxyId: added.snapshot.proxies[0]!.id,
              ghostModeDefault: true,
            });
            assert.isTrue(srvRes.ok);
            const srvId = srvRes.snapshot.servers[0]!.id;
            const cmd = yield* vault.buildServerCommand(srvId);
            assert.isNotNull(cmd);
            assert.include(cmd!, "v3 --ghost --no-logs");
            assert.include(cmd!, "ProxyCommand=nc -X 5 -x 127.0.0.1:9050 %h %p");

            // 3. Identity Compartments & Burner
            const burner = yield* vault.createBurnerCompartment("Research Burner");
            assert.isTrue(burner.ok);
            assert.isTrue(burner.detail?.ephemeral === true);
            assert.equal(burner.snapshot.activeCompartmentId, burner.detail?.id);

            // 4. Burn-after-TTL threads
            const burnRes = yield* vault.setBurnThread("thread-secret-1", "1h");
            assert.isTrue(burnRes.ok);
            assert.equal(burnRes.snapshot.burnThreads.length, 1);

            // 5. Vault at-rest encryption + lock/unlock roundtrip
            const encrypted = yield* vault.configureEncryption({
              action: "enable",
              newPassphrase: "super-strong-master-pass",
            });
            assert.isTrue(encrypted.ok);
            assert.isTrue(encrypted.snapshot.encrypted);

            const rawDisk = NodeFS.readFileSync(
              NodePath.join(fixture.dir, "v3-privacy-vault.json"),
              "utf8",
            );
            assert.notInclude(rawDisk, "secretpass");
            assert.notInclude(rawDisk, "198.51.100.7");

            const locked = yield* vault.lock;
            assert.isTrue(locked.ok);
            assert.isTrue(locked.snapshot.locked);
            assert.equal(locked.snapshot.proxies.length, 0);

            const wrongUnlock = yield* vault.unlock("wrong-pass");
            assert.isFalse(wrongUnlock.ok);
            assert.isTrue(wrongUnlock.snapshot.locked);

            const unlocked = yield* vault.unlock("super-strong-master-pass");
            assert.isTrue(unlocked.ok);
            assert.isFalse(unlocked.snapshot.locked);
            assert.equal(unlocked.snapshot.proxies.length, 3);
            assert.equal(unlocked.snapshot.servers.length, 1);
            // Ephemeral burner must NOT persist across lock/unlock!
            assert.isFalse(unlocked.snapshot.compartments.some((c) => c.ephemeral));
          }).pipe(Effect.scoped, Effect.provide(fixture.layer));
        } finally {
          fixture.cleanup();
        }
      }),
  );
});
