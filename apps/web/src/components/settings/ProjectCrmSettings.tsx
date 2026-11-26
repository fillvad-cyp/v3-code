import { useAtomValue } from "@effect/atom-react";
import {
  type CrmClient,
  type CrmClientId,
  type CrmClientInviteResult,
  type CrmClientStatus,
  type CrmContact,
  type CrmNote,
  type EnvironmentId,
  type MemberWithMemberships,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  Link2Icon,
  MailIcon,
  PencilIcon,
  PhoneIcon,
  PlusIcon,
  ShieldAlertIcon,
  StickyNoteIcon,
  Trash2Icon,
  UnlinkIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";
import { T, useGT, useMessages, Var } from "gt-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { m as resolveMessage } from "../../i18n/messages";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useSyncAccessRevision } from "../../state/accessRevision";
import { authEnvironment } from "../../state/auth";
import { useThreadShellsForProjectRefs } from "../../state/entities";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { formatAccessTimestamp } from "./ConnectionsSettings.logic";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import {
  CRM_STATUS_LABELS,
  CRM_STATUS_OPTIONS,
  deriveProjectCrmPermissions,
  downloadJsonlFile,
  formatCrmErrorMessage,
  sortCrmClients,
  supportsCrmCapability,
} from "./ProjectCrmSettings.logic";
import { SettingsSection } from "./settingsLayout";

const EMPTY_MEMBERS: ReadonlyArray<MemberWithMemberships> = [];
const EMPTY_CLIENTS: ReadonlyArray<CrmClient> = [];

function clientStatusBadgeVariant(status: CrmClientStatus) {
  if (status === "active") return "success" as const;
  if (status === "lead") return "warning" as const;
  return "secondary" as const;
}

interface ClientEditorDialogProps {
  readonly open: boolean;
  readonly client: CrmClient | null;
  readonly projectTitle: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: {
    readonly name: string;
    readonly company: string | null;
    readonly status: CrmClientStatus;
    readonly email?: string | null;
    readonly phone?: string | null;
  }) => Promise<void>;
}

function ClientEditorDialog({
  open,
  client,
  projectTitle,
  busy,
  error,
  onOpenChange,
  onSubmit,
}: ClientEditorDialogProps) {
  const gt = useGT();
  const m = useMessages();
  const [name, setName] = useState(client?.name ?? "");
  const [company, setCompany] = useState(client?.company ?? "");
  const [status, setStatus] = useState<CrmClientStatus>(client?.status ?? "active");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [clearEmail, setClearEmail] = useState(false);
  const [clearPhone, setClearPhone] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setValidationError(gt("Enter a client name."));
      return;
    }
    setValidationError(null);
    const trimmedEmail = email.trim();
    const trimmedPhone = phone.trim();
    const emailPatch =
      client === null
        ? trimmedEmail.length > 0
          ? trimmedEmail
          : null
        : clearEmail
          ? null
          : trimmedEmail.length > 0
            ? trimmedEmail
            : undefined;
    const phonePatch =
      client === null
        ? trimmedPhone.length > 0
          ? trimmedPhone
          : null
        : clearPhone
          ? null
          : trimmedPhone.length > 0
            ? trimmedPhone
            : undefined;
    await onSubmit({
      name: trimmedName,
      company: company.trim().length > 0 ? company.trim() : null,
      status,
      ...(emailPatch === undefined ? {} : { email: emailPatch }),
      ...(phonePatch === undefined ? {} : { phone: phonePatch }),
    });
  };

  const displayError = validationError ?? error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {client ? (
              <T>
                Edit client <Var>{client.name}</Var>
              </T>
            ) : (
              <T>
                Add client to <Var>{projectTitle}</Var>
              </T>
            )}
          </DialogTitle>
          <DialogDescription>
            <T>
              Email and phone values are encrypted at rest and displayed masked. Leave blank when
              editing to keep existing encrypted values.
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
              <label htmlFor="crm-client-name" className="text-xs font-medium text-foreground">
                <T>Name</T>
              </label>
              <Input
                id="crm-client-name"
                value={name}
                disabled={busy}
                placeholder={gt("Acme Corp")}
                onChange={(event) => {
                  setName(event.target.value);
                  if (validationError) setValidationError(null);
                }}
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="crm-client-company" className="text-xs font-medium text-foreground">
                  <T>Company</T>
                </label>
                <Input
                  id="crm-client-company"
                  value={company}
                  disabled={busy}
                  placeholder={gt("Optional company name")}
                  onChange={(event) => setCompany(event.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <span className="text-xs font-medium text-foreground">
                  <T>Status</T>
                </span>
                <Select
                  value={status}
                  onValueChange={(value) => {
                    if (typeof value === "string") {
                      setStatus(value as CrmClientStatus);
                    }
                  }}
                >
                  <SelectTrigger size="sm" disabled={busy} aria-label={gt("Client status")}>
                    <SelectValue>{m(CRM_STATUS_LABELS[status])}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="start" alignItemWithTrigger={false}>
                    {CRM_STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {m(CRM_STATUS_LABELS[option])}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="crm-client-email" className="text-xs font-medium text-foreground">
                  <T>Email</T>
                </label>
                {client?.emailMasked ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setClearEmail((current) => !current);
                      setEmail("");
                    }}
                  >
                    {clearEmail ? <T>Keep existing</T> : <T>Clear email</T>}
                  </Button>
                ) : null}
              </div>
              <Input
                id="crm-client-email"
                type="email"
                value={email}
                disabled={busy || clearEmail}
                placeholder={
                  clearEmail
                    ? gt("Email will be cleared")
                    : client?.emailMasked
                      ? gt("Current: {masked}", { masked: client.emailMasked })
                      : gt("client@example.com")
                }
                autoComplete="off"
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="crm-client-phone" className="text-xs font-medium text-foreground">
                  <T>Phone</T>
                </label>
                {client?.phoneMasked ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setClearPhone((current) => !current);
                      setPhone("");
                    }}
                  >
                    {clearPhone ? <T>Keep existing</T> : <T>Clear phone</T>}
                  </Button>
                ) : null}
              </div>
              <Input
                id="crm-client-phone"
                value={phone}
                disabled={busy || clearPhone}
                placeholder={
                  clearPhone
                    ? gt("Phone will be cleared")
                    : client?.phoneMasked
                      ? gt("Current: {masked}", { masked: client.phoneMasked })
                      : gt("+1 555 0100")
                }
                autoComplete="off"
                onChange={(event) => setPhone(event.target.value)}
              />
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            <T>Cancel</T>
          </Button>
          <Button type="button" disabled={busy} onClick={() => void handleSave()}>
            {client ? <T>Save changes</T> : <T>Add client</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

interface ContactEditorDialogProps {
  readonly open: boolean;
  readonly contact: CrmContact | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (input: {
    readonly name: string;
    readonly roleTitle: string | null;
    readonly email?: string | null;
    readonly phone?: string | null;
  }) => Promise<void>;
}

function ContactEditorDialog({
  open,
  contact,
  busy,
  error,
  onOpenChange,
  onSubmit,
}: ContactEditorDialogProps) {
  const gt = useGT();
  const [name, setName] = useState(contact?.name ?? "");
  const [roleTitle, setRoleTitle] = useState(contact?.roleTitle ?? "");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setValidationError(gt("Enter a contact name."));
      return;
    }
    setValidationError(null);
    const trimmedEmail = email.trim();
    const trimmedPhone = phone.trim();
    await onSubmit({
      name: trimmedName,
      roleTitle: roleTitle.trim().length > 0 ? roleTitle.trim() : null,
      ...(contact === null
        ? {
            email: trimmedEmail.length > 0 ? trimmedEmail : null,
            phone: trimmedPhone.length > 0 ? trimmedPhone : null,
          }
        : {
            ...(trimmedEmail.length > 0 ? { email: trimmedEmail } : {}),
            ...(trimmedPhone.length > 0 ? { phone: trimmedPhone } : {}),
          }),
    });
  };

  const displayError = validationError ?? error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {contact ? (
              <T>
                Edit contact <Var>{contact.name}</Var>
              </T>
            ) : (
              <T>Add contact</T>
            )}
          </DialogTitle>
          <DialogDescription>
            <T>Contact email and phone are encrypted at rest and displayed masked.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            {displayError ? (
              <Alert variant="error">
                <AlertDescription>{displayError}</AlertDescription>
              </Alert>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor="crm-contact-name" className="text-xs font-medium text-foreground">
                <T>Name</T>
              </label>
              <Input
                id="crm-contact-name"
                value={name}
                disabled={busy}
                placeholder={gt("Jane Doe")}
                onChange={(event) => {
                  setName(event.target.value);
                  if (validationError) setValidationError(null);
                }}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="crm-contact-role" className="text-xs font-medium text-foreground">
                <T>Role or title</T>
              </label>
              <Input
                id="crm-contact-role"
                value={roleTitle}
                disabled={busy}
                placeholder={gt("Account Manager")}
                onChange={(event) => setRoleTitle(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="crm-contact-email" className="text-xs font-medium text-foreground">
                <T>Email</T>
              </label>
              <Input
                id="crm-contact-email"
                type="email"
                value={email}
                disabled={busy}
                placeholder={
                  contact?.emailMasked
                    ? gt("Current: {masked}", { masked: contact.emailMasked })
                    : gt("contact@example.com")
                }
                autoComplete="off"
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="crm-contact-phone" className="text-xs font-medium text-foreground">
                <T>Phone</T>
              </label>
              <Input
                id="crm-contact-phone"
                value={phone}
                disabled={busy}
                placeholder={
                  contact?.phoneMasked
                    ? gt("Current: {masked}", { masked: contact.phoneMasked })
                    : gt("+1 555 0199")
                }
                autoComplete="off"
                onChange={(event) => setPhone(event.target.value)}
              />
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            <T>Cancel</T>
          </Button>
          <Button type="button" disabled={busy} onClick={() => void handleSave()}>
            {contact ? <T>Save contact</T> : <T>Add contact</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

interface NoteEditorDialogProps {
  readonly open: boolean;
  readonly note: CrmNote | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (body: string) => Promise<void>;
}

function NoteEditorDialog({
  open,
  note,
  busy,
  error,
  onOpenChange,
  onSubmit,
}: NoteEditorDialogProps) {
  const gt = useGT();
  const [body, setBody] = useState(note?.body ?? "");
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleSave = async () => {
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      setValidationError(gt("Enter note text."));
      return;
    }
    setValidationError(null);
    await onSubmit(trimmed);
  };

  const displayError = validationError ?? error;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{note ? <T>Edit note</T> : <T>Add note</T>}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            {displayError ? (
              <Alert variant="error">
                <AlertDescription>{displayError}</AlertDescription>
              </Alert>
            ) : null}

            <Textarea
              id="crm-note-body"
              value={body}
              disabled={busy}
              rows={4}
              placeholder={gt("Write a client note…")}
              onChange={(event) => {
                setBody(event.target.value);
                if (validationError) setValidationError(null);
              }}
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            <T>Cancel</T>
          </Button>
          <Button type="button" disabled={busy} onClick={() => void handleSave()}>
            {note ? <T>Save note</T> : <T>Add note</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

interface CrmClientDetailPanelProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly client: CrmClient;
  readonly canWrite: boolean;
  readonly canInvite: boolean;
  readonly onChanged: () => void;
  readonly onExportClient: (client: CrmClient) => Promise<void>;
  readonly onInviteClient: (client: CrmClient) => Promise<void>;
  readonly onRequestEdit: (client: CrmClient) => void;
  readonly onRequestPurge: (client: CrmClient) => void;
}

function CrmClientDetailPanel({
  environmentId,
  projectId,
  client,
  canWrite,
  canInvite,
  onChanged,
  onExportClient,
  onInviteClient,
  onRequestEdit,
  onRequestPurge,
}: CrmClientDetailPanelProps) {
  const gt = useGT();
  const detailQuery = useEnvironmentQuery(
    authEnvironment.getCrmClient({ environmentId, input: { projectId, clientId: client.id } }),
    useMessages(),
  );
  const projectThreads = useThreadShellsForProjectRefs([{ environmentId, projectId }]);

  const createContact = useAtomCommand(authEnvironment.createCrmContact, { reportFailure: false });
  const updateContact = useAtomCommand(authEnvironment.updateCrmContact, { reportFailure: false });
  const deleteContact = useAtomCommand(authEnvironment.deleteCrmContact, { reportFailure: false });
  const createNote = useAtomCommand(authEnvironment.createCrmNote, { reportFailure: false });
  const updateNote = useAtomCommand(authEnvironment.updateCrmNote, { reportFailure: false });
  const deleteNote = useAtomCommand(authEnvironment.deleteCrmNote, { reportFailure: false });
  const linkThread = useAtomCommand(authEnvironment.linkCrmClientThread, { reportFailure: false });
  const unlinkThread = useAtomCommand(authEnvironment.unlinkCrmClientThread, {
    reportFailure: false,
  });

  const [contactDialog, setContactDialog] = useState<
    { readonly open: false } | { readonly open: true; readonly contact: CrmContact | null }
  >({ open: false });
  const [noteDialog, setNoteDialog] = useState<
    { readonly open: false } | { readonly open: true; readonly note: CrmNote | null }
  >({ open: false });
  const [selectedThreadId, setSelectedThreadId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);

  const detail = detailQuery.data;
  const isRedacted = client.redactedAt !== null;
  const linkedThreadIds = new Set(detail?.threads.map((entry) => entry.threadId) ?? []);
  const availableThreads = projectThreads.filter((thread) => !linkedThreadIds.has(thread.id));
  const threadTitleById = new Map<string, string>(
    projectThreads.map((thread) => [thread.id, thread.title]),
  );

  const refreshDetail = () => {
    appAtomRegistry.refresh(
      authEnvironment.getCrmClient({ environmentId, input: { projectId, clientId: client.id } }),
    );
    onChanged();
  };

  const handleSaveContact = async (input: {
    readonly name: string;
    readonly roleTitle: string | null;
    readonly email?: string | null;
    readonly phone?: string | null;
  }) => {
    setBusy(true);
    setPanelError(null);
    const result =
      contactDialog.open && contactDialog.contact !== null
        ? await updateContact({
            environmentId,
            input: {
              projectId,
              clientId: client.id,
              contactId: contactDialog.contact.id,
              data: input,
            },
          })
        : await createContact({
            environmentId,
            input: {
              projectId,
              clientId: client.id,
              data: input,
            },
          });
    setBusy(false);
    if (result._tag === "Success") {
      setContactDialog({ open: false });
      refreshDetail();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setPanelError(formatCrmErrorMessage(squashAtomCommandFailure(result), resolveMessage));
    }
  };

  const handleDeleteContact = async (contact: CrmContact) => {
    setBusy(true);
    setPanelError(null);
    const result = await deleteContact({
      environmentId,
      input: { projectId, clientId: client.id, contactId: contact.id },
    });
    setBusy(false);
    if (result._tag === "Success") {
      refreshDetail();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setPanelError(formatCrmErrorMessage(squashAtomCommandFailure(result), resolveMessage));
    }
  };

  const handleSaveNote = async (body: string) => {
    setBusy(true);
    setPanelError(null);
    const result =
      noteDialog.open && noteDialog.note !== null
        ? await updateNote({
            environmentId,
            input: {
              projectId,
              clientId: client.id,
              noteId: noteDialog.note.id,
              data: { body },
            },
          })
        : await createNote({
            environmentId,
            input: {
              projectId,
              clientId: client.id,
              data: { body },
            },
          });
    setBusy(false);
    if (result._tag === "Success") {
      setNoteDialog({ open: false });
      refreshDetail();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setPanelError(formatCrmErrorMessage(squashAtomCommandFailure(result), resolveMessage));
    }
  };

  const handleDeleteNote = async (note: CrmNote) => {
    setBusy(true);
    setPanelError(null);
    const result = await deleteNote({
      environmentId,
      input: { projectId, clientId: client.id, noteId: note.id },
    });
    setBusy(false);
    if (result._tag === "Success") {
      refreshDetail();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setPanelError(formatCrmErrorMessage(squashAtomCommandFailure(result), resolveMessage));
    }
  };

  const handleLinkThread = async () => {
    const trimmed = selectedThreadId.trim();
    if (trimmed.length === 0) return;
    setBusy(true);
    setPanelError(null);
    const result = await linkThread({
      environmentId,
      input: { projectId, clientId: client.id, threadId: trimmed as ThreadId },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setSelectedThreadId("");
      refreshDetail();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setPanelError(formatCrmErrorMessage(squashAtomCommandFailure(result), resolveMessage));
    }
  };

  const handleUnlinkThread = async (threadId: ThreadId) => {
    setBusy(true);
    setPanelError(null);
    const result = await unlinkThread({
      environmentId,
      input: { projectId, clientId: client.id, threadId },
    });
    setBusy(false);
    if (result._tag === "Success") {
      refreshDetail();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setPanelError(formatCrmErrorMessage(squashAtomCommandFailure(result), resolveMessage));
    }
  };

  return (
    <div className="space-y-4 border-t border-border/60 bg-muted/20 px-3 py-3 sm:px-4">
      {(panelError ?? detailQuery.error) ? (
        <Alert variant="error">
          <AlertDescription>{panelError ?? detailQuery.error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {canWrite && !isRedacted ? (
          <Button
            size="xs"
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => onRequestEdit(client)}
          >
            <PencilIcon />
            <T>Edit client</T>
          </Button>
        ) : null}
        {canInvite && !isRedacted ? (
          <Button
            size="xs"
            variant="outline"
            type="button"
            disabled={busy}
            onClick={() => void onInviteClient(client)}
          >
            <UserPlusIcon />
            <T>Invite client</T>
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="outline"
          type="button"
          disabled={busy}
          onClick={() => void onExportClient(client)}
        >
          <DownloadIcon />
          <T>Export JSONL</T>
        </Button>
        {canWrite && !isRedacted ? (
          <Button
            size="xs"
            variant="destructive-outline"
            type="button"
            disabled={busy}
            onClick={() => onRequestPurge(client)}
          >
            <ShieldAlertIcon />
            <T>Purge PII</T>
          </Button>
        ) : null}
      </div>

      {detailQuery.isPending && detail === null ? (
        <p className="text-xs text-muted-foreground">
          <T>Loading client details…</T>
        </p>
      ) : detail !== null ? (
        <div className="space-y-4">
          {/* Contacts */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-semibold text-foreground">
                <T>Contacts</T> ({detail.contacts.length})
              </h4>
              {canWrite && !isRedacted ? (
                <Button
                  size="xs"
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPanelError(null);
                    setContactDialog({ open: true, contact: null });
                  }}
                >
                  <PlusIcon />
                  <T>Add contact</T>
                </Button>
              ) : null}
            </div>

            {detail.contacts.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <T>No contacts added yet.</T>
              </p>
            ) : (
              <div className="space-y-1.5">
                {detail.contacts.map((contact) => (
                  <div
                    key={contact.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-background px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-xs font-medium text-foreground">
                          {contact.name}
                        </span>
                        {contact.roleTitle ? (
                          <Badge variant="outline" size="sm">
                            {contact.roleTitle}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        {contact.emailMasked ? (
                          <span className="inline-flex items-center gap-1 font-mono">
                            <MailIcon className="size-3" />
                            {contact.emailMasked}
                          </span>
                        ) : null}
                        {contact.phoneMasked ? (
                          <span className="inline-flex items-center gap-1 font-mono">
                            <PhoneIcon className="size-3" />
                            {contact.phoneMasked}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    {canWrite && !isRedacted ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="xs"
                          variant="ghost"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setPanelError(null);
                            setContactDialog({ open: true, contact });
                          }}
                        >
                          <PencilIcon />
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          type="button"
                          disabled={busy}
                          onClick={() => void handleDeleteContact(contact)}
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Notes */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-semibold text-foreground">
                <T>Notes</T> ({detail.notes.length})
              </h4>
              {canWrite && !isRedacted ? (
                <Button
                  size="xs"
                  variant="outline"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPanelError(null);
                    setNoteDialog({ open: true, note: null });
                  }}
                >
                  <StickyNoteIcon />
                  <T>Add note</T>
                </Button>
              ) : null}
            </div>

            {detail.notes.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <T>No notes recorded yet.</T>
              </p>
            ) : (
              <div className="space-y-1.5">
                {detail.notes.map((note) => (
                  <div
                    key={note.id}
                    className="flex items-start justify-between gap-2 rounded-md border border-border/60 bg-background px-2.5 py-2"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="whitespace-pre-wrap text-xs text-foreground">
                        {note.redactedAt !== null ? gt("[redacted]") : note.body}
                      </p>
                      <p className="text-2xs text-muted-foreground">
                        {formatAccessTimestamp(note.updatedAt)}
                      </p>
                    </div>
                    {canWrite && !isRedacted ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="xs"
                          variant="ghost"
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setPanelError(null);
                            setNoteDialog({ open: true, note });
                          }}
                        >
                          <PencilIcon />
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          type="button"
                          disabled={busy}
                          onClick={() => void handleDeleteNote(note)}
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Linked threads */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-foreground">
              <T>Linked threads</T> ({detail.threads.length})
            </h4>

            {canWrite ? (
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-[200px] flex-1">
                  <Select
                    value={selectedThreadId}
                    onValueChange={(value) => {
                      if (typeof value === "string") setSelectedThreadId(value);
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      disabled={busy || availableThreads.length === 0}
                      aria-label={gt("Select a thread to link")}
                    >
                      <SelectValue>
                        {selectedThreadId
                          ? (threadTitleById.get(selectedThreadId) ?? selectedThreadId)
                          : availableThreads.length === 0
                            ? gt("No unlinked threads in this project")
                            : gt("Select a project thread…")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="start" alignItemWithTrigger={false}>
                      {availableThreads.map((thread) => (
                        <SelectItem key={thread.id} value={thread.id}>
                          {thread.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  type="button"
                  disabled={busy || selectedThreadId.length === 0}
                  onClick={() => void handleLinkThread()}
                >
                  <Link2Icon />
                  <T>Link thread</T>
                </Button>
              </div>
            ) : null}

            {detail.threads.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                <T>No threads linked to this client yet.</T>
              </p>
            ) : (
              <div className="space-y-1.5">
                {detail.threads.map((link) => (
                  <div
                    key={link.threadId}
                    className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-background px-2.5 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-foreground">
                        {threadTitleById.get(link.threadId) ?? link.threadId}
                      </p>
                      <p className="truncate font-mono text-2xs text-muted-foreground">
                        {link.threadId}
                      </p>
                    </div>
                    {canWrite ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        type="button"
                        disabled={busy}
                        onClick={() => void handleUnlinkThread(link.threadId)}
                      >
                        <UnlinkIcon />
                        <T>Unlink</T>
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {contactDialog.open ? (
        <ContactEditorDialog
          key={contactDialog.contact?.id ?? "new-contact"}
          open
          contact={contactDialog.contact}
          busy={busy}
          error={panelError}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setContactDialog({ open: false });
              setPanelError(null);
            }
          }}
          onSubmit={handleSaveContact}
        />
      ) : null}

      {noteDialog.open ? (
        <NoteEditorDialog
          key={noteDialog.note?.id ?? "new-note"}
          open
          note={noteDialog.note}
          busy={busy}
          error={panelError}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setNoteDialog({ open: false });
              setPanelError(null);
            }
          }}
          onSubmit={handleSaveNote}
        />
      ) : null}
    </div>
  );
}

interface ProjectCrmCardProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly environmentLabel?: string | null;
  readonly showEnvironmentSubtitle?: boolean;
  readonly sectionId?: string;
}

function ProjectCrmCard({
  environmentId,
  projectId,
  projectTitle,
  environmentLabel = null,
  showEnvironmentSubtitle = false,
  sectionId,
}: ProjectCrmCardProps) {
  const gt = useGT();
  const m = useMessages();
  const environment = useEnvironment(environmentId);
  const crmSupported = supportsCrmCapability(environment?.serverConfig?.environment.capabilities);
  const session = useEnvironmentSessionState(environmentId);
  const canReadMembers = useAtomValue(authEnvironment.listMembers.permissionAtom(environmentId));
  const canReadScope = useAtomValue(authEnvironment.listCrmClients.permissionAtom(environmentId));
  const canOperateScope = useAtomValue(
    authEnvironment.createCrmClient.permissionAtom(environmentId),
  );
  useSyncAccessRevision(environmentId, crmSupported && canReadScope);

  const membersQuery = useEnvironmentQuery(
    crmSupported && canReadMembers
      ? authEnvironment.listMembers({ environmentId, input: null })
      : null,
    m,
  );
  const rawMembers = membersQuery.data ?? EMPTY_MEMBERS;
  const permissions = deriveProjectCrmPermissions({
    session: session.data,
    canReadScope,
    canOperateScope,
    projectId,
    members: rawMembers,
  });

  const clientsQuery = useEnvironmentQuery(
    crmSupported && permissions.canRead
      ? authEnvironment.listCrmClients({ environmentId, input: { projectId } })
      : null,
    m,
  );

  const createClient = useAtomCommand(authEnvironment.createCrmClient, { reportFailure: false });
  const updateClient = useAtomCommand(authEnvironment.updateCrmClient, { reportFailure: false });
  const deleteClient = useAtomCommand(authEnvironment.deleteCrmClient, { reportFailure: false });
  const inviteClient = useAtomCommand(authEnvironment.inviteCrmClient, { reportFailure: false });
  const exportCrm = useAtomCommand(authEnvironment.exportCrm, { reportFailure: false });
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const [expandedClientId, setExpandedClientId] = useState<CrmClientId | null>(null);
  const [editorState, setEditorState] = useState<
    { readonly open: false } | { readonly open: true; readonly record: CrmClient | null }
  >({ open: false });
  const [pendingPurge, setPendingPurge] = useState<CrmClient | null>(null);
  const [inviteResult, setInviteResult] = useState<{
    readonly clientName: string;
    readonly result: CrmClientInviteResult;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  if (!crmSupported || !permissions.canRead) {
    return null;
  }

  const clients = sortCrmClients(clientsQuery.data ?? EMPTY_CLIENTS);
  const isLoadingInitial = clientsQuery.isPending && clientsQuery.data === null;
  const activeError = mutationError ?? clientsQuery.error;

  const refreshClients = () => {
    appAtomRegistry.refresh(
      authEnvironment.listCrmClients({ environmentId, input: { projectId } }),
    );
  };

  const handleSaveClient = async (input: {
    readonly name: string;
    readonly company: string | null;
    readonly status: CrmClientStatus;
    readonly email?: string | null;
    readonly phone?: string | null;
  }) => {
    setBusy(true);
    setMutationError(null);
    const result =
      editorState.open && editorState.record !== null
        ? await updateClient({
            environmentId,
            input: {
              projectId,
              clientId: editorState.record.id,
              data: input,
            },
          })
        : await createClient({
            environmentId,
            input: {
              projectId,
              data: input,
            },
          });
    setBusy(false);
    if (result._tag === "Success") {
      setEditorState({ open: false });
      refreshClients();
      if (editorState.open && editorState.record !== null) {
        appAtomRegistry.refresh(
          authEnvironment.getCrmClient({
            environmentId,
            input: { projectId, clientId: editorState.record.id },
          }),
        );
      }
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setMutationError(formatCrmErrorMessage(squashAtomCommandFailure(result), resolveMessage));
    }
  };

  const handleConfirmPurge = async () => {
    if (!pendingPurge) return;
    const target = pendingPurge;
    setBusy(true);
    setMutationError(null);
    const result = await deleteClient({
      environmentId,
      input: { projectId, clientId: target.id, purge: true },
    });
    setBusy(false);
    setPendingPurge(null);
    if (result._tag === "Success") {
      refreshClients();
      appAtomRegistry.refresh(
        authEnvironment.getCrmClient({ environmentId, input: { projectId, clientId: target.id } }),
      );
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: gt("Client PII purged"),
          description: gt(
            "Encrypted contact data was cleared and the redacted record was preserved.",
          ),
        }),
      );
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setMutationError(formatCrmErrorMessage(squashAtomCommandFailure(result), resolveMessage));
    }
  };

  const handleExport = async (client?: CrmClient) => {
    setBusy(true);
    setMutationError(null);
    const result = await exportCrm({
      environmentId,
      input: {
        projectId,
        ...(client === undefined ? {} : { clientId: client.id }),
      },
    });
    setBusy(false);
    if (result._tag === "Success") {
      const filename =
        client === undefined ? `crm-${projectId}.jsonl` : `crm-${projectId}-${client.id}.jsonl`;
      downloadJsonlFile(filename, result.value);
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: gt("CRM export ready"),
          description: gt("Downloaded {filename}", { filename }),
        }),
      );
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setMutationError(formatCrmErrorMessage(squashAtomCommandFailure(result), resolveMessage));
    }
  };

  const handleInviteClient = async (client: CrmClient) => {
    setBusy(true);
    setMutationError(null);
    const result = await inviteClient({
      environmentId,
      input: { projectId, clientId: client.id },
    });
    setBusy(false);
    if (result._tag === "Success") {
      setInviteResult({ clientName: client.name, result: result.value });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setMutationError(formatCrmErrorMessage(squashAtomCommandFailure(result), resolveMessage));
    }
  };

  const sectionTitle =
    showEnvironmentSubtitle && environmentLabel
      ? gt("CRM · {environment}", { environment: environmentLabel })
      : gt("CRM");

  return (
    <>
      <SettingsSection
        id={sectionId}
        title={sectionTitle}
        headerAction={
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              type="button"
              disabled={busy}
              onClick={() => void handleExport()}
            >
              <DownloadIcon />
              <T>Export JSONL</T>
            </Button>
            {permissions.canWrite ? (
              <Button
                size="xs"
                variant="default"
                type="button"
                disabled={busy}
                onClick={() => {
                  setMutationError(null);
                  setEditorState({ open: true, record: null });
                }}
              >
                <PlusIcon />
                <T>Add client</T>
              </Button>
            ) : null}
          </div>
        }
      >
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          <T>
            Project-scoped clients, contacts, notes, and linked threads. Email and phone numbers are
            encrypted at rest and displayed masked.
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
              <T>Loading CRM clients…</T>
            </p>
          </div>
        ) : clients.length === 0 ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              <T>No CRM clients in this project yet.</T>
            </p>
          </div>
        ) : (
          clients.map((client) => {
            const isExpanded = expandedClientId === client.id;
            const isRedacted = client.redactedAt !== null;
            return (
              <div key={client.id} className="border-t border-border/60 first:border-t-0">
                <div className={ITEM_ROW_CLASSNAME}>
                  <div className={ITEM_ROW_INNER_CLASSNAME}>
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-start gap-2 text-left"
                      onClick={() => setExpandedClientId(isExpanded ? null : client.id)}
                    >
                      {isExpanded ? (
                        <ChevronDownIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRightIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <UsersIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          <h3 className="truncate text-sm font-medium text-foreground">
                            {client.name}
                          </h3>
                          {client.company ? (
                            <span className="truncate text-xs text-muted-foreground">
                              · {client.company}
                            </span>
                          ) : null}
                          <Badge variant={clientStatusBadgeVariant(client.status)} size="sm">
                            {m(CRM_STATUS_LABELS[client.status])}
                          </Badge>
                          {client.principalId ? (
                            <Badge variant="outline" size="sm">
                              <T>Portal linked</T>
                            </Badge>
                          ) : null}
                          {isRedacted ? (
                            <Badge variant="warning" size="sm">
                              <T>Purged</T>
                            </Badge>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          {client.emailMasked ? (
                            <span className="inline-flex items-center gap-1 font-mono">
                              <MailIcon className="size-3" />
                              {client.emailMasked}
                            </span>
                          ) : null}
                          {client.phoneMasked ? (
                            <span className="inline-flex items-center gap-1 font-mono">
                              <PhoneIcon className="size-3" />
                              {client.phoneMasked}
                            </span>
                          ) : null}
                          {isRedacted && client.redactedAt ? (
                            <span>
                              <T>
                                Purged <Var>{formatAccessTimestamp(client.redactedAt)}</Var>
                              </T>
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </button>
                  </div>
                </div>

                {isExpanded ? (
                  <CrmClientDetailPanel
                    environmentId={environmentId}
                    projectId={projectId}
                    client={client}
                    canWrite={permissions.canWrite}
                    canInvite={permissions.canInvite}
                    onChanged={refreshClients}
                    onExportClient={(target) => handleExport(target)}
                    onInviteClient={handleInviteClient}
                    onRequestEdit={(target) => {
                      setMutationError(null);
                      setEditorState({ open: true, record: target });
                    }}
                    onRequestPurge={(target) => setPendingPurge(target)}
                  />
                ) : null}
              </div>
            );
          })
        )}
      </SettingsSection>

      {editorState.open ? (
        <ClientEditorDialog
          key={editorState.record?.id ?? "new-client"}
          open
          client={editorState.record}
          projectTitle={projectTitle}
          busy={busy}
          error={mutationError}
          onOpenChange={(nextOpen) => {
            if (!nextOpen) {
              setEditorState({ open: false });
              setMutationError(null);
            }
          }}
          onSubmit={handleSaveClient}
        />
      ) : null}

      <Dialog
        open={inviteResult !== null}
        onOpenChange={(open) => {
          if (!open) setInviteResult(null);
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              <T>
                Client invitation for <Var>{inviteResult?.clientName ?? ""}</Var>
              </T>
            </DialogTitle>
            <DialogDescription>
              <T>
                Share this one-time code with the external client. Once accepted, they can view only
                their own CRM record and linked threads.
              </T>
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {inviteResult ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
                  <code className="truncate font-mono text-sm text-foreground">
                    {inviteResult.result.code}
                  </code>
                  <Button
                    size="xs"
                    variant="outline"
                    type="button"
                    onClick={() => copyToClipboard(inviteResult.result.code, undefined)}
                  >
                    {isCopied ? <CheckIcon /> : <CopyIcon />}
                    {isCopied ? <T>Copied</T> : <T>Copy code</T>}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  <T>
                    Expires{" "}
                    <Var>{formatAccessTimestamp(inviteResult.result.invitation.expiresAt)}</Var>
                  </T>
                </p>
              </div>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" onClick={() => setInviteResult(null)}>
              <T>Done</T>
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={pendingPurge !== null}
        onOpenChange={(open) => {
          if (!open) setPendingPurge(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <T>
                Purge PII for <Var>{pendingPurge?.name ?? ""}</Var>?
              </T>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>
                This permanently clears encrypted email and phone fields, contact PII, and note
                bodies, sets a redaction timestamp, and keeps the redacted row for audit integrity.
                This action cannot be undone.
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
              disabled={pendingPurge === null || busy}
              onClick={() => void handleConfirmPurge()}
            >
              <T>Purge PII</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

export function ProjectCrmSettings({
  members,
}: {
  readonly members: ReadonlyArray<SidebarProjectGroupMember>;
}) {
  const { environments } = useEnvironments();
  const supportedEnvironmentIds = new Set(
    environments
      .filter((environment) =>
        supportsCrmCapability(environment.serverConfig?.environment.capabilities),
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
        <ProjectCrmCard
          key={member.physicalProjectKey}
          environmentId={member.environmentId}
          projectId={member.id}
          projectTitle={member.title}
          environmentLabel={member.environmentLabel}
          showEnvironmentSubtitle={showEnvironmentSubtitle}
          {...(index === 0 ? { sectionId: "project-crm" } : {})}
        />
      ))}
    </>
  );
}
