import { useReducer } from "react";
import type React from "react";
import { msg, T, useGT, Var } from "gt-react";

import { m } from "../../i18n/messages";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import {
  initialRecoverySurfaceState,
  transitionRecoverySurfaceState,
} from "./RecoveryRouteSurface.logic";

const MIN_PASSWORD_LENGTH = 8;

export interface RecoveryRouteSurfaceProps {
  readonly initialCode?: string;
  readonly host?: string;
  readonly onSubmitRecovery: (input: {
    readonly code: string;
    readonly password: string;
  }) => Promise<void>;
}

export function RecoveryRouteSurface({
  initialCode,
  host,
  onSubmitRecovery,
}: RecoveryRouteSurfaceProps) {
  const gt = useGT();
  const [state, dispatch] = useReducer(
    transitionRecoverySurfaceState,
    initialCode,
    initialRecoverySurfaceState,
  );

  const isSubmitting = state.status === "submitting";
  const loginHref = host ? `/login?host=${encodeURIComponent(host)}` : "/login";

  const handleSubmit = async (event?: React.SubmitEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const trimmedCode = state.code.trim();
    if (trimmedCode.length === 0) {
      dispatch({
        type: "validation_failed",
        message: gt("Enter your recovery code to continue."),
      });
      return;
    }
    if (state.password.length < MIN_PASSWORD_LENGTH) {
      dispatch({
        type: "validation_failed",
        message: gt("Password must be at least {min} characters.", { min: MIN_PASSWORD_LENGTH }),
      });
      return;
    }
    if (state.password !== state.confirmPassword) {
      dispatch({
        type: "validation_failed",
        message: gt("Passwords do not match."),
      });
      return;
    }

    dispatch({ type: "submit_started" });

    const submitError = await onSubmitRecovery({
      code: trimmedCode,
      password: state.password,
    }).then(
      () => null,
      (error) => errorMessageFromUnknown(error),
    );

    if (submitError !== null) {
      dispatch({ type: "submit_failed", message: submitError });
      return;
    }

    dispatch({ type: "submit_succeeded" });
  };

  return (
    <StandalonePage>
      <StandalonePageHeader
        title={gt("Recover account access")}
        description={gt(
          "Use a one-time recovery code to set a new password and sign out all existing sessions.",
        )}
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

      {state.status === "recovered" ? (
        <div className="mt-6 space-y-4">
          <Alert variant="success">
            <AlertDescription>
              <T>
                Your password has been updated and all previous sessions, devices, and access tokens
                have been revoked.
              </T>
            </AlertDescription>
          </Alert>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" render={<a href={loginHref} />}>
              <T>Sign in with your new password</T>
            </Button>
          </div>
        </div>
      ) : (
        <form className="mt-6 space-y-4" onSubmit={(event) => void handleSubmit(event)}>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="recovery-code">
              <T>Recovery code</T>
            </label>
            <Input
              id="recovery-code"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              autoCorrect="off"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) =>
                dispatch({ type: "code_changed", value: event.currentTarget.value })
              }
              placeholder={gt("Paste or type your recovery code")}
              spellCheck={false}
              value={state.code}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="recovery-password">
              <T>New password</T>
            </label>
            <Input
              id="recovery-password"
              type="password"
              autoComplete="new-password"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) =>
                dispatch({ type: "password_changed", value: event.currentTarget.value })
              }
              placeholder={gt("At least 8 characters")}
              value={state.password}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="recovery-confirm-password">
              <T>Confirm password</T>
            </label>
            <Input
              id="recovery-confirm-password"
              type="password"
              autoComplete="new-password"
              disabled={isSubmitting}
              nativeInput
              onChange={(event) =>
                dispatch({ type: "confirm_password_changed", value: event.currentTarget.value })
              }
              placeholder={gt("Re-enter your new password")}
              value={state.confirmPassword}
            />
          </div>

          {state.status === "error" && state.errorMessage ? (
            <Alert variant="error">
              <AlertDescription>{state.errorMessage}</AlertDescription>
            </Alert>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={isSubmitting} size="sm" type="submit">
              {isSubmitting ? gt("Recovering…") : gt("Reset password")}
            </Button>
            <Button size="sm" variant="ghost-muted" render={<a href={loginHref} />}>
              <T>Back to sign in</T>
            </Button>
          </div>
        </form>
      )}
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

  return m(msg("Account recovery failed."));
}
