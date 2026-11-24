import { describe, expect, it } from "vite-plus/test";
import {
  applyProcessPrivacyShield,
  buildChromiumProxyConfig,
  CHROMIUM_PROXY_BYPASS_LIST,
  CHROMIUM_PROXY_DNS_LEAK_GUARD_RULE,
  DEFAULT_NO_PROXY,
  HOST_FINGERPRINT_SCRUB_KEYS,
  PROVIDER_TELEMETRY_OPTOUT_ENV,
  stripFingerprintRequestHeaders,
  validateOutboundProxyUrl,
} from "./privacyShield.ts";

describe("validateOutboundProxyUrl", () => {
  it("accepts HTTP(S) and SOCKS proxies and strips credentials from display", () => {
    expect(validateOutboundProxyUrl("socks5h://127.0.0.1:9050")).toEqual({
      ok: true,
      url: "socks5h://127.0.0.1:9050",
      display: "socks5h://127.0.0.1:9050",
    });

    expect(validateOutboundProxyUrl("http://user:supersecret@proxy.internal:8080/")).toEqual({
      ok: true,
      url: "http://user:supersecret@proxy.internal:8080",
      display: "http://proxy.internal:8080",
    });
  });

  it("rejects malformed or unsupported proxy schemes", () => {
    expect(validateOutboundProxyUrl("").ok).toBe(false);
    expect(validateOutboundProxyUrl("ftp://127.0.0.1:21").ok).toBe(false);
    expect(validateOutboundProxyUrl("socks5h://127.0.0.1:9050/path").ok).toBe(false);
    expect(validateOutboundProxyUrl("http://127.0.0.1:8080?x=1").ok).toBe(false);
    expect(validateOutboundProxyUrl("socks5://bad host:1080").ok).toBe(false);
  });
});

describe("applyProcessPrivacyShield", () => {
  it("always injects provider CLI telemetry opt-outs and leaves host vars unless strictPrivacy", () => {
    const env: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      SSH_CONNECTION: "10.0.0.1 12345 10.0.0.2 22",
      TERM_SESSION_ID: "w0t0p0:ABC",
    };

    const result = applyProcessPrivacyShield(env, { strictPrivacy: false });
    expect(result.telemetryOptOutCount).toBe(Object.keys(PROVIDER_TELEMETRY_OPTOUT_ENV).length);
    expect(result.scrubbedEnvCount).toBe(0);
    expect(result.proxyDisplay).toBeNull();
    expect(env.DISABLE_TELEMETRY).toBe("1");
    expect(env.OTEL_SDK_DISABLED).toBe("true");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env.OPENCODE_DISABLE_TELEMETRY).toBe("1");
    expect(env.SSH_CONNECTION).toBe("10.0.0.1 12345 10.0.0.2 22");
  });

  it("scrubs host fingerprint vars in strictPrivacy mode and configures proxy + loopback NO_PROXY", () => {
    const env: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      SSH_CLIENT: "192.168.1.5 55555 22",
      SSH_CONNECTION: "192.168.1.5 55555 192.168.1.1 22",
      TMUX: "/tmp/tmux-1000/default,123,0",
      VSCODE_IPC_HOOK_CLI: "/run/user/1000/vscode.sock",
      NO_PROXY: "corp.local",
    };

    const result = applyProcessPrivacyShield(env, {
      strictPrivacy: true,
      proxyUrl: "socks5h://alice:pass@127.0.0.1:9050",
    });

    expect(result.scrubbedEnvCount).toBe(4);
    expect(result.proxyDisplay).toBe("socks5h://127.0.0.1:9050");
    for (const key of HOST_FINGERPRINT_SCRUB_KEYS) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ALL_PROXY).toBe("socks5h://alice:pass@127.0.0.1:9050");
    expect(env.HTTPS_PROXY).toBe("socks5h://alice:pass@127.0.0.1:9050");
    expect(env.NO_PROXY).toBe(`corp.local,${DEFAULT_NO_PROXY}`);
    expect(env.no_proxy).toBe(`corp.local,${DEFAULT_NO_PROXY}`);
  });
});

describe("stripFingerprintRequestHeaders", () => {
  it("strips high-entropy Client Hints and wrapper headers while keeping standard headers", () => {
    const sanitized = stripFingerprintRequestHeaders({
      Accept: "text/html",
      "User-Agent": "Mozilla/5.0",
      "Sec-CH-UA-Full-Version-List": '"Chromium";v="134.0.0.0"',
      "sec-ch-ua-platform-version": '"15.1.0"',
      "Sec-CH-UA-Model": '"MacBookPro18,1"',
      "X-Requested-With": "Electron",
    });

    expect(sanitized).toEqual({
      Accept: "text/html",
      "User-Agent": "Mozilla/5.0",
    });
  });
});

describe("buildChromiumProxyConfig", () => {
  it("normalizes socks5h to socks5, strips credentials, and excludes hostname proxies from DNS block", () => {
    expect(buildChromiumProxyConfig("socks5h://user:secret@127.0.0.1:9050")).toEqual({
      proxyServer: "socks5://127.0.0.1:9050",
      hostResolverRules: CHROMIUM_PROXY_DNS_LEAK_GUARD_RULE,
      proxyBypassList: CHROMIUM_PROXY_BYPASS_LIST,
      display: "socks5h://127.0.0.1:9050",
    });

    expect(buildChromiumProxyConfig("socks5h://tor.internal:9050")).toEqual({
      proxyServer: "socks5://tor.internal:9050",
      hostResolverRules: `${CHROMIUM_PROXY_DNS_LEAK_GUARD_RULE}, EXCLUDE tor.internal`,
      proxyBypassList: CHROMIUM_PROXY_BYPASS_LIST,
      display: "socks5h://tor.internal:9050",
    });

    expect(buildChromiumProxyConfig("ftp://bad")).toBeNull();
  });
});
