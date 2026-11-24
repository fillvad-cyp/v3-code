import { useLocation } from "@tanstack/react-router";
import { msg, T, useGT, Var } from "gt-react";
import {
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  EllipsisVerticalIcon,
  LockIcon,
  ShareIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  SmartphoneIcon,
  SquarePlusIcon,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import { isElectron } from "../../env";
import { peekPairingTokenFromUrl } from "../../environments/primary";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import {
  assessPwaConnectionSecurity,
  closePwaInstallPrompt,
  maybeAutoOpenPwaInstallPrompt,
  sanitizeInstallShareUrl,
  triggerNativePwaInstall,
  usePwaInstallStore,
  type PwaInstallPlatform,
} from "../../lib/pwaInstall";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

function InstallStep({
  number,
  icon,
  children,
}: {
  readonly number: number;
  readonly icon: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 rounded-xl border border-border/70 bg-muted/35 px-3 py-2.5 text-sm leading-snug text-foreground">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/12 text-xs font-semibold text-primary">
        {number}
      </span>
      <div className="min-w-0 flex-1 text-foreground/90">{children}</div>
      <span className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true">
        {icon}
      </span>
    </li>
  );
}

function PlatformInstructions({
  platform,
  onCopyLink,
  isCopied,
}: {
  readonly platform: PwaInstallPlatform;
  readonly onCopyLink: () => void;
  readonly isCopied: boolean;
}) {
  const gt = useGT();

  if (platform === "ios-safari") {
    return (
      <ol className="space-y-2">
        <InstallStep number={1} icon={<ShareIcon className="size-4" />}>
          <T>
            Tap the <strong>Share</strong> button in Safari&apos;s toolbar.
          </T>
        </InstallStep>
        <InstallStep number={2} icon={<SquarePlusIcon className="size-4" />}>
          <T>
            Scroll down and tap <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.
          </T>
        </InstallStep>
        <InstallStep number={3} icon={<LockIcon className="size-4" />}>
          <T>
            Launch <Var>{APP_DISPLAY_NAME}</Var> from your Home Screen and pair once. iOS keeps the
            app&apos;s session securely isolated from Safari.
          </T>
        </InstallStep>
      </ol>
    );
  }

  if (platform === "ios-other-browser") {
    return (
      <div className="space-y-2.5">
        <ol className="space-y-2">
          <InstallStep number={1} icon={<CopyIcon className="size-4" />}>
            <T>
              Copy this address and open it in <strong>Safari</strong> on your iPhone or iPad.
            </T>
          </InstallStep>
          <InstallStep number={2} icon={<ShareIcon className="size-4" />}>
            <T>
              In Safari, tap <strong>Share</strong> and choose <strong>Add to Home Screen</strong>.
            </T>
          </InstallStep>
          <InstallStep number={3} icon={<LockIcon className="size-4" />}>
            <T>
              Open <Var>{APP_DISPLAY_NAME}</Var> from your Home Screen and pair once inside the
              pinned app.
            </T>
          </InstallStep>
        </ol>
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={onCopyLink}>
            {isCopied ? <CheckIcon className="text-success" /> : <CopyIcon />}
            {isCopied ? gt("Link copied") : gt("Copy link for Safari")}
          </Button>
        </div>
      </div>
    );
  }

  if (platform === "chromium-prompt") {
    return (
      <ol className="space-y-2">
        <InstallStep number={1} icon={<DownloadIcon className="size-4" />}>
          <T>
            Tap <strong>Install app</strong> below to pin <Var>{APP_DISPLAY_NAME}</Var> directly to
            your Home Screen.
          </T>
        </InstallStep>
        <InstallStep number={2} icon={<SmartphoneIcon className="size-4" />}>
          <T>Launch it fullscreen like a native app without browser bars or tabs.</T>
        </InstallStep>
      </ol>
    );
  }

  return (
    <ol className="space-y-2">
      <InstallStep number={1} icon={<EllipsisVerticalIcon className="size-4" />}>
        <T>
          Open your browser menu and choose <strong>Add to Home screen</strong> or{" "}
          <strong>Install app</strong>.
        </T>
      </InstallStep>
      <InstallStep number={2} icon={<SmartphoneIcon className="size-4" />}>
        <T>
          Confirm to pin <Var>{APP_DISPLAY_NAME}</Var> as a standalone app icon on your device.
        </T>
      </InstallStep>
    </ol>
  );
}

function SecurityNotice({ platform }: { readonly platform: PwaInstallPlatform }) {
  const security = assessPwaConnectionSecurity(window.location);

  if (security === "lan-http") {
    return (
      <Alert variant="warning">
        <ShieldAlertIcon />
        <AlertTitle>
          <T>Local network connection (HTTP)</T>
        </AlertTitle>
        <AlertDescription>
          <T>
            Pin this app only on trusted Wi-Fi. For encrypted remote access from iPhone anywhere,
            connect over Tailscale HTTPS. No pairing tokens are saved in the shortcut URL.
          </T>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="success">
      <ShieldCheckIcon />
      <AlertTitle>
        {security === "https" ? (
          <T>Encrypted &amp; isolated session</T>
        ) : (
          <T>Local &amp; isolated session</T>
        )}
      </AlertTitle>
      <AlertDescription>
        {platform === "ios-safari" || platform === "ios-other-browser" ? (
          <T>
            Your session stays pinned in an HttpOnly cookie with zero telemetry and zero cloud
            relay. No secret tokens are stored in the Home Screen link.
          </T>
        ) : (
          <T>
            Your session is kept in an HttpOnly cookie directly with your server, with zero
            telemetry, zero cloud relay, and no tokens in the shortcut URL.
          </T>
        )}
      </AlertDescription>
    </Alert>
  );
}

export function HomeScreenInstallPromptHost() {
  const gt = useGT();
  const pathname = useLocation({ select: (location) => location.pathname });
  const open = usePwaInstallStore((state) => state.open);
  const platform = usePwaInstallStore((state) => state.platform);
  const installing = usePwaInstallStore((state) => state.installing);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: {
      target: "pwa-install-url",
      unavailableMessage: msg("Clipboard API is unavailable while copying the app link."),
      failureMessage: msg("Failed to copy the app link to the clipboard."),
    },
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- auto-opens the mobile Home Screen install sheet once after route mount when not already installed or dismissed
  useEffect(() => {
    if (isElectron) return;
    maybeAutoOpenPwaInstallPrompt({
      pathname,
      hasPairingTokenInUrl: peekPairingTokenFromUrl() !== null,
    });
  }, [pathname]);

  if (isElectron) {
    return null;
  }

  const handleCopyLink = () => {
    copyToClipboard(sanitizeInstallShareUrl(window.location.href));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          closePwaInstallPrompt("later");
        }
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <div className="flex items-center gap-3.5 pr-8">
            <img
              alt={APP_DISPLAY_NAME}
              className="size-12 shrink-0 rounded-xl border border-border/70 object-cover"
              src="/apple-touch-icon.png"
            />
            <div className="min-w-0 space-y-0.5">
              <DialogTitle>
                <T>
                  Add <Var>{APP_DISPLAY_NAME}</Var> to Home Screen
                </T>
              </DialogTitle>
              <DialogDescription>
                {platform === "ios-safari" || platform === "ios-other-browser" ? (
                  <T>Use it fullscreen like a native app without Safari toolbars.</T>
                ) : (
                  <T>Launch V3 Code in its own standalone app window from your Home Screen.</T>
                )}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <DialogPanel>
          <PlatformInstructions
            isCopied={isCopied}
            onCopyLink={handleCopyLink}
            platform={platform}
          />
          <SecurityNotice platform={platform} />
        </DialogPanel>

        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => closePwaInstallPrompt("never")}>
            <T>Don&apos;t show again</T>
          </Button>
          <Button size="sm" variant="outline" onClick={() => closePwaInstallPrompt("later")}>
            <T>Not now</T>
          </Button>
          {platform === "chromium-prompt" ? (
            <Button disabled={installing} size="sm" onClick={() => void triggerNativePwaInstall()}>
              <DownloadIcon />
              {installing ? gt("Installing...") : gt("Install app")}
            </Button>
          ) : (
            <Button size="sm" onClick={() => closePwaInstallPrompt("later")}>
              <T>Got it</T>
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
