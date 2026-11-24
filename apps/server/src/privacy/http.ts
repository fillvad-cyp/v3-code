import { AuthAccessWriteScope } from "@t3tools/contracts";
import {
  PRIVACY_PANIC_LOGOUT_PATH,
  PRIVACY_STATUS_PATH,
  PROVIDER_TELEMETRY_OPTOUT_ENV,
  validateOutboundProxyUrl,
  type PrivacyShieldStatus,
} from "@t3tools/shared/privacyShield";
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

function buildPrivacyShieldStatus(
  config: ServerConfig.ServerConfig["Service"],
): PrivacyShieldStatus {
  const proxyValidated =
    config.proxyUrl !== undefined ? validateOutboundProxyUrl(config.proxyUrl) : undefined;
  return {
    ephemeral: config.ephemeral === true,
    ephemeralStorage: config.ephemeralStorage ?? "disk",
    noLogs: config.noLogs === true,
    strictPrivacy: config.strictPrivacy === true,
    telemetryOptOutCount:
      config.privacyTelemetryOptOutCount ?? Object.keys(PROVIDER_TELEMETRY_OPTOUT_ENV).length,
    scrubbedEnvCount: config.privacyScrubbedEnvCount ?? 0,
    proxyEnabled: proxyValidated?.ok === true,
    proxyDisplay: proxyValidated?.ok === true ? proxyValidated.display : null,
    zeroTelemetry: true,
    autoUpdatesDisabled: true,
  };
}

const layerPrivacyStatusRoute = HttpRouter.add(
  "GET",
  PRIVACY_STATUS_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const authenticated = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!authenticated) {
      return HttpServerResponse.jsonUnsafe(
        { code: "auth_invalid", message: "Authentication required." },
        { status: 401, headers: PRIVACY_RESPONSE_HEADERS },
      );
    }
    const config = yield* ServerConfig.ServerConfig;
    return HttpServerResponse.jsonUnsafe(buildPrivacyShieldStatus(config), {
      status: 200,
      headers: PRIVACY_RESPONSE_HEADERS,
    });
  }),
);

const layerPrivacyPanicLogoutRoute = HttpRouter.add(
  "POST",
  PRIVACY_PANIC_LOGOUT_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    // Require an explicit non-simple header so cross-site form submissions cannot trigger logout.
    if (request.headers[PANIC_CONFIRM_HEADER] !== "1") {
      return HttpServerResponse.jsonUnsafe(
        { code: "invalid_request", message: "Missing panic confirmation header." },
        { status: 400, headers: PRIVACY_RESPONSE_HEADERS },
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
        HttpServerResponse.jsonUnsafe(
          { code: "auth_invalid", message: "Authentication required." },
          { status: 401, headers: PRIVACY_RESPONSE_HEADERS },
        ),
        clearedCookies,
      );
    }

    const session = authenticatedSession.value;
    if (revokeAll && !session.scopes.includes(AuthAccessWriteScope)) {
      return HttpServerResponse.jsonUnsafe(
        {
          code: "insufficient_scope",
          message: "access:write scope is required to revoke all paired devices.",
        },
        { status: 403, headers: PRIVACY_RESPONSE_HEADERS },
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

    if (!keepCurrentSession) {
      const revokedSelf = yield* serverAuth
        .revokeClient(session.sessionId)
        .pipe(Effect.orElseSucceed(() => false));
      if (revokedSelf) {
        revokedSessions += 1;
      }
    }

    const response = HttpServerResponse.jsonUnsafe(
      {
        ok: true,
        revokedSessions,
        revokedPairingLinks,
        revokedAll: revokeAll,
        keptCurrentSession: keepCurrentSession,
      },
      { status: 200, headers: PRIVACY_RESPONSE_HEADERS },
    );
    return keepCurrentSession
      ? response
      : HttpServerResponse.mergeCookies(response, expireSessionCookies(request, sessions, config));
  }),
);

export const layer = Layer.mergeAll(layerPrivacyStatusRoute, layerPrivacyPanicLogoutRoute);
