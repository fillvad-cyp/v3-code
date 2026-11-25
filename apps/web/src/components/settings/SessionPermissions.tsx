import { type EnvironmentId, sessionGrantsScope } from "@t3tools/contracts";
import {
  AUTH_SCOPE_OPTIONS,
  sessionPermissionsUnavailableMessage,
} from "@t3tools/shared/authScopeOptions";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";
import { signOutPrimaryEnvironment } from "~/environments/primary";
import { m } from "~/i18n/messages";
import { authEnvironment } from "~/state/auth";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentSessionState, usePreparedConnection } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function SessionPermissions({
  environmentId,
  connected,
  routeContext = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly routeContext?: boolean;
}) {
  const gt = useGT();
  const messages = useMessages();
  const router = useRouter();
  const navigate = useNavigate();
  const primaryEnvironment = usePrimaryEnvironment();
  const session = useEnvironmentSessionState(environmentId);
  const prepared = usePreparedConnection(environmentId);
  const signOutCurrentSession = useAtomCommand(authEnvironment.signOutCurrentSession, {
    reportFailure: false,
  });
  const [isSigningOut, setIsSigningOut] = useState(false);

  const isPrimary = primaryEnvironment?.environmentId === environmentId;
  const showSignOut =
    session.data?.authenticated === true &&
    (session.data.auth.authMode === "multi-user" || session.data.principal !== undefined);

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    if (isPrimary) {
      const error = await signOutPrimaryEnvironment().then(
        () => null,
        (cause) => (cause instanceof Error ? cause.message : String(cause)),
      );
      if (error !== null) {
        setIsSigningOut(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: gt("Could not sign out"),
            description: error,
          }),
        );
        return;
      }
      router.history.replace("/login");
      router.history.flush();
      window.location.reload();
      return;
    }

    const result = await signOutCurrentSession({ environmentId, input: null });
    setIsSigningOut(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      const message =
        failure instanceof Error
          ? (thrownErrorMessage(failure, m) ?? failure.message)
          : gt("Could not sign out.");
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not sign out"),
          description: message,
        }),
      );
      return;
    }
    const host = prepared._tag === "Some" ? prepared.value.httpBaseUrl : undefined;
    const label = prepared._tag === "Some" ? prepared.value.label : undefined;
    void navigate({
      to: "/login",
      search: {
        ...(host ? { host } : {}),
        environmentId,
        ...(label ? { label } : {}),
      },
    });
  };

  return connected && !session.hasError && !session.isPending && session.data?.authenticated ? (
    <div className="space-y-3 py-3 text-xs">
      {session.data.principal || showSignOut ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {session.data.principal ? (
            <p className="text-foreground">
              {session.data.role ? (
                <T>
                  Signed in as{" "}
                  <span className="font-medium">
                    <Var>{session.data.principal.displayName}</Var>
                  </span>{" "}
                  (<Var>{session.data.role}</Var>)
                </T>
              ) : (
                <T>
                  Signed in as{" "}
                  <span className="font-medium">
                    <Var>{session.data.principal.displayName}</Var>
                  </span>
                </T>
              )}
            </p>
          ) : (
            <span />
          )}
          {showSignOut ? (
            <Button
              size="xs"
              variant="outline"
              disabled={isSigningOut}
              onClick={() => void handleSignOut()}
            >
              {isSigningOut ? gt("Signing out…") : gt("Sign out")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <p className="text-muted-foreground">
        {routeContext ? (
          <T>
            These permissions apply to your active route. Other routes may have different
            permissions.
          </T>
        ) : (
          <T>These permissions apply to this client’s current connection.</T>
        )}
      </p>
      <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {AUTH_SCOPE_OPTIONS.map(({ scope, title }) => (
          <li key={scope} className="flex items-start justify-between gap-3">
            <span>{messages(title)}</span>
            <span className="shrink-0 text-muted-foreground">
              {sessionGrantsScope(session.data!, scope)
                ? gt("Allowed", { $context: "permission state" })
                : gt("Not granted")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  ) : (
    <p className="py-3 text-xs text-muted-foreground">
      {sessionPermissionsUnavailableMessage(
        {
          connected,
          failed: session.hasError,
          rejected:
            !session.hasError && !session.isPending && session.data?.authenticated === false,
        },
        messages,
      )}
    </p>
  );
}
