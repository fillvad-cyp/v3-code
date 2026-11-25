import type { DesktopPrivacyNetworkState } from "@t3tools/contracts";
import {
  DEFAULT_DLP_CONFIG,
  PRIVACY_VAULT_ACTION_HEADER,
  PRIVACY_VAULT_BURN_PATH,
  PRIVACY_VAULT_COMPARTMENTS_PATH,
  PRIVACY_VAULT_DLP_PATH,
  PRIVACY_VAULT_EGRESS_PATH,
  PRIVACY_VAULT_ENCRYPTION_PATH,
  PRIVACY_VAULT_LOCK_PATH,
  PRIVACY_VAULT_PATH,
  PRIVACY_VAULT_PROXIES_PATH,
  PRIVACY_VAULT_SERVERS_PATH,
  PRIVACY_VAULT_UNLOCK_PATH,
  scanAndRedactPrompt,
  type BurnTtlPreset,
  type DlpConfig,
  type DlpScanResult,
  type EgressPolicy,
  type IdentityCompartment,
  type PrivacyVaultPublicSnapshot,
  type ProxyHealthResult,
  type ServerProbeResult,
  type ServerVaultKind,
} from "@t3tools/shared/privacyVault";
import { msg } from "gt-react";
import { create } from "zustand";

import { isElectron } from "../env";
import { m } from "../i18n/messages";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { buildPrimaryPrivacyFetchInit } from "./privacyShield";

const DLP_CACHE_STORAGE_KEY = "v3code:privacy-dlp-cache:v1";

function readCachedDlpConfig(): DlpConfig {
  try {
    if (typeof window === "undefined") return DEFAULT_DLP_CONFIG;
    const raw = window.localStorage.getItem(DLP_CACHE_STORAGE_KEY);
    if (!raw) return DEFAULT_DLP_CONFIG;
    const parsed = JSON.parse(raw) as Partial<DlpConfig>;
    if (!parsed.mode || !parsed.rules) return DEFAULT_DLP_CONFIG;
    return {
      mode: parsed.mode,
      rules: { ...DEFAULT_DLP_CONFIG.rules, ...parsed.rules },
    };
  } catch {
    return DEFAULT_DLP_CONFIG;
  }
}

function writeCachedDlpConfig(config: DlpConfig): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(DLP_CACHE_STORAGE_KEY, JSON.stringify(config));
  } catch {}
}

export interface PrivacyVaultClientState {
  readonly snapshot: PrivacyVaultPublicSnapshot | null;
  readonly desktopNetwork: DesktopPrivacyNetworkState | null;
  readonly dlpConfig: DlpConfig;
  readonly alwaysOnTop: boolean;
  readonly loading: boolean;
  readonly busy: boolean;
  readonly lastError: string | null;
}

export const usePrivacyVaultStore = create<PrivacyVaultClientState>(() => ({
  snapshot: null,
  desktopNetwork: null,
  dlpConfig: readCachedDlpConfig(),
  alwaysOnTop: false,
  loading: false,
  busy: false,
  lastError: null,
}));

export async function hydrateWindowAlwaysOnTop(): Promise<boolean> {
  const bridge = window.desktopBridge;
  if (!isElectron || typeof bridge?.getWindowAlwaysOnTop !== "function") {
    return false;
  }
  const current = await bridge.getWindowAlwaysOnTop().catch(() => false);
  usePrivacyVaultStore.setState({ alwaysOnTop: current });
  return current;
}

export async function toggleWindowAlwaysOnTop(): Promise<boolean | null> {
  const bridge = window.desktopBridge;
  if (!isElectron || typeof bridge?.setWindowAlwaysOnTop !== "function") {
    return null;
  }
  const current =
    typeof bridge.getWindowAlwaysOnTop === "function"
      ? await bridge.getWindowAlwaysOnTop().catch(() => usePrivacyVaultStore.getState().alwaysOnTop)
      : usePrivacyVaultStore.getState().alwaysOnTop;
  const next = await bridge.setWindowAlwaysOnTop(!current);
  usePrivacyVaultStore.setState({ alwaysOnTop: next });
  return next;
}

let lastAppliedDesktopProxy: string | null | undefined;

async function syncDesktopPrivacyNetwork(snapshot: PrivacyVaultPublicSnapshot): Promise<void> {
  if (!isElectron || !window.desktopBridge?.privacyNetwork) return;
  try {
    const killSwitchActive = snapshot.activeKillSwitch || snapshot.egress.killSwitchActive;
    let nextState = await window.desktopBridge.privacyNetwork.setEgressPolicy({
      mode: snapshot.egress.mode,
      allowlist: [...snapshot.egress.allowlist],
      blocklist: [...snapshot.egress.blocklist],
      killSwitchActive,
    });
    const effectiveProxy = killSwitchActive ? "http://127.0.0.1:9" : snapshot.activeProxyDisplay;
    if (effectiveProxy !== lastAppliedDesktopProxy) {
      lastAppliedDesktopProxy = effectiveProxy;
      nextState = await window.desktopBridge.privacyNetwork.applyProxy(effectiveProxy);
    }
    usePrivacyVaultStore.setState({ desktopNetwork: nextState });
  } catch {}
}

function applyVaultSnapshot(snapshot: PrivacyVaultPublicSnapshot): void {
  if (snapshot.locked) {
    lastDlpWarningAck = null;
  } else {
    writeCachedDlpConfig(snapshot.dlp);
  }
  usePrivacyVaultStore.setState({
    snapshot,
    dlpConfig: snapshot.locked ? usePrivacyVaultStore.getState().dlpConfig : snapshot.dlp,
    lastError: null,
  });
  void syncDesktopPrivacyNetwork(snapshot);
}

interface VaultApiResponse<T = unknown> {
  readonly ok: boolean;
  readonly error?: string | undefined;
  readonly snapshot?: PrivacyVaultPublicSnapshot | undefined;
  readonly detail?: T | undefined;
  readonly command?: string | null | undefined;
}

async function postVaultAction<T = unknown>(
  path: string,
  payload: Record<string, unknown>,
): Promise<VaultApiResponse<T>> {
  if (isLocalEnvironmentDisabled()) {
    return { ok: false, error: m(msg("Local environment is disabled.")) };
  }
  usePrivacyVaultStore.setState({ busy: true, lastError: null });
  try {
    const url = resolvePrimaryEnvironmentHttpUrl(path);
    const response = await fetch(
      url,
      await buildPrimaryPrivacyFetchInit({
        method: "POST",
        headers: {
          "content-type": "application/json",
          [PRIVACY_VAULT_ACTION_HEADER]: "1",
        },
        body: JSON.stringify(payload),
      }),
    );
    const body = (await response.json().catch(() => ({ ok: false }))) as VaultApiResponse<T>;
    if (body.snapshot) {
      applyVaultSnapshot(body.snapshot);
    }
    if (!body.ok && body.error) {
      usePrivacyVaultStore.setState({ lastError: body.error });
    }
    usePrivacyVaultStore.setState({ busy: false });
    return body;
  } catch {
    const errorText = m(msg("Failed to reach privacy vault API."));
    usePrivacyVaultStore.setState({ busy: false, lastError: errorText });
    return { ok: false, error: errorText };
  }
}

export async function refreshPrivacyVault(): Promise<PrivacyVaultPublicSnapshot | null> {
  if (isLocalEnvironmentDisabled()) {
    return null;
  }
  usePrivacyVaultStore.setState({ loading: true });
  try {
    const url = resolvePrimaryEnvironmentHttpUrl(PRIVACY_VAULT_PATH);
    const response = await fetch(url, await buildPrimaryPrivacyFetchInit({ method: "GET" }));
    if (isElectron && window.desktopBridge?.privacyNetwork) {
      const net = await window.desktopBridge.privacyNetwork.getState().catch(() => null);
      if (net) usePrivacyVaultStore.setState({ desktopNetwork: net });
    }
    if (!response.ok) {
      usePrivacyVaultStore.setState({ loading: false });
      return null;
    }
    const snapshot = (await response.json()) as PrivacyVaultPublicSnapshot;
    applyVaultSnapshot(snapshot);
    usePrivacyVaultStore.setState({ loading: false });
    return snapshot;
  } catch {
    usePrivacyVaultStore.setState({ loading: false });
    return null;
  }
}

export const unlockPrivacyVault = (passphrase: string) =>
  postVaultAction(PRIVACY_VAULT_UNLOCK_PATH, { passphrase });

export const lockPrivacyVault = () => postVaultAction(PRIVACY_VAULT_LOCK_PATH, {});

export const configureVaultEncryption = (input: {
  readonly action: "enable" | "disable" | "change";
  readonly currentPassphrase?: string;
  readonly newPassphrase?: string;
}) => postVaultAction(PRIVACY_VAULT_ENCRYPTION_PATH, input);

export const addVaultProxy = (input: {
  readonly name: string;
  readonly url: string;
  readonly tags?: readonly string[];
}) => postVaultAction(PRIVACY_VAULT_PROXIES_PATH, { action: "add", ...input });

export const bulkImportVaultProxies = (raw: string) =>
  postVaultAction<{ readonly added: number; readonly invalidLines: readonly string[] }>(
    PRIVACY_VAULT_PROXIES_PATH,
    { action: "bulk-import", raw },
  );

export const deleteVaultProxy = (id: string) =>
  postVaultAction(PRIVACY_VAULT_PROXIES_PATH, { action: "delete", id });

export const setDefaultVaultProxy = (id: string | null) =>
  postVaultAction(PRIVACY_VAULT_PROXIES_PATH, { action: "set-default", id });

export const testVaultProxy = (id: string) =>
  postVaultAction<ProxyHealthResult | null>(PRIVACY_VAULT_PROXIES_PATH, { action: "test", id });

export const upsertVaultServer = (input: {
  readonly id?: string;
  readonly name: string;
  readonly kind: ServerVaultKind;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly identityFile?: string | null;
  readonly proxyJump?: string | null;
  readonly proxyId?: string | null;
  readonly defaultWorkdir?: string | null;
  readonly ghostModeDefault?: boolean;
  readonly tags?: readonly string[];
  readonly notes?: string | null;
}) => postVaultAction(PRIVACY_VAULT_SERVERS_PATH, { action: "upsert", ...input });

export const deleteVaultServer = (id: string) =>
  postVaultAction(PRIVACY_VAULT_SERVERS_PATH, { action: "delete", id });

export const probeVaultServer = (id: string) =>
  postVaultAction<ServerProbeResult | null>(PRIVACY_VAULT_SERVERS_PATH, { action: "probe", id });

export const buildVaultServerCommand = async (
  id: string,
  ghost?: boolean,
): Promise<string | null> => {
  const res = await postVaultAction(PRIVACY_VAULT_SERVERS_PATH, {
    action: "command",
    id,
    ...(ghost === undefined ? {} : { ghost }),
  });
  return typeof res.command === "string" ? res.command : null;
};

export const upsertVaultCompartment = (input: {
  readonly id?: string;
  readonly name: string;
  readonly color?: string;
  readonly proxyId?: string | null;
  readonly killSwitch?: boolean;
  readonly gitAuthorName?: string | null;
  readonly gitAuthorEmail?: string | null;
  readonly gitSshKeyPath?: string | null;
  readonly timezone?: string | null;
  readonly locale?: string | null;
  readonly projectBindings?: readonly string[];
}) => postVaultAction(PRIVACY_VAULT_COMPARTMENTS_PATH, { action: "upsert", ...input });

export const deleteVaultCompartment = (id: string) =>
  postVaultAction(PRIVACY_VAULT_COMPARTMENTS_PATH, { action: "delete", id });

export const activateVaultCompartment = (id: string) =>
  postVaultAction(PRIVACY_VAULT_COMPARTMENTS_PATH, { action: "activate", id });

export const createBurnerVaultCompartment = (name?: string) =>
  postVaultAction<IdentityCompartment | null>(PRIVACY_VAULT_COMPARTMENTS_PATH, {
    action: "create-burner",
    ...(name ? { name } : {}),
  });

export const updateVaultDlp = (config: DlpConfig) => {
  writeCachedDlpConfig(config);
  usePrivacyVaultStore.setState({ dlpConfig: config });
  return postVaultAction(PRIVACY_VAULT_DLP_PATH, { action: "update", config });
};

export const updateVaultEgress = (policy: EgressPolicy) =>
  postVaultAction(PRIVACY_VAULT_EGRESS_PATH, { action: "update", policy });

export const clearVaultEgressLog = async (): Promise<void> => {
  await postVaultAction(PRIVACY_VAULT_EGRESS_PATH, { action: "clear-log" });
  if (isElectron && window.desktopBridge?.privacyNetwork) {
    const net = await window.desktopBridge.privacyNetwork.clearLog().catch(() => null);
    if (net) usePrivacyVaultStore.setState({ desktopNetwork: net });
  }
};

export const setVaultBurnThread = (threadId: string, preset: BurnTtlPreset) =>
  postVaultAction(PRIVACY_VAULT_BURN_PATH, { action: "set", threadId, preset });

export const clearVaultBurnThread = (threadId: string) =>
  postVaultAction(PRIVACY_VAULT_BURN_PATH, { action: "clear", threadId });

export const burnVaultThreadNow = (threadId: string) =>
  postVaultAction(PRIVACY_VAULT_BURN_PATH, { action: "burn-now", threadId });

export function getBurnPolicyForThread(threadId: string) {
  const snapshot = usePrivacyVaultStore.getState().snapshot;
  return snapshot?.burnThreads.find((item) => item.threadId === threadId) ?? null;
}

// Tracks one-time warning acknowledgements for DLP "warn" mode (valid for 15 seconds on identical text).
let lastDlpWarningAck: { readonly text: string; readonly expiresAt: number } | null = null;

export type ComposerDlpDecision =
  | { readonly action: "allow"; readonly text: string; readonly redactedCount: number }
  | { readonly action: "warn"; readonly scan: DlpScanResult }
  | { readonly action: "block"; readonly scan: DlpScanResult };

export function evaluateComposerDlp(text: string, nowMs = Date.now()): ComposerDlpDecision {
  if (lastDlpWarningAck !== null && lastDlpWarningAck.expiresAt < nowMs) {
    lastDlpWarningAck = null;
  }
  const config = usePrivacyVaultStore.getState().dlpConfig;
  if (config.mode === "off" || text.trim().length === 0) {
    lastDlpWarningAck = null;
    return { action: "allow", text, redactedCount: 0 };
  }
  const scan = scanAndRedactPrompt(text, config);
  if (!scan.hasFindings) {
    lastDlpWarningAck = null;
    return { action: "allow", text, redactedCount: 0 };
  }
  if (config.mode === "block") {
    lastDlpWarningAck = null;
    return { action: "block", scan };
  }
  if (config.mode === "redact") {
    lastDlpWarningAck = null;
    return { action: "allow", text: scan.redactedText, redactedCount: scan.findings.length };
  }
  // mode === "warn": require a second Send click within 15s for the exact same text.
  if (
    lastDlpWarningAck !== null &&
    lastDlpWarningAck.text === text &&
    lastDlpWarningAck.expiresAt >= nowMs
  ) {
    lastDlpWarningAck = null;
    return { action: "allow", text, redactedCount: 0 };
  }
  lastDlpWarningAck = { text, expiresAt: nowMs + 15_000 };
  return { action: "warn", scan };
}
