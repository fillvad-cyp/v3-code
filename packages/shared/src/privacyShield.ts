/**
 * Shared privacy-hardening rules for V3 Code ("Ghost / Anti-Detect Harness" mode).
 *
 * Keeps all legitimate privacy, zero-telemetry, outbound proxy validation, and
 * environment-fingerprint scrubbing definitions in one place for Server, Desktop, and Web.
 */

export const PRIVACY_STATUS_PATH = "/api/privacy/status";
export const PRIVACY_PANIC_LOGOUT_PATH = "/api/privacy/panic-logout";

export type EphemeralStorageKind = "ram" | "tmp" | "disk";

export interface PrivacyShieldStatus {
  readonly ephemeral: boolean;
  readonly ephemeralStorage: EphemeralStorageKind;
  readonly noLogs: boolean;
  readonly strictPrivacy: boolean;
  readonly telemetryOptOutCount: number;
  readonly scrubbedEnvCount: number;
  readonly proxyEnabled: boolean;
  readonly proxyDisplay: string | null;
  readonly zeroTelemetry: true;
  readonly autoUpdatesDisabled: true;
}

/**
 * Official opt-out environment variables respected by coding-agent CLIs and
 * developer toolchains spawned by V3 Code.
 */
export const PROVIDER_TELEMETRY_OPTOUT_ENV: Readonly<Record<string, string>> = {
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_BUG_COMMAND: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  OTEL_SDK_DISABLED: "true",
  DO_NOT_TRACK: "1",
  TELEMETRY_DISABLED: "1",
  ANONYMIZED_TELEMETRY: "false",
  POSTHOG_DISABLED: "true",
  SENTRY_DSN: "",
  CODEX_TELEMETRY_DISABLED: "1",
  OPENCODE_DISABLE_TELEMETRY: "1",
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  HOMEBREW_NO_ANALYTICS: "1",
  SCARF_NO_ANALYTICS: "true",
  CHECKPOINT_DISABLE: "1",
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_AUDIT: "false",
};

/**
 * Host, SSH, IDE, and desktop session environment variables that expose workstation
 * topology or operator identity to spawned provider CLIs and shells.
 */
export const HOST_FINGERPRINT_SCRUB_KEYS: ReadonlyArray<string> = [
  "SSH_CLIENT",
  "SSH_CONNECTION",
  "SSH_TTY",
  "TERM_SESSION_ID",
  "ITERM_SESSION_ID",
  "ITERM_PROFILE",
  "VSCODE_GIT_IPC_HANDLE",
  "VSCODE_IPC_HOOK_CLI",
  "VSCODE_NONCE",
  "TMUX",
  "TMUX_PANE",
  "XDG_SESSION_ID",
  "DESKTOP_SESSION",
  "GDMSESSION",
  "MAIL",
  "COMPUTERNAME",
  "USERDOMAIN",
  "LOGONSERVER",
];

/**
 * High-entropy Client Hints and wrapper headers stripped from Electron preview browser
 * sessions to prevent exact hardware/OS/wrapper fingerprinting.
 */
const DESKTOP_STRIPPED_CLIENT_HINT_HEADERS: ReadonlySet<string> = new Set([
  "sec-ch-ua-full-version-list",
  "sec-ch-ua-full-version",
  "sec-ch-ua-platform-version",
  "sec-ch-ua-model",
  "sec-ch-ua-arch",
  "sec-ch-ua-bitness",
  "sec-ch-ua-wow64",
  "x-requested-with",
]);

export const DEFAULT_NO_PROXY = "localhost,127.0.0.1,::1";

/**
 * Chromium host resolver base rule that blocks non-loopback local DNS queries whenever
 * an explicit proxy is configured (prevents DNS leaks outside SOCKS5/Tor/HTTP proxies).
 */
export const CHROMIUM_PROXY_DNS_LEAK_GUARD_RULE =
  "MAP * ~NOTFOUND , EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE ::1";

export const CHROMIUM_PROXY_BYPASS_LIST = "<-loopback>;localhost;127.0.0.1;[::1]";

export interface ChromiumProxyConfig {
  readonly proxyServer: string;
  readonly hostResolverRules: string;
  readonly proxyBypassList: string;
  readonly display: string;
}

const IPV4_LITERAL = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * Translates a validated outbound proxy URL into Chromium command-line switches:
 * - Maps `socks5h://` -> `socks5://` and `socks4a://` -> `socks4://` (Chromium rejects the `h`/`a` suffixes)
 * - Strips embedded credentials so they never leak into `/proc/<pid>/cmdline`
 * - Appends `EXCLUDE <proxyHost>` to `--host-resolver-rules` when the proxy itself uses a hostname
 */
export function buildChromiumProxyConfig(raw: string): ChromiumProxyConfig | null {
  const validated = validateOutboundProxyUrl(raw);
  if (!validated.ok) return null;
  const parsed = new URL(validated.url);
  const chromiumProtocol =
    parsed.protocol === "socks5h:"
      ? "socks5:"
      : parsed.protocol === "socks4a:"
        ? "socks4:"
        : parsed.protocol;
  const proxyServer = `${chromiumProtocol}//${parsed.host}`;
  const cleanHost = parsed.hostname.replace(/^\[|\]$/g, "");
  const isLoopbackOrIp =
    cleanHost === "localhost" ||
    cleanHost === "127.0.0.1" ||
    cleanHost === "::1" ||
    IPV4_LITERAL.test(cleanHost) ||
    cleanHost.includes(":");
  const hostResolverRules = isLoopbackOrIp
    ? CHROMIUM_PROXY_DNS_LEAK_GUARD_RULE
    : `${CHROMIUM_PROXY_DNS_LEAK_GUARD_RULE}, EXCLUDE ${cleanHost}`;
  return {
    proxyServer,
    hostResolverRules,
    proxyBypassList: CHROMIUM_PROXY_BYPASS_LIST,
    display: validated.display,
  };
}

const SUPPORTED_PROXY_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks4:",
  "socks4a:",
  "socks5:",
  "socks5h:",
]);

export type ProxyUrlValidationResult =
  | {
      readonly ok: true;
      readonly url: string;
      readonly display: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

export function validateOutboundProxyUrl(raw: string): ProxyUrlValidationResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "Proxy URL cannot be empty." };
  }
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) {
    return { ok: false, reason: "Proxy URL cannot contain whitespace or control characters." };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      reason: "Invalid proxy URL. Expected http://, https://, socks5://, or socks5h://host:port.",
    };
  }

  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      reason: `Unsupported proxy scheme "${parsed.protocol}". Use http://, https://, socks5://, or socks5h://.`,
    };
  }
  if (!parsed.hostname) {
    return { ok: false, reason: "Proxy URL must include a host." };
  }
  const cleanHost = parsed.hostname.replace(/^\[|\]$/g, "");
  if (
    cleanHost.length === 0 ||
    cleanHost.startsWith("-") ||
    !/^[A-Za-z0-9._:-]+$/.test(cleanHost)
  ) {
    return { ok: false, reason: "Proxy URL contains an invalid host." };
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    return { ok: false, reason: "Proxy URL must not include a path." };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, reason: "Proxy URL must not include a query string or fragment." };
  }

  const display = `${parsed.protocol}//${parsed.host}`;
  return { ok: true, url: parsed.toString().replace(/\/$/, ""), display };
}

function mergeNoProxy(existing: string | undefined): string {
  const entries = (existing ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const seen = new Set(entries.map((entry) => entry.toLowerCase()));
  for (const required of DEFAULT_NO_PROXY.split(",")) {
    if (!seen.has(required)) {
      entries.push(required);
      seen.add(required);
    }
  }
  return entries.join(",");
}

export interface AppliedProcessPrivacyShield {
  readonly telemetryOptOutCount: number;
  readonly scrubbedEnvCount: number;
  readonly proxyDisplay: string | null;
}

/**
 * Applies V3 Code's process-wide privacy shield to an environment map in place:
 * 1. Always injects official provider CLI telemetry opt-out variables.
 * 2. When `strictPrivacy` is enabled, strips workstation/session fingerprint variables.
 * 3. When `proxyUrl` is provided, configures HTTP/HTTPS/ALL_PROXY while preserving loopback NO_PROXY.
 */
export function applyProcessPrivacyShield(
  targetEnv: Record<string, string | undefined>,
  options: {
    readonly strictPrivacy: boolean;
    readonly proxyUrl?: string | undefined;
  },
): AppliedProcessPrivacyShield {
  const optOutEntries = Object.entries(PROVIDER_TELEMETRY_OPTOUT_ENV);
  for (const [key, value] of optOutEntries) {
    targetEnv[key] = value;
  }

  let scrubbedEnvCount = 0;
  if (options.strictPrivacy) {
    for (const key of HOST_FINGERPRINT_SCRUB_KEYS) {
      if (targetEnv[key] !== undefined) {
        delete targetEnv[key];
        scrubbedEnvCount += 1;
      }
    }
  }

  let proxyDisplay: string | null = null;
  if (options.proxyUrl !== undefined) {
    const validated = validateOutboundProxyUrl(options.proxyUrl);
    if (validated.ok) {
      targetEnv.HTTP_PROXY = validated.url;
      targetEnv.HTTPS_PROXY = validated.url;
      targetEnv.ALL_PROXY = validated.url;
      targetEnv.http_proxy = validated.url;
      targetEnv.https_proxy = validated.url;
      targetEnv.all_proxy = validated.url;
      const mergedNoProxy = mergeNoProxy(targetEnv.NO_PROXY ?? targetEnv.no_proxy);
      targetEnv.NO_PROXY = mergedNoProxy;
      targetEnv.no_proxy = mergedNoProxy;
      // Enables Node 24+/26 native fetch/undici HTTP(S) proxy support.
      targetEnv.NODE_USE_ENV_PROXY = "1";
      proxyDisplay = validated.display;
    }
  }

  return {
    telemetryOptOutCount: optOutEntries.length,
    scrubbedEnvCount,
    proxyDisplay,
  };
}

export function stripFingerprintRequestHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (DESKTOP_STRIPPED_CLIENT_HINT_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    next[name] = value;
  }
  return next;
}
