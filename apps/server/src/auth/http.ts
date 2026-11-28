import {
  authScopeRequiredResponse,
  authScopeResponse,
  AuthAccessReadScope,
  AuthAccessTokenType,
  AuthAccessWriteScope,
  AuthAdministrativeClientScopes,
  AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthStandardClientScopes,
  AuthGrantScope,
  type AuthInvitationSessionResult,
  EnvironmentAuthInvalidError,
  type EnvironmentAuthInvalidReason,
  EnvironmentConnectApprovalPendingError,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpTooManyRequestsError,
  EnvironmentHttpUnauthorizedError,
  EnvironmentInternalError,
  type EnvironmentInternalErrorReason,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  type EnvironmentRequestInvalidReason,
  EnvironmentResourceNotFoundError,
  type EnvironmentResourceNotFoundReason,
  EnvironmentScopeRequiredError,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  highestProjectRole,
  intersectScopes,
  mcpClientScopes,
  type ProjectRole,
  roleScopes,
} from "@t3tools/contracts";
import type { DpopFailureReason } from "@t3tools/contracts";
import { parseOAuthScope } from "@t3tools/shared/oauthScope";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as Cookies from "effect/http/Cookies";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ProjectAccess from "../access/ProjectAccess.ts";
import * as ApiTokenService from "../identity/ApiTokenService.ts";
import * as AuditService from "../identity/AuditService.ts";
import * as InvitationService from "../identity/InvitationService.ts";
import * as MembershipService from "../identity/MembershipService.ts";
import * as Passwords from "../identity/Passwords.ts";
import * as Principals from "../persistence/Principals.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { renderInvitePage } from "./inviteHtml.ts";
import * as SessionStore from "./SessionStore.ts";
import { traceAuthenticatedRelayRequest, traceRelayRequest } from "../cloud/traceRelayRequest.ts";
import { deriveAuthClientMetadata } from "./utils.ts";
import { checkRequestDpopProof } from "./dpop.ts";
import { requestUrl } from "../requestUrl.ts";

const CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const INVITE_PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

const isAuthEnvironmentScope = Schema.is(AuthEnvironmentScope);

const appendCredentialResponseHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, CREDENTIAL_RESPONSE_HEADERS)),
);

const appendDpopChallengeHeader = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")),
);

const failTooManyRequests =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (message: string, retryAfterSeconds: number) {
    const normalizedRetryAfter = Math.max(1, Math.ceil(retryAfterSeconds));
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(
        HttpServerResponse.setHeader(response, "retry-after", String(normalizedRetryAfter)),
      ),
    );
    return yield* new EnvironmentHttpTooManyRequestsError({
      message,
      retryAfterSeconds: normalizedRetryAfter,
    });
  });

const appendDpopChallengeOnUnauthorized =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (error: EnvironmentAuthInvalidError) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const usesDpop =
      (request.originalUrl.startsWith("/oauth/token") && request.headers.dpop !== undefined) ||
      /^DPoP /i.test(request.headers.authorization ?? "");
    if (usesDpop) {
      yield* appendDpopChallengeHeader;
    }
    return yield* error;
  });

const currentEnvironmentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

export const annotateEnvironmentRequest =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (endpoint: string) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = requestUrl(request);
    const traceId = yield* currentEnvironmentTraceId;

    yield* Effect.addFinalizer((exit) =>
      exit._tag === "Failure"
        ? Effect.logWarning("environment api request failed", {
            endpoint,
            traceId,
            errorTag: causeErrorTag(exit.cause),
            cause: exit.cause,
          })
        : Effect.void,
    );
    yield* Effect.annotateLogsScoped({ "environment.endpoint": endpoint, traceId });
    yield* Effect.annotateCurrentSpan({
      "environment.endpoint": endpoint,
      "http.request.method": request.method,
      "url.path": url._tag === "Some" ? url.value.pathname : "unknown",
    });
  });

export function failEnvironmentAuthInvalid(
  reason: EnvironmentAuthInvalidReason,
  dpopFailureReason?: DpopFailureReason,
) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentAuthInvalidError({
          code: "auth_invalid",
          reason,
          ...(dpopFailureReason === undefined ? {} : { dpopFailureReason }),
          traceId,
        }),
      ),
    ),
  );
}

export function failEnvironmentInvalidRequest(reason: EnvironmentRequestInvalidReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentRequestInvalidError({ code: "invalid_request", reason, traceId })),
    ),
  );
}

export function failEnvironmentScopeRequired(requiredScope: AuthEnvironmentScope) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentScopeRequiredError({
          code: "insufficient_scope",
          ...authScopeRequiredResponse(requiredScope),
          traceId,
        }),
      ),
    ),
  );
}

function failEnvironmentOperationForbidden(reason: "current_session_revoke_not_allowed") {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentOperationForbiddenError({
          code: "operation_forbidden",
          reason,
          traceId,
        }),
      ),
    ),
  );
}

export function failEnvironmentNotFound(reason: EnvironmentResourceNotFoundReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentResourceNotFoundError({ code: "not_found", reason, traceId })),
    ),
  );
}

/**
 * `<img>` and WebSocket cannot set headers, so media routes (device hub, preview stream)
 * authenticate the way the `/ws` upgrade does: a cookie for browser sessions, or a short-lived
 * `wsTicket` minted over authenticated HTTP for bearer and DPoP clients.
 */
export const authenticateMediaRequest =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (requiredScope: AuthEnvironmentScope) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateWebSocketUpgrade(request, "media").pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          if (EnvironmentAuth.isServerAuthCredentialError(error)) {
            return yield* failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            );
          }
          return yield* failEnvironmentInternal("internal_error", error);
        }),
      ),
    );
    if (!session.scopes.includes(requiredScope)) {
      return yield* failEnvironmentScopeRequired(requiredScope);
    }
    return session;
  });

export const failEnvironmentInternal =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (
    reason: EnvironmentInternalErrorReason,
    error?: unknown,
    detail?: string,
  ) {
    const traceId = yield* currentEnvironmentTraceId;
    if (error !== undefined) {
      yield* Effect.logError("environment api operation failed", {
        reason,
        traceId,
        cause: error,
      });
    }
    return yield* new EnvironmentInternalError({
      code: "internal_error",
      reason,
      traceId,
      ...(detail === undefined ? {} : { detail }),
    });
  });

// Plaintext LAN servers still need the cookie; TLS arrives through a proxy that sets X-Forwarded-Proto.
const sessionCookieOptions = (request: HttpServerRequest.HttpServerRequest) => ({
  httpOnly: true,
  path: "/",
  sameSite: "lax" as const,
  secure: Option.exists(requestUrl(request), (url) => url.protocol === "https:"),
});

const appendSessionCookie = (
  request: HttpServerRequest.HttpServerRequest,
  cookieName: string,
  token: string,
  expiresAt: DateTime.DateTime,
) =>
  Effect.fromResult(
    Cookies.set(Cookies.empty, cookieName, token, {
      ...sessionCookieOptions(request),
      expires: DateTime.toDate(expiresAt),
    }),
  ).pipe(
    Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")),
    Effect.flatMap((cookies) =>
      HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.mergeCookies(response, cookies)),
      ),
    ),
  );

export const requireEnvironmentScope = Effect.fn("environment.auth.requireScope")(function* (
  scope: AuthEnvironmentScope,
) {
  const session = yield* EnvironmentAuthenticatedPrincipal;
  if (!session.scopes.has(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
  return session;
});

export const layerAuthenticatedAuth = Layer.effect(
  EnvironmentAuthenticatedAuth,
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const startTime = yield* Clock.currentTimeNanos;
        const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const endTime = yield* Clock.currentTimeNanos;
        const handler = httpEffect.pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, {
            ...session,
            scopes: new Set(session.scopes),
          }),
        );
        return yield* session.subject === EnvironmentAuth.CLOUD_CONNECT_SUBJECT
          ? traceAuthenticatedRelayRequest(handler, { startTime, endTime })
          : handler;
      }).pipe(Effect.catchTags({ EnvironmentAuthInvalidError: appendDpopChallengeOnUnauthorized }));
  }),
);

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "auth",
  Effect.fnUntraced(function* (handlers) {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const invitations = yield* InvitationService.InvitationService;
    const membershipService = yield* MembershipService.MembershipService;
    const passwords = yield* Passwords.Passwords;
    const auditService = yield* AuditService.AuditService;
    const apiTokenService = yield* ApiTokenService.ApiTokenService;
    const projectAccess = yield* ProjectAccess.ProjectAccess;
    const principalsRepo = yield* Effect.serviceOption(Principals.PrincipalRepository);
    const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);

    const resolveExistingMemberCookieSession = Effect.fnUntraced(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      if (Option.isNone(principalsRepo)) {
        return undefined;
      }
      const credential = EnvironmentAuth.selectRequestCredential(
        request,
        sessions.cookieName,
        sessions.legacyCookieName,
      );
      if (
        credential === undefined ||
        !EnvironmentAuth.isBrowserCookieCredential(credential.source)
      ) {
        return undefined;
      }
      const authenticated = yield* serverAuth
        .authenticateHttpRequest(request)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (authenticated?.principalId === undefined) {
        return undefined;
      }
      const maybePrincipal = yield* principalsRepo.value
        .get(authenticated.principalId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(maybePrincipal)) {
        return undefined;
      }
      const principal = maybePrincipal.value;
      if (principal.status !== "active" || principal.kind === "owner") {
        return undefined;
      }
      return {
        sessionId: authenticated.sessionId,
        principal,
      } as const;
    });

    const resolveSessionActor = (session: EnvironmentAuthenticatedPrincipal["Service"]) =>
      projectAccess
        .resolve({
          sessionId: session.sessionId,
          subject: session.subject,
          scopes: [...session.scopes],
          principalId: session.principalId,
          binding: session.binding,
        })
        .pipe(
          Effect.catchTags({
            AccessResolveError: (error) =>
              error.reason === "repository_error"
                ? failEnvironmentInternal("internal_error", error)
                : Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
          }),
        );

    const issueInvitationSession = Effect.fnUntraced(function* (input: {
      readonly accepted: InvitationService.ConsumedInvitation;
      readonly method: "browser-session-cookie" | "bearer-access-token";
      readonly request: HttpServerRequest.HttpServerRequest;
      readonly clientMetadata: ReturnType<typeof deriveAuthClientMetadata>;
      readonly replaceSessionId?: EnvironmentAuthenticatedPrincipal["Service"]["sessionId"];
    }) {
      const { accepted, method, request, clientMetadata, replaceSessionId } = input;
      const principalCeiling = accepted.principal.ceiling.filter(isAuthEnvironmentScope);
      let scopes: ReadonlyArray<AuthEnvironmentScope>;
      let role: ProjectRole | undefined;
      if (accepted.principal.kind === "owner") {
        scopes = AuthAdministrativeClientScopes;
        role = "owner";
      } else {
        const activeRoles = accepted.memberships
          .filter((membership) => membership.state === "active")
          .map((membership) => membership.role);
        const roleScopeUnion = [
          ...new Set(activeRoles.flatMap((activeRole) => roleScopes(activeRole))),
        ];
        scopes =
          roleScopeUnion.length > 0
            ? intersectScopes(roleScopeUnion, principalCeiling)
            : intersectScopes(roleScopes(accepted.invitation.role), principalCeiling);
        role = highestProjectRole(activeRoles) ?? accepted.invitation.role;
      }
      const binding = { _tag: "principal" as const };
      const issued = yield* serverAuth
        .issuePrincipalSession({
          principalId: accepted.principal.id,
          binding,
          scopes,
          method,
          ...(replaceSessionId === undefined ? {} : { replaceSessionId }),
          client: {
            ...clientMetadata,
            label: accepted.principal.displayName,
          },
        })
        .pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("browser_session_issuance_failed", error),
          ),
          Effect.catchTags({
            SessionLimitExceededError: (error) =>
              failTooManyRequests(error.message, error.retryAfterSeconds),
          }),
        );
      yield* appendSessionCookie(request, sessions.cookieName, issued.token, issued.expiresAt);
      yield* appendCredentialResponseHeaders;
      return {
        authenticated: true,
        token: issued.token,
        expiresAt: issued.expiresAt,
        ...authScopeResponse(issued.scopes),
        sessionMethod: issued.method,
        binding_kind: "principal",
        binding,
        ...(role !== undefined ? { role } : {}),
        principal: accepted.principal,
        projectId: accepted.invitation.projectId,
      } satisfies AuthInvitationSessionResult;
    });

    return handlers
      .handle(
        "session",
        Effect.fn("environment.auth.session")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const result = yield* serverAuth.getSessionState(request);
            const credential = EnvironmentAuth.selectRequestCredential(
              request,
              sessions.cookieName,
              sessions.legacyCookieName,
            );
            if (
              credential?.source === "legacy-cookie" &&
              result.authenticated &&
              result.sessionMethod === "browser-session-cookie" &&
              result.expiresAt
            ) {
              yield* appendSessionCookie(
                request,
                sessions.cookieName,
                credential.token,
                result.expiresAt,
              );
              yield* appendCredentialResponseHeaders;
            }
            return result;
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        ),
      )
      .handle(
        "browserSession",
        Effect.fn("environment.auth.browserSession")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const previousCredential = EnvironmentAuth.selectRequestCredential(
              request,
              sessions.cookieName,
              sessions.legacyCookieName,
            );
            const result = yield* serverAuth.createBrowserSession(
              args.payload.credential,
              deriveAuthClientMetadata({ request }),
              previousCredential &&
                EnvironmentAuth.isBrowserCookieCredential(previousCredential.source)
                ? previousCredential.token
                : undefined,
            );
            const cookieName = result.cookieName ?? sessions.cookieName;
            const selectedCookie = yield* Effect.fromResult(
              Cookies.set(Cookies.empty, cookieName, result.sessionToken, {
                ...sessionCookieOptions(request),
                expires: DateTime.toDate(result.response.expiresAt),
              }),
            ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")));
            const sessionCookies = result.expireNormalCookie
              ? yield* Effect.fromResult(
                  Cookies.expireCookie(
                    selectedCookie,
                    sessions.cookieName,
                    sessionCookieOptions(request),
                  ),
                ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")))
              : selectedCookie;

            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.mergeCookies(response, sessionCookies)),
            );
            yield* appendCredentialResponseHeaders;
            return result.response;
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("browser_session_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "token",
        Effect.fn("environment.auth.token")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const requestedScopes =
              args.payload.scope === undefined
                ? undefined
                : (parseOAuthScope(args.payload.scope)?.filter(Schema.is(AuthGrantScope)) ?? null);
            if (requestedScopes === null || requestedScopes?.length === 0) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            // Bootstrap exchanges leave the proof unrecorded because its key is not always trusted.
            const proof = args.headers.dpop
              ? yield* checkRequestDpopProof({ request }).pipe(
                  Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
                    appendDpopChallengeHeader.pipe(
                      Effect.andThen(
                        failEnvironmentAuthInvalid(
                          "invalid_credential",
                          EnvironmentAuth.serverAuthDpopFailureReason(error),
                        ),
                      ),
                    ),
                  ),
                  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
                    failEnvironmentInternal("access_token_issuance_failed", error),
                  ),
                )
              : undefined;
            yield* appendCredentialResponseHeaders;
            if (args.payload.subject_token_type === AuthAccessTokenType) {
              if (requestedScopes !== undefined) {
                return yield* failEnvironmentInvalidRequest("invalid_scope");
              }
              if (!proof) {
                yield* appendDpopChallengeHeader;
                return yield* failEnvironmentAuthInvalid("invalid_credential");
              }
              return yield* serverAuth.renewAccessToken(
                args.payload.subject_token,
                proof.thumbprint,
                proof.consume,
              );
            }
            return yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
              args.payload.subject_token,
              requestedScopes,
              deriveAuthClientMetadata({
                request,
                presented: {
                  ...(args.payload.client_label ? { label: args.payload.client_label } : {}),
                  ...(args.payload.client_device_type
                    ? { deviceType: args.payload.client_device_type }
                    : {}),
                  ...(args.payload.client_os ? { os: args.payload.client_os } : {}),
                },
              }),
              proof ? { proofKeyThumbprint: proof.thumbprint } : undefined,
            );
          },
          traceRelayRequest,
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchTags({
            ServerAuthConnectApprovalPendingError: () =>
              currentEnvironmentTraceId.pipe(
                Effect.flatMap((traceId) =>
                  Effect.fail(
                    new EnvironmentConnectApprovalPendingError({
                      code: "connect_approval_pending",
                      traceId,
                    }),
                  ),
                ),
              ),
          }),
          Effect.catchIf(EnvironmentAuth.isServerAuthInvalidRequestError, (error) =>
            failEnvironmentInvalidRequest(EnvironmentAuth.serverAuthInvalidRequestReason(error)),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("access_token_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "webSocketTicket",
        Effect.fn("environment.auth.webSocketTicket")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.issueWebSocketTicket(session);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("websocket_ticket_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "webSocketTicketFor",
        Effect.fn("environment.auth.webSocketTicketFor")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.issueWebSocketTicket(session, { use: args.params.use });
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("websocket_ticket_issuance_failed", error),
          ),
        ),
      )
      .handle(
        "pairingCredential",
        Effect.fn("environment.auth.pairingCredential")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const delegatedScopes = args.payload.access
              ? mcpClientScopes(args.payload.access)
              : (args.payload.scopes ?? AuthStandardClientScopes);
            if (
              delegatedScopes.length === 0 ||
              new Set<AuthEnvironmentScope>(delegatedScopes).size !== delegatedScopes.length
            ) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            for (const delegatedScope of delegatedScopes) {
              if (!session.scopes.has(delegatedScope)) {
                return yield* failEnvironmentScopeRequired(delegatedScope);
              }
            }
            return yield* serverAuth.issuePairingCredential(args.payload);
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_credential_issuance_failed", error),
          ),
          Effect.catchTags({
            ManagedPolicyRefusedError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
          }),
        ),
      )
      .handle(
        "revokePairingLink",
        Effect.fn("environment.auth.revokePairingLink")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokePairingLink(args.payload.id);
            return { revoked };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("pairing_link_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "revokeClient",
        Effect.fn("environment.auth.revokeClient")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            if (args.payload.current === true) {
              const revoked = yield* serverAuth.revokeSession(session.sessionId);
              const request = yield* HttpServerRequest.HttpServerRequest;
              const expiredCookies = yield* Effect.fromResult(
                Cookies.expireCookie(
                  Cookies.empty,
                  sessions.cookieName,
                  sessionCookieOptions(request),
                ),
              ).pipe(Effect.catch(() => failEnvironmentInternal("browser_session_cookie_failed")));
              yield* HttpEffect.appendPreResponseHandler((_request, response) =>
                Effect.succeed(HttpServerResponse.mergeCookies(response, expiredCookies)),
              );
              yield* appendCredentialResponseHeaders;
              return { revoked };
            }
            if (args.payload.sessionId === undefined) {
              return yield* failEnvironmentInvalidRequest("invalid_command");
            }
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokeClientSession(
              session.sessionId,
              args.payload.sessionId,
            );
            return { revoked };
          },
          Effect.catchTags({
            ServerAuthForbiddenOperationError: () =>
              failEnvironmentOperationForbidden("current_session_revoke_not_allowed"),
          }),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "approveConnectDevice",
        Effect.fn("environment.auth.approveConnectDevice")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            const approved = yield* serverAuth.approveConnectDevice(args.payload.pairingLinkId);
            return { approved };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("connect_device_approve_failed", error),
          ),
        ),
      )
      .handle(
        "revokeConnectDevice",
        Effect.fn("environment.auth.revokeConnectDevice")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokeConnectDevice(args.payload.proofKeyThumbprint);
            return { revoked };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("connect_device_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "revokeOtherClients",
        Effect.fn("environment.auth.revokeOtherClients")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revokedCount = yield* serverAuth.revokeOtherClientSessions(session.sessionId);
            return { revokedCount };
          },
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("client_session_revoke_failed", error),
          ),
        ),
      )
      .handle(
        "previewInvitation",
        Effect.fn("environment.auth.previewInvitation")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            yield* appendCredentialResponseHeaders;
            return yield* invitations.preview({
              code: args.query.code,
              ip: clientMetadata.ipAddress ?? null,
            });
          },
          Effect.catchTags({
            InvitationRateLimitedError: (error) =>
              failTooManyRequests(error.message, error.retryAfterSeconds ?? 60),
            InvitationInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "acceptInvitation",
        Effect.fn("environment.auth.acceptInvitation")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            const existingMember = yield* resolveExistingMemberCookieSession(request);
            const accepted = yield* invitations.consume({
              code: args.payload.code,
              ...(args.payload.displayName === undefined
                ? {}
                : { displayName: args.payload.displayName }),
              ...(existingMember === undefined
                ? {}
                : { existingPrincipalId: existingMember.principal.id }),
              audit: {
                ...(existingMember === undefined ? {} : { sessionId: existingMember.sessionId }),
                ip: clientMetadata.ipAddress ?? null,
                userAgent: clientMetadata.userAgent ?? null,
              },
            });
            return yield* issueInvitationSession({
              accepted,
              method: "browser-session-cookie",
              request,
              clientMetadata,
              ...(existingMember === undefined
                ? {}
                : { replaceSessionId: existingMember.sessionId }),
            });
          },
          Effect.catchTags({
            InvitationInvalidError: (error) =>
              Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            InvitationForbiddenError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            InvitationExpiredError: (error) =>
              Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            InvitationAlreadyUsedError: (error) =>
              Effect.fail(new EnvironmentHttpConflictError({ message: error.message })),
            InvitationInternalError: (error) =>
              failEnvironmentInternal("browser_session_issuance_failed", error),
          }),
        ),
      )
      .handle(
        "loginInvitation",
        Effect.fn("environment.auth.loginInvitation")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            const accepted = yield* invitations.consume({
              code: args.payload.code,
              audit: {
                ip: clientMetadata.ipAddress ?? null,
                userAgent: clientMetadata.userAgent ?? null,
              },
            });
            return yield* issueInvitationSession({
              accepted,
              method: "bearer-access-token",
              request,
              clientMetadata,
            });
          },
          Effect.catchTags({
            InvitationInvalidError: (error) =>
              Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            InvitationForbiddenError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            InvitationExpiredError: (error) =>
              Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            InvitationAlreadyUsedError: (error) =>
              Effect.fail(new EnvironmentHttpConflictError({ message: error.message })),
            InvitationInternalError: (error) =>
              failEnvironmentInternal("access_token_issuance_failed", error),
          }),
        ),
      )
      .handleRaw("invitePage", ({ params }) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const clientMetadata = deriveAuthClientMetadata({ request });
          const preview = yield* invitations.preview({
            code: params.code,
            ip: clientMetadata.ipAddress ?? null,
          });
          const existingMember = preview.valid
            ? yield* resolveExistingMemberCookieSession(request)
            : undefined;
          return HttpServerResponse.text(
            renderInvitePage({
              code: params.code,
              preview,
              existingMemberName: existingMember?.principal.displayName ?? null,
            }),
            {
              status: 200,
              contentType: "text/html; charset=utf-8",
              headers: INVITE_PAGE_HEADERS,
            },
          );
        }).pipe(
          Effect.catchTags({
            InvitationRateLimitedError: (error) =>
              Effect.succeed(
                HttpServerResponse.text(error.message, {
                  status: 429,
                  headers: {
                    ...INVITE_PAGE_HEADERS,
                    "retry-after": String(Math.max(1, Math.ceil(error.retryAfterSeconds ?? 60))),
                  },
                }),
              ),
            InvitationInternalError: () =>
              Effect.succeed(
                HttpServerResponse.text("Failed to load invitation.", {
                  status: 500,
                  headers: INVITE_PAGE_HEADERS,
                }),
              ),
          }),
        ),
      )
      .handle(
        "createInvitation",
        Effect.fn("environment.auth.createInvitation")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const isClientInvite =
              args.payload.kind === "client" || args.payload.kind === "external";
            const session = yield* requireEnvironmentScope(
              isClientInvite ? AuthOrchestrationOperateScope : AuthAccessWriteScope,
            );
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            const actor = yield* resolveSessionActor(session);
            const createdBy = session.principalId ?? InvitationService.OWNER_PRINCIPAL_ID;
            yield* appendCredentialResponseHeaders;
            const issued = yield* invitations.issue({
              ...(args.payload.kind === undefined ? {} : { kind: args.payload.kind }),
              role: args.payload.role,
              projectId: args.payload.projectId,
              ...(args.payload.crmClientId === undefined
                ? {}
                : { crmClientId: args.payload.crmClientId }),
              ...(args.payload.expiresInHours === undefined
                ? {}
                : { ttl: Duration.hours(args.payload.expiresInHours) }),
              createdBy,
              actor,
              audit: {
                sessionId: session.sessionId,
                ip: clientMetadata.ipAddress ?? null,
                userAgent: clientMetadata.userAgent ?? null,
              },
            });
            let multiUserEnabled: boolean | undefined;
            if (actor.isOwner && Option.isSome(serverSettings)) {
              const currentSettings = yield* serverSettings.value.getSettings.pipe(
                Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
              );
              if (currentSettings.multiUser !== true) {
                yield* serverSettings.value
                  .updateSettings({ multiUser: true })
                  .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
                multiUserEnabled = true;
              }
            }
            return {
              ...issued,
              ...(multiUserEnabled === true ? { multiUserEnabled: true } : {}),
            };
          },
          Effect.catchTags({
            InvitationForbiddenError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            InvitationRateLimitedError: (error) =>
              Effect.fail(new EnvironmentHttpTooManyRequestsError({ message: error.message })),
            InvitationInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "listInvitations",
        Effect.fn("environment.auth.listInvitations")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessReadScope);
            const actor = yield* resolveSessionActor(session);
            const actorId = session.principalId ?? InvitationService.OWNER_PRINCIPAL_ID;
            return yield* invitations.listPending({
              actorId,
              actor,
              ...(args.query.projectId === undefined ? {} : { projectId: args.query.projectId }),
            });
          },
          Effect.catchTags({
            InvitationForbiddenError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            InvitationInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "revokeInvitation",
        Effect.fn("environment.auth.revokeInvitation")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            const actor = yield* resolveSessionActor(session);
            const revokedBy = session.principalId ?? InvitationService.OWNER_PRINCIPAL_ID;
            const revoked = yield* invitations.revoke({
              id: args.params.id,
              revokedBy,
              actor,
              audit: {
                sessionId: session.sessionId,
                ip: clientMetadata.ipAddress ?? null,
                userAgent: clientMetadata.userAgent ?? null,
              },
            });
            return { revoked };
          },
          Effect.catchTags({
            InvitationForbiddenError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            InvitationInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "listMembers",
        Effect.fn("environment.auth.listMembers")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessReadScope);
            const actor = yield* resolveSessionActor(session);
            return yield* membershipService.listForActor(actor);
          },
          Effect.catchTags({
            MembershipInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "updateMember",
        Effect.fn("environment.auth.updateMember")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            const actor = yield* resolveSessionActor(session);
            return yield* membershipService.updateMember({
              actor,
              principalId: args.params.principalId,
              ...(args.payload.projectId === undefined
                ? {}
                : { projectId: args.payload.projectId }),
              ...(args.payload.role === undefined ? {} : { role: args.payload.role }),
              ...(args.payload.state === undefined ? {} : { state: args.payload.state }),
              ...(args.payload.ceiling === undefined ? {} : { ceiling: args.payload.ceiling }),
              audit: {
                sessionId: session.sessionId,
                ip: clientMetadata.ipAddress ?? null,
                userAgent: clientMetadata.userAgent ?? null,
              },
            });
          },
          Effect.catchTags({
            MembershipInvalidInputError: (error) =>
              Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            MembershipForbiddenError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            MembershipCeilingError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            MembershipNotFoundError: (error) =>
              failEnvironmentNotFound(
                error.resource === "principal" ? "member_not_found" : "membership_not_found",
              ),
            MembershipInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "removeMember",
        Effect.fn("environment.auth.removeMember")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            const actor = yield* resolveSessionActor(session);
            const audit = {
              sessionId: session.sessionId,
              ip: clientMetadata.ipAddress ?? null,
              userAgent: clientMetadata.userAgent ?? null,
            };
            if (args.query.projectId !== undefined) {
              const result = yield* membershipService.removeFromProject({
                actor,
                projectId: args.query.projectId,
                principalId: args.params.principalId,
                audit,
              });
              return { removed: true, promotedOwner: result.promotedOwner };
            }
            yield* membershipService.removePrincipal({
              actor,
              principalId: args.params.principalId,
              audit,
            });
            return { removed: true };
          },
          Effect.catchTags({
            MembershipForbiddenError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            MembershipCeilingError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            MembershipNotFoundError: (error) =>
              failEnvironmentNotFound(
                error.resource === "principal" ? "member_not_found" : "membership_not_found",
              ),
            MembershipInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "issueMemberLoginCode",
        Effect.fn("environment.auth.issueMemberLoginCode")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            const actor = yield* resolveSessionActor(session);
            const createdBy = session.principalId ?? InvitationService.OWNER_PRINCIPAL_ID;
            yield* appendCredentialResponseHeaders;
            const issued = yield* invitations.issueLogin({
              principalId: args.params.principalId,
              createdBy,
              actor,
              audit: {
                sessionId: session.sessionId,
                ip: clientMetadata.ipAddress ?? null,
                userAgent: clientMetadata.userAgent ?? null,
              },
            });
            return {
              code: issued.code,
              expiresAt: issued.invitation.expiresAt,
            };
          },
          Effect.catchTags({
            InvitationInvalidError: (error) =>
              error.reason === "principal_not_found"
                ? failEnvironmentNotFound("principal_not_found")
                : Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            InvitationForbiddenError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            InvitationRateLimitedError: (error) =>
              Effect.fail(new EnvironmentHttpTooManyRequestsError({ message: error.message })),
            InvitationInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "listAuditEvents",
        Effect.fn("environment.auth.listAuditEvents")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessReadScope);
            const actor = yield* resolveSessionActor(session);
            return yield* auditService.listForActor({
              actor,
              query: args.query,
            });
          },
          Effect.catchTags({
            AuditInvalidInputError: (error) =>
              Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            AuditForbiddenError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            AuditInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "setOwnPassword",
        Effect.fn("environment.auth.setOwnPassword")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            const actor = yield* resolveSessionActor(session);
            yield* appendCredentialResponseHeaders;
            return yield* passwords.setOwnPassword({
              actor,
              password: args.payload.password,
              audit: {
                sessionId: session.sessionId,
                ip: clientMetadata.ipAddress ?? null,
                userAgent: clientMetadata.userAgent ?? null,
              },
            });
          },
          Effect.catchTags({
            PasswordValidationError: (error) =>
              Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            PasswordForbiddenError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            PasswordNotFoundError: () => failEnvironmentNotFound("principal_not_found"),
            PasswordInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "setMemberPassword",
        Effect.fn("environment.auth.setMemberPassword")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            const actor = yield* resolveSessionActor(session);
            yield* appendCredentialResponseHeaders;
            return yield* passwords.setMemberPassword({
              actor,
              principalId: args.params.principalId,
              password: args.payload.password,
              audit: {
                sessionId: session.sessionId,
                ip: clientMetadata.ipAddress ?? null,
                userAgent: clientMetadata.userAgent ?? null,
              },
            });
          },
          Effect.catchTags({
            PasswordValidationError: (error) =>
              Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            PasswordForbiddenError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            PasswordNotFoundError: () => failEnvironmentNotFound("principal_not_found"),
            PasswordInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "loginPassword",
        Effect.fn("environment.auth.loginPassword")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            const verified = yield* passwords.verifyLogin({
              ...("email" in args.payload
                ? { email: args.payload.email }
                : { principalId: args.payload.principalId }),
              password: args.payload.password,
              audit: {
                ip: clientMetadata.ipAddress ?? null,
                userAgent: clientMetadata.userAgent ?? null,
              },
            });
            const principalCeiling = verified.principal.ceiling.filter(isAuthEnvironmentScope);
            let scopes: ReadonlyArray<AuthEnvironmentScope>;
            let role: ProjectRole | undefined;
            if (verified.principal.kind === "owner") {
              scopes = AuthAdministrativeClientScopes;
              role = "owner";
            } else {
              const activeRoles = verified.memberships
                .filter((membership) => membership.state === "active")
                .map((membership) => membership.role);
              const roleScopeUnion = [
                ...new Set(activeRoles.flatMap((activeRole) => roleScopes(activeRole))),
              ];
              scopes =
                roleScopeUnion.length > 0
                  ? intersectScopes(roleScopeUnion, principalCeiling)
                  : intersectScopes(roleScopes("viewer"), principalCeiling);
              role = highestProjectRole(activeRoles);
            }
            const binding = { _tag: "principal" as const };
            const issued = yield* serverAuth
              .issuePrincipalSession({
                principalId: verified.principal.id,
                binding,
                scopes,
                method: "bearer-access-token",
                client: {
                  ...clientMetadata,
                  label: verified.principal.displayName,
                },
              })
              .pipe(
                Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
                  failEnvironmentInternal("access_token_issuance_failed", error),
                ),
                Effect.catchTags({
                  SessionLimitExceededError: (error) =>
                    failTooManyRequests(error.message, error.retryAfterSeconds),
                }),
              );
            yield* appendSessionCookie(
              request,
              sessions.cookieName,
              issued.token,
              issued.expiresAt,
            );
            yield* appendCredentialResponseHeaders;
            return {
              authenticated: true,
              token: issued.token,
              expiresAt: issued.expiresAt,
              ...authScopeResponse(issued.scopes),
              sessionMethod: issued.method,
              binding_kind: "principal",
              binding,
              ...(role !== undefined ? { role } : {}),
              principal: verified.principal,
            } satisfies AuthInvitationSessionResult;
          },
          Effect.catchTags({
            PasswordAuthFailedError: (error) =>
              Effect.fail(new EnvironmentHttpUnauthorizedError({ message: error.message })),
            PasswordRateLimitedError: (error) =>
              Effect.fail(new EnvironmentHttpTooManyRequestsError({ message: error.message })),
            PasswordInternalError: (error) =>
              failEnvironmentInternal("access_token_issuance_failed", error),
          }),
        ),
      )
      .handle(
        "issueRecoveryCode",
        Effect.fn("environment.auth.issueRecoveryCode")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            const actor = yield* resolveSessionActor(session);
            yield* appendCredentialResponseHeaders;
            return yield* passwords.issueRecoveryCode({
              actor,
              ...(args.payload.principalId === undefined
                ? {}
                : { principalId: args.payload.principalId }),
              audit: {
                sessionId: session.sessionId,
                ip: clientMetadata.ipAddress ?? null,
                userAgent: clientMetadata.userAgent ?? null,
              },
            });
          },
          Effect.catchTags({
            PasswordValidationError: (error) =>
              Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            PasswordForbiddenError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            PasswordNotFoundError: () => failEnvironmentNotFound("principal_not_found"),
            PasswordInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "confirmRecovery",
        Effect.fn("environment.auth.confirmRecovery")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            yield* appendCredentialResponseHeaders;
            return yield* passwords.confirmRecovery({
              code: args.payload.code,
              password: args.payload.password,
              audit: {
                ip: clientMetadata.ipAddress ?? null,
                userAgent: clientMetadata.userAgent ?? null,
              },
            });
          },
          Effect.catchTags({
            PasswordValidationError: (error) =>
              Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            PasswordRecoveryInvalidError: (error) =>
              Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            PasswordRecoveryExpiredError: (error) =>
              Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            PasswordRecoveryAlreadyUsedError: (error) =>
              Effect.fail(new EnvironmentHttpConflictError({ message: error.message })),
            PasswordInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "transferOwnership",
        Effect.fn("environment.auth.transferOwnership")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            const actor = yield* resolveSessionActor(session);
            return yield* membershipService.transferOwnership({
              actor,
              toPrincipalId: args.payload.toPrincipalId,
              confirmation: args.payload.confirmation,
              audit: {
                sessionId: session.sessionId,
                ip: clientMetadata.ipAddress ?? null,
                userAgent: clientMetadata.userAgent ?? null,
              },
            });
          },
          Effect.catchTags({
            MembershipInvalidInputError: (error) =>
              Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            MembershipForbiddenError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            MembershipNotFoundError: () => failEnvironmentNotFound("principal_not_found"),
            MembershipInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "listApiTokens",
        Effect.fn("environment.auth.listApiTokens")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            const actor = yield* resolveSessionActor(session);
            return yield* apiTokenService.listForActor({
              actor,
              ...(args.query.principalId === undefined
                ? {}
                : { principalId: args.query.principalId }),
            });
          },
          Effect.catchTags({
            ApiTokenForbiddenError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            ApiTokenInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "createApiToken",
        Effect.fn("environment.auth.createApiToken")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            const actor = yield* resolveSessionActor(session);
            yield* appendCredentialResponseHeaders;
            return yield* apiTokenService.create({
              actor,
              ...(args.payload.principalId === undefined
                ? {}
                : { principalId: args.payload.principalId }),
              scopes: args.payload.scopes,
              binding: args.payload.binding,
              ...(args.payload.expiresAt === undefined
                ? {}
                : { expiresAt: args.payload.expiresAt }),
              audit: {
                sessionId: session.sessionId,
                ip: clientMetadata.ipAddress ?? null,
                userAgent: clientMetadata.userAgent ?? null,
              },
            });
          },
          Effect.catchTags({
            ApiTokenInvalidInputError: (error) =>
              Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message })),
            ApiTokenForbiddenError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            ApiTokenNotFoundError: () => failEnvironmentNotFound("principal_not_found"),
            ApiTokenLimitExceededError: (error) => failTooManyRequests(error.message, 60),
            ApiTokenInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "revokeApiToken",
        Effect.fn("environment.auth.revokeApiToken")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            const request = yield* HttpServerRequest.HttpServerRequest;
            const clientMetadata = deriveAuthClientMetadata({ request });
            const actor = yield* resolveSessionActor(session);
            const revoked = yield* apiTokenService.revoke({
              actor,
              id: args.params.id,
              audit: {
                sessionId: session.sessionId,
                ip: clientMetadata.ipAddress ?? null,
                userAgent: clientMetadata.userAgent ?? null,
              },
            });
            return { revoked };
          },
          Effect.catchTags({
            ApiTokenForbiddenError: (error) =>
              Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
            ApiTokenInternalError: (error) => failEnvironmentInternal("internal_error", error),
          }),
        ),
      );
  }),
);
