import { type EnvironmentId, type PrincipalId } from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import type React from "react";
import { T, useGT } from "gt-react";

import { m as resolveMessage } from "../../i18n/messages";
import { authEnvironment } from "../../state/auth";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
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
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";

const MIN_PASSWORD_LENGTH = 8;

export interface SetPasswordDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  /** When set, uses the owner endpoint to set another member's password. */
  readonly targetPrincipalId?: PrincipalId;
  readonly targetName?: string;
}

export function SetPasswordDialog({
  open,
  onOpenChange,
  environmentId,
  targetPrincipalId,
  targetName,
}: SetPasswordDialogProps) {
  const gt = useGT();
  const setOwnPassword = useAtomCommand(authEnvironment.setOwnPassword, {
    reportFailure: false,
  });
  const setMemberPassword = useAtomCommand(authEnvironment.setMemberPassword, {
    reportFailure: false,
  });

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const resetForm = () => {
    setPassword("");
    setConfirmPassword("");
    setErrorMessage(null);
    setIsSaving(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetForm();
    }
    onOpenChange(nextOpen);
  };

  const handleSubmit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSaving) return;

    if (password.length < MIN_PASSWORD_LENGTH) {
      setErrorMessage(
        gt("Password must be at least {min} characters.", { min: MIN_PASSWORD_LENGTH }),
      );
      return;
    }
    if (password !== confirmPassword) {
      setErrorMessage(gt("Passwords do not match."));
      return;
    }

    setErrorMessage(null);
    setIsSaving(true);
    const result =
      targetPrincipalId !== undefined
        ? await setMemberPassword({
            environmentId,
            input: { principalId: targetPrincipalId, password },
          })
        : await setOwnPassword({
            environmentId,
            input: { password },
          });
    setIsSaving(false);

    if (result._tag === "Success") {
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: gt("Password updated"),
          description:
            targetName !== undefined
              ? gt("Password updated for {name}.", { name: targetName })
              : gt("You can now sign in with your password."),
        }),
      );
      handleOpenChange(false);
      return;
    }

    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      const message =
        failure instanceof Error
          ? (thrownErrorMessage(failure, resolveMessage) ?? failure.message)
          : gt("Could not update password.");
      setErrorMessage(message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {targetName !== undefined ? (
              gt("Set password for {name}", { name: targetName })
            ) : (
              <T>Set or change password</T>
            )}
          </DialogTitle>
          <DialogDescription>
            <T>Choose a password of at least 8 characters to sign in without a one-time code.</T>
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <DialogPanel>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="settings-new-password">
                  <T>New password</T>
                </label>
                <Input
                  id="settings-new-password"
                  type="password"
                  autoComplete="new-password"
                  disabled={isSaving}
                  nativeInput
                  onChange={(event) => {
                    setPassword(event.currentTarget.value);
                    if (errorMessage !== null) setErrorMessage(null);
                  }}
                  placeholder={gt("At least 8 characters")}
                  value={password}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium" htmlFor="settings-confirm-password">
                  <T>Confirm password</T>
                </label>
                <Input
                  id="settings-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  disabled={isSaving}
                  nativeInput
                  onChange={(event) => {
                    setConfirmPassword(event.currentTarget.value);
                    if (errorMessage !== null) setErrorMessage(null);
                  }}
                  placeholder={gt("Re-enter your new password")}
                  value={confirmPassword}
                />
              </div>
              {errorMessage ? (
                <Alert variant="error">
                  <AlertDescription>{errorMessage}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter variant="bare">
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={() => handleOpenChange(false)}
            >
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? gt("Saving…") : gt("Save password")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
