// @effect-diagnostics globalDate:off -- Shared browser/server helpers default timestamps cleanly.
/** Shared types, validators, DLP redactor, and egress evaluators for the V3 Privacy Vault. */

import {
  DEFAULT_NO_PROXY,
  PROVIDER_TELEMETRY_OPTOUT_ENV,
  validateOutboundProxyUrl,
} from "./privacyShield.ts";

export const PRIVACY_VAULT_PATH = "/api/privacy/vault";
export const PRIVACY_VAULT_UNLOCK_PATH = "/api/privacy/vault/unlock";
export const PRIVACY_VAULT_LOCK_PATH = "/api/privacy/vault/lock";
export const PRIVACY_VAULT_ENCRYPTION_PATH = "/api/privacy/vault/encryption";
export const PRIVACY_VAULT_PROXIES_PATH = "/api/privacy/vault/proxies";
export const PRIVACY_VAULT_SERVERS_PATH = "/api/privacy/vault/servers";
export const PRIVACY_VAULT_COMPARTMENTS_PATH = "/api/privacy/vault/compartments";
export const PRIVACY_VAULT_DLP_PATH = "/api/privacy/vault/dlp";
export const PRIVACY_VAULT_EGRESS_PATH = "/api/privacy/vault/egress";
export const PRIVACY_VAULT_BURN_PATH = "/api/privacy/vault/burn-threads";
export const PRIVACY_VAULT_ACTION_HEADER = "x-v3-vault-action";

export interface ProxyHealthResult {
  readonly ok: boolean;
  readonly latencyMs: number | null;
  readonly exitIp: string | null;
  readonly dnsLeakProtected: boolean;
  readonly protocol: string;
  readonly error: string | null;
  readonly checkedAt: string;
}

export interface ProxyVaultEntry {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly tags: readonly string[];
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly lastCheck: ProxyHealthResult | null;
}

export interface ProxyVaultPublicEntry {
  readonly id: string;
  readonly name: string;
  readonly displayUrl: string;
  readonly hasCredentials: boolean;
  readonly dnsLeakProtected: boolean;
  readonly tags: readonly string[];
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly lastCheck: ProxyHealthResult | null;
}

const REMOTE_DNS_PROXY_PROTOCOLS = new Set(["socks5h:", "socks4a:", "http:", "https:"]);

export function isDnsLeakProtectedProxyUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    return REMOTE_DNS_PROXY_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function redactProxyUrl(rawUrl: string): {
  readonly displayUrl: string;
  readonly hasCredentials: boolean;
} {
  try {
    const parsed = new URL(rawUrl.trim());
    const hasCredentials = parsed.username.length > 0 || parsed.password.length > 0;
    let decodedUser = "auth";
    if (parsed.username) {
      try {
        decodedUser = decodeURIComponent(parsed.username);
      } catch {
        decodedUser = parsed.username;
      }
    }
    const authPrefix = hasCredentials ? `${decodedUser}:***@` : "";
    return {
      displayUrl: `${parsed.protocol}//${authPrefix}${parsed.host}`,
      hasCredentials,
    };
  } catch {
    return { displayUrl: "(invalid proxy)", hasCredentials: false };
  }
}

export function toPublicProxyEntry(entry: ProxyVaultEntry): ProxyVaultPublicEntry {
  const { displayUrl, hasCredentials } = redactProxyUrl(entry.url);
  return {
    id: entry.id,
    name: entry.name,
    displayUrl,
    hasCredentials,
    dnsLeakProtected: isDnsLeakProtectedProxyUrl(entry.url),
    tags: entry.tags,
    enabled: entry.enabled,
    createdAt: entry.createdAt,
    lastCheck: entry.lastCheck,
  };
}

export interface ParsedBulkProxyLine {
  readonly name: string;
  readonly url: string;
}

/** Parses multi-line proxies: URL, `host:port`, or `host:port:user:pass` (defaults to `socks5h://`). */
export function parseProxyBulkInput(raw: string): {
  readonly valid: readonly ParsedBulkProxyLine[];
  readonly invalidLines: readonly string[];
} {
  const valid: ParsedBulkProxyLine[] = [];
  const invalidLines: string[] = [];

  for (const rawLine of raw.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    let candidateUrl = trimmed;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      const parts = trimmed.split(":");
      if (parts.length === 2 && parts[0] && /^\d+$/.test(parts[1] ?? "")) {
        candidateUrl = `socks5h://${parts[0]}:${parts[1]}`;
      } else if (parts.length === 4 && parts[0] && /^\d+$/.test(parts[1] ?? "")) {
        const user = encodeURIComponent(parts[2] ?? "");
        const pass = encodeURIComponent(parts[3] ?? "");
        candidateUrl = `socks5h://${user}:${pass}@${parts[0]}:${parts[1]}`;
      }
    }

    const checked = validateOutboundProxyUrl(candidateUrl);
    if (!checked.ok) {
      // Never echo credentials back in invalid line reports.
      invalidLines.push(
        trimmed.replace(/\/\/[^/\s@]+@/, "//***@").replace(/^([^:\s]+:\d+):.*$/, "$1:***"),
      );
      continue;
    }
    const parsed = new URL(checked.url);
    valid.push({
      name: `${parsed.protocol.replace(":", "").toUpperCase()} ${parsed.hostname}`,
      url: checked.url,
    });
  }

  return { valid, invalidLines };
}

export type ServerVaultKind = "ssh" | "lan" | "tailscale";

export interface ServerProbeResult {
  readonly reachable: boolean;
  readonly latencyMs: number | null;
  readonly error: string | null;
  readonly checkedAt: string;
}

export interface ServerVaultEntry {
  readonly id: string;
  readonly name: string;
  readonly kind: ServerVaultKind;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly identityFile: string | null;
  readonly proxyJump: string | null;
  readonly proxyId: string | null;
  readonly defaultWorkdir: string | null;
  readonly ghostModeDefault: boolean;
  readonly tags: readonly string[];
  readonly notes: string | null;
  readonly createdAt: string;
  readonly lastProbe: ServerProbeResult | null;
}

const SAFE_HOST_PATTERN = /^[A-Za-z0-9._:[\]-]+$/;
const SAFE_USER_PATTERN = /^[A-Za-z0-9._-]+$/;
const SAFE_PROXY_JUMP_PATTERN = /^[A-Za-z0-9._:@,[\]-]+$/;

function stripControlChars(value: string): string {
  return value.replace(/[\r\n\0]/g, "").trim();
}

export function validateServerVaultHost(host: string): boolean {
  const trimmed = host.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 253 &&
    !trimmed.startsWith("-") &&
    SAFE_HOST_PATTERN.test(trimmed)
  );
}

export function validateServerVaultUsername(username: string): boolean {
  const trimmed = username.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 64 &&
    !trimmed.startsWith("-") &&
    SAFE_USER_PATTERN.test(trimmed)
  );
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Generates a copyable, injection-safe SSH command to launch or attach to V3 Code
 * on a vaulted server (optionally with `--ghost --no-logs` and Jump/SOCKS proxy).
 */
export function buildRemoteV3LaunchCommand(
  server: ServerVaultEntry,
  options?: { readonly proxyUrl?: string | null; readonly ghost?: boolean },
): string {
  const host = server.host.trim();
  const user = server.username.trim();
  const useGhost = options?.ghost ?? server.ghostModeDefault;

  if (!validateServerVaultHost(host)) {
    return "# Invalid server host";
  }

  const sshArgs: string[] = ["ssh"];
  if (
    server.port !== 22 &&
    Number.isInteger(server.port) &&
    server.port > 0 &&
    server.port <= 65535
  ) {
    sshArgs.push("-p", String(server.port));
  }
  const cleanIdentityFile = server.identityFile ? stripControlChars(server.identityFile) : "";
  if (cleanIdentityFile.length > 0) {
    sshArgs.push("-i", shellSingleQuote(cleanIdentityFile));
  }
  const cleanProxyJump = server.proxyJump ? stripControlChars(server.proxyJump) : "";
  if (
    cleanProxyJump.length > 0 &&
    !cleanProxyJump.startsWith("-") &&
    SAFE_PROXY_JUMP_PATTERN.test(cleanProxyJump)
  ) {
    sshArgs.push("-J", shellSingleQuote(cleanProxyJump));
  }
  if (options?.proxyUrl) {
    const validated = validateOutboundProxyUrl(options.proxyUrl);
    if (validated.ok) {
      const parsed = new URL(validated.url);
      const cleanProxyHost = parsed.hostname;
      if (parsed.protocol.startsWith("socks5") && validateServerVaultHost(cleanProxyHost)) {
        const proxyPort = parsed.port || "1080";
        sshArgs.push(
          "-o",
          shellSingleQuote(`ProxyCommand=nc -X 5 -x ${cleanProxyHost}:${proxyPort} %h %p`),
        );
      }
    }
  }

  const target = validateServerVaultUsername(user) ? `${user}@${host}` : host;
  sshArgs.push("--", shellSingleQuote(target));

  const remoteCmdParts: string[] = [];
  const cleanWorkdir = server.defaultWorkdir ? stripControlChars(server.defaultWorkdir) : "";
  if (cleanWorkdir.length > 0) {
    remoteCmdParts.push(`cd -- ${shellSingleQuote(cleanWorkdir)}`);
  }
  remoteCmdParts.push(useGhost ? "v3 --ghost --no-logs" : "v3");
  sshArgs.push(shellSingleQuote(remoteCmdParts.join(" && ")));

  return sshArgs.join(" ");
}

export interface IdentityCompartment {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly proxyId: string | null;
  readonly killSwitch: boolean;
  readonly browserPartition: string;
  readonly gitAuthorName: string | null;
  readonly gitAuthorEmail: string | null;
  readonly gitSshKeyPath: string | null;
  readonly timezone: string | null;
  readonly locale: string | null;
  readonly ephemeral: boolean;
  readonly projectBindings: readonly string[];
  readonly createdAt: string;
}

export const DEFAULT_COMPARTMENT_ID = "default";

export function createDefaultCompartment(now = new Date().toISOString()): IdentityCompartment {
  return {
    id: DEFAULT_COMPARTMENT_ID,
    name: "Default",
    color: "blue",
    proxyId: null,
    killSwitch: false,
    browserPartition: "persist:t3code-preview-default",
    gitAuthorName: null,
    gitAuthorEmail: null,
    gitSshKeyPath: null,
    timezone: null,
    locale: null,
    ephemeral: false,
    projectBindings: [],
    createdAt: now,
  };
}

export function resolveCompartmentForProject(
  compartments: readonly IdentityCompartment[],
  activeCompartmentId: string,
  projectPathOrId?: string | null,
): IdentityCompartment | null {
  if (projectPathOrId && projectPathOrId.trim().length > 0) {
    const normalized = projectPathOrId.trim();
    const bound = compartments.find((compartment) =>
      compartment.projectBindings.some((binding) => {
        const clean = binding.trim();
        return clean.length > 0 && (normalized === clean || normalized.startsWith(`${clean}/`));
      }),
    );
    if (bound) return bound;
  }
  return (
    compartments.find((compartment) => compartment.id === activeCompartmentId) ??
    compartments[0] ??
    null
  );
}

/**
 * Computes environment variable overrides to apply when spawning an agent CLI
 * or shell inside a specific Identity Compartment.
 */
export function buildCompartmentProcessEnv(
  compartment: IdentityCompartment,
  resolvedProxyUrl: string | null,
  options?: { readonly failClosed?: boolean },
): Record<string, string> {
  const env: Record<string, string> = {
    ...PROVIDER_TELEMETRY_OPTOUT_ENV,
    V3_COMPARTMENT_ID: compartment.id,
    V3_COMPARTMENT_NAME: compartment.name,
  };

  if (options?.failClosed) {
    const sinkhole = "http://127.0.0.1:9";
    env.HTTP_PROXY = sinkhole;
    env.HTTPS_PROXY = sinkhole;
    env.ALL_PROXY = sinkhole;
    env.http_proxy = sinkhole;
    env.https_proxy = sinkhole;
    env.all_proxy = sinkhole;
    env.NO_PROXY = DEFAULT_NO_PROXY;
    env.no_proxy = DEFAULT_NO_PROXY;
    env.V3_KILL_SWITCH_ACTIVE = "1";
  } else if (resolvedProxyUrl) {
    const validated = validateOutboundProxyUrl(resolvedProxyUrl);
    if (validated.ok) {
      env.HTTP_PROXY = validated.url;
      env.HTTPS_PROXY = validated.url;
      env.ALL_PROXY = validated.url;
      env.http_proxy = validated.url;
      env.https_proxy = validated.url;
      env.all_proxy = validated.url;
      env.NO_PROXY = DEFAULT_NO_PROXY;
      env.no_proxy = DEFAULT_NO_PROXY;
      env.NODE_USE_ENV_PROXY = "1";
    }
  } else if (compartment.killSwitch && compartment.proxyId !== null) {
    // Fail-closed proxy sinkhole: point outbound requests to discard port so agents cannot leak direct IP.
    const sinkhole = "http://127.0.0.1:9";
    env.HTTP_PROXY = sinkhole;
    env.HTTPS_PROXY = sinkhole;
    env.ALL_PROXY = sinkhole;
    env.http_proxy = sinkhole;
    env.https_proxy = sinkhole;
    env.all_proxy = sinkhole;
    env.NO_PROXY = DEFAULT_NO_PROXY;
    env.no_proxy = DEFAULT_NO_PROXY;
    env.V3_KILL_SWITCH_ACTIVE = "1";
  }

  if (compartment.gitAuthorName && compartment.gitAuthorName.trim().length > 0) {
    env.GIT_AUTHOR_NAME = compartment.gitAuthorName.trim();
    env.GIT_COMMITTER_NAME = compartment.gitAuthorName.trim();
  }
  if (compartment.gitAuthorEmail && compartment.gitAuthorEmail.trim().length > 0) {
    env.GIT_AUTHOR_EMAIL = compartment.gitAuthorEmail.trim();
    env.GIT_COMMITTER_EMAIL = compartment.gitAuthorEmail.trim();
  }
  if (compartment.gitSshKeyPath && compartment.gitSshKeyPath.trim().length > 0) {
    const cleanKey = compartment.gitSshKeyPath.trim();
    if (!/[\r\n\u0000]/.test(cleanKey)) {
      env.GIT_SSH_COMMAND = `ssh -i ${shellSingleQuote(cleanKey)} -o IdentitiesOnly=yes`;
    }
  }
  if (compartment.timezone && /^[A-Za-z0-9_./+-]+$/.test(compartment.timezone.trim())) {
    env.TZ = compartment.timezone.trim();
  }
  if (compartment.locale && /^[A-Za-z0-9_.@-]+$/.test(compartment.locale.trim())) {
    env.LANG = compartment.locale.trim();
    env.LC_ALL = compartment.locale.trim();
  }

  return env;
}

export type DlpMode = "off" | "warn" | "redact" | "block";

export type DlpRuleCategory =
  | "api-keys"
  | "private-keys"
  | "jwt"
  | "env-secrets"
  | "local-paths"
  | "ip-addresses";

export interface DlpConfig {
  readonly mode: DlpMode;
  readonly rules: Readonly<Record<DlpRuleCategory, boolean>>;
}

export const DEFAULT_DLP_CONFIG: DlpConfig = {
  mode: "warn",
  rules: {
    "api-keys": true,
    "private-keys": true,
    jwt: true,
    "env-secrets": true,
    "local-paths": true,
    "ip-addresses": false,
  },
};

export interface DlpFinding {
  readonly category: DlpRuleCategory;
  readonly label: string;
  readonly preview: string;
  readonly placeholder: string;
  readonly start: number;
  readonly end: number;
}

export interface DlpScanResult {
  readonly hasFindings: boolean;
  readonly findings: readonly DlpFinding[];
  readonly redactedText: string;
  readonly categories: readonly DlpRuleCategory[];
}

interface DlpDetectorSpec {
  readonly category: DlpRuleCategory;
  readonly label: string;
  readonly tokenPrefix: string;
  readonly pattern: RegExp;
  readonly replacement?: (match: string, index: number) => string;
}

const DLP_DETECTORS: readonly DlpDetectorSpec[] = [
  {
    category: "private-keys",
    label: "Private key block",
    tokenPrefix: "PRIVATE_KEY",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{16,8192}?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    category: "api-keys",
    label: "API key or access token",
    tokenPrefix: "API_KEY",
    pattern:
      /\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{30,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xai-[A-Za-z0-9_-]{24,}|rk_live_[A-Za-z0-9]{20,}|pk_live_[A-Za-z0-9]{20,})\b/g,
  },
  {
    category: "jwt",
    label: "JWT bearer token",
    tokenPrefix: "JWT",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    category: "env-secrets",
    label: "Database URL or .env secret",
    tokenPrefix: "SECRET",
    pattern:
      /(?:(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s@/]+@[^\s"'`]+|\b[A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_TOKEN|AUTH_TOKEN|API_KEY|CLIENT_SECRET)\s*=\s*["']?[^\s"'`]{8,}["']?)/g,
  },
  {
    category: "local-paths",
    label: "Local workstation path",
    tokenPrefix: "LOCAL_PATH",
    pattern:
      /(?:\/(?:Users|home)\/[A-Za-z0-9._-]{2,48}(?=\/|\b)|[A-Za-z]:\\Users\\[A-Za-z0-9._-]{2,48}(?=\\|\b))/g,
    replacement: (match) => (match.includes("\\") ? "C:\\workspace" : "/workspace"),
  },
  {
    category: "ip-addresses",
    label: "IPv4 address",
    tokenPrefix: "IP_ADDR",
    pattern:
      /\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
  },
];

function maskPreview(raw: string): string {
  const singleLine = raw.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 12) return `${singleLine.slice(0, 3)}***`;
  return `${singleLine.slice(0, 6)}...${singleLine.slice(-4)}`;
}

export function scanAndRedactPrompt(text: string, config: DlpConfig): DlpScanResult {
  if (config.mode === "off" || text.length === 0) {
    return { hasFindings: false, findings: [], redactedText: text, categories: [] };
  }

  interface RawMatch {
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly spec: DlpDetectorSpec;
  }

  const rawMatches: RawMatch[] = [];
  for (const spec of DLP_DETECTORS) {
    if (!config.rules[spec.category]) continue;
    const regex = new RegExp(spec.pattern.source, spec.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
        continue;
      }
      rawMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        spec,
      });
    }
  }

  if (rawMatches.length === 0) {
    return { hasFindings: false, findings: [], redactedText: text, categories: [] };
  }

  // Sort by start offset, preferring longer spans when two rules overlap.
  rawMatches.sort((left, right) => left.start - right.start || right.end - left.end);
  const nonOverlapping: RawMatch[] = [];
  let cursor = 0;
  for (const candidate of rawMatches) {
    if (candidate.start < cursor) continue;
    nonOverlapping.push(candidate);
    cursor = candidate.end;
  }

  const counters = new Map<string, number>();
  const findings: DlpFinding[] = [];
  let out = "";
  let pos = 0;

  for (const item of nonOverlapping) {
    const nextIndex = (counters.get(item.spec.tokenPrefix) ?? 0) + 1;
    counters.set(item.spec.tokenPrefix, nextIndex);
    const placeholder = item.spec.replacement
      ? item.spec.replacement(item.text, nextIndex)
      : `[REDACTED:${item.spec.tokenPrefix}_${nextIndex}]`;

    findings.push({
      category: item.spec.category,
      label: item.spec.label,
      preview: maskPreview(item.text),
      placeholder,
      start: item.start,
      end: item.end,
    });

    out += text.slice(pos, item.start) + placeholder;
    pos = item.end;
  }
  out += text.slice(pos);

  const categories = Array.from(new Set(findings.map((finding) => finding.category)));
  return {
    hasFindings: findings.length > 0,
    findings,
    redactedText: out,
    categories,
  };
}

export type EgressMode = "monitor" | "allowlist";

export interface EgressPolicy {
  readonly mode: EgressMode;
  readonly allowlist: readonly string[];
  readonly blocklist: readonly string[];
  readonly killSwitchActive: boolean;
}

export interface EgressEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly host: string;
  readonly protocol: string;
  readonly action: "allowed" | "blocked";
  readonly source: "desktop" | "server";
  readonly reason: string | null;
}

export const EGRESS_PROVIDER_PRESETS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["api.anthropic.com", "*.anthropic.com", "claude.ai"],
  openai: ["api.openai.com", "chatgpt.com", "*.openai.com"],
  google: ["generativelanguage.googleapis.com", "*.googleapis.com"],
  xai: ["api.x.ai"],
  openrouter: ["openrouter.ai"],
  github: ["github.com", "api.github.com"],
};

export const DEFAULT_EGRESS_POLICY: EgressPolicy = {
  mode: "monitor",
  allowlist: [
    "api.anthropic.com",
    "api.openai.com",
    "chatgpt.com",
    "generativelanguage.googleapis.com",
    "api.x.ai",
    "openrouter.ai",
  ],
  blocklist: [],
  killSwitchActive: false,
};

function normalizeHostPattern(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

function isLoopbackHost(host: string): boolean {
  const clean = normalizeHostPattern(host);
  return (
    clean === "localhost" ||
    clean === "127.0.0.1" ||
    clean === "::1" ||
    clean.endsWith(".localhost")
  );
}

function hostMatchesPattern(host: string, pattern: string): boolean {
  const cleanHost = normalizeHostPattern(host);
  const cleanPattern = normalizeHostPattern(pattern);
  if (cleanPattern.length === 0) return false;
  if (cleanPattern.startsWith("*.")) {
    const suffix = cleanPattern.slice(1); // ".example.com"
    return cleanHost.endsWith(suffix) && cleanHost.length > suffix.length;
  }
  return cleanHost === cleanPattern;
}

export function evaluateEgressHost(
  hostname: string,
  policy: EgressPolicy,
): { readonly action: "allowed" | "blocked"; readonly reason: string | null } {
  const cleanHost = normalizeHostPattern(hostname);
  if (cleanHost.length === 0 || isLoopbackHost(cleanHost)) {
    return { action: "allowed", reason: null };
  }
  if (policy.killSwitchActive) {
    return { action: "blocked", reason: "Proxy kill-switch active" };
  }
  if (policy.blocklist.some((pattern) => hostMatchesPattern(cleanHost, pattern))) {
    return { action: "blocked", reason: "Matched egress blocklist" };
  }
  if (policy.mode === "allowlist") {
    if (policy.allowlist.some((pattern) => hostMatchesPattern(cleanHost, pattern))) {
      return { action: "allowed", reason: null };
    }
    return { action: "blocked", reason: "Not in egress allowlist" };
  }
  return { action: "allowed", reason: null };
}

export type BurnTtlPreset = "15m" | "1h" | "6h" | "24h" | "on-exit";

export interface BurnThreadPolicy {
  readonly threadId: string;
  readonly preset: BurnTtlPreset;
  readonly expiresAt: string | null;
  readonly onExit: boolean;
  readonly createdAt: string;
}

const BURN_PRESET_DURATION_MS: Readonly<Record<Exclude<BurnTtlPreset, "on-exit">, number>> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
};

export function createBurnThreadPolicy(
  threadId: string,
  preset: BurnTtlPreset,
  nowMs = Date.now(),
): BurnThreadPolicy {
  const createdAt = new Date(nowMs).toISOString();
  if (preset === "on-exit") {
    return { threadId, preset, expiresAt: null, onExit: true, createdAt };
  }
  return {
    threadId,
    preset,
    expiresAt: new Date(nowMs + BURN_PRESET_DURATION_MS[preset]).toISOString(),
    onExit: false,
    createdAt,
  };
}

export function isBurnThreadExpired(policy: BurnThreadPolicy, nowMs = Date.now()): boolean {
  if (policy.expiresAt === null) return false;
  const expiresMs = Date.parse(policy.expiresAt);
  return Number.isFinite(expiresMs) && expiresMs <= nowMs;
}

export interface PrivacyVaultData {
  readonly version: 1;
  readonly proxies: readonly ProxyVaultEntry[];
  readonly defaultProxyId: string | null;
  readonly servers: readonly ServerVaultEntry[];
  readonly compartments: readonly IdentityCompartment[];
  readonly activeCompartmentId: string;
  readonly dlp: DlpConfig;
  readonly egress: EgressPolicy;
  readonly burnThreads: Readonly<Record<string, BurnThreadPolicy>>;
}

export function createDefaultPrivacyVaultData(now = new Date().toISOString()): PrivacyVaultData {
  return {
    version: 1,
    proxies: [],
    defaultProxyId: null,
    servers: [],
    compartments: [createDefaultCompartment(now)],
    activeCompartmentId: DEFAULT_COMPARTMENT_ID,
    dlp: DEFAULT_DLP_CONFIG,
    egress: DEFAULT_EGRESS_POLICY,
    burnThreads: {},
  };
}

export interface PrivacyVaultPublicSnapshot {
  readonly encrypted: boolean;
  readonly locked: boolean;
  readonly proxies: readonly ProxyVaultPublicEntry[];
  readonly defaultProxyId: string | null;
  readonly servers: readonly ServerVaultEntry[];
  readonly compartments: readonly IdentityCompartment[];
  readonly activeCompartmentId: string;
  readonly activeProxyDisplay: string | null;
  readonly activeKillSwitch: boolean;
  readonly dlp: DlpConfig;
  readonly egress: EgressPolicy;
  readonly egressEvents: readonly EgressEvent[];
  readonly burnThreads: readonly BurnThreadPolicy[];
}
