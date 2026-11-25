import { AuthAccessWriteScope, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import {
  PRIVACY_PANIC_LOGOUT_PATH,
  PRIVACY_STATUS_PATH,
  PROVIDER_TELEMETRY_OPTOUT_ENV,
  validateOutboundProxyUrl,
  type PrivacyShieldStatus,
} from "@t3tools/shared/privacyShield";
import {
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
  type EgressPolicy,
} from "@t3tools/shared/privacyVault";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Cookies from "effect/http/Cookies";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { resolveReusableDevAuth } from "../auth/ReusableDevAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import { requestUrl } from "../requestUrl.ts";
import * as PrivacyVaultService from "./PrivacyVaultService.ts";

const PRIVACY_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
} as const;

const PANIC_CONFIRM_HEADER = "x-v3-panic-confirm";

const PanicLogoutBody = Schema.Struct({
  revokeAll: Schema.optional(Schema.Boolean),
  keepCurrentSession: Schema.optional(Schema.Boolean),
});
const decodePanicLogoutBody = Schema.decodeUnknownEffect(PanicLogoutBody);

const UnlockBody = Schema.Struct({ passphrase: Schema.String });
const decodeUnlockBody = Schema.decodeUnknownEffect(UnlockBody);

const EncryptionBody = Schema.Struct({
  action: Schema.Literals(["enable", "disable", "change"]),
  currentPassphrase: Schema.optional(Schema.String),
  newPassphrase: Schema.optional(Schema.String),
});
const decodeEncryptionBody = Schema.decodeUnknownEffect(EncryptionBody);

const ProxyActionBody = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("add"),
    name: Schema.String,
    url: Schema.String,
    tags: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    action: Schema.Literal("bulk-import"),
    raw: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("delete"),
    id: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("set-default"),
    id: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    action: Schema.Literal("test"),
    id: Schema.String,
  }),
]);
const decodeProxyActionBody = Schema.decodeUnknownEffect(ProxyActionBody);

const ServerActionBody = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("upsert"),
    id: Schema.optional(Schema.String),
    name: Schema.String,
    kind: Schema.Literals(["ssh", "lan", "tailscale"]),
    host: Schema.String,
    port: Schema.Number,
    username: Schema.String,
    identityFile: Schema.optional(Schema.NullOr(Schema.String)),
    proxyJump: Schema.optional(Schema.NullOr(Schema.String)),
    proxyId: Schema.optional(Schema.NullOr(Schema.String)),
    defaultWorkdir: Schema.optional(Schema.NullOr(Schema.String)),
    ghostModeDefault: Schema.optional(Schema.Boolean),
    tags: Schema.optional(Schema.Array(Schema.String)),
    notes: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    action: Schema.Literal("delete"),
    id: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("probe"),
    id: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("command"),
    id: Schema.String,
    ghost: Schema.optional(Schema.Boolean),
  }),
]);
const decodeServerActionBody = Schema.decodeUnknownEffect(ServerActionBody);

const CompartmentActionBody = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("upsert"),
    id: Schema.optional(Schema.String),
    name: Schema.String,
    color: Schema.optional(Schema.String),
    proxyId: Schema.optional(Schema.NullOr(Schema.String)),
    killSwitch: Schema.optional(Schema.Boolean),
    gitAuthorName: Schema.optional(Schema.NullOr(Schema.String)),
    gitAuthorEmail: Schema.optional(Schema.NullOr(Schema.String)),
    gitSshKeyPath: Schema.optional(Schema.NullOr(Schema.String)),
    timezone: Schema.optional(Schema.NullOr(Schema.String)),
    locale: Schema.optional(Schema.NullOr(Schema.String)),
    projectBindings: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    action: Schema.Literal("delete"),
    id: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("activate"),
    id: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("create-burner"),
    name: Schema.optional(Schema.String),
  }),
]);
const decodeCompartmentActionBody = Schema.decodeUnknownEffect(CompartmentActionBody);

const DlpConfigSchema = Schema.Struct({
  mode: Schema.Literals(["off", "warn", "redact", "block"]),
  rules: Schema.Struct({
    "api-keys": Schema.Boolean,
    "private-keys": Schema.Boolean,
    jwt: Schema.Boolean,
    "env-secrets": Schema.Boolean,
    "local-paths": Schema.Boolean,
    "ip-addresses": Schema.Boolean,
  }),
});

const DlpActionBody = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("update"),
    config: DlpConfigSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("scan"),
    text: Schema.String,
    config: Schema.optional(DlpConfigSchema),
  }),
]);
const decodeDlpActionBody = Schema.decodeUnknownEffect(DlpActionBody);

const EgressActionBody = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("update"),
    policy: Schema.Struct({
      mode: Schema.Literals(["monitor", "allowlist"]),
      allowlist: Schema.Array(Schema.String),
      blocklist: Schema.Array(Schema.String),
      killSwitchActive: Schema.Boolean,
    }),
  }),
  Schema.Struct({
    action: Schema.Literal("clear-log"),
  }),
]);
const decodeEgressActionBody = Schema.decodeUnknownEffect(EgressActionBody);

const BurnActionBody = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("set"),
    threadId: Schema.String,
    preset: Schema.Literals(["15m", "1h", "6h", "24h", "on-exit"]),
  }),
  Schema.Struct({
    action: Schema.Literal("clear"),
    threadId: Schema.String,
  }),
  Schema.Struct({
    action: Schema.Literal("burn-now"),
    threadId: Schema.String,
  }),
]);
const decodeBurnActionBody = Schema.decodeUnknownEffect(BurnActionBody);

function cookieExpireOptions(request: HttpServerRequest.HttpServerRequest) {
  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax" as const,
    secure: Option.exists(requestUrl(request), (url) => url.protocol === "https:"),
  };
}

function expireSessionCookies(
  request: HttpServerRequest.HttpServerRequest,
  sessions: SessionStore.SessionStore["Service"],
  config: ServerConfig.ServerConfig["Service"],
): Cookies.Cookies {
  const expireOpts = cookieExpireOptions(request);
  const cookieNames = new Set<string>([sessions.cookieName]);
  if (sessions.legacyCookieName) {
    cookieNames.add(sessions.legacyCookieName);
  }
  const devAuth = resolveReusableDevAuth(config);
  if (devAuth) {
    cookieNames.add(devAuth.cookieName);
  }
  let responseCookies = Cookies.empty;
  for (const name of cookieNames) {
    const expired = Cookies.expireCookie(responseCookies, name, expireOpts);
    if (expired._tag === "Success") {
      responseCookies = expired.success;
    }
  }
  return responseCookies;
}

function jsonResponse(body: unknown, status = 200) {
  return HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: PRIVACY_RESPONSE_HEADERS,
  });
}

function buildPrivacyShieldStatus(
  config: ServerConfig.ServerConfig["Service"],
  vaultSnapshot?: {
    readonly activeProxyDisplay: string | null;
    readonly activeKillSwitch: boolean;
  },
): PrivacyShieldStatus {
  const proxyValidated =
    config.proxyUrl !== undefined ? validateOutboundProxyUrl(config.proxyUrl) : undefined;
  const effectiveProxyDisplay =
    vaultSnapshot?.activeProxyDisplay ??
    (proxyValidated?.ok === true ? proxyValidated.display : null);
  return {
    ephemeral: config.ephemeral === true,
    ephemeralStorage: config.ephemeralStorage ?? "disk",
    noLogs: config.noLogs === true,
    strictPrivacy: config.strictPrivacy === true,
    telemetryOptOutCount:
      config.privacyTelemetryOptOutCount ?? Object.keys(PROVIDER_TELEMETRY_OPTOUT_ENV).length,
    scrubbedEnvCount: config.privacyScrubbedEnvCount ?? 0,
    proxyEnabled: effectiveProxyDisplay !== null,
    proxyDisplay: effectiveProxyDisplay,
    zeroTelemetry: true,
    autoUpdatesDisabled: true,
  };
}

const requireAuthenticatedSession = Effect.fn("privacy.http.requireAuth")(function* (options?: {
  readonly requireMutationHeader?: boolean;
  readonly requireWriteScope?: boolean;
  readonly allowOperateScope?: boolean;
}) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (options?.requireMutationHeader && request.headers[PRIVACY_VAULT_ACTION_HEADER] !== "1") {
    return {
      ok: false as const,
      response: jsonResponse(
        { code: "invalid_request", message: "Missing vault action confirmation header." },
        400,
      ),
    };
  }
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessionOption = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.asSome,
    Effect.orElseSucceed(() => Option.none()),
  );
  if (Option.isNone(sessionOption)) {
    return {
      ok: false as const,
      response: jsonResponse({ code: "auth_invalid", message: "Authentication required." }, 401),
    };
  }
  const session = sessionOption.value;
  if (options?.requireWriteScope) {
    const hasAccessWrite = session.scopes.includes(AuthAccessWriteScope);
    const hasOperate =
      options.allowOperateScope === true && session.scopes.includes(AuthOrchestrationOperateScope);
    if (!hasAccessWrite && !hasOperate) {
      return {
        ok: false as const,
        response: jsonResponse(
          { code: "insufficient_scope", message: "Insufficient scope for privacy vault mutation." },
          403,
        ),
      };
    }
  }
  return { ok: true as const, request, session };
});

const layerPrivacyStatusRoute = HttpRouter.add(
  "GET",
  PRIVACY_STATUS_PATH,
  Effect.gen(function* () {
    const auth = yield* requireAuthenticatedSession();
    if (!auth.ok) return auth.response;
    const config = yield* ServerConfig.ServerConfig;
    const vaultOpt = yield* Effect.serviceOption(PrivacyVaultService.PrivacyVaultService);
    const vaultSnapshot = Option.isSome(vaultOpt) ? yield* vaultOpt.value.getSnapshot : undefined;
    return jsonResponse(buildPrivacyShieldStatus(config, vaultSnapshot), 200);
  }),
);

const layerPrivacyVaultGetRoute = HttpRouter.add(
  "GET",
  PRIVACY_VAULT_PATH,
  Effect.gen(function* () {
    const auth = yield* requireAuthenticatedSession();
    if (!auth.ok) return auth.response;
    const vault = yield* PrivacyVaultService.PrivacyVaultService;
    return jsonResponse(yield* vault.getSnapshot, 200);
  }),
);

const layerPrivacyVaultUnlockRoute = HttpRouter.add(
  "POST",
  PRIVACY_VAULT_UNLOCK_PATH,
  Effect.gen(function* () {
    const auth = yield* requireAuthenticatedSession({
      requireMutationHeader: true,
      requireWriteScope: true,
    });
    if (!auth.ok) return auth.response;
    const parsed = yield* auth.request.json.pipe(
      Effect.flatMap(decodeUnlockBody),
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(parsed)) {
      return jsonResponse({ ok: false, error: "Invalid unlock payload." }, 400);
    }
    const vault = yield* PrivacyVaultService.PrivacyVaultService;
    const result = yield* vault.unlock(parsed.value.passphrase);
    return jsonResponse(result, result.ok ? 200 : 403);
  }),
);

const layerPrivacyVaultLockRoute = HttpRouter.add(
  "POST",
  PRIVACY_VAULT_LOCK_PATH,
  Effect.gen(function* () {
    const auth = yield* requireAuthenticatedSession({
      requireMutationHeader: true,
      requireWriteScope: true,
    });
    if (!auth.ok) return auth.response;
    const vault = yield* PrivacyVaultService.PrivacyVaultService;
    const result = yield* vault.lock;
    return jsonResponse(result, result.ok ? 200 : 400);
  }),
);

const layerPrivacyVaultEncryptionRoute = HttpRouter.add(
  "POST",
  PRIVACY_VAULT_ENCRYPTION_PATH,
  Effect.gen(function* () {
    const auth = yield* requireAuthenticatedSession({
      requireMutationHeader: true,
      requireWriteScope: true,
    });
    if (!auth.ok) return auth.response;
    const parsed = yield* auth.request.json.pipe(
      Effect.flatMap(decodeEncryptionBody),
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(parsed)) {
      return jsonResponse({ ok: false, error: "Invalid encryption payload." }, 400);
    }
    const vault = yield* PrivacyVaultService.PrivacyVaultService;
    const result = yield* vault.configureEncryption(parsed.value);
    return jsonResponse(result, result.ok ? 200 : 400);
  }),
);

const layerPrivacyVaultProxiesRoute = HttpRouter.add(
  "POST",
  PRIVACY_VAULT_PROXIES_PATH,
  Effect.gen(function* () {
    const auth = yield* requireAuthenticatedSession({
      requireMutationHeader: true,
      requireWriteScope: true,
    });
    if (!auth.ok) return auth.response;
    const parsed = yield* auth.request.json.pipe(
      Effect.flatMap(decodeProxyActionBody),
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(parsed)) {
      return jsonResponse({ ok: false, error: "Invalid proxy payload." }, 400);
    }
    const vault = yield* PrivacyVaultService.PrivacyVaultService;
    const body = parsed.value;
    switch (body.action) {
      case "add": {
        const result = yield* vault.addProxy(body);
        return jsonResponse(result, result.ok ? 200 : 400);
      }
      case "bulk-import": {
        const result = yield* vault.bulkImportProxies(body.raw);
        return jsonResponse(result, result.ok ? 200 : 400);
      }
      case "delete": {
        const result = yield* vault.deleteProxy(body.id);
        return jsonResponse(result, result.ok ? 200 : 400);
      }
      case "set-default": {
        const result = yield* vault.setDefaultProxy(body.id);
        return jsonResponse(result, result.ok ? 200 : 400);
      }
      case "test": {
        const result = yield* vault.testProxy(body.id);
        return jsonResponse(result, result.ok ? 200 : 400);
      }
    }
  }),
);

const layerPrivacyVaultServersRoute = HttpRouter.add(
  "POST",
  PRIVACY_VAULT_SERVERS_PATH,
  Effect.gen(function* () {
    const auth = yield* requireAuthenticatedSession({
      requireMutationHeader: true,
      requireWriteScope: true,
    });
    if (!auth.ok) return auth.response;
    const parsed = yield* auth.request.json.pipe(
      Effect.flatMap(decodeServerActionBody),
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(parsed)) {
      return jsonResponse({ ok: false, error: "Invalid server payload." }, 400);
    }
    const vault = yield* PrivacyVaultService.PrivacyVaultService;
    const body = parsed.value;
    switch (body.action) {
      case "upsert": {
        const result = yield* vault.upsertServer(body);
        return jsonResponse(result, result.ok ? 200 : 400);
      }
      case "delete": {
        const result = yield* vault.deleteServer(body.id);
        return jsonResponse(result, result.ok ? 200 : 400);
      }
      case "probe": {
        const result = yield* vault.probeServer(body.id);
        return jsonResponse(result, result.ok ? 200 : 400);
      }
      case "command": {
        const command = yield* vault.buildServerCommand(body.id, body.ghost);
        return jsonResponse({ ok: command !== null, command }, command !== null ? 200 : 404);
      }
    }
  }),
);

const layerPrivacyVaultCompartmentsRoute = HttpRouter.add(
  "POST",
  PRIVACY_VAULT_COMPARTMENTS_PATH,
  Effect.gen(function* () {
    const auth = yield* requireAuthenticatedSession({
      requireMutationHeader: true,
      requireWriteScope: true,
    });
    if (!auth.ok) return auth.response;
    const parsed = yield* auth.request.json.pipe(
      Effect.flatMap(decodeCompartmentActionBody),
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(parsed)) {
      return jsonResponse({ ok: false, error: "Invalid compartment payload." }, 400);
    }
    const vault = yield* PrivacyVaultService.PrivacyVaultService;
    const body = parsed.value;
    switch (body.action) {
      case "upsert": {
        const result = yield* vault.upsertCompartment(body);
        return jsonResponse(result, result.ok ? 200 : 400);
      }
      case "delete": {
        const result = yield* vault.deleteCompartment(body.id);
        return jsonResponse(result, result.ok ? 200 : 400);
      }
      case "activate": {
        const result = yield* vault.activateCompartment(body.id);
        return jsonResponse(result, result.ok ? 200 : 400);
      }
      case "create-burner": {
        const result = yield* vault.createBurnerCompartment(body.name);
        return jsonResponse(result, result.ok ? 200 : 400);
      }
    }
  }),
);

const layerPrivacyVaultDlpRoute = HttpRouter.add(
  "POST",
  PRIVACY_VAULT_DLP_PATH,
  Effect.gen(function* () {
    const auth = yield* requireAuthenticatedSession({
      requireMutationHeader: true,
      requireWriteScope: true,
      allowOperateScope: true,
    });
    if (!auth.ok) return auth.response;
    const parsed = yield* auth.request.json.pipe(
      Effect.flatMap(decodeDlpActionBody),
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(parsed)) {
      return jsonResponse({ ok: false, error: "Invalid DLP payload." }, 400);
    }
    const vault = yield* PrivacyVaultService.PrivacyVaultService;
    const body = parsed.value;
    if (body.action === "update") {
      const result = yield* vault.updateDlp(body.config as DlpConfig);
      return jsonResponse(result, result.ok ? 200 : 400);
    }
    const snapshot = yield* vault.getSnapshot;
    const scanResult = scanAndRedactPrompt(body.text, (body.config ?? snapshot.dlp) as DlpConfig);
    return jsonResponse({ ok: true, result: scanResult }, 200);
  }),
);

const layerPrivacyVaultEgressRoute = HttpRouter.add(
  "POST",
  PRIVACY_VAULT_EGRESS_PATH,
  Effect.gen(function* () {
    const auth = yield* requireAuthenticatedSession({
      requireMutationHeader: true,
      requireWriteScope: true,
    });
    if (!auth.ok) return auth.response;
    const parsed = yield* auth.request.json.pipe(
      Effect.flatMap(decodeEgressActionBody),
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(parsed)) {
      return jsonResponse({ ok: false, error: "Invalid egress payload." }, 400);
    }
    const vault = yield* PrivacyVaultService.PrivacyVaultService;
    if (parsed.value.action === "clear-log") {
      return jsonResponse(yield* vault.clearEgressEvents, 200);
    }
    const result = yield* vault.updateEgress(parsed.value.policy as EgressPolicy);
    return jsonResponse(result, result.ok ? 200 : 400);
  }),
);

const layerPrivacyVaultBurnRoute = HttpRouter.add(
  "POST",
  PRIVACY_VAULT_BURN_PATH,
  Effect.gen(function* () {
    const auth = yield* requireAuthenticatedSession({
      requireMutationHeader: true,
      requireWriteScope: true,
      allowOperateScope: true,
    });
    if (!auth.ok) return auth.response;
    const parsed = yield* auth.request.json.pipe(
      Effect.flatMap(decodeBurnActionBody),
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(parsed)) {
      return jsonResponse({ ok: false, error: "Invalid burn-thread payload." }, 400);
    }
    const vault = yield* PrivacyVaultService.PrivacyVaultService;
    const body = parsed.value;
    if (body.action === "set") {
      const result = yield* vault.setBurnThread(body.threadId, body.preset as BurnTtlPreset);
      return jsonResponse(result, result.ok ? 200 : 400);
    }
    if (body.action === "clear") {
      const result = yield* vault.setBurnThread(body.threadId, null);
      return jsonResponse(result, result.ok ? 200 : 400);
    }
    const result = yield* vault.burnThreadNow(body.threadId);
    return jsonResponse(result, result.ok ? 200 : 400);
  }),
);

const layerPrivacyPanicLogoutRoute = HttpRouter.add(
  "POST",
  PRIVACY_PANIC_LOGOUT_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Require an explicit non-simple header so cross-site form submissions cannot trigger logout.
    if (request.headers[PANIC_CONFIRM_HEADER] !== "1") {
      return jsonResponse(
        { code: "invalid_request", message: "Missing panic confirmation header." },
        400,
      );
    }

    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const config = yield* ServerConfig.ServerConfig;

    const payload = yield* request.json.pipe(
      Effect.flatMap(decodePanicLogoutBody),
      Effect.orElseSucceed(() => ({ revokeAll: false, keepCurrentSession: false })),
    );
    const revokeAll = payload.revokeAll === true;
    const keepCurrentSession = payload.keepCurrentSession === true;

    const authenticatedSession = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );

    if (Option.isNone(authenticatedSession)) {
      // Still expire any stale browser cookies even when unauthenticated, but return 401 honestly.
      const clearedCookies = expireSessionCookies(request, sessions, config);
      return HttpServerResponse.mergeCookies(
        jsonResponse({ code: "auth_invalid", message: "Authentication required." }, 401),
        clearedCookies,
      );
    }

    const session = authenticatedSession.value;
    if (revokeAll && !session.scopes.includes(AuthAccessWriteScope)) {
      return jsonResponse(
        {
          code: "insufficient_scope",
          message: "access:write scope is required to revoke all paired devices.",
        },
        403,
      );
    }

    let revokedSessions = 0;
    let revokedPairingLinks = 0;

    if (revokeAll) {
      revokedSessions += yield* serverAuth
        .revokeOtherClientSessions(session.sessionId)
        .pipe(Effect.orElseSucceed(() => 0));
      const links = yield* serverAuth
        .listPairingLinks()
        .pipe(Effect.orElseSucceed(() => [] as const));
      for (const link of links) {
        const revoked = yield* serverAuth
          .revokePairingLink(link.id)
          .pipe(Effect.orElseSucceed(() => false));
        if (revoked) revokedPairingLinks += 1;
      }
    }

    // Lock encrypted vault, purge burner compartments, and burn on-exit threads on panic!
    const vaultOpt = yield* Effect.serviceOption(PrivacyVaultService.PrivacyVaultService);
    if (Option.isSome(vaultOpt)) {
      yield* vaultOpt.value.handlePanic.pipe(Effect.ignoreCause);
    }

    if (!keepCurrentSession) {
      const revokedSelf = yield* serverAuth
        .revokeClient(session.sessionId)
        .pipe(Effect.orElseSucceed(() => false));
      if (revokedSelf) {
        revokedSessions += 1;
      }
    }

    const response = jsonResponse(
      {
        ok: true,
        revokedSessions,
        revokedPairingLinks,
        revokedAll: revokeAll,
        keptCurrentSession: keepCurrentSession,
      },
      200,
    );
    return keepCurrentSession
      ? response
      : HttpServerResponse.mergeCookies(response, expireSessionCookies(request, sessions, config));
  }),
);

export const layer = Layer.mergeAll(
  layerPrivacyStatusRoute,
  layerPrivacyPanicLogoutRoute,
  layerPrivacyVaultGetRoute,
  layerPrivacyVaultUnlockRoute,
  layerPrivacyVaultLockRoute,
  layerPrivacyVaultEncryptionRoute,
  layerPrivacyVaultProxiesRoute,
  layerPrivacyVaultServersRoute,
  layerPrivacyVaultCompartmentsRoute,
  layerPrivacyVaultDlpRoute,
  layerPrivacyVaultEgressRoute,
  layerPrivacyVaultBurnRoute,
);
