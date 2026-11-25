// @effect-diagnostics nodeBuiltinImport:off -- Uses node:crypto for compact egress event IDs.
import * as NodeCrypto from "node:crypto";

import type {
  DesktopEgressEvent,
  DesktopEgressPolicy,
  DesktopPrivacyNetworkState,
} from "@t3tools/contracts";
import { buildChromiumProxyConfig } from "@t3tools/shared/privacyShield";
import { DEFAULT_EGRESS_POLICY, evaluateEgressHost } from "@t3tools/shared/privacyVault";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";

const MAX_DESKTOP_EGRESS_EVENTS = 200;
const INTERNAL_ALLOWED_PROTOCOLS = new Set([
  "v3code:",
  "v3code-dev:",
  "t3code:",
  "t3code-dev:",
  "devtools:",
  "chrome:",
  "chrome-extension:",
  "about:",
  "data:",
  "blob:",
  "file:",
]);

export class DesktopNetworkShield extends Context.Service<
  DesktopNetworkShield,
  {
    readonly getState: Effect.Effect<DesktopPrivacyNetworkState>;
    readonly setEgressPolicy: (
      policy: DesktopEgressPolicy,
    ) => Effect.Effect<DesktopPrivacyNetworkState>;
    readonly applyProxy: (proxyUrl: string | null) => Effect.Effect<DesktopPrivacyNetworkState>;
    readonly clearLog: Effect.Effect<DesktopPrivacyNetworkState>;
  }
>()("@t3tools/desktop/privacy/DesktopNetworkShield") {}

const make = Effect.gen(function* () {
  let activeProxyDisplay: string | null = null;
  let policy: DesktopEgressPolicy = {
    mode: DEFAULT_EGRESS_POLICY.mode,
    allowlist: [...DEFAULT_EGRESS_POLICY.allowlist],
    blocklist: [...DEFAULT_EGRESS_POLICY.blocklist],
    killSwitchActive: DEFAULT_EGRESS_POLICY.killSwitchActive,
  };
  const events: DesktopEgressEvent[] = [];

  const recordEvent = (
    host: string,
    protocol: string,
    action: "allowed" | "blocked",
    reason: string | null,
  ) => {
    const cleanHost = host
      .trim()
      .toLowerCase()
      .replace(/^\[|\]$/g, "");
    if (
      cleanHost === "localhost" ||
      cleanHost === "127.0.0.1" ||
      cleanHost === "::1" ||
      cleanHost.endsWith(".localhost")
    ) {
      return;
    }
    events.unshift({
      id: `deg-${NodeCrypto.randomBytes(5).toString("hex")}`,
      timestamp: DateTime.formatIso(DateTime.nowUnsafe()),
      host,
      protocol,
      action,
      source: "desktop",
      reason,
    });
    if (events.length > MAX_DESKTOP_EGRESS_EVENTS) {
      events.length = MAX_DESKTOP_EGRESS_EVENTS;
    }
  };

  let attachedDefaultSession = false;
  const attachSessionFilter = (targetSession: Electron.Session) => {
    targetSession.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] },
      (details, callback) => {
        const parsed = URL.parse(details.url);
        if (parsed === null || INTERNAL_ALLOWED_PROTOCOLS.has(parsed.protocol)) {
          callback({ cancel: false });
          return;
        }
        const host = parsed.hostname;
        const protocol = parsed.protocol.replace(":", "");
        const decision = evaluateEgressHost(host, policy);
        recordEvent(host, protocol, decision.action, decision.reason);
        callback({ cancel: decision.action === "blocked" });
      },
    );
  };

  const ensureDefaultSessionAttached = () => {
    if (attachedDefaultSession) return;
    if (typeof Electron.session?.defaultSession?.webRequest?.onBeforeRequest === "function") {
      attachedDefaultSession = true;
      attachSessionFilter(Electron.session.defaultSession);
    }
  };

  // Defer defaultSession access until Electron app.whenReady() so startup never crashes pre-ready.
  yield* Effect.sync(() => {
    if (typeof Electron.app?.isReady === "function" && !Electron.app.isReady()) {
      void Electron.app.whenReady().then(ensureDefaultSessionAttached);
    } else {
      ensureDefaultSessionAttached();
    }
  });

  const snapshot = (): DesktopPrivacyNetworkState => ({
    activeProxyDisplay,
    policy: {
      mode: policy.mode,
      allowlist: [...policy.allowlist],
      blocklist: [...policy.blocklist],
      killSwitchActive: policy.killSwitchActive,
    },
    events: [...events],
  });

  return DesktopNetworkShield.of({
    getState: Effect.sync(snapshot),

    setEgressPolicy: Effect.fn("DesktopNetworkShield.setEgressPolicy")(function (nextPolicy) {
      return Effect.sync(() => {
        policy = {
          mode: nextPolicy.mode,
          allowlist: Array.from(
            new Set(nextPolicy.allowlist.map((h) => h.trim().toLowerCase()).filter(Boolean)),
          ),
          blocklist: Array.from(
            new Set(nextPolicy.blocklist.map((h) => h.trim().toLowerCase()).filter(Boolean)),
          ),
          killSwitchActive: nextPolicy.killSwitchActive,
        };
        return snapshot();
      });
    }),

    applyProxy: Effect.fn("DesktopNetworkShield.applyProxy")(function* (proxyUrl) {
      if (typeof Electron.app?.isReady === "function" && !Electron.app.isReady()) {
        return snapshot();
      }
      const targetSession = Electron.session?.defaultSession;
      if (proxyUrl === null || proxyUrl.trim().length === 0) {
        activeProxyDisplay = null;
        if (targetSession && typeof targetSession.setProxy === "function") {
          yield* Effect.promise(async () => {
            await targetSession.setProxy({ mode: "direct" });
            if (typeof targetSession.closeAllConnections === "function") {
              await targetSession.closeAllConnections();
            }
          }).pipe(Effect.ignoreCause);
        }
        return snapshot();
      }
      const chromiumConfig = buildChromiumProxyConfig(proxyUrl);
      if (chromiumConfig === null) {
        return snapshot();
      }
      activeProxyDisplay = chromiumConfig.display;
      if (targetSession && typeof targetSession.setProxy === "function") {
        yield* Effect.promise(async () => {
          await targetSession.setProxy({
            mode: "fixed_servers",
            proxyRules: chromiumConfig.proxyServer,
            proxyBypassRules: chromiumConfig.proxyBypassList,
          });
          if (typeof targetSession.closeAllConnections === "function") {
            await targetSession.closeAllConnections();
          }
        }).pipe(Effect.ignoreCause);
      }
      return snapshot();
    }),

    clearLog: Effect.sync(() => {
      events.length = 0;
      return snapshot();
    }),
  });
});

export const layer = Layer.effect(DesktopNetworkShield, make);
