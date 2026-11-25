import {
  DEFAULT_COMPARTMENT_ID,
  EGRESS_PROVIDER_PRESETS,
  scanAndRedactPrompt,
  type DlpMode,
  type DlpRuleCategory,
  type ServerVaultKind,
} from "@t3tools/shared/privacyVault";
import { T, useGT, Var } from "gt-react";
import {
  CopyIcon,
  FlameIcon,
  GlobeIcon,
  KeyRoundIcon,
  LayersIcon,
  LockIcon,
  NetworkIcon,
  PlusIcon,
  RefreshCwIcon,
  ServerIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  Trash2Icon,
  UnlockIcon,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import {
  activateVaultCompartment,
  addVaultProxy,
  buildVaultServerCommand,
  bulkImportVaultProxies,
  burnVaultThreadNow,
  clearVaultBurnThread,
  clearVaultEgressLog,
  configureVaultEncryption,
  createBurnerVaultCompartment,
  deleteVaultCompartment,
  deleteVaultProxy,
  deleteVaultServer,
  lockPrivacyVault,
  probeVaultServer,
  refreshPrivacyVault,
  setDefaultVaultProxy,
  testVaultProxy,
  unlockPrivacyVault,
  updateVaultDlp,
  updateVaultEgress,
  upsertVaultCompartment,
  upsertVaultServer,
  usePrivacyVaultStore,
} from "../../lib/privacyVaultClient";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsSection } from "./settingsLayout";

type VaultTab = "proxies" | "servers" | "compartments" | "dlp" | "egress" | "crypto";

const DLP_RULE_CATEGORIES: ReadonlyArray<DlpRuleCategory> = [
  "api-keys",
  "private-keys",
  "jwt",
  "env-secrets",
  "local-paths",
  "ip-addresses",
];

function formatBurnRemaining(expiresAt: string | null, nowMs: number): string | null {
  if (!expiresAt) return null;
  const remainingMs = Date.parse(expiresAt) - nowMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "0m";
  const mins = Math.ceil(remainingMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

export function PrivacyVaultPanel() {
  const gt = useGT();
  const snapshot = usePrivacyVaultStore((state) => state.snapshot);
  const desktopNetwork = usePrivacyVaultStore((state) => state.desktopNetwork);
  const dlpConfig = usePrivacyVaultStore((state) => state.dlpConfig);
  const loading = usePrivacyVaultStore((state) => state.loading);
  const busy = usePrivacyVaultStore((state) => state.busy);

  const [tab, setTab] = useState<VaultTab>("proxies");

  // Unlock / Crypto state
  const [unlockPassphrase, setUnlockPassphrase] = useState("");
  const [masterPassDraft, setMasterPassDraft] = useState("");
  const [currentPassDraft, setCurrentPassDraft] = useState("");

  // Proxy form state
  const [proxyName, setProxyName] = useState("");
  const [proxyUrl, setProxyUrl] = useState("");
  const [bulkProxyInput, setBulkProxyInput] = useState("");
  const [showBulkImport, setShowBulkImport] = useState(false);

  // Server form state
  const [serverName, setServerName] = useState("");
  const [serverKind, setServerKind] = useState<ServerVaultKind>("ssh");
  const [serverHost, setServerHost] = useState("");
  const [serverPort, setServerPort] = useState("22");
  const [serverUser, setServerUser] = useState("root");
  const [serverKeyPath, setServerKeyPath] = useState("");
  const [serverJump, setServerJump] = useState("");
  const [serverProxyId, setServerProxyId] = useState<string>("none");
  const [serverWorkdir, setServerWorkdir] = useState("");
  const [serverGhostDefault, setServerGhostDefault] = useState(true);

  // Compartment form state
  const [compName, setCompName] = useState("");
  const [compProxyId, setCompProxyId] = useState<string>("none");
  const [compKillSwitch, setCompKillSwitch] = useState(false);
  const [compGitName, setCompGitName] = useState("");
  const [compGitEmail, setCompGitEmail] = useState("");
  const [compGitKey, setCompGitKey] = useState("");
  const [compTimezone, setCompTimezone] = useState("");
  const [compBindings, setCompBindings] = useState("");

  // DLP sandbox state
  const [dlpTestText, setDlpTestText] = useState("");

  // Egress custom host input
  const [egressHostDraft, setEgressHostDraft] = useState("");

  // Clock for burn-after-TTL countdown display
  const [nowMs, setNowMs] = useState(() => Date.now());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads privacy vault snapshot when Settings opens
  useEffect(() => {
    void refreshPrivacyVault();
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps burn-after-TTL countdown badges fresh
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const notifyResult = (ok: boolean, successTitle: string, errorMessage?: string) => {
    toastManager.add(
      stackedThreadToast({
        type: ok ? "success" : "error",
        title: ok ? successTitle : (errorMessage ?? gt("Action failed")),
      }),
    );
  };

  const handleUnlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const res = await unlockPrivacyVault(unlockPassphrase);
    setUnlockPassphrase("");
    notifyResult(res.ok, gt("Vault unlocked"), res.error);
  };

  const handleAddProxy = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!proxyUrl.trim()) return;
    const res = await addVaultProxy({ name: proxyName, url: proxyUrl });
    if (res.ok) {
      setProxyName("");
      setProxyUrl("");
    }
    notifyResult(res.ok, gt("Proxy saved to vault"), res.error);
  };

  const handleBulkImport = async () => {
    if (!bulkProxyInput.trim()) return;
    const res = await bulkImportVaultProxies(bulkProxyInput);
    if (res.ok) {
      setBulkProxyInput("");
      setShowBulkImport(false);
    }
    toastManager.add(
      stackedThreadToast({
        type: res.ok ? "success" : "error",
        title: res.ok
          ? gt("Imported {count} proxies", { count: res.detail?.added ?? 0 })
          : (res.error ?? gt("Import failed")),
        ...(res.detail && res.detail.invalidLines.length > 0
          ? {
              description: gt("Skipped {count} invalid lines", {
                count: res.detail.invalidLines.length,
              }),
            }
          : {}),
      }),
    );
  };

  const handleTestProxy = async (id: string) => {
    const res = await testVaultProxy(id);
    if (!res.ok || !res.detail) {
      notifyResult(false, "", res.error ?? gt("Proxy test failed"));
      return;
    }
    toastManager.add(
      stackedThreadToast({
        type: res.detail.ok ? "success" : "error",
        title: res.detail.ok
          ? gt("Proxy reachable ({ms} ms)", { ms: res.detail.latencyMs ?? 0 })
          : gt("Proxy unreachable"),
        description: res.detail.ok
          ? res.detail.dnsLeakProtected
            ? gt("Remote DNS resolution active (DNS leak protected).")
            : gt("Warning: local DNS resolution. Prefer socks5h:// or http://.")
          : (res.detail.error ?? undefined),
      }),
    );
  };

  const handleAddServer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!serverHost.trim()) return;
    const portNum = Number.parseInt(serverPort, 10) || 22;
    const res = await upsertVaultServer({
      name: serverName || serverHost,
      kind: serverKind,
      host: serverHost,
      port: portNum,
      username: serverUser || "root",
      identityFile: serverKeyPath || null,
      proxyJump: serverJump || null,
      proxyId: serverProxyId === "none" ? null : serverProxyId,
      defaultWorkdir: serverWorkdir || null,
      ghostModeDefault: serverGhostDefault,
    });
    if (res.ok) {
      setServerName("");
      setServerHost("");
      setServerKeyPath("");
      setServerJump("");
      setServerWorkdir("");
    }
    notifyResult(res.ok, gt("Server saved to vault"), res.error);
  };

  const handleCopyServerCommand = async (id: string, ghost: boolean) => {
    const command = await buildVaultServerCommand(id, ghost);
    if (!command) {
      notifyResult(false, "", gt("Could not build SSH command"));
      return;
    }
    await navigator.clipboard?.writeText(command).catch(() => undefined);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: gt("SSH command copied to clipboard"),
        description: command,
      }),
    );
  };

  const handleAddCompartment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!compName.trim()) return;
    const res = await upsertVaultCompartment({
      name: compName,
      proxyId: compProxyId === "none" ? null : compProxyId,
      killSwitch: compKillSwitch,
      gitAuthorName: compGitName || null,
      gitAuthorEmail: compGitEmail || null,
      gitSshKeyPath: compGitKey || null,
      timezone: compTimezone || null,
      projectBindings: compBindings
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    });
    if (res.ok) {
      setCompName("");
      setCompGitName("");
      setCompGitEmail("");
      setCompGitKey("");
      setCompTimezone("");
      setCompBindings("");
    }
    notifyResult(res.ok, gt("Identity compartment created"), res.error);
  };

  const handleCreateBurner = async () => {
    const res = await createBurnerVaultCompartment();
    notifyResult(res.ok, gt("Burner RAM compartment activated"), res.error);
  };

  const handleToggleDlpRule = (category: DlpRuleCategory, enabled: boolean) => {
    void updateVaultDlp({
      ...dlpConfig,
      rules: { ...dlpConfig.rules, [category]: enabled },
    });
  };

  const handleSetDlpMode = (mode: DlpMode) => {
    void updateVaultDlp({ ...dlpConfig, mode });
  };

  const handleAddEgressHost = (list: "allowlist" | "blocklist") => {
    if (!snapshot || !egressHostDraft.trim()) return;
    const host = egressHostDraft.trim().toLowerCase();
    const nextPolicy = {
      ...snapshot.egress,
      [list]: Array.from(new Set([...snapshot.egress[list], host])),
    };
    setEgressHostDraft("");
    void updateVaultEgress(nextPolicy);
  };

  const handleApplyEgressPreset = (presetKey: string) => {
    if (!snapshot) return;
    const hosts = EGRESS_PROVIDER_PRESETS[presetKey] ?? [];
    void updateVaultEgress({
      ...snapshot.egress,
      allowlist: Array.from(new Set([...snapshot.egress.allowlist, ...hosts])),
    });
  };

  const handleEnableEncryption = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const res = await configureVaultEncryption({
      action: "enable",
      newPassphrase: masterPassDraft,
    });
    if (res.ok) setMasterPassDraft("");
    notifyResult(res.ok, gt("Vault encrypted with AES-256-GCM"), res.error);
  };

  const handleDisableEncryption = async () => {
    const res = await configureVaultEncryption({
      action: "disable",
      currentPassphrase: currentPassDraft,
    });
    if (res.ok) setCurrentPassDraft("");
    notifyResult(res.ok, gt("Vault encryption disabled"), res.error);
  };

  const dlpRuleLabel = (category: DlpRuleCategory): string => {
    switch (category) {
      case "api-keys":
        return gt("API keys & access tokens");
      case "private-keys":
        return gt("Private key blocks (SSH / PEM)");
      case "jwt":
        return gt("JWT bearer tokens");
      case "env-secrets":
        return gt(".env secrets & database URLs");
      case "local-paths":
        return gt("Local home paths (/home, /Users)");
      case "ip-addresses":
        return gt("IPv4 addresses");
    }
  };

  const mergedEgressEvents = [...(desktopNetwork?.events ?? []), ...(snapshot?.egressEvents ?? [])]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
    .slice(0, 60);

  const dlpPreview = dlpTestText.trim()
    ? scanAndRedactPrompt(dlpTestText, { ...dlpConfig, mode: "redact" })
    : null;

  const serverKindLabel =
    serverKind === "ssh" ? "SSH" : serverKind === "tailscale" ? "Tailscale" : "LAN";
  const serverProxyLabel =
    serverProxyId === "none"
      ? gt("Direct connection (no proxy)")
      : (snapshot?.proxies.find((proxy) => proxy.id === serverProxyId)?.name ??
        gt("Direct connection (no proxy)"));
  const compProxyLabel =
    compProxyId === "none"
      ? gt("Use default / direct proxy")
      : (snapshot?.proxies.find((proxy) => proxy.id === compProxyId)?.name ??
        gt("Use default / direct proxy"));
  const dlpModeLabel =
    dlpConfig.mode === "off"
      ? gt("Off")
      : dlpConfig.mode === "warn"
        ? gt("Warn before send")
        : dlpConfig.mode === "redact"
          ? gt("Auto-redact secrets")
          : gt("Strict block");
  const egressModeLabel =
    snapshot?.egress.mode === "allowlist" ? gt("Strict Allowlist") : gt("Monitor only");

  return (
    <SettingsSection id="privacy-vault" title={gt("Privacy Vault, Compartments & Egress Control")}>
      <div className="flex flex-col gap-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="xs"
              variant={tab === "proxies" ? "default" : "outline"}
              onClick={() => setTab("proxies")}
            >
              <GlobeIcon />
              <T>Proxies</T>
              {snapshot ? ` (${snapshot.proxies.length})` : ""}
            </Button>
            <Button
              size="xs"
              variant={tab === "servers" ? "default" : "outline"}
              onClick={() => setTab("servers")}
            >
              <ServerIcon />
              <T>Servers</T>
              {snapshot ? ` (${snapshot.servers.length})` : ""}
            </Button>
            <Button
              size="xs"
              variant={tab === "compartments" ? "default" : "outline"}
              onClick={() => setTab("compartments")}
            >
              <LayersIcon />
              <T>Compartments</T>
              {snapshot ? ` (${snapshot.compartments.length})` : ""}
            </Button>
            <Button
              size="xs"
              variant={tab === "dlp" ? "default" : "outline"}
              onClick={() => setTab("dlp")}
            >
              <ShieldAlertIcon />
              <T>DLP Guard</T>
            </Button>
            <Button
              size="xs"
              variant={tab === "egress" ? "default" : "outline"}
              onClick={() => setTab("egress")}
            >
              <NetworkIcon />
              <T>Egress</T>
            </Button>
            <Button
              size="xs"
              variant={tab === "crypto" ? "default" : "outline"}
              onClick={() => setTab("crypto")}
            >
              <KeyRoundIcon />
              <T>Crypto &amp; Burn</T>
            </Button>
          </div>
          <Button
            size="xs"
            variant="ghost"
            disabled={loading}
            onClick={() => void refreshPrivacyVault()}
          >
            <RefreshCwIcon />
            <T>Refresh</T>
          </Button>
        </div>

        {snapshot?.locked ? (
          <form
            onSubmit={(event) => void handleUnlock(event)}
            className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4"
          >
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <LockIcon className="size-4 text-warning" />
              <T>Privacy Vault is encrypted and locked</T>
            </div>
            <p className="text-xs text-muted-foreground">
              <T>Enter your master password to decrypt proxies, servers, and identity profiles.</T>
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="password"
                value={unlockPassphrase}
                onChange={(event) => setUnlockPassphrase(event.target.value)}
                placeholder={gt("Master password")}
                autoComplete="current-password"
              />
              <Button size="xs" type="submit" disabled={busy || unlockPassphrase.length === 0}>
                <UnlockIcon />
                <T>Unlock vault</T>
              </Button>
            </div>
          </form>
        ) : snapshot ? (
          <>
            {/* TAB 1: PROXY VAULT */}
            {tab === "proxies" ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/20 px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-foreground">
                      <T>Proxy Kill-Switch (Fail-Closed)</T>
                    </span>
                    <span className="text-2xs text-muted-foreground">
                      <T>Block outbound traffic instead of falling back to your direct IP.</T>
                    </span>
                  </div>
                  <Switch
                    checked={snapshot.egress.killSwitchActive}
                    onCheckedChange={(checked) =>
                      void updateVaultEgress({ ...snapshot.egress, killSwitchActive: checked })
                    }
                  />
                </div>

                <form
                  onSubmit={(event) => void handleAddProxy(event)}
                  className="grid grid-cols-1 gap-2 sm:grid-cols-3"
                >
                  <Input
                    value={proxyName}
                    onChange={(event) => setProxyName(event.target.value)}
                    placeholder={gt("Label (e.g. Tor EU)")}
                  />
                  <Input
                    value={proxyUrl}
                    onChange={(event) => setProxyUrl(event.target.value)}
                    placeholder="socks5h://user:pass@127.0.0.1:9050"
                  />
                  <div className="flex items-center gap-1.5">
                    <Button size="xs" type="submit" disabled={busy || !proxyUrl.trim()}>
                      <PlusIcon />
                      <T>Add proxy</T>
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      type="button"
                      onClick={() => setShowBulkImport((prev) => !prev)}
                    >
                      <T>Bulk import</T>
                    </Button>
                  </div>
                </form>

                {showBulkImport ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                    <Textarea
                      value={bulkProxyInput}
                      onChange={(event) => setBulkProxyInput(event.target.value)}
                      placeholder={
                        "socks5h://127.0.0.1:9050\nhttp://user:pass@proxy.host:8080\nhost:port:user:pass"
                      }
                      rows={4}
                    />
                    <div className="flex items-center gap-2">
                      <Button size="xs" disabled={busy} onClick={() => void handleBulkImport()}>
                        <T>Import list</T>
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setShowBulkImport(false)}>
                        <T>Cancel</T>
                      </Button>
                    </div>
                  </div>
                ) : null}

                {snapshot.proxies.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    <T>No proxies saved yet. Add a SOCKS5h, Tor, or HTTP(S) proxy above.</T>
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {snapshot.proxies.map((proxy) => {
                      const isDefault = snapshot.defaultProxyId === proxy.id;
                      return (
                        <div
                          key={proxy.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2"
                        >
                          <div className="flex flex-col gap-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="text-xs font-medium text-foreground">
                                {proxy.name}
                              </span>
                              {isDefault ? (
                                <Badge size="sm" variant="info">
                                  <T>Default</T>
                                </Badge>
                              ) : null}
                              <Badge
                                size="sm"
                                variant={proxy.dnsLeakProtected ? "success" : "warning"}
                              >
                                {proxy.dnsLeakProtected ? <T>DNS Safe</T> : <T>Local DNS risk</T>}
                              </Badge>
                              {proxy.lastCheck ? (
                                <Badge size="sm" variant={proxy.lastCheck.ok ? "success" : "error"}>
                                  {proxy.lastCheck.ok
                                    ? `${proxy.lastCheck.latencyMs ?? 0} ms`
                                    : gt("Offline")}
                                </Badge>
                              ) : null}
                            </div>
                            <span className="font-mono text-2xs text-muted-foreground">
                              {proxy.displayUrl}
                            </span>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void handleTestProxy(proxy.id)}
                            >
                              <T>Test</T>
                            </Button>
                            <Button
                              size="xs"
                              variant={isDefault ? "secondary" : "outline"}
                              disabled={busy}
                              onClick={() => void setDefaultVaultProxy(isDefault ? null : proxy.id)}
                            >
                              {isDefault ? <T>Clear default</T> : <T>Set default</T>}
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void deleteVaultProxy(proxy.id)}
                            >
                              <Trash2Icon />
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}

            {/* TAB 2: SERVER & SSH/TAILSCALE VAULT */}
            {tab === "servers" ? (
              <div className="flex flex-col gap-3">
                <form
                  onSubmit={(event) => void handleAddServer(event)}
                  className="grid grid-cols-1 gap-2 rounded-lg border border-border/70 p-3 sm:grid-cols-2"
                >
                  <Input
                    value={serverName}
                    onChange={(event) => setServerName(event.target.value)}
                    placeholder={gt("Server name (e.g. VPS Frankfurt)")}
                  />
                  <Select
                    value={serverKind}
                    onValueChange={(value) => {
                      if (value === "ssh" || value === "lan" || value === "tailscale") {
                        setServerKind(value);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue>{serverKindLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="ssh">SSH</SelectItem>
                      <SelectItem value="tailscale">Tailscale</SelectItem>
                      <SelectItem value="lan">LAN</SelectItem>
                    </SelectPopup>
                  </Select>
                  <Input
                    value={serverHost}
                    onChange={(event) => setServerHost(event.target.value)}
                    placeholder={gt("Host or IP (e.g. 100.64.0.5)")}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      value={serverPort}
                      onChange={(event) => setServerPort(event.target.value)}
                      placeholder="22"
                    />
                    <Input
                      value={serverUser}
                      onChange={(event) => setServerUser(event.target.value)}
                      placeholder={gt("Username")}
                    />
                  </div>
                  <Input
                    value={serverKeyPath}
                    onChange={(event) => setServerKeyPath(event.target.value)}
                    placeholder={gt("SSH key path (optional, e.g. ~/.ssh/id_ed25519)")}
                  />
                  <Input
                    value={serverJump}
                    onChange={(event) => setServerJump(event.target.value)}
                    placeholder={gt("ProxyJump bastion (optional)")}
                  />
                  <Input
                    value={serverWorkdir}
                    onChange={(event) => setServerWorkdir(event.target.value)}
                    placeholder={gt("Default remote workdir (optional)")}
                  />
                  <Select
                    value={serverProxyId}
                    onValueChange={(value) => setServerProxyId(value ?? "none")}
                  >
                    <SelectTrigger>
                      <SelectValue>{serverProxyLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="none">
                        <T>Direct connection (no proxy)</T>
                      </SelectItem>
                      {snapshot.proxies.map((proxy) => (
                        <SelectItem key={proxy.id} value={proxy.id}>
                          {proxy.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <div className="flex items-center justify-between gap-2 sm:col-span-2">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Switch
                        checked={serverGhostDefault}
                        onCheckedChange={setServerGhostDefault}
                      />
                      <T>Launch remote V3 in Ghost Mode (--ghost --no-logs)</T>
                    </label>
                    <Button size="xs" type="submit" disabled={busy || !serverHost.trim()}>
                      <PlusIcon />
                      <T>Save server</T>
                    </Button>
                  </div>
                </form>

                {snapshot.servers.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    <T>No servers saved yet. Add SSH, LAN, or Tailscale hosts above.</T>
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {snapshot.servers.map((server) => (
                      <div
                        key={server.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2"
                      >
                        <div className="flex flex-col gap-0.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs font-medium text-foreground">
                              {server.name}
                            </span>
                            <Badge size="sm" variant="outline">
                              {server.kind.toUpperCase()}
                            </Badge>
                            {server.ghostModeDefault ? (
                              <Badge size="sm" variant="info">
                                <T>Ghost</T>
                              </Badge>
                            ) : null}
                            {server.lastProbe ? (
                              <Badge
                                size="sm"
                                variant={server.lastProbe.reachable ? "success" : "error"}
                              >
                                {server.lastProbe.reachable
                                  ? `${server.lastProbe.latencyMs ?? 0} ms`
                                  : gt("Unreachable")}
                              </Badge>
                            ) : null}
                          </div>
                          <span className="font-mono text-2xs text-muted-foreground">
                            {server.username}@{server.host}:{server.port}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busy}
                            onClick={() => void probeVaultServer(server.id)}
                          >
                            <T>Ping</T>
                          </Button>
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={busy}
                            onClick={() =>
                              void handleCopyServerCommand(server.id, server.ghostModeDefault)
                            }
                          >
                            <CopyIcon />
                            <T>Copy SSH command</T>
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void deleteVaultServer(server.id)}
                          >
                            <Trash2Icon />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            {/* TAB 3: IDENTITY COMPARTMENTS */}
            {tab === "compartments" ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    <T>
                      Isolate proxy routing, git author/SSH key, timezone, and browser partition per
                      profile.
                    </T>
                  </p>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void handleCreateBurner()}
                  >
                    <FlameIcon />
                    <T>New Burner (RAM)</T>
                  </Button>
                </div>

                <div className="flex flex-col gap-2">
                  {snapshot.compartments.map((comp) => {
                    const isActive = snapshot.activeCompartmentId === comp.id;
                    const boundProxy = comp.proxyId
                      ? snapshot.proxies.find((p) => p.id === comp.proxyId)
                      : null;
                    return (
                      <div
                        key={comp.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2"
                      >
                        <div className="flex flex-col gap-0.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs font-medium text-foreground">{comp.name}</span>
                            {isActive ? (
                              <Badge size="sm" variant="success">
                                <T>Active</T>
                              </Badge>
                            ) : null}
                            {comp.ephemeral ? (
                              <Badge size="sm" variant="warning">
                                <T>Burner RAM</T>
                              </Badge>
                            ) : null}
                            {comp.killSwitch ? (
                              <Badge size="sm" variant="error">
                                <T>Kill-Switch</T>
                              </Badge>
                            ) : null}
                          </div>
                          <span className="font-mono text-2xs text-muted-foreground">
                            {boundProxy ? boundProxy.displayUrl : gt("Default / Direct proxy")}
                            {comp.gitAuthorEmail
                              ? ` | ${gt("git: {email}", { email: comp.gitAuthorEmail })}`
                              : ""}
                            {comp.timezone ? ` | ${gt("TZ: {tz}", { tz: comp.timezone })}` : ""}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          {!isActive ? (
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={busy}
                              onClick={() => void activateVaultCompartment(comp.id)}
                            >
                              <T>Activate</T>
                            </Button>
                          ) : null}
                          {comp.id !== DEFAULT_COMPARTMENT_ID ? (
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void deleteVaultCompartment(comp.id)}
                            >
                              <Trash2Icon />
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <form
                  onSubmit={(event) => void handleAddCompartment(event)}
                  className="grid grid-cols-1 gap-2 rounded-lg border border-border/70 p-3 sm:grid-cols-2"
                >
                  <Input
                    value={compName}
                    onChange={(event) => setCompName(event.target.value)}
                    placeholder={gt("Compartment name (e.g. Research Tor)")}
                  />
                  <Select
                    value={compProxyId}
                    onValueChange={(value) => setCompProxyId(value ?? "none")}
                  >
                    <SelectTrigger>
                      <SelectValue>{compProxyLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="none">
                        <T>Use default / direct proxy</T>
                      </SelectItem>
                      {snapshot.proxies.map((proxy) => (
                        <SelectItem key={proxy.id} value={proxy.id}>
                          {proxy.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <Input
                    value={compGitName}
                    onChange={(event) => setCompGitName(event.target.value)}
                    placeholder={gt("Git author name (optional)")}
                  />
                  <Input
                    value={compGitEmail}
                    onChange={(event) => setCompGitEmail(event.target.value)}
                    placeholder={gt("Git author email (optional)")}
                  />
                  <Input
                    value={compGitKey}
                    onChange={(event) => setCompGitKey(event.target.value)}
                    placeholder={gt("Git SSH key path (optional)")}
                  />
                  <Input
                    value={compTimezone}
                    onChange={(event) => setCompTimezone(event.target.value)}
                    placeholder={gt("Timezone (e.g. UTC)")}
                  />
                  <Input
                    value={compBindings}
                    onChange={(event) => setCompBindings(event.target.value)}
                    placeholder={gt("Bound project paths, comma separated (optional)")}
                    className="sm:col-span-2"
                  />
                  <div className="flex items-center justify-between gap-2 sm:col-span-2">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Switch checked={compKillSwitch} onCheckedChange={setCompKillSwitch} />
                      <T>Enable fail-closed Kill-Switch for this profile</T>
                    </label>
                    <Button size="xs" type="submit" disabled={busy || !compName.trim()}>
                      <PlusIcon />
                      <T>Create profile</T>
                    </Button>
                  </div>
                </form>
              </div>
            ) : null}

            {/* TAB 4: OUTBOUND PROMPT DLP GUARD */}
            {tab === "dlp" ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-foreground">
                      <T>Outbound Prompt Secret &amp; Path DLP Mode</T>
                    </span>
                    <span className="text-2xs text-muted-foreground">
                      <T>Scans outgoing messages locally before they reach any LLM provider.</T>
                    </span>
                  </div>
                  <Select
                    value={dlpConfig.mode}
                    onValueChange={(value) => {
                      if (
                        value === "off" ||
                        value === "warn" ||
                        value === "redact" ||
                        value === "block"
                      ) {
                        handleSetDlpMode(value);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue>{dlpModeLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="off">
                        <T>Off</T>
                      </SelectItem>
                      <SelectItem value="warn">
                        <T>Warn before send</T>
                      </SelectItem>
                      <SelectItem value="redact">
                        <T>Auto-redact secrets</T>
                      </SelectItem>
                      <SelectItem value="block">
                        <T>Strict block</T>
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {DLP_RULE_CATEGORIES.map((category) => (
                    <label
                      key={category}
                      className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs text-foreground"
                    >
                      <span>{dlpRuleLabel(category)}</span>
                      <Switch
                        checked={dlpConfig.rules[category]}
                        onCheckedChange={(checked) => handleToggleDlpRule(category, checked)}
                      />
                    </label>
                  ))}
                </div>

                <div className="flex flex-col gap-2 rounded-lg border border-border/70 p-3">
                  <span className="text-xs font-medium text-foreground">
                    <T>Live DLP test scanner</T>
                  </span>
                  <Textarea
                    value={dlpTestText}
                    onChange={(event) => setDlpTestText(event.target.value)}
                    placeholder={gt(
                      "Paste a sample snippet with a key or /home/user path to preview redaction...",
                    )}
                    rows={3}
                  />
                  {dlpPreview ? (
                    <div className="flex flex-col gap-1.5 text-xs">
                      {dlpPreview.hasFindings ? (
                        <>
                          <span className="font-medium text-warning">
                            <T>
                              Detected <Var>{dlpPreview.findings.length}</Var> sensitive item(s):
                            </T>
                          </span>
                          <pre className="overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-2xs text-foreground">
                            {dlpPreview.redactedText}
                          </pre>
                        </>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-success">
                          <ShieldCheckIcon className="size-3.5" />
                          <T>No sensitive tokens detected.</T>
                        </span>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* TAB 5: NETWORK EGRESS MONITOR */}
            {tab === "egress" ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 px-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-foreground">
                      <T>Egress Enforcement Mode</T>
                    </span>
                    <span className="text-2xs text-muted-foreground">
                      <T>
                        Monitor logs outbound hostnames; Strict Allowlist blocks unlisted hosts in
                        Desktop &amp; probes.
                      </T>
                    </span>
                  </div>
                  <Select
                    value={snapshot.egress.mode}
                    onValueChange={(value) => {
                      if (value === "monitor" || value === "allowlist") {
                        void updateVaultEgress({ ...snapshot.egress, mode: value });
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue>{egressModeLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="monitor">
                        <T>Monitor only</T>
                      </SelectItem>
                      <SelectItem value="allowlist">
                        <T>Strict Allowlist</T>
                      </SelectItem>
                    </SelectPopup>
                  </Select>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-2xs text-muted-foreground">
                    <T>Allow presets:</T>
                  </span>
                  {Object.keys(EGRESS_PROVIDER_PRESETS).map((presetKey) => (
                    <Button
                      key={presetKey}
                      size="xs"
                      variant="outline"
                      onClick={() => handleApplyEgressPreset(presetKey)}
                    >
                      + {presetKey}
                    </Button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={egressHostDraft}
                    onChange={(event) => setEgressHostDraft(event.target.value)}
                    placeholder={gt("Domain or wildcard (e.g. *.anthropic.com)")}
                  />
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!egressHostDraft.trim()}
                    onClick={() => handleAddEgressHost("allowlist")}
                  >
                    <T>Allow host</T>
                  </Button>
                  <Button
                    size="xs"
                    variant="destructive"
                    disabled={!egressHostDraft.trim()}
                    onClick={() => handleAddEgressHost("blocklist")}
                  >
                    <T>Block host</T>
                  </Button>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {snapshot.egress.allowlist.map((host) => (
                    <Badge key={`allow-${host}`} size="sm" variant="success">
                      {host}
                      <button
                        type="button"
                        className="ml-1 opacity-70 hover:opacity-100"
                        onClick={() =>
                          void updateVaultEgress({
                            ...snapshot.egress,
                            allowlist: snapshot.egress.allowlist.filter((item) => item !== host),
                          })
                        }
                      >
                        x
                      </button>
                    </Badge>
                  ))}
                  {snapshot.egress.blocklist.map((host) => (
                    <Badge key={`block-${host}`} size="sm" variant="error">
                      {host}
                      <button
                        type="button"
                        className="ml-1 opacity-70 hover:opacity-100"
                        onClick={() =>
                          void updateVaultEgress({
                            ...snapshot.egress,
                            blocklist: snapshot.egress.blocklist.filter((item) => item !== host),
                          })
                        }
                      >
                        x
                      </button>
                    </Badge>
                  ))}
                </div>

                <div className="flex flex-col gap-2 rounded-lg border border-border/70 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-foreground">
                      <T>Recent outbound connections</T>
                    </span>
                    <Button size="xs" variant="ghost" onClick={() => void clearVaultEgressLog()}>
                      <T>Clear log</T>
                    </Button>
                  </div>
                  {mergedEgressEvents.length === 0 ? (
                    <p className="text-2xs text-muted-foreground">
                      <T>No outbound events recorded yet.</T>
                    </p>
                  ) : (
                    <div className="flex max-h-48 flex-col gap-1 overflow-y-auto font-mono text-2xs">
                      {mergedEgressEvents.map((ev) => (
                        <div
                          key={ev.id}
                          className="flex items-center justify-between gap-2 border-b border-border/40 py-1"
                        >
                          <span className="truncate text-foreground">
                            {ev.protocol}://{ev.host}
                          </span>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <Badge
                              size="sm"
                              variant={ev.action === "allowed" ? "success" : "error"}
                            >
                              {ev.action}
                            </Badge>
                            {ev.reason ? (
                              <span className="text-muted-foreground">{ev.reason}</span>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {/* TAB 6: VAULT AT-REST ENCRYPTION & BURN-AFTER-TTL */}
            {tab === "crypto" ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2 rounded-lg border border-border/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <KeyRoundIcon className="size-4 text-foreground" />
                      <span className="text-xs font-medium text-foreground">
                        <T>Vault At-Rest Encryption (AES-256-GCM + PBKDF2-SHA256)</T>
                      </span>
                    </div>
                    <Badge size="sm" variant={snapshot.encrypted ? "success" : "warning"}>
                      {snapshot.encrypted ? <T>Encrypted</T> : <T>Unencrypted (0600 file)</T>}
                    </Badge>
                  </div>
                  {snapshot.encrypted ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void lockPrivacyVault()}
                      >
                        <LockIcon />
                        <T>Lock vault now</T>
                      </Button>
                      <Input
                        type="password"
                        value={currentPassDraft}
                        onChange={(event) => setCurrentPassDraft(event.target.value)}
                        placeholder={gt("Current password to remove encryption")}
                      />
                      <Button
                        size="xs"
                        variant="destructive"
                        disabled={busy || currentPassDraft.length === 0}
                        onClick={() => void handleDisableEncryption()}
                      >
                        <T>Remove encryption</T>
                      </Button>
                    </div>
                  ) : (
                    <form
                      onSubmit={(event) => void handleEnableEncryption(event)}
                      className="flex flex-wrap items-center gap-2"
                    >
                      <Input
                        type="password"
                        value={masterPassDraft}
                        onChange={(event) => setMasterPassDraft(event.target.value)}
                        placeholder={gt("Master password (min 6 chars)")}
                        autoComplete="new-password"
                      />
                      <Button size="xs" type="submit" disabled={busy || masterPassDraft.length < 6}>
                        <LockIcon />
                        <T>Encrypt vault</T>
                      </Button>
                    </form>
                  )}
                </div>

                <div className="flex flex-col gap-2 rounded-lg border border-border/70 p-3">
                  <div className="flex items-center gap-2">
                    <FlameIcon className="size-4 text-warning" />
                    <span className="text-xs font-medium text-foreground">
                      <T>Burn-After-TTL Threads</T>
                    </span>
                  </div>
                  <p className="text-2xs text-muted-foreground">
                    <T>
                      Right-click any chat thread and choose Auto-burn thread to schedule automatic
                      deletion.
                    </T>
                  </p>
                  {snapshot.burnThreads.length === 0 ? (
                    <p className="text-2xs text-muted-foreground">
                      <T>No threads scheduled for auto-burn.</T>
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {snapshot.burnThreads.map((entry) => {
                        const remaining = formatBurnRemaining(entry.expiresAt, nowMs);
                        return (
                          <div
                            key={entry.threadId}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 px-2.5 py-1.5"
                          >
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-2xs text-foreground">
                                {entry.threadId}
                              </span>
                              <Badge size="sm" variant="warning">
                                {entry.onExit
                                  ? gt("Burn on exit")
                                  : remaining
                                    ? gt("{time} left", { time: remaining })
                                    : entry.preset}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <Button
                                size="xs"
                                variant="outline"
                                disabled={busy}
                                onClick={() => void clearVaultBurnThread(entry.threadId)}
                              >
                                <T>Cancel</T>
                              </Button>
                              <Button
                                size="xs"
                                variant="destructive"
                                disabled={busy}
                                onClick={() => void burnVaultThreadNow(entry.threadId)}
                              >
                                <FlameIcon />
                                <T>Burn now</T>
                              </Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            <T>Connect to a local V3 server to manage the Privacy Vault.</T>
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
