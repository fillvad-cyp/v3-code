// @effect-diagnostics nodeBuiltinImport:off -- Uses node:crypto/fs/path for atomic 0600 encrypted vault persistence and process env sync.
// @effect-diagnostics globalDate:off -- Vault timestamps and burn-TTL checks use wall-clock ISO strings.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { CommandId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_NO_PROXY, validateOutboundProxyUrl } from "@t3tools/shared/privacyShield";
import {
  buildCompartmentProcessEnv,
  buildRemoteV3LaunchCommand,
  createBurnThreadPolicy,
  createDefaultCompartment,
  createDefaultPrivacyVaultData,
  DEFAULT_COMPARTMENT_ID,
  evaluateEgressHost,
  isBurnThreadExpired,
  parseProxyBulkInput,
  toPublicProxyEntry,
  validateServerVaultHost,
  validateServerVaultUsername,
  type BurnTtlPreset,
  type DlpConfig,
  type EgressEvent,
  type EgressPolicy,
  type IdentityCompartment,
  type PrivacyVaultData,
  type PrivacyVaultPublicSnapshot,
  type ProxyHealthResult,
  type ProxyVaultEntry,
  type ServerProbeResult,
  type ServerVaultEntry,
  type ServerVaultKind,
} from "@t3tools/shared/privacyVault";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { probeProxyEndpoint, probeServerEndpoint } from "./ProxyProbe.ts";
import {
  decryptVaultJson,
  encryptVaultJson,
  isEncryptedVaultEnvelope,
  type EncryptedVaultEnvelope,
} from "./VaultCrypto.ts";

const VAULT_FILENAME = "v3-privacy-vault.json";
const MAX_EGRESS_EVENTS = 250;
const BURN_REAPER_INTERVAL = Duration.seconds(30);
const decodeJsonUnknown = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function nowIso(): string {
  return DateTime.formatIso(DateTime.nowUnsafe());
}

function nowEpochMs(): number {
  return DateTime.toEpochMillis(DateTime.nowUnsafe());
}

function captureBaselineEnv(): Map<string, string | undefined> {
  const baseline = new Map<string, string | undefined>();
  for (const key of MANAGED_COMPARTMENT_ENV_KEYS) {
    baseline.set(key, process.env[key]);
  }
  return baseline;
}

function readInitialVaultFile(vaultPath: string): {
  readonly status: "missing" | "encrypted" | "plain" | "unreadable";
  readonly envelope?: EncryptedVaultEnvelope;
  readonly data?: PrivacyVaultData;
} {
  if (!NodeFS.existsSync(vaultPath)) {
    return { status: "missing" };
  }
  try {
    const rawText = NodeFS.readFileSync(vaultPath, "utf8");
    const parsedOpt = decodeJsonUnknown(rawText);
    if (Option.isNone(parsedOpt)) {
      return { status: "unreadable" };
    }
    const parsed = parsedOpt.value;
    if (isEncryptedVaultEnvelope(parsed)) {
      return { status: "encrypted", envelope: parsed };
    }
    return { status: "plain", data: normalizeLoadedVaultData(parsed) };
  } catch {
    return { status: "unreadable" };
  }
}

const MANAGED_COMPARTMENT_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
  "V3_COMPARTMENT_ID",
  "V3_COMPARTMENT_NAME",
  "V3_KILL_SWITCH_ACTIVE",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_SSH_COMMAND",
  "TZ",
  "LANG",
  "LC_ALL",
] as const;

export interface AddProxyInput {
  readonly name: string;
  readonly url: string;
  readonly tags?: readonly string[] | undefined;
}

export interface UpsertServerInput {
  readonly id?: string | undefined;
  readonly name: string;
  readonly kind: ServerVaultKind;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly identityFile?: string | null | undefined;
  readonly proxyJump?: string | null | undefined;
  readonly proxyId?: string | null | undefined;
  readonly defaultWorkdir?: string | null | undefined;
  readonly ghostModeDefault?: boolean | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly notes?: string | null | undefined;
}

export interface UpsertCompartmentInput {
  readonly id?: string | undefined;
  readonly name: string;
  readonly color?: string | undefined;
  readonly proxyId?: string | null | undefined;
  readonly killSwitch?: boolean | undefined;
  readonly gitAuthorName?: string | null | undefined;
  readonly gitAuthorEmail?: string | null | undefined;
  readonly gitSshKeyPath?: string | null | undefined;
  readonly timezone?: string | null | undefined;
  readonly locale?: string | null | undefined;
  readonly projectBindings?: readonly string[] | undefined;
}

export interface VaultMutationResult<T = PrivacyVaultPublicSnapshot> {
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly snapshot: PrivacyVaultPublicSnapshot;
  readonly detail?: T | undefined;
}

export class PrivacyVaultService extends Context.Service<
  PrivacyVaultService,
  {
    readonly getSnapshot: Effect.Effect<PrivacyVaultPublicSnapshot>;
    readonly unlock: (passphrase: string) => Effect.Effect<VaultMutationResult>;
    readonly lock: Effect.Effect<VaultMutationResult>;
    readonly configureEncryption: (input: {
      readonly action: "enable" | "disable" | "change";
      readonly currentPassphrase?: string | undefined;
      readonly newPassphrase?: string | undefined;
    }) => Effect.Effect<VaultMutationResult>;
    readonly addProxy: (input: AddProxyInput) => Effect.Effect<VaultMutationResult>;
    readonly bulkImportProxies: (
      raw: string,
    ) => Effect.Effect<
      VaultMutationResult<{ readonly added: number; readonly invalidLines: readonly string[] }>
    >;
    readonly deleteProxy: (id: string) => Effect.Effect<VaultMutationResult>;
    readonly setDefaultProxy: (id: string | null) => Effect.Effect<VaultMutationResult>;
    readonly testProxy: (
      id: string,
    ) => Effect.Effect<VaultMutationResult<ProxyHealthResult | null>>;
    readonly upsertServer: (input: UpsertServerInput) => Effect.Effect<VaultMutationResult>;
    readonly deleteServer: (id: string) => Effect.Effect<VaultMutationResult>;
    readonly probeServer: (
      id: string,
    ) => Effect.Effect<VaultMutationResult<ServerProbeResult | null>>;
    readonly buildServerCommand: (id: string, ghost?: boolean) => Effect.Effect<string | null>;
    readonly upsertCompartment: (
      input: UpsertCompartmentInput,
    ) => Effect.Effect<VaultMutationResult>;
    readonly deleteCompartment: (id: string) => Effect.Effect<VaultMutationResult>;
    readonly activateCompartment: (id: string) => Effect.Effect<VaultMutationResult>;
    readonly createBurnerCompartment: (
      name?: string,
    ) => Effect.Effect<VaultMutationResult<IdentityCompartment | null>>;
    readonly updateDlp: (config: DlpConfig) => Effect.Effect<VaultMutationResult>;
    readonly updateEgress: (policy: EgressPolicy) => Effect.Effect<VaultMutationResult>;
    readonly clearEgressEvents: Effect.Effect<VaultMutationResult>;
    readonly setBurnThread: (
      threadId: string,
      preset: BurnTtlPreset | null,
    ) => Effect.Effect<VaultMutationResult>;
    readonly burnThreadNow: (threadId: string) => Effect.Effect<VaultMutationResult>;
    readonly handlePanic: Effect.Effect<{
      readonly burnedThreads: number;
      readonly removedBurners: number;
    }>;
  }
>()("v3code/privacy/PrivacyVaultService") {}

function randomId(prefix: string): string {
  return `${prefix}-${NodeCrypto.randomBytes(6).toString("hex")}`;
}

function sanitizeTags(tags?: readonly string[]): readonly string[] {
  if (!tags) return [];
  return Array.from(
    new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0 && tag.length <= 32)),
  ).slice(0, 12);
}

function constantTimePassphraseEquals(left: string, right: string): boolean {
  const leftDigest = NodeCrypto.createHash("sha256").update(left, "utf8").digest();
  const rightDigest = NodeCrypto.createHash("sha256").update(right, "utf8").digest();
  return NodeCrypto.timingSafeEqual(leftDigest, rightDigest);
}

function atomicWriteSecretFile(filePath: string, content: string): void {
  const dir = NodePath.dirname(filePath);
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${NodeCrypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    NodeFS.writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
    NodeFS.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      NodeFS.unlinkSync(tempPath);
    } catch {}
    throw error;
  }
  try {
    NodeFS.chmodSync(filePath, 0o600);
  } catch {}
}

function normalizeLoadedVaultData(raw: unknown): PrivacyVaultData {
  const fallback = createDefaultPrivacyVaultData();
  if (typeof raw !== "object" || raw === null) return fallback;
  const parsed = raw as Partial<PrivacyVaultData>;
  const compartments =
    Array.isArray(parsed.compartments) && parsed.compartments.length > 0
      ? parsed.compartments
      : fallback.compartments;
  const activeCompartmentId =
    typeof parsed.activeCompartmentId === "string" &&
    compartments.some((c) => c.id === parsed.activeCompartmentId)
      ? parsed.activeCompartmentId
      : (compartments[0]?.id ?? DEFAULT_COMPARTMENT_ID);
  return {
    version: 1,
    proxies: Array.isArray(parsed.proxies) ? parsed.proxies : [],
    defaultProxyId: typeof parsed.defaultProxyId === "string" ? parsed.defaultProxyId : null,
    servers: Array.isArray(parsed.servers) ? parsed.servers : [],
    compartments,
    activeCompartmentId,
    dlp: parsed.dlp ?? fallback.dlp,
    egress: parsed.egress ?? fallback.egress,
    burnThreads:
      parsed.burnThreads && typeof parsed.burnThreads === "object" ? parsed.burnThreads : {},
  };
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const threadManagementOption = yield* Effect.serviceOption(
    ThreadManagementService.ThreadManagementService,
  );
  const vaultPath = NodePath.join(config.stateDir, VAULT_FILENAME);

  const baselineEnv = captureBaselineEnv();

  let encryptedEnvelope: EncryptedVaultEnvelope | null = null;
  let activePassphrase: string | null = null;
  let data: PrivacyVaultData = createDefaultPrivacyVaultData();
  let locked = false;
  let vaultUnreadable = false;
  const egressEvents: EgressEvent[] = [];

  const initialVault = readInitialVaultFile(vaultPath);
  if (initialVault.status === "encrypted" && initialVault.envelope) {
    encryptedEnvelope = initialVault.envelope;
    locked = true;
  } else if (initialVault.status === "plain" && initialVault.data) {
    data = initialVault.data;
  } else if (initialVault.status === "unreadable") {
    // Never overwrite an unreadable vault file with empty defaults.
    vaultUnreadable = true;
    locked = true;
  }

  const recordEgressEvent = (
    host: string,
    protocol: string,
    action: "allowed" | "blocked",
    reason: string | null,
  ) => {
    egressEvents.unshift({
      id: randomId("eg"),
      timestamp: nowIso(),
      host,
      protocol,
      action,
      source: "server",
      reason,
    });
    if (egressEvents.length > MAX_EGRESS_EVENTS) {
      egressEvents.length = MAX_EGRESS_EVENTS;
    }
  };

  const resolveActiveProxyForData = (
    vault: PrivacyVaultData,
  ): {
    readonly compartment: IdentityCompartment;
    readonly proxy: ProxyVaultEntry | null;
    readonly killSwitch: boolean;
  } => {
    const compartment =
      vault.compartments.find((item) => item.id === vault.activeCompartmentId) ??
      vault.compartments[0] ??
      createDefaultCompartment();
    const effectiveProxyId = compartment.proxyId ?? vault.defaultProxyId;
    const proxy =
      effectiveProxyId !== null
        ? (vault.proxies.find((item) => item.id === effectiveProxyId && item.enabled) ?? null)
        : null;
    const killSwitch =
      vault.egress.killSwitchActive ||
      (compartment.killSwitch &&
        (effectiveProxyId !== null ? proxy === null || proxy.lastCheck?.ok === false : false));
    return { compartment, proxy, killSwitch };
  };

  const syncRuntimeProcessEnv = () => {
    for (const key of MANAGED_COMPARTMENT_ENV_KEYS) {
      const original = baselineEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }

    if (locked) return;
    const { compartment, proxy, killSwitch } = resolveActiveProxyForData(data);
    const effectiveUrl = killSwitch ? null : (proxy?.url ?? config.proxyUrl ?? null);
    const overrides = buildCompartmentProcessEnv(compartment, effectiveUrl, {
      failClosed: killSwitch,
    });
    for (const [key, value] of Object.entries(overrides)) {
      process.env[key] = value;
    }
    if (effectiveUrl !== null) {
      process.env.NO_PROXY = DEFAULT_NO_PROXY;
    }
  };

  const persistVault = (): void => {
    if (locked || vaultUnreadable) return;
    const persistable: PrivacyVaultData = {
      ...data,
      compartments: data.compartments.filter((c) => !c.ephemeral),
      activeCompartmentId: data.compartments.some(
        (c) => c.id === data.activeCompartmentId && !c.ephemeral,
      )
        ? data.activeCompartmentId
        : DEFAULT_COMPARTMENT_ID,
    };
    const json = JSON.stringify(persistable, null, 2);
    if (activePassphrase !== null) {
      encryptedEnvelope = encryptVaultJson(json, activePassphrase);
      atomicWriteSecretFile(vaultPath, JSON.stringify(encryptedEnvelope, null, 2));
    } else {
      encryptedEnvelope = null;
      atomicWriteSecretFile(vaultPath, json);
    }
  };

  const buildSnapshot = (): PrivacyVaultPublicSnapshot => {
    if (locked) {
      return {
        encrypted: true,
        locked: true,
        proxies: [],
        defaultProxyId: null,
        servers: [],
        compartments: [],
        activeCompartmentId: DEFAULT_COMPARTMENT_ID,
        activeProxyDisplay: null,
        activeKillSwitch: false,
        dlp: data.dlp,
        egress: data.egress,
        egressEvents: [],
        burnThreads: [],
      };
    }

    const { proxy, killSwitch } = resolveActiveProxyForData(data);
    const publicProxies = data.proxies.map(toPublicProxyEntry);
    const activePublicProxy = proxy ? toPublicProxyEntry(proxy) : null;
    return {
      encrypted: activePassphrase !== null || encryptedEnvelope !== null,
      locked: false,
      proxies: publicProxies,
      defaultProxyId: data.defaultProxyId,
      servers: [...data.servers],
      compartments: [...data.compartments],
      activeCompartmentId: data.activeCompartmentId,
      activeProxyDisplay: activePublicProxy?.displayUrl ?? null,
      activeKillSwitch: killSwitch,
      dlp: data.dlp,
      egress: data.egress,
      egressEvents: [...egressEvents],
      burnThreads: Object.values(data.burnThreads),
    };
  };

  const deleteThreadById = Effect.fn("privacyVault.deleteThread")(function* (threadId: string) {
    if (Option.isNone(threadManagementOption)) return false;
    return yield* threadManagementOption.value
      .dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`v3-burn-${NodeCrypto.randomBytes(6).toString("hex")}`),
        threadId: ThreadId.make(threadId),
      })
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
  });

  const sweepExpiredBurnThreads = Effect.fn("privacyVault.sweepExpiredBurnThreads")(function* (
    includeOnExit: boolean,
  ) {
    if (locked) return 0;
    const nowMs = nowEpochMs();
    const policies = Object.values(data.burnThreads);
    const toBurn = policies.filter(
      (policy) => (includeOnExit && policy.onExit) || isBurnThreadExpired(policy, nowMs),
    );
    if (toBurn.length === 0) return 0;

    let burned = 0;
    const deletedIds: string[] = [];
    for (const policy of toBurn) {
      const deleted = yield* deleteThreadById(policy.threadId);
      if (deleted) {
        deletedIds.push(policy.threadId);
        burned += 1;
      }
    }
    if (deletedIds.length > 0 && !locked) {
      const nextBurnThreads = { ...data.burnThreads };
      for (const threadId of deletedIds) {
        delete nextBurnThreads[threadId];
      }
      data = { ...data, burnThreads: nextBurnThreads };
      persistVault();
    }
    return burned;
  });

  syncRuntimeProcessEnv();

  const reaperFiber = yield* Effect.forkScoped(
    Effect.repeat(
      sweepExpiredBurnThreads(false).pipe(Effect.ignoreCause),
      Schedule.spaced(BURN_REAPER_INTERVAL),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Fiber.interrupt(reaperFiber);
      yield* sweepExpiredBurnThreads(true).pipe(Effect.ignoreCause);
    }),
  );

  const lockedResult = (): VaultMutationResult<never> => ({
    ok: false,
    error: "Vault is locked. Unlock with your master password first.",
    snapshot: buildSnapshot(),
  });

  return PrivacyVaultService.of({
    getSnapshot: Effect.sync(() => buildSnapshot()),

    unlock: Effect.fn("PrivacyVault.unlock")(function* (passphrase) {
      if (!locked || encryptedEnvelope === null) {
        return { ok: true, snapshot: buildSnapshot() };
      }
      const decrypted = decryptVaultJson(encryptedEnvelope, passphrase);
      if (decrypted === null) {
        return { ok: false, error: "Incorrect master password.", snapshot: buildSnapshot() };
      }
      const parsedOpt = decodeJsonUnknown(decrypted);
      if (Option.isNone(parsedOpt)) {
        return {
          ok: false,
          error: "Vault payload could not be parsed.",
          snapshot: buildSnapshot(),
        };
      }
      data = normalizeLoadedVaultData(parsedOpt.value);
      activePassphrase = passphrase;
      locked = false;
      syncRuntimeProcessEnv();
      yield* sweepExpiredBurnThreads(false);
      return { ok: true, snapshot: buildSnapshot() };
    }),

    lock: Effect.sync(() => {
      if (activePassphrase === null && encryptedEnvelope === null) {
        return {
          ok: false,
          error: "Set a master password before locking the vault.",
          snapshot: buildSnapshot(),
        };
      }
      persistVault();
      activePassphrase = null;
      locked = true;
      egressEvents.length = 0;
      data = createDefaultPrivacyVaultData();
      syncRuntimeProcessEnv();
      return { ok: true, snapshot: buildSnapshot() };
    }),

    configureEncryption: Effect.fn("PrivacyVault.configureEncryption")(function ({
      action,
      currentPassphrase,
      newPassphrase,
    }) {
      return Effect.sync(() => {
        if (locked) return lockedResult();
        const isAlreadyEncrypted = activePassphrase !== null || encryptedEnvelope !== null;
        if (action === "enable") {
          if (isAlreadyEncrypted) {
            return {
              ok: false,
              error:
                "Vault is already encrypted. Use change or disable with your current password.",
              snapshot: buildSnapshot(),
            };
          }
          if (!newPassphrase || newPassphrase.length < 6) {
            return {
              ok: false,
              error: "Master password must be at least 6 characters.",
              snapshot: buildSnapshot(),
            };
          }
          activePassphrase = newPassphrase;
          persistVault();
          return { ok: true, snapshot: buildSnapshot() };
        }
        if (
          activePassphrase !== null &&
          (currentPassphrase === undefined ||
            !constantTimePassphraseEquals(currentPassphrase, activePassphrase))
        ) {
          return {
            ok: false,
            error: "Current master password does not match.",
            snapshot: buildSnapshot(),
          };
        }
        if (action === "change") {
          if (!newPassphrase || newPassphrase.length < 6) {
            return {
              ok: false,
              error: "New master password must be at least 6 characters.",
              snapshot: buildSnapshot(),
            };
          }
          activePassphrase = newPassphrase;
          persistVault();
          return { ok: true, snapshot: buildSnapshot() };
        }
        activePassphrase = null;
        encryptedEnvelope = null;
        persistVault();
        return { ok: true, snapshot: buildSnapshot() };
      });
    }),

    addProxy: Effect.fn("PrivacyVault.addProxy")(function (input) {
      return Effect.sync(() => {
        if (locked) return lockedResult();
        const validated = validateOutboundProxyUrl(input.url);
        if (!validated.ok) {
          return { ok: false, error: validated.reason, snapshot: buildSnapshot() };
        }
        const entry: ProxyVaultEntry = {
          id: randomId("px"),
          name: input.name.trim() || validated.display,
          url: validated.url,
          tags: sanitizeTags(input.tags),
          enabled: true,
          createdAt: nowIso(),
          lastCheck: null,
        };
        const defaultProxyId = data.defaultProxyId ?? entry.id;
        data = {
          ...data,
          proxies: [...data.proxies, entry],
          defaultProxyId,
        };
        persistVault();
        syncRuntimeProcessEnv();
        return { ok: true, snapshot: buildSnapshot() };
      });
    }),

    bulkImportProxies: Effect.fn("PrivacyVault.bulkImportProxies")(function (raw) {
      return Effect.sync(() => {
        if (locked) {
          return {
            ok: false,
            error: "Vault is locked. Unlock with your master password first.",
            snapshot: buildSnapshot(),
            detail: { added: 0, invalidLines: [] },
          };
        }
        const { valid, invalidLines } = parseProxyBulkInput(raw);
        const now = nowIso();
        const created: ProxyVaultEntry[] = valid.map((item) => ({
          id: randomId("px"),
          name: item.name,
          url: item.url,
          tags: ["imported"],
          enabled: true,
          createdAt: now,
          lastCheck: null,
        }));
        data = {
          ...data,
          proxies: [...data.proxies, ...created],
          defaultProxyId: data.defaultProxyId ?? created[0]?.id ?? null,
        };
        persistVault();
        syncRuntimeProcessEnv();
        return {
          ok: true,
          snapshot: buildSnapshot(),
          detail: { added: created.length, invalidLines },
        };
      });
    }),

    deleteProxy: Effect.fn("PrivacyVault.deleteProxy")(function (id) {
      return Effect.sync(() => {
        if (locked) return lockedResult();
        data = {
          ...data,
          proxies: data.proxies.filter((item) => item.id !== id),
          defaultProxyId: data.defaultProxyId === id ? null : data.defaultProxyId,
          compartments: data.compartments.map((comp) =>
            comp.proxyId === id ? { ...comp, proxyId: null } : comp,
          ),
          servers: data.servers.map((srv) =>
            srv.proxyId === id ? { ...srv, proxyId: null } : srv,
          ),
        };
        persistVault();
        syncRuntimeProcessEnv();
        return { ok: true, snapshot: buildSnapshot() };
      });
    }),

    setDefaultProxy: Effect.fn("PrivacyVault.setDefaultProxy")(function (id) {
      return Effect.sync(() => {
        if (locked) return lockedResult();
        if (id !== null && !data.proxies.some((item) => item.id === id)) {
          return { ok: false, error: "Proxy not found.", snapshot: buildSnapshot() };
        }
        data = { ...data, defaultProxyId: id };
        persistVault();
        syncRuntimeProcessEnv();
        return { ok: true, snapshot: buildSnapshot() };
      });
    }),

    testProxy: Effect.fn("PrivacyVault.testProxy")(function* (id) {
      if (locked) {
        return {
          ok: false,
          error: "Vault is locked. Unlock with your master password first.",
          snapshot: buildSnapshot(),
          detail: null,
        };
      }
      const target = data.proxies.find((item) => item.id === id);
      if (!target) {
        return { ok: false, error: "Proxy not found.", snapshot: buildSnapshot(), detail: null };
      }
      const parsed = new URL(target.url);
      const egressDecision = evaluateEgressHost(parsed.hostname, data.egress);
      if (egressDecision.action === "blocked") {
        recordEgressEvent(
          parsed.hostname,
          parsed.protocol.replace(":", ""),
          "blocked",
          egressDecision.reason,
        );
        const blocked: ProxyHealthResult = {
          ok: false,
          latencyMs: null,
          exitIp: null,
          dnsLeakProtected: false,
          protocol: parsed.protocol.replace(":", ""),
          error: egressDecision.reason ?? "Blocked by egress policy",
          checkedAt: nowIso(),
        };
        data = {
          ...data,
          proxies: data.proxies.map((item) =>
            item.id === id ? { ...item, lastCheck: blocked } : item,
          ),
        };
        return { ok: true, snapshot: buildSnapshot(), detail: blocked };
      }
      const result = yield* Effect.promise(() => probeProxyEndpoint(target.url));
      recordEgressEvent(
        parsed.hostname,
        parsed.protocol.replace(":", ""),
        result.ok ? "allowed" : "blocked",
        result.ok ? `Proxy probe (${result.latencyMs ?? 0}ms)` : result.error,
      );
      data = {
        ...data,
        proxies: data.proxies.map((item) =>
          item.id === id ? { ...item, lastCheck: result } : item,
        ),
      };
      persistVault();
      syncRuntimeProcessEnv();
      return { ok: true, snapshot: buildSnapshot(), detail: result };
    }),

    upsertServer: Effect.fn("PrivacyVault.upsertServer")(function (input) {
      return Effect.sync(() => {
        if (locked) return lockedResult();
        if (!validateServerVaultHost(input.host)) {
          return { ok: false, error: "Invalid server hostname or IP.", snapshot: buildSnapshot() };
        }
        if (!validateServerVaultUsername(input.username)) {
          return { ok: false, error: "Invalid username.", snapshot: buildSnapshot() };
        }
        if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
          return {
            ok: false,
            error: "Port must be between 1 and 65535.",
            snapshot: buildSnapshot(),
          };
        }
        const existing = input.id ? data.servers.find((item) => item.id === input.id) : undefined;
        const entry: ServerVaultEntry = {
          id: existing?.id ?? randomId("srv"),
          name: input.name.trim() || input.host.trim(),
          kind: input.kind,
          host: input.host.trim(),
          port: input.port,
          username: input.username.trim(),
          identityFile: input.identityFile?.trim() || null,
          proxyJump: input.proxyJump?.trim() || null,
          proxyId: input.proxyId ?? null,
          defaultWorkdir: input.defaultWorkdir?.trim() || null,
          ghostModeDefault: input.ghostModeDefault ?? true,
          tags: sanitizeTags(input.tags),
          notes: input.notes?.trim() || null,
          createdAt: existing?.createdAt ?? nowIso(),
          lastProbe: existing?.lastProbe ?? null,
        };
        data = {
          ...data,
          servers: existing
            ? data.servers.map((item) => (item.id === entry.id ? entry : item))
            : [...data.servers, entry],
        };
        persistVault();
        return { ok: true, snapshot: buildSnapshot() };
      });
    }),

    deleteServer: Effect.fn("PrivacyVault.deleteServer")(function (id) {
      return Effect.sync(() => {
        if (locked) return lockedResult();
        data = { ...data, servers: data.servers.filter((item) => item.id !== id) };
        persistVault();
        return { ok: true, snapshot: buildSnapshot() };
      });
    }),

    probeServer: Effect.fn("PrivacyVault.probeServer")(function* (id) {
      if (locked) {
        return {
          ok: false,
          error: "Vault is locked. Unlock with your master password first.",
          snapshot: buildSnapshot(),
          detail: null,
        };
      }
      const target = data.servers.find((item) => item.id === id);
      if (!target) {
        return { ok: false, error: "Server not found.", snapshot: buildSnapshot(), detail: null };
      }
      const decision = evaluateEgressHost(target.host, data.egress);
      if (decision.action === "blocked") {
        recordEgressEvent(target.host, "tcp", "blocked", decision.reason);
        const blockedResult: ServerProbeResult = {
          reachable: false,
          latencyMs: null,
          error: decision.reason ?? "Blocked by egress policy",
          checkedAt: nowIso(),
        };
        data = {
          ...data,
          servers: data.servers.map((item) =>
            item.id === id ? { ...item, lastProbe: blockedResult } : item,
          ),
        };
        return { ok: true, snapshot: buildSnapshot(), detail: blockedResult };
      }
      const result = yield* Effect.promise(() => probeServerEndpoint(target.host, target.port));
      recordEgressEvent(
        target.host,
        "tcp",
        result.reachable ? "allowed" : "blocked",
        result.reachable ? `TCP :${target.port} (${result.latencyMs ?? 0}ms)` : result.error,
      );
      data = {
        ...data,
        servers: data.servers.map((item) =>
          item.id === id ? { ...item, lastProbe: result } : item,
        ),
      };
      persistVault();
      return { ok: true, snapshot: buildSnapshot(), detail: result };
    }),

    buildServerCommand: Effect.fn("PrivacyVault.buildServerCommand")(function (id, ghost) {
      return Effect.sync(() => {
        if (locked) return null;
        const server = data.servers.find((item) => item.id === id);
        if (!server) return null;
        const proxy = server.proxyId
          ? (data.proxies.find((item) => item.id === server.proxyId)?.url ?? null)
          : null;
        return buildRemoteV3LaunchCommand(server, {
          proxyUrl: proxy,
          ...(ghost === undefined ? {} : { ghost }),
        });
      });
    }),

    upsertCompartment: Effect.fn("PrivacyVault.upsertCompartment")(function (input) {
      return Effect.sync(() => {
        if (locked) return lockedResult();
        const existing = input.id
          ? data.compartments.find((item) => item.id === input.id)
          : undefined;
        const id = existing?.id ?? randomId("comp");
        const entry: IdentityCompartment = {
          id,
          name: input.name.trim() || "Profile",
          color: input.color?.trim() || existing?.color || "blue",
          proxyId: input.proxyId === undefined ? (existing?.proxyId ?? null) : input.proxyId,
          killSwitch: input.killSwitch ?? existing?.killSwitch ?? false,
          browserPartition: existing?.browserPartition ?? `persist:t3code-preview-${id}`,
          gitAuthorName:
            input.gitAuthorName === undefined
              ? (existing?.gitAuthorName ?? null)
              : input.gitAuthorName?.trim() || null,
          gitAuthorEmail:
            input.gitAuthorEmail === undefined
              ? (existing?.gitAuthorEmail ?? null)
              : input.gitAuthorEmail?.trim() || null,
          gitSshKeyPath:
            input.gitSshKeyPath === undefined
              ? (existing?.gitSshKeyPath ?? null)
              : input.gitSshKeyPath?.trim() || null,
          timezone:
            input.timezone === undefined
              ? (existing?.timezone ?? null)
              : input.timezone?.trim() || null,
          locale:
            input.locale === undefined ? (existing?.locale ?? null) : input.locale?.trim() || null,
          ephemeral: existing?.ephemeral ?? false,
          projectBindings:
            input.projectBindings !== undefined
              ? input.projectBindings.map((item) => item.trim()).filter((item) => item.length > 0)
              : (existing?.projectBindings ?? []),
          createdAt: existing?.createdAt ?? nowIso(),
        };
        data = {
          ...data,
          compartments: existing
            ? data.compartments.map((item) => (item.id === id ? entry : item))
            : [...data.compartments, entry],
        };
        persistVault();
        syncRuntimeProcessEnv();
        return { ok: true, snapshot: buildSnapshot() };
      });
    }),

    deleteCompartment: Effect.fn("PrivacyVault.deleteCompartment")(function (id) {
      return Effect.sync(() => {
        if (locked) return lockedResult();
        if (id === DEFAULT_COMPARTMENT_ID) {
          return {
            ok: false,
            error: "The default compartment cannot be deleted.",
            snapshot: buildSnapshot(),
          };
        }
        const remaining = data.compartments.filter((item) => item.id !== id);
        data = {
          ...data,
          compartments: remaining.length > 0 ? remaining : [createDefaultCompartment()],
          activeCompartmentId:
            data.activeCompartmentId === id ? DEFAULT_COMPARTMENT_ID : data.activeCompartmentId,
        };
        persistVault();
        syncRuntimeProcessEnv();
        return { ok: true, snapshot: buildSnapshot() };
      });
    }),

    activateCompartment: Effect.fn("PrivacyVault.activateCompartment")(function (id) {
      return Effect.sync(() => {
        if (locked) return lockedResult();
        if (!data.compartments.some((item) => item.id === id)) {
          return { ok: false, error: "Compartment not found.", snapshot: buildSnapshot() };
        }
        data = { ...data, activeCompartmentId: id };
        persistVault();
        syncRuntimeProcessEnv();
        return { ok: true, snapshot: buildSnapshot() };
      });
    }),

    createBurnerCompartment: Effect.fn("PrivacyVault.createBurnerCompartment")(function (name) {
      return Effect.sync(() => {
        if (locked) {
          return {
            ok: false,
            error: "Vault is locked. Unlock with your master password first.",
            snapshot: buildSnapshot(),
            detail: null,
          };
        }
        const id = randomId("burner");
        const burner: IdentityCompartment = {
          id,
          name: name?.trim() || `Burner ${id.slice(-4).toUpperCase()}`,
          color: "rose",
          proxyId: data.defaultProxyId,
          killSwitch: data.defaultProxyId !== null,
          browserPartition: `t3code-preview-ephemeral-${id}`,
          gitAuthorName: "Anonymous",
          gitAuthorEmail: "anonymous@localhost",
          gitSshKeyPath: null,
          timezone: "UTC",
          locale: "en_US.UTF-8",
          ephemeral: true,
          projectBindings: [],
          createdAt: nowIso(),
        };
        data = {
          ...data,
          compartments: [...data.compartments, burner],
          activeCompartmentId: burner.id,
        };
        syncRuntimeProcessEnv();
        return { ok: true, snapshot: buildSnapshot(), detail: burner };
      });
    }),

    updateDlp: Effect.fn("PrivacyVault.updateDlp")(function (dlp) {
      return Effect.sync(() => {
        if (locked) return lockedResult();
        data = { ...data, dlp };
        persistVault();
        return { ok: true, snapshot: buildSnapshot() };
      });
    }),

    updateEgress: Effect.fn("PrivacyVault.updateEgress")(function (egress) {
      return Effect.sync(() => {
        if (locked) return lockedResult();
        data = {
          ...data,
          egress: {
            mode: egress.mode,
            allowlist: Array.from(
              new Set(egress.allowlist.map((h) => h.trim().toLowerCase()).filter(Boolean)),
            ),
            blocklist: Array.from(
              new Set(egress.blocklist.map((h) => h.trim().toLowerCase()).filter(Boolean)),
            ),
            killSwitchActive: egress.killSwitchActive,
          },
        };
        persistVault();
        syncRuntimeProcessEnv();
        return { ok: true, snapshot: buildSnapshot() };
      });
    }),

    clearEgressEvents: Effect.sync(() => {
      egressEvents.length = 0;
      return { ok: true, snapshot: buildSnapshot() };
    }),

    setBurnThread: Effect.fn("PrivacyVault.setBurnThread")(function (threadId, preset) {
      return Effect.sync(() => {
        if (locked) return lockedResult();
        const trimmed = threadId.trim();
        if (trimmed.length === 0) {
          return { ok: false, error: "Invalid thread ID.", snapshot: buildSnapshot() };
        }
        const nextBurnThreads = { ...data.burnThreads };
        if (preset === null) {
          delete nextBurnThreads[trimmed];
        } else {
          nextBurnThreads[trimmed] = createBurnThreadPolicy(trimmed, preset);
        }
        data = { ...data, burnThreads: nextBurnThreads };
        persistVault();
        return { ok: true, snapshot: buildSnapshot() };
      });
    }),

    burnThreadNow: Effect.fn("PrivacyVault.burnThreadNow")(function* (threadId) {
      if (locked) return lockedResult();
      const trimmed = threadId.trim();
      if (trimmed.length === 0) {
        return { ok: false, error: "Invalid thread ID.", snapshot: buildSnapshot() };
      }
      const deleted = yield* deleteThreadById(trimmed);
      if (!deleted && Option.isSome(threadManagementOption)) {
        return {
          ok: false,
          error: "Could not delete thread; burn timer kept active.",
          snapshot: buildSnapshot(),
        };
      }
      if (!locked) {
        const nextBurnThreads = { ...data.burnThreads };
        delete nextBurnThreads[trimmed];
        data = { ...data, burnThreads: nextBurnThreads };
        persistVault();
      }
      return { ok: true, snapshot: buildSnapshot() };
    }),

    handlePanic: Effect.gen(function* () {
      const burnedThreads = yield* sweepExpiredBurnThreads(true);
      const removedBurners = data.compartments.filter((c) => c.ephemeral).length;
      if (!locked && removedBurners > 0) {
        const nonEphemeral = data.compartments.filter((c) => !c.ephemeral);
        data = {
          ...data,
          compartments: nonEphemeral.length > 0 ? nonEphemeral : [createDefaultCompartment()],
          activeCompartmentId: DEFAULT_COMPARTMENT_ID,
        };
      }
      egressEvents.length = 0;
      if (activePassphrase !== null || encryptedEnvelope !== null) {
        if (!locked) persistVault();
        activePassphrase = null;
        locked = true;
        data = createDefaultPrivacyVaultData();
      }
      syncRuntimeProcessEnv();
      return { burnedThreads, removedBurners };
    }).pipe(Effect.withSpan("PrivacyVault.handlePanic")),
  });
});

export const layer = Layer.effect(PrivacyVaultService, make);
