// @effect-diagnostics nodeBuiltinImport:off -- Low-level TCP and SOCKS5 handshake probes use node:net directly.
// @effect-diagnostics globalDate:off -- Latency measurement uses wall-clock Date.now() inside raw socket callbacks.
// @effect-diagnostics globalTimers:off -- Low-level raw TCP/SOCKS5 socket deadlines use Node timers.
import * as NodeNet from "node:net";

import { validateOutboundProxyUrl } from "@t3tools/shared/privacyShield";
import {
  isDnsLeakProtectedProxyUrl,
  validateServerVaultHost,
  type ProxyHealthResult,
  type ServerProbeResult,
} from "@t3tools/shared/privacyVault";

const DEFAULT_PROBE_TIMEOUT_MS = 4_000;

function defaultPortForProtocol(protocol: string): number {
  switch (protocol) {
    case "https:":
      return 443;
    case "socks4:":
    case "socks4a:":
    case "socks5:":
    case "socks5h:":
      return 1080;
    default:
      return 8080;
  }
}

/**
 * Performs a real TCP connect and (for SOCKS5/SOCKS5h) SOCKS5 method negotiation handshake
 * against a configured proxy endpoint without sending telemetry or leaking credentials.
 */
export async function probeProxyEndpoint(
  rawUrl: string,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProxyHealthResult> {
  const checkedAt = new Date().toISOString();
  const validated = validateOutboundProxyUrl(rawUrl);
  if (!validated.ok) {
    return {
      ok: false,
      latencyMs: null,
      exitIp: null,
      dnsLeakProtected: false,
      protocol: "unknown",
      error: validated.reason,
      checkedAt,
    };
  }

  const parsed = new URL(validated.url);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const port = parsed.port
    ? Number.parseInt(parsed.port, 10)
    : defaultPortForProtocol(parsed.protocol);
  const dnsLeakProtected = isDnsLeakProtectedProxyUrl(validated.url);
  const isSocks5 = parsed.protocol === "socks5:" || parsed.protocol === "socks5h:";
  const hasAuth = parsed.username.length > 0 || parsed.password.length > 0;
  const startedAt = Date.now();

  return new Promise<ProxyHealthResult>((resolve) => {
    let settled = false;
    let socksBuffer = Buffer.alloc(0);
    const socket = NodeNet.createConnection({ host, port });

    const finish = (
      result: Omit<ProxyHealthResult, "dnsLeakProtected" | "protocol" | "checkedAt">,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      socket.destroy();
      resolve({
        ...result,
        dnsLeakProtected,
        protocol: parsed.protocol.replace(":", ""),
        checkedAt,
      });
    };

    const deadlineTimer = setTimeout(() => {
      finish({ ok: false, latencyMs: null, exitIp: null, error: "Connection timed out" });
    }, timeoutMs);

    socket.setTimeout(timeoutMs, () => {
      finish({ ok: false, latencyMs: null, exitIp: null, error: "Connection timed out" });
    });

    socket.on("error", (error) => {
      finish({
        ok: false,
        latencyMs: null,
        exitIp: null,
        error: error.message || "Connection failed",
      });
    });

    socket.on("close", () => {
      finish({
        ok: false,
        latencyMs: null,
        exitIp: null,
        error: "Connection closed before handshake completed",
      });
    });

    socket.on("connect", () => {
      if (!isSocks5) {
        finish({
          ok: true,
          latencyMs: Math.max(1, Date.now() - startedAt),
          exitIp: null,
          error: null,
        });
        return;
      }

      // SOCKS5 greeting: version 5, offer no-auth (0x00) and username/password (0x02) if credentials exist.
      const methods = hasAuth ? [0x00, 0x02] : [0x00];
      socket.write(Buffer.from([0x05, methods.length, ...methods]));
    });

    socket.on("data", (chunk) => {
      if (!isSocks5) return;
      socksBuffer = Buffer.concat([socksBuffer, chunk]);
      if (socksBuffer.length < 2) return;
      if (socksBuffer[0] !== 0x05) {
        finish({
          ok: false,
          latencyMs: null,
          exitIp: null,
          error: "Endpoint did not respond with a valid SOCKS5 handshake",
        });
        return;
      }
      const chosenMethod = socksBuffer[1];
      if (chosenMethod === 0xff) {
        finish({
          ok: false,
          latencyMs: null,
          exitIp: null,
          error: "SOCKS5 proxy rejected authentication methods",
        });
        return;
      }
      finish({
        ok: true,
        latencyMs: Math.max(1, Date.now() - startedAt),
        exitIp: null,
        error: null,
      });
    });
  });
}

/**
 * Performs a real TCP reachability and latency check against a vaulted SSH/LAN/Tailscale server.
 */
export async function probeServerEndpoint(
  host: string,
  port: number,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ServerProbeResult> {
  const checkedAt = new Date().toISOString();
  const cleanHost = host.trim().replace(/^\[|\]$/g, "");
  if (!validateServerVaultHost(cleanHost) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      reachable: false,
      latencyMs: null,
      error: "Invalid host or port",
      checkedAt,
    };
  }

  const startedAt = Date.now();
  return new Promise<ServerProbeResult>((resolve) => {
    let settled = false;
    const socket = NodeNet.createConnection({ host: cleanHost, port });

    const finish = (reachable: boolean, error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      socket.destroy();
      resolve({
        reachable,
        latencyMs: reachable ? Math.max(1, Date.now() - startedAt) : null,
        error,
        checkedAt,
      });
    };

    const deadlineTimer = setTimeout(() => finish(false, "Connection timed out"), timeoutMs);
    socket.setTimeout(timeoutMs, () => finish(false, "Connection timed out"));
    socket.on("error", (error) => finish(false, error.message || "Unreachable"));
    socket.on("close", () => finish(false, "Connection closed"));
    socket.on("connect", () => finish(true, null));
  });
}
