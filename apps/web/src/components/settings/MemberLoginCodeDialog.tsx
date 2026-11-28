import type { MemberLoginCodeResult } from "@t3tools/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowSecond } from "../../hooks/useNowSecond";
import { formatExpiresInLabel } from "../../timestampFormat";
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
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { formatAccessTimestamp } from "./ConnectionsSettings.logic";

export interface MemberLoginCodeDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly memberName: string;
  readonly loginCode: MemberLoginCodeResult | null;
  readonly isLoading: boolean;
  readonly errorMessage: string | null;
}

export function MemberLoginCodeDialog({
  open,
  onOpenChange,
  memberName,
  loginCode,
  isLoading,
  errorMessage,
}: MemberLoginCodeDialogProps) {
  const gt = useGT();
  const m = useMessages();
  const nowMs = useNowSecond();
  const [copied, setCopied] = useState(false);
  const [manualCopyValue, setManualCopyValue] = useState<string | null>(null);

  const { copyToClipboard } = useCopyToClipboard<string>({
    onCopy: () => {
      setCopied(true);
      setManualCopyValue(null);
    },
    onError: (error, value) => {
      setManualCopyValue(value);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not copy login code"),
          description: error.message || gt("Copy the code manually instead."),
        }),
      );
    },
  });

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setCopied(false);
      setManualCopyValue(null);
    }
    onOpenChange(nextOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <T>Login code</T>
          </DialogTitle>
          <DialogDescription>
            {gt("One-time sign-in code for {name}.", { name: memberName })}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">
                <T>Creating one-time login code…</T>
              </p>
            ) : errorMessage ? (
              <Alert variant="error">
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            ) : loginCode ? (
              <>
                <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
                  <code className="min-w-0 flex-1 truncate font-mono text-sm font-medium text-foreground">
                    {loginCode.code}
                  </code>
                  <Button
                    size="xs"
                    variant="outline"
                    type="button"
                    onClick={() => copyToClipboard(loginCode.code, loginCode.code)}
                  >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                    {copied ? gt("Copied") : gt("Copy code")}
                  </Button>
                </div>
                {manualCopyValue !== null ? (
                  <Textarea
                    readOnly
                    rows={2}
                    value={manualCopyValue}
                    onFocus={(event) => event.currentTarget.select()}
                    onClick={(event) => event.currentTarget.select()}
                  />
                ) : null}
                <p className="text-xs text-muted-foreground">
                  <T>
                    <Var>{formatExpiresInLabel(loginCode.expiresAt, nowMs, m)}</Var> (
                    <Var>{formatAccessTimestamp(loginCode.expiresAt)}</Var>). Anyone with this code
                    can sign in once as <Var>{memberName}</Var>.
                  </T>
                </p>
              </>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="default" onClick={() => handleOpenChange(false)}>
            <T>Done</T>
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
