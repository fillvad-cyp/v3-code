import { describe, expect, it } from "vite-plus/test";

import {
  buildCompartmentProcessEnv,
  buildRemoteV3LaunchCommand,
  createBurnThreadPolicy,
  createDefaultCompartment,
  DEFAULT_DLP_CONFIG,
  DEFAULT_EGRESS_POLICY,
  evaluateEgressHost,
  isBurnThreadExpired,
  isDnsLeakProtectedProxyUrl,
  parseProxyBulkInput,
  redactProxyUrl,
  resolveCompartmentForProject,
  scanAndRedactPrompt,
  type ServerVaultEntry,
} from "./privacyVault.ts";

describe("privacyVault", () => {
  it("parses bulk proxies, detects remote-DNS safety, and redacts credentials", () => {
    const parsed = parseProxyBulkInput(`
      # comment line
      socks5h://alice:s3cr3t@127.0.0.1:9050
      10.0.0.5:1080:bob:p@ss
      http://proxy.internal:8080
      not a proxy
    `);
    expect(parsed.valid).toHaveLength(3);
    expect(parsed.invalidLines).toEqual(["not a proxy"]);
    expect(parsed.valid[0]?.url).toBe("socks5h://alice:s3cr3t@127.0.0.1:9050");
    expect(parsed.valid[1]?.url).toBe("socks5h://bob:p%40ss@10.0.0.5:1080");

    expect(isDnsLeakProtectedProxyUrl("socks5h://127.0.0.1:9050")).toBe(true);
    expect(isDnsLeakProtectedProxyUrl("socks5://127.0.0.1:1080")).toBe(false);
    expect(redactProxyUrl("socks5h://alice:s3cr3t@127.0.0.1:9050")).toEqual({
      displayUrl: "socks5h://alice:***@127.0.0.1:9050",
      hasCredentials: true,
    });
  });

  it("builds safe SSH remote v3 --ghost commands with jump host and socks5 proxy", () => {
    const server: ServerVaultEntry = {
      id: "srv-1",
      name: "VPS EU",
      kind: "ssh",
      host: "198.51.100.10",
      port: 2222,
      username: "ops",
      identityFile: "~/.ssh/id_ed25519_work",
      proxyJump: "bastion.internal",
      proxyId: "px-1",
      defaultWorkdir: "/srv/app",
      ghostModeDefault: true,
      tags: ["eu"],
      notes: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastProbe: null,
    };
    const command = buildRemoteV3LaunchCommand(server, {
      proxyUrl: "socks5h://127.0.0.1:9050",
    });
    expect(command).toContain("ssh -p 2222");
    expect(command).toContain("-i '~/.ssh/id_ed25519_work'");
    expect(command).toContain("-J 'bastion.internal'");
    expect(command).toContain("ProxyCommand=nc -X 5 -x 127.0.0.1:9050 %h %p");
    expect(command).toContain("v3 --ghost --no-logs");
  });

  it("builds compartment env with proxy, git identity, and fail-closed kill-switch", () => {
    const comp = {
      ...createDefaultCompartment("2026-01-01T00:00:00.000Z"),
      id: "work",
      name: "Work",
      proxyId: "px-1",
      killSwitch: true,
      gitAuthorName: "Work Bot",
      gitAuthorEmail: "bot@work.example",
      gitSshKeyPath: "/keys/work_ed25519",
      timezone: "UTC",
      projectBindings: ["/repos/client-a"],
    };

    const withProxy = buildCompartmentProcessEnv(comp, "socks5h://127.0.0.1:9050");
    expect(withProxy.ALL_PROXY).toBe("socks5h://127.0.0.1:9050");
    expect(withProxy.GIT_AUTHOR_EMAIL).toBe("bot@work.example");
    expect(withProxy.GIT_SSH_COMMAND).toBe("ssh -i '/keys/work_ed25519' -o IdentitiesOnly=yes");
    expect(withProxy.TZ).toBe("UTC");

    const killSwitched = buildCompartmentProcessEnv(comp, null);
    expect(killSwitched.V3_KILL_SWITCH_ACTIVE).toBe("1");
    expect(killSwitched.ALL_PROXY).toBe("http://127.0.0.1:9");

    const matched = resolveCompartmentForProject(
      [createDefaultCompartment(), comp],
      "default",
      "/repos/client-a/sub",
    );
    expect(matched?.id).toBe("work");
  });

  it("scans and redacts API keys, private keys, DB URLs, and local paths", () => {
    const prompt = [
      "Debug /home/alice/secret-repo with key sk-ant-1234567890abcdefghijklmnop",
      "DB: postgres://admin:supersecret@db.internal:5432/prod",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nabcdefghijklmnopqrstuvwxyz123456\n-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");

    const result = scanAndRedactPrompt(prompt, {
      ...DEFAULT_DLP_CONFIG,
      mode: "redact",
    });

    expect(result.hasFindings).toBe(true);
    expect(result.categories).toEqual(
      expect.arrayContaining(["local-paths", "api-keys", "env-secrets", "private-keys"]),
    );
    expect(result.redactedText).toContain("/workspace/secret-repo");
    expect(result.redactedText).toContain("[REDACTED:API_KEY_1]");
    expect(result.redactedText).toContain("[REDACTED:SECRET_1]");
    expect(result.redactedText).toContain("[REDACTED:PRIVATE_KEY_1]");
    expect(result.redactedText).not.toContain("supersecret");
  });

  it("enforces egress allowlist, blocklist, loopback bypass, and kill-switch", () => {
    const allowlistPolicy = {
      ...DEFAULT_EGRESS_POLICY,
      mode: "allowlist" as const,
      allowlist: ["*.anthropic.com", "api.openai.com"],
      blocklist: ["telemetry.anthropic.com"],
    };

    expect(evaluateEgressHost("127.0.0.1", allowlistPolicy).action).toBe("allowed");
    expect(evaluateEgressHost("api.anthropic.com", allowlistPolicy).action).toBe("allowed");
    expect(evaluateEgressHost("telemetry.anthropic.com", allowlistPolicy).action).toBe("blocked");
    expect(evaluateEgressHost("tracker.example.com", allowlistPolicy).action).toBe("blocked");
    expect(
      evaluateEgressHost("api.openai.com", { ...allowlistPolicy, killSwitchActive: true }).action,
    ).toBe("blocked");
  });

  it("rejects option and shell injection payloads in SSH command generation and proxy URLs", () => {
    const maliciousHost: ServerVaultEntry = {
      id: "srv-bad",
      name: "Bad",
      kind: "ssh",
      host: "-Fevil.conf",
      port: 22,
      username: "-oProxyCommand=id",
      identityFile: "~/.ssh/id_ed25519\nmalicious",
      proxyJump: "-oProxyCommand=id",
      proxyId: null,
      defaultWorkdir: "/tmp/app",
      ghostModeDefault: true,
      tags: [],
      notes: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastProbe: null,
    };
    expect(buildRemoteV3LaunchCommand(maliciousHost)).toBe("# Invalid server host");

    const safeHostBadOpts: ServerVaultEntry = {
      ...maliciousHost,
      host: "198.51.100.10",
    };
    const cmd = buildRemoteV3LaunchCommand(safeHostBadOpts, {
      proxyUrl: "socks5h://127.0.0.1;id;:9050",
    });
    expect(cmd).not.toContain("ProxyCommand=");
    expect(cmd).not.toContain("-J");
    expect(cmd).not.toContain("-oProxyCommand");
    expect(cmd).toContain("-- '198.51.100.10'");
    expect(cmd).toContain("cd -- '\\''/tmp/app'\\''");

    const globalKillSwitch = buildCompartmentProcessEnv(createDefaultCompartment(), null, {
      failClosed: true,
    });
    expect(globalKillSwitch.V3_KILL_SWITCH_ACTIVE).toBe("1");
    expect(globalKillSwitch.ALL_PROXY).toBe("http://127.0.0.1:9");
  });

  it("computes and checks burn-after-TTL thread expiration", () => {
    const now = 1_700_000_000_000;
    const oneHour = createBurnThreadPolicy("thread-1", "1h", now);
    expect(isBurnThreadExpired(oneHour, now + 30 * 60_000)).toBe(false);
    expect(isBurnThreadExpired(oneHour, now + 60 * 60_000)).toBe(true);

    const onExit = createBurnThreadPolicy("thread-2", "on-exit", now);
    expect(onExit.onExit).toBe(true);
    expect(isBurnThreadExpired(onExit, now + 999_999_999)).toBe(false);
  });
});
