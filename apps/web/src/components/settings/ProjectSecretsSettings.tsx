import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type MemberWithMemberships,
  type ProjectId,
  type ProjectSecret,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CheckIcon, CopyIcon, KeyRoundIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { m as resolveMessage } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useSyncAccessRevision } from "../../state/accessRevision";
import { authEnvironment } from "../../state/auth";
import { useEnvironment, useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
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
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { formatAccessTimestamp } from "./ConnectionsSettings.logic";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import {
  deriveProjectSecretsPermissions,
  formatProjectSecretErrorMessage,
  projectSecretReferenceText,
  sortProjectSecrets,
  supportsProjectSecretsCapability,
  validateProjectSecretNameInput,
  validateProjectSecretValueInput,
} from "./ProjectSecretsSettings.logic";
import { SettingsSection } from "./settingsLayout";

const EMPTY_MEMBERS: ReadonlyArray<MemberWithMemberships> = [];
const EMPTY_SECRETS: ReadonlyArray<ProjectSecret> = [];

interface SecretEditorDialogProps {
  readonly open: boolean;
  readonly mode: "create" | "update";
  readonly fixedName: string | null;
  readonly projectTitle: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: { readonly name: string; readonly value: string }) => Promise<void>;
}

function SecretEditorDialog({
  open,
  mode,
  fixedName,
  projectTitle,
  busy,
  error,
  onOpenChange,
  onSubmit,
}: SecretEditorDialogProps) {
  const gt = useGT();
  const m = useMessages();
  const [name, setName] = useState(fixedName ?? "");
  const [value, setValue] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const effectiveName = mode === "update" && fixedName !== null ? fixedName : name;

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setValue("");
      setValidationError(null);
      if (mode === "create") {
        setName("");
      }
    }
    onOpenChange(nextOpen);
  };

  const handleSave = async () => {
    const trimmedName = effectiveName.trim();
    const nameError = validateProjectSecretNameInput(trimmedName, m);
    if (nameError !== null) {
      setValidationError(nameError);
      return;
    }
    const valueError = validateProjectSecretValueInput(value, m);
    if (valueError !== null) {
      setValidationError(valueError);
      return;
    }
    setValidationError(null);
    const submittedValue = value;
    setValue("");
    await onSubmit({ name: trimmedName, value: submittedValue });
  };

  const displayError = validationError ?? error;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === "update" ? (
              <T>
                Update secret <Var>{fixedName ?? ""}</Var>
              </T>
            ) : (
              <T>
                Add secret to <Var>{projectTitle}</Var>
              </T>
            )}
          </DialogTitle>
          <DialogDescription>
            <T>
              Values are encrypted at rest on the server and are never shown again after saving.
              Only the SHA-256 fingerprint is displayed.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            {displayError ? (
              <Alert variant="error">
                <AlertDescription>{displayError}</AlertDescription>
              </Alert>
            ) : null}

            <div className="space-y-1.5">
              <label
                htmlFor="project-secret-name-input"
                className="text-xs font-medium text-foreground"
              >
                <T>Name</T>
              </label>
              <Input
                id="project-secret-name-input"
                value={effectiveName}
                disabled={mode === "update" || busy}
                placeholder={gt("API_TOKEN")}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setName(event.target.value);
                  if (validationError) setValidationError(null);
                }}
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="project-secret-value-input"
                className="text-xs font-medium text-foreground"
              >
                <T>Secret value</T>
              </label>
              <Textarea
                id="project-secret-value-input"
                value={value}
                disabled={busy}
                rows={4}
                placeholder={gt("Paste the secret value…")}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setValue(event.target.value);
                  if (validationError) setValidationError(null);
                }}
              />
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => handleOpenChange(false)}
          >
            <T>Cancel</T>
          </Button>
          <Button type="button" disabled={busy} onClick={() => void handleSave()}>
            {mode === "update" ? <T>Update secret</T> : <T>Save secret</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

interface ProjectSecretsCardProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly environmentLabel?: string | null;
  readonly showEnvironmentSubtitle?: boolean;
  readonly sectionId?: string;
}

function ProjectSecretsCard({
  environmentId,
  projectId,
  projectTitle,
  environmentLabel = null,
  showEnvironmentSubtitle = false,
  sectionId,
}: ProjectSecretsCardProps) {
  const gt = useGT();
  const environment = useEnvironment(environmentId);
  const secretsSupported = supportsProjectSecretsCapability(
    environment?.serverConfig?.environment.capabilities,
  );
  const session = useEnvironmentSessionState(environmentId);
  const canReadMembers = useAtomValue(authEnvironment.listMembers.permissionAtom(environmentId));
  const canManageProviders = useAtomValue(
    authEnvironment.listProjectSecrets.permissionAtom(environmentId),
  );
  useSyncAccessRevision(environmentId, secretsSupported && canManageProviders);

  const membersQuery = useEnvironmentQuery(
    secretsSupported && canReadMembers
      ? authEnvironment.listMembers({ environmentId, input: null })
      : null,
    useMessages(),
  );
  const rawMembers = membersQuery.data ?? EMPTY_MEMBERS;
  const permissions = deriveProjectSecretsPermissions({
    session: session.data,
    canManageProviders,
    projectId,
    members: rawMembers,
  });

  const secretsQuery = useEnvironmentQuery(
    secretsSupported && permissions.canManage
      ? authEnvironment.listProjectSecrets({ environmentId, input: { projectId } })
      : null,
    useMessages(),
  );
  const setProjectSecret = useAtomCommand(authEnvironment.setProjectSecret, {
    reportFailure: false,
  });
  const deleteProjectSecret = useAtomCommand(authEnvironment.deleteProjectSecret, {
    reportFailure: false,
  });
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const [editorState, setEditorState] = useState<
    | { readonly open: false }
    | { readonly open: true; readonly mode: "create" | "update"; readonly name: string | null }
  >({ open: false });
  const [pendingDelete, setPendingDelete] = useState<ProjectSecret | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [copiedName, setCopiedName] = useState<string | null>(null);

  if (!secretsSupported || !permissions.canManage) {
    return null;
  }

  const secrets = sortProjectSecrets(secretsQuery.data ?? EMPTY_SECRETS);
  const isLoadingInitial = secretsQuery.isPending && secretsQuery.data === null;
  const activeError = mutationError ?? secretsQuery.error;

  const refreshSecrets = () => {
    appAtomRegistry.refresh(
      authEnvironment.listProjectSecrets({ environmentId, input: { projectId } }),
    );
  };

  const handleSaveSecret = async (input: { readonly name: string; readonly value: string }) => {
    setMutationError(null);
    setBusyKey(input.name);
    const result = await setProjectSecret({
      environmentId,
      input: {
        projectId,
        name: input.name,
        value: input.value,
      },
    });
    setBusyKey(null);
    if (result._tag === "Success") {
      setEditorState({ open: false });
      refreshSecrets();
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: gt("Secret saved"),
          description: gt("Fingerprint: {fingerprint}", {
            fingerprint: result.value.fingerprint,
          }),
        }),
      );
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setMutationError(formatProjectSecretErrorMessage(error, resolveMessage));
    }
  };

  const handleConfirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setMutationError(null);
    setBusyKey(target.name);
    const result = await deleteProjectSecret({
      environmentId,
      input: {
        projectId,
        name: target.name,
      },
    });
    setBusyKey(null);
    setPendingDelete(null);
    if (result._tag === "Success") {
      refreshSecrets();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setMutationError(formatProjectSecretErrorMessage(error, resolveMessage));
    }
  };

  const sectionTitle =
    showEnvironmentSubtitle && environmentLabel
      ? gt("Project secrets · {environment}", { environment: environmentLabel })
      : gt("Project secrets");

  return (
    <>
      <SettingsSection
        id={sectionId}
        title={sectionTitle}
        headerAction={
          <Button
            size="xs"
            variant="default"
            type="button"
            onClick={() => {
              setMutationError(null);
              setEditorState({ open: true, mode: "create", name: null });
            }}
          >
            <PlusIcon />
            <T>Add secret</T>
          </Button>
        }
      >
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          <T>
            Encrypted per-project secrets resolved server-side via{" "}
            <code>secret://project/&lt;projectId&gt;/&lt;name&gt;</code>. Plaintext values are never
            returned to clients.
          </T>
        </p>

        {activeError && !editorState.open ? (
          <div className="px-3 py-2 sm:px-4">
            <Alert variant="error">
              <AlertDescription>{activeError}</AlertDescription>
            </Alert>
          </div>
        ) : null}

        {isLoadingInitial ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              <T>Loading project secrets…</T>
            </p>
          </div>
        ) : secrets.length === 0 ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              <T>No secrets configured for this project yet.</T>
            </p>
          </div>
        ) : (
          secrets.map((secret) => {
            const isBusy = busyKey === secret.name;
            const reference = projectSecretReferenceText(projectId, secret.name);
            const copiedThis = isCopied && copiedName === secret.name;
            return (
              <div key={secret.name} className={ITEM_ROW_CLASSNAME}>
                <div className={ITEM_ROW_INNER_CLASSNAME}>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <KeyRoundIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <h3 className="truncate font-mono text-sm font-medium text-foreground">
                        {secret.name}
                      </h3>
                      <Badge variant="outline" size="sm">
                        <code className="font-mono">{secret.fingerprint}</code>
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      <T>
                        Updated <Var>{formatAccessTimestamp(secret.updatedAt)}</Var>
                      </T>
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <Button
                      size="xs"
                      variant="outline"
                      type="button"
                      disabled={isBusy}
                      title={reference}
                      onClick={() => {
                        setCopiedName(secret.name);
                        copyToClipboard(reference, undefined);
                      }}
                    >
                      {copiedThis ? <CheckIcon /> : <CopyIcon />}
                      {copiedThis ? <T>Copied ref</T> : <T>Copy ref</T>}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      type="button"
                      disabled={isBusy}
                      onClick={() => {
                        setMutationError(null);
                        setEditorState({ open: true, mode: "update", name: secret.name });
                      }}
                    >
                      <PencilIcon />
                      <T>Update</T>
                    </Button>
                    <Button
                      size="xs"
                      variant="destructive-outline"
                      type="button"
                      disabled={isBusy}
                      onClick={() => setPendingDelete(secret)}
                    >
                      <Trash2Icon />
                      <T>Delete</T>
                    </Button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </SettingsSection>

      {editorState.open ? (
        <SecretEditorDialog
          key={`${editorState.mode}:${editorState.name ?? ""}`}
          open
          mode={editorState.mode}
          fixedName={editorState.name}
          projectTitle={projectTitle}
          busy={busyKey !== null}
          error={mutationError}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setEditorState({ open: false });
              setMutationError(null);
            }
          }}
          onSubmit={handleSaveSecret}
        />
      ) : null}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Delete secret <Var>{pendingDelete?.name ?? ""}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                Any references to this secret will stop resolving immediately. This action cannot be
                undone.
              </T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              type="button"
              disabled={pendingDelete === null || busyKey !== null}
              onClick={() => void handleConfirmDelete()}
            >
              {gt("Delete", { $context: "verb, confirms deleting a project secret" })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

export function ProjectSecretsSettings({
  members,
}: {
  readonly members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const { environments } = useEnvironments();
  const supportedEnvironmentIds = new Set(
    environments
      .filter((environment) =>
        supportsProjectSecretsCapability(environment.serverConfig?.environment.capabilities),
      )
      .map((environment) => environment.environmentId),
  );
  const supportedMembers = members.filter((member) =>
    supportedEnvironmentIds.has(member.environmentId),
  );
  if (supportedMembers.length === 0) return null;
  const showEnvironmentSubtitle = supportedMembers.length > 1;
  return (
    <>
      {supportedMembers.map((member, index) => (
        <ProjectSecretsCard
          key={member.physicalProjectKey}
          environmentId={member.environmentId}
          projectId={member.id}
          projectTitle={member.title}
          environmentLabel={member.environmentLabel}
          showEnvironmentSubtitle={showEnvironmentSubtitle}
          {...(index === 0 ? { sectionId: "project-secrets" } : {})}
        />
      ))}
    </>
  );
}
