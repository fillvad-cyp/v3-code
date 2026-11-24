import { T, useGT, Var } from "gt-react";
import { LockIcon, RefreshCwIcon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  executePanicWipe,
  hasPrivacyPasscode,
  unlockPrivacyScreen,
  usePrivacyShieldStore,
} from "../../lib/privacyShield";

export function PrivacyLockOverlayHost() {
  const locked = usePrivacyShieldStore((state) => state.locked);
  const curtainVisible = usePrivacyShieldStore((state) => state.curtainVisible);
  const wiped = usePrivacyShieldStore((state) => state.wiped);
  const lastWipeServerRevoked = usePrivacyShieldStore((state) => state.lastWipeServerRevoked);
  const panicInProgress = usePrivacyShieldStore((state) => state.panicInProgress);
  const preferences = usePrivacyShieldStore((state) => state.preferences);

  const [passcode, setPasscode] = useState("");
  const [unlockError, setUnlockError] = useState<null | {
    readonly kind: "wrong" | "cooldown";
    readonly seconds?: number;
  }>(null);
  const [confirmPanic, setConfirmPanic] = useState(false);
  const gt = useGT();

  if (!locked && !curtainVisible && !wiped) {
    return null;
  }

  const requiresPasscode = hasPrivacyPasscode(preferences);

  const handleUnlockSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = await unlockPrivacyScreen(passcode);
    if (result.ok) {
      setPasscode("");
      setUnlockError(null);
      setConfirmPanic(false);
      return;
    }
    if (result.reason === "cooldown") {
      setUnlockError({
        kind: "cooldown",
        seconds: Math.max(1, Math.ceil((result.retryAfterMs ?? 1000) / 1000)),
      });
    } else {
      setUnlockError({ kind: "wrong" });
    }
  };

  const handleTapUnlock = async () => {
    const result = await unlockPrivacyScreen();
    if (result.ok) {
      setPasscode("");
      setUnlockError(null);
      setConfirmPanic(false);
    }
  };

  const handlePanicFromLock = async () => {
    if (!confirmPanic) {
      setConfirmPanic(true);
      return;
    }
    setConfirmPanic(false);
    await executePanicWipe({ revokeAll: true });
  };

  // App Switcher curtain: instant opaque cover above popovers/toasts without interactive form.
  if (curtainVisible && !locked && !wiped) {
    return (
      <div
        className="fixed inset-0 z-[250] flex flex-col items-center justify-center gap-3 bg-background text-foreground select-none"
        data-testid="privacy-curtain-overlay"
      >
        <div className="flex size-14 items-center justify-center rounded-2xl border border-border bg-card">
          <ShieldCheckIcon className="size-7 text-foreground" />
        </div>
        <p className="text-sm font-medium text-muted-foreground">
          <T>V3 Code Privacy Shield</T>
        </p>
      </div>
    );
  }

  if (wiped) {
    return (
      <div
        className="fixed inset-0 z-[250] flex items-center justify-center bg-background p-6 text-foreground"
        data-testid="privacy-wiped-overlay"
      >
        <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-xl border border-border bg-card p-6 text-center">
          <div className="flex size-12 items-center justify-center rounded-full border border-destructive/30 bg-destructive/10 text-destructive">
            <ShieldAlertIcon className="size-6" />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-base font-semibold">
              <T>Session wiped and locked</T>
            </h1>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {lastWipeServerRevoked === false ? (
                <T>
                  Local storage, IndexedDB, and caches were cleared, but the server could not be
                  reached to confirm remote revocation.
                </T>
              ) : (
                <T>
                  Browser storage, IndexedDB, caches, and active server sessions were cleared.
                  Reload when you are ready to pair again.
                </T>
              )}
            </p>
          </div>
          <Button onClick={() => window.location.reload()}>
            <RefreshCwIcon />
            <T>Reload V3 Code</T>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[250] flex items-center justify-center bg-background p-6 text-foreground"
      data-testid="privacy-lock-overlay"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-5 rounded-xl border border-border bg-card p-6 text-center">
        <div className="flex size-12 items-center justify-center rounded-full border border-border bg-muted/40">
          <LockIcon className="size-5 text-foreground" />
        </div>
        <div className="space-y-1">
          <h1 className="text-base font-semibold">
            <T>V3 Code is locked</T>
          </h1>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {requiresPasscode ? (
              <T>Enter your local unlock passcode to resume this session.</T>
            ) : (
              <T>Screen contents are hidden by Privacy Shield.</T>
            )}
          </p>
        </div>

        {requiresPasscode ? (
          <form className="flex w-full flex-col gap-3" onSubmit={handleUnlockSubmit}>
            <Input
              type="password"
              autoFocus
              autoComplete="off"
              value={passcode}
              onChange={(event) => {
                setPasscode(event.target.value);
                if (unlockError !== null) setUnlockError(null);
              }}
              placeholder={gt("Passcode")}
              aria-label={gt("Unlock passcode")}
            />
            {unlockError?.kind === "cooldown" ? (
              <p className="text-xs text-destructive">
                <T>
                  Too many attempts. Wait <Var>{unlockError.seconds ?? 2}</Var>s before retrying.
                </T>
              </p>
            ) : unlockError?.kind === "wrong" ? (
              <p className="text-xs text-destructive">
                <T>Incorrect passcode. Try again.</T>
              </p>
            ) : null}
            <Button type="submit" disabled={panicInProgress}>
              <T>Unlock</T>
            </Button>
          </form>
        ) : (
          <Button onClick={handleTapUnlock} disabled={panicInProgress}>
            <T>Unlock</T>
          </Button>
        )}

        <div className="w-full border-t border-border/60 pt-4">
          {confirmPanic ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                <T>Revoke all active sessions and wipe local browser data?</T>
              </p>
              <div className="flex items-center justify-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmPanic(false)}
                  disabled={panicInProgress}
                >
                  <T>Cancel</T>
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={handlePanicFromLock}
                  disabled={panicInProgress}
                >
                  <T>Confirm panic wipe</T>
                </Button>
              </div>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={handlePanicFromLock}
              disabled={panicInProgress}
            >
              <ShieldAlertIcon />
              <T>Panic wipe session</T>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
