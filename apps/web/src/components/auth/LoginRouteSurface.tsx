import type { PasswordLoginInput } from "@t3tools/contracts";
import { startTransition, useReducer } from "react";
import type React from "react";
import { msg, T, useGT, Var } from "gt-react";

import { m } from "../../i18n/messages";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import {
  buildPasswordLoginPayload,
  initialLoginSurfaceState,
  normalizeSubmittedLoginCode,
  transitionLoginSurfaceState,
} from "./LoginRouteSurface.logic";

export interface LoginRouteSurfaceProps {
  readonly environmentLabel?: string;
  readonly host?: string;
  readonly initialErrorMessage?: string;
  readonly onSubmitCode: (code: string) => Promise<void>;
  readonly onSubmitPassword?: (credentials: PasswordLoginInput) => Promise<void>;
  readonly onAuthenticated: () => void;
}

export function LoginRouteSurface({
  environmentLabel,
  host,
  initialErrorMessage,
  onSubmitCode,
  onSubmitPassword,
  onAuthenticated,
}: LoginRouteSurfaceProps) {
  const gt = useGT();
  const [state, dispatch] = useReducer(
    transitionLoginSurfaceState,
    initialErrorMessage,
    initialLoginSurfaceState,
  );

  const isSubmitting = state.status === "submitting";
  const supportsPassword = onSubmitPassword !== undefined;
  const recoveryHref = host ? `/recover?host=${encodeURIComponent(host)}` : "/recover";

  const handleSubmit = async (event?: React.SubmitEvent<HTMLFormElement>) => {
    event?.preventDefault();

    if (state.mode === "password" && onSubmitPassword !== undefined) {
      const payload = buildPasswordLoginPayload(state.identifier, state.password);
      if (payload === null) {
        dispatch({
          type: "validation_failed",
          message: gt("Enter your email or member ID and password to continue."),
        });
        return;
      }

      dispatch({ type: "submit_started" });

      const submitError = await onSubmitPassword(payload).then(
        () => null,
        (error) => errorMessageFromUnknown(error),
      );

      if (submitError !== null) {
        dispatch({ type: "submit_failed", message: submitError });
        return;
      }

      dispatch({ type: "submit_succeeded" });
      startTransition(() => {
        onAuthenticated();
      });
      return;
    }

    const trimmed = normalizeSubmittedLoginCode(state.code);
    if (trimmed === null) {
      dispatch({
        type: "validation_failed",
        message: gt("Enter a login code to continue."),
      });
      return;
    }

    dispatch({ type: "submit_started" });

    const submitError = await onSubmitCode(trimmed).then(
      () => null,
      (error) => errorMessageFromUnknown(error),
    );

    if (submitError !== null) {
      dispatch({ type: "submit_failed", message: submitError });
      return;
    }

    dispatch({ type: "submit_succeeded" });
    startTransition(() => {
      onAuthenticated();
    });
  };

  return (
    <StandalonePage>
      <StandalonePageHeader
        title={
          environmentLabel
            ? gt("Sign in to {environment}", { environment: environmentLabel })
            : gt("Sign in to this environment")
        }
        description={
          state.mode === "password"
            ? gt("Sign in with your email or member ID and password.")
            : gt("Enter your one-time login code to start a session.")
        }
      />

      {host ? (
        <div className="mt-5 rounded-lg border border-border/70 bg-background/55 px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          <T>
            Host:{" "}
            <span className="font-mono text-foreground/80">
              <Var>{host}</Var>
            </span>
          </T>
        </div>
      ) : null}

      {supportsPassword ? (
        <div className="mt-5 flex gap-2" role="tablist" aria-label={gt("Sign-in method")}>
          <Button
            type="button"
            size="xs"
            variant={state.mode === "code" ? "default" : "outline"}
            role="tab"
            aria-selected={state.mode === "code"}
            disabled={isSubmitting}
            onClick={() => dispatch({ type: "mode_changed", mode: "code" })}
          >
            <T>One-time code</T>
          </Button>
          <Button
            type="button"
            size="xs"
            variant={state.mode === "password" ? "default" : "outline"}
            role="tab"
            aria-selected={state.mode === "password"}
            disabled={isSubmitting}
            onClick={() => dispatch({ type: "mode_changed", mode: "password" })}
          >
            <T>Password</T>
          </Button>
        </div>
      ) : null}

      <form className="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
        {state.mode === "password" && supportsPassword ? (
          <>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="member-login-identifier">
                <T>Email or member ID</T>
              </label>
              <Input
                id="member-login-identifier"
                autoCapitalize="none"
                autoComplete="username"
                autoCorrect="off"
                disabled={isSubmitting}
                nativeInput
                onChange={(event) =>
                  dispatch({ type: "identifier_changed", value: event.currentTarget.value })
                }
                placeholder={gt("you@example.com or member ID")}
                spellCheck={false}
                value={state.identifier}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="member-login-password">
                <T>Password</T>
              </label>
              <Input
                id="member-login-password"
                type="password"
                autoComplete="current-password"
                disabled={isSubmitting}
                nativeInput
                onChange={(event) =>
                  dispatch({ type: "password_changed", value: event.currentTarget.value })
                }
                placeholder={gt("Enter your password")}
                value={state.password}
              />
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="member-login-code">
              <T>Login code</T>
            </label>
            <Input
              id="member-login-code"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              autoCorrect="off"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) =>
                dispatch({ type: "code_changed", value: event.currentTarget.value })
              }
              placeholder={gt("Paste or type your one-time login code")}
              spellCheck={false}
              value={state.code}
            />
          </div>
        )}

        {state.status === "error" && state.errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{state.errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={isSubmitting} size="sm" type="submit">
            {isSubmitting ? gt("Signing in...") : gt("Sign in")}
          </Button>
          {state.mode === "password" && supportsPassword ? (
            <Button size="sm" variant="ghost-muted" render={<a href={recoveryHref} />}>
              <T>Recover with a code</T>
            </Button>
          ) : null}
        </div>
      </form>

      <div className="mt-6 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
        {state.mode === "password" ? (
          <T>
            Forgot your password? Ask the environment owner for a one-time recovery code, then reset
            it on the recovery page.
          </T>
        ) : (
          <T>Ask the environment owner for a new one-time login code if yours has expired.</T>
        )}
      </div>
    </StandalonePage>
  );
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return m(msg("Sign-in failed."));
}
