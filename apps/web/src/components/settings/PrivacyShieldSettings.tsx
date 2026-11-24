import { msg, T, useGT, useMessages, Var } from "gt-react";
import { LockIcon, RefreshCwIcon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { isElectron } from "../../env";
import {
  clearPrivacyPasscode,
  executePanicWipe,
  hasPrivacyPasscode,
  isStrongPasscodeCryptoAvailable,
  lockPrivacyScreen,
  refreshServerPrivacyStatus,
  setPrivacyPasscode,
  updatePrivacyPreferences,
  usePrivacyShieldStore,
  type AutoLockMinutes,
} from "../../lib/privacyShield";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import type { useSearchableSetting } from "./settingsSearch";

const AUTO_LOCK_LABELS: Record<AutoLockMinutes, string> = {
  0: msg("Off"),
  1: msg("1 minute"),
  5: msg("5 minutes"),
  15: msg("15 minutes"),
  30: msg("30 minutes"),
};

const AUTO_LOCK_OPTIONS: ReadonlyArray<AutoLockMinutes> = [0, 1, 5, 15, 30];

export function PrivacyShieldSettingsSection({
  setting,
}: {
  readonly setting: ReturnType<typeof useSearchableSetting>;
}) {
  const gt = useGT();
  const messages = useMessages();
  const preferences = usePrivacyShieldStore((state) => state.preferences);
  const serverStatus = usePrivacyShieldStore((state) => state.serverStatus);
  const serverStatusLoading = usePrivacyShieldStore((state) => state.serverStatusLoading);
  const panicInProgress = usePrivacyShieldStore((state) => state.panicInProgress);

  const [editingPasscode, setEditingPasscode] = useState(false);
  const [passcodeDraft, setPasscodeDraft] = useState("");
  const [confirmPanicMode, setConfirmPanicMode] = useState<null | "this" | "all">(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads live server privacy status when opening Settings
  useEffect(() => {
    void refreshServerPrivacyStatus();
  }, []);

  const passcodeConfigured = hasPrivacyPasscode(preferences);
  const strongCrypto = isStrongPasscodeCryptoAvailable();

  const handleSavePasscode = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const saved = await setPrivacyPasscode(passcodeDraft);
    if (!saved) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Passcode must be at least 4 characters"),
        }),
      );
      return;
    }
    setPasscodeDraft("");
    setEditingPasscode(false);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: gt("Local unlock passcode saved"),
      }),
    );
  };

  const handleClearPasscode = () => {
    clearPrivacyPasscode();
    setPasscodeDraft("");
    setEditingPasscode(false);
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: gt("Local unlock passcode removed"),
      }),
    );
  };

  const handlePanicConfirm = async () => {
    const revokeAll = confirmPanicMode === "all";
    setConfirmPanicMode(null);
    await executePanicWipe({ revokeAll });
  };

  const storageLabel =
    serverStatus?.ephemeral === true
      ? serverStatus.ephemeralStorage === "ram"
        ? gt("Ghost RAM (/dev/shm, wiped on exit)")
        : gt("Ghost Temp (wiped on exit)")
      : gt("Standard local storage");

  return (
    <SettingsSection id="privacy-shield" title={gt("Privacy Shield & Ghost Mode")}>
      <SettingsRow
        {...setting("privacy-shield-status")}
        description={
          <T>
            Launch with v3 --ghost for RAM-only storage, zero disk logs, and scrubbed host
            environment fingerprints. Add --proxy socks5h://127.0.0.1:9050 to route outbound
            provider traffic through Tor or SOCKS5.
          </T>
        }
        status={
          serverStatus ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-2xs font-medium text-foreground">
                <ShieldCheckIcon className="size-3 text-success" />
                <T>
                  Telemetry firewall: <Var>{serverStatus.telemetryOptOutCount}</Var> env guards
                </T>
              </span>
              <span className="inline-flex items-center rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-2xs font-medium text-foreground">
                {storageLabel}
              </span>
              <span className="inline-flex items-center rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-2xs font-medium text-foreground">
                {serverStatus.noLogs ? <T>Disk logs: Off</T> : <T>Disk logs: Local only</T>}
              </span>
              {serverStatus.strictPrivacy ? (
                <span className="inline-flex items-center rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-2xs font-medium text-foreground">
                  <T>
                    Host env scrubbed: <Var>{serverStatus.scrubbedEnvCount}</Var>
                  </T>
                </span>
              ) : null}
              {serverStatus.proxyEnabled && serverStatus.proxyDisplay ? (
                <span className="inline-flex items-center rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-2xs font-medium text-foreground">
                  <T>
                    Proxy: <Var>{serverStatus.proxyDisplay}</Var>
                  </T>
                </span>
              ) : null}
            </div>
          ) : undefined
        }
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={serverStatusLoading}
            onClick={() => void refreshServerPrivacyStatus()}
          >
            <RefreshCwIcon />
            <T>Refresh</T>
          </Button>
        }
      />

      <SettingsRow
        {...setting("privacy-exif-scrub")}
        description={
          <T>
            Losslessly strips GPS coordinates, camera model, Apple MakerNotes, XMP, and PNG text
            timestamps before images are uploaded or stashed.
          </T>
        }
        control={
          <Switch
            checked={preferences.exifScrubEnabled}
            onCheckedChange={(checked) => updatePrivacyPreferences({ exifScrubEnabled: checked })}
            aria-label={gt("Strip EXIF and GPS metadata from images")}
          />
        }
      />

      <SettingsRow
        {...setting("privacy-app-switcher-curtain")}
        description={
          <T>
            Covers the screen with an opaque shield whenever V3 Code moves to the background so iOS
            App Switcher and task previews never capture prompts or code.
          </T>
        }
        control={
          <Switch
            checked={preferences.hideInAppSwitcher}
            onCheckedChange={(checked) => updatePrivacyPreferences({ hideInAppSwitcher: checked })}
            aria-label={gt("Hide screen in App Switcher")}
          />
        }
      />

      <SettingsRow
        {...setting("privacy-auto-lock")}
        description={
          <T>
            Automatically covers V3 Code after inactivity. Press Alt+Shift+L anytime to lock
            immediately.
          </T>
        }
        control={
          <Select
            value={String(preferences.autoLockMinutes)}
            onValueChange={(value) => {
              const parsed = Number(value);
              if (parsed === 0 || parsed === 1 || parsed === 5 || parsed === 15 || parsed === 30) {
                updatePrivacyPreferences({ autoLockMinutes: parsed });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={gt("Auto-lock timer")}>
              <SelectValue>{messages(AUTO_LOCK_LABELS[preferences.autoLockMinutes])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {AUTO_LOCK_OPTIONS.map((minutes) => (
                <SelectItem hideIndicator key={minutes} value={String(minutes)}>
                  {messages(AUTO_LOCK_LABELS[minutes])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        {...setting("privacy-passcode")}
        description={
          passcodeConfigured ? (
            strongCrypto ? (
              <T>A PBKDF2-SHA256 local passcode protects unlocking this browser or PWA.</T>
            ) : (
              <T>
                A local passcode is active. Open over HTTPS or localhost for full Web Crypto PBKDF2
                protection.
              </T>
            )
          ) : (
            <T>
              Optional local passcode required to unlock after Quick Lock or inactivity auto-lock.
            </T>
          )
        }
        status={
          editingPasscode ? (
            <form className="mt-1.5 flex max-w-xs items-center gap-2" onSubmit={handleSavePasscode}>
              <Input
                type="password"
                autoComplete="new-password"
                value={passcodeDraft}
                onChange={(event) => setPasscodeDraft(event.target.value)}
                placeholder={gt("At least 4 characters")}
                aria-label={gt("New unlock passcode")}
              />
              <Button size="xs" type="submit">
                <T>Save</T>
              </Button>
              <Button
                size="xs"
                variant="ghost"
                type="button"
                onClick={() => {
                  setEditingPasscode(false);
                  setPasscodeDraft("");
                }}
              >
                <T>Cancel</T>
              </Button>
            </form>
          ) : undefined
        }
        control={
          <div className="flex items-center gap-2">
            <Button size="xs" variant="outline" onClick={lockPrivacyScreen}>
              <LockIcon />
              <T>Lock now</T>
            </Button>
            {passcodeConfigured ? (
              <Button size="xs" variant="ghost" onClick={handleClearPasscode}>
                <T>Remove</T>
              </Button>
            ) : (
              <Button size="xs" variant="outline" onClick={() => setEditingPasscode(true)}>
                <T>Set passcode</T>
              </Button>
            )}
          </div>
        }
      />

      <SettingsRow
        {...setting("privacy-panic-wipe")}
        description={
          isElectron ? (
            <T>
              Revokes all paired phones, browsers, and active pairing links on the server, wipes
              renderer storage and caches, and locks this window.
            </T>
          ) : (
            <T>
              Instantly revokes the session on the server, expires the HttpOnly cookie, clears
              localStorage, IndexedDB, and Service Worker caches, and locks the screen.
            </T>
          )
        }
        status={
          confirmPanicMode !== null ? (
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <span className="text-xs text-destructive">
                {confirmPanicMode === "all" ? (
                  <T>Revoke every paired device and wipe local data now?</T>
                ) : (
                  <T>Revoke this device session and wipe local storage now?</T>
                )}
              </span>
              <Button
                size="xs"
                variant="destructive"
                disabled={panicInProgress}
                onClick={() => void handlePanicConfirm()}
              >
                <T>Confirm wipe</T>
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={panicInProgress}
                onClick={() => setConfirmPanicMode(null)}
              >
                <T>Cancel</T>
              </Button>
            </div>
          ) : undefined
        }
        control={
          <div className="flex flex-wrap items-center gap-2">
            {!isElectron ? (
              <Button
                size="xs"
                variant="outline"
                disabled={panicInProgress}
                onClick={() => setConfirmPanicMode("this")}
              >
                <ShieldAlertIcon />
                <T>Wipe this device</T>
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="destructive"
              disabled={panicInProgress}
              onClick={() => setConfirmPanicMode("all")}
            >
              {isElectron ? <T>Revoke paired devices &amp; wipe cache</T> : <T>Panic wipe all</T>}
            </Button>
          </div>
        }
      />
    </SettingsSection>
  );
}
