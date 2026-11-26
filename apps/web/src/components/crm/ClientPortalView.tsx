import { type CrmClientId, type CrmPortalView } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  ArrowUpRightIcon,
  Building2Icon,
  LogOutIcon,
  MailIcon,
  MessageSquareIcon,
  PhoneIcon,
  RefreshCwIcon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import {
  invalidatePrimaryAuthGateCache,
  signOutPrimaryEnvironment,
} from "../../environments/primary";
import {
  buildClientPortalRoutePath,
  type ClientPortalLoadErrorKind,
  classifyClientPortalError,
  fetchCrmPortal,
  PORTAL_THREAD_STATUS_LABELS,
  portalThreadStatusBadgeVariant,
} from "../../lib/clientPortal";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { formatAccessTimestamp } from "../settings/ConnectionsSettings.logic";
import { CRM_STATUS_LABELS } from "../settings/ProjectCrmSettings.logic";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

interface ClientPortalViewProps {
  readonly clientId: CrmClientId;
  readonly authGateStatus: string;
  readonly authMode?: "single-owner" | "multi-user";
}

type PortalState =
  | { readonly clientId: CrmClientId; readonly status: "loading" }
  | { readonly clientId: CrmClientId; readonly status: "ready"; readonly data: CrmPortalView }
  | {
      readonly clientId: CrmClientId;
      readonly status: "error";
      readonly kind: ClientPortalLoadErrorKind;
    };

function ClientPortalSkeleton() {
  const gt = useGT();
  return (
    <StandalonePage>
      <div
        className="flex flex-col gap-5"
        role="status"
        aria-busy="true"
        aria-label={gt("Loading client portal")}
      >
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-7 w-52" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex flex-col gap-2.5 pt-2">
          <Skeleton shape="card" className="h-16 w-full" />
          <Skeleton shape="card" className="h-16 w-full" />
        </div>
      </div>
    </StandalonePage>
  );
}

export function ClientPortalView({ clientId, authGateStatus, authMode }: ClientPortalViewProps) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [state, setState] = useState<PortalState>({ clientId, status: "loading" });
  const [signingOut, setSigningOut] = useState(false);

  const redirectTarget = buildClientPortalRoutePath(clientId);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- redirects unauthenticated visitors to login or pairing before loading portal data
  useEffect(() => {
    if (authGateStatus !== "requires-auth") return;
    if (authMode === "multi-user") {
      void navigate({
        to: "/login",
        search: { redirect: redirectTarget },
        replace: true,
      });
      return;
    }
    void navigate({ to: "/pair", replace: true });
  }, [authGateStatus, authMode, navigate, redirectTarget]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the external client's scoped portal payload from GET /api/crm/portal
  useEffect(() => {
    if (authGateStatus === "requires-auth") return;
    let cancelled = false;
    void fetchCrmPortal(clientId).then(
      (data) => {
        if (cancelled) return;
        setState({ clientId, status: "ready", data });
      },
      (error: unknown) => {
        if (cancelled) return;
        const kind = classifyClientPortalError(error);
        if (kind === "unauthorized") {
          invalidatePrimaryAuthGateCache();
          void navigate({
            to: "/login",
            search: { redirect: redirectTarget },
            replace: true,
          });
          return;
        }
        setState({ clientId, status: "error", kind });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [authGateStatus, clientId, navigate, redirectTarget]);

  const handleRefresh = () => {
    setState({ clientId, status: "loading" });
    void fetchCrmPortal(clientId).then(
      (data) => {
        setState({ clientId, status: "ready", data });
      },
      (error: unknown) => {
        const kind = classifyClientPortalError(error);
        if (kind === "unauthorized") {
          invalidatePrimaryAuthGateCache();
          void navigate({
            to: "/login",
            search: { redirect: redirectTarget },
            replace: true,
          });
          return;
        }
        setState({ clientId, status: "error", kind });
      },
    );
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    await signOutPrimaryEnvironment().catch(() => undefined);
    setSigningOut(false);
    void navigate({
      to: "/login",
      search: { redirect: redirectTarget },
      replace: true,
    });
  };

  const effectiveState: PortalState =
    state.clientId === clientId ? state : { clientId, status: "loading" };

  if (authGateStatus === "requires-auth" || effectiveState.status === "loading") {
    return <ClientPortalSkeleton />;
  }

  if (effectiveState.status === "error") {
    return (
      <StandalonePage>
        <StandalonePageHeader
          title={
            effectiveState.kind === "not_found"
              ? gt("Client portal unavailable")
              : gt("Could not load client portal")
          }
          description={
            effectiveState.kind === "not_found"
              ? gt("This portal is only available to the invited client for this record.")
              : gt("A network or server error occurred while loading your client portal.")
          }
        />
        <div className="mt-5 flex flex-wrap gap-2">
          {effectiveState.kind === "failed" ? (
            <Button size="sm" onClick={handleRefresh}>
              <RefreshCwIcon />
              <T>Try again</T>
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleSignOut()}
            disabled={signingOut}
          >
            <LogOutIcon />
            <T>Sign out</T>
          </Button>
        </div>
      </StandalonePage>
    );
  }

  const { projectTitle, contacts, threads } = effectiveState.data;
  // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- CrmPortalView.client is a CRM customer record, not an RPC client
  const crmClient = effectiveState.data.client;

  return (
    <StandalonePage>
      <StandalonePageHeader
        context={projectTitle ?? gt("Client portal")}
        title={crmClient.name}
        description={
          crmClient.company ? (
            <span className="inline-flex items-center gap-1.5">
              <Building2Icon className="size-3.5 shrink-0" aria-hidden />
              <span>{crmClient.company}</span>
            </span>
          ) : (
            <T>Your client record and linked conversations.</T>
          )
        }
      />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{resolveMessage(CRM_STATUS_LABELS[crmClient.status])}</Badge>
          {crmClient.emailMasked ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <MailIcon className="size-3.5 shrink-0" aria-hidden />
              <span>{crmClient.emailMasked}</span>
            </span>
          ) : null}
          {crmClient.phoneMasked ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <PhoneIcon className="size-3.5 shrink-0" aria-hidden />
              <span>{crmClient.phoneMasked}</span>
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button size="xs" variant="ghost" onClick={handleRefresh} aria-label={gt("Refresh")}>
            <RefreshCwIcon />
            <T>Refresh</T>
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => void handleSignOut()}
            disabled={signingOut}
          >
            <LogOutIcon />
            <T>Sign out</T>
          </Button>
        </div>
      </div>

      {crmClient.redactedAt !== null ? (
        <div className="mt-4">
          <Alert>
            <AlertDescription>
              <T>Personal contact details for this client record have been redacted.</T>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      <section className="mt-6">
        <div className="mb-2.5 flex items-center gap-2">
          <UsersIcon className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-medium text-foreground">
            <T>Contacts</T>
          </h2>
        </div>

        {contacts.length === 0 ? (
          <p className="rounded-lg border border-border/60 bg-background/40 px-3.5 py-3 text-xs text-muted-foreground">
            <T>No contacts listed.</T>
          </p>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border border-border/70 bg-background/40">
            {contacts.map((contact) => (
              <li key={contact.id} className="flex flex-col gap-1 px-3.5 py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">{contact.name}</span>
                  {contact.roleTitle ? (
                    <span className="text-xs text-muted-foreground">{contact.roleTitle}</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  {contact.emailMasked ? (
                    <span className="inline-flex items-center gap-1">
                      <MailIcon className="size-3 shrink-0" aria-hidden />
                      <span>{contact.emailMasked}</span>
                    </span>
                  ) : null}
                  {contact.phoneMasked ? (
                    <span className="inline-flex items-center gap-1">
                      <PhoneIcon className="size-3 shrink-0" aria-hidden />
                      <span>{contact.phoneMasked}</span>
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MessageSquareIcon className="size-4 text-muted-foreground" aria-hidden />
            <h2 className="text-sm font-medium text-foreground">
              <T>Linked threads</T>
            </h2>
          </div>
          <span className="text-xs text-muted-foreground">
            {gt("{count, plural, one {{count} thread} other {{count} threads}}", {
              count: threads.length,
            })}
          </span>
        </div>

        {threads.length === 0 ? (
          <div className="rounded-lg border border-border/60 bg-background/40 py-6">
            <Empty>
              <EmptyHeader>
                <EmptyTitle>
                  <T>No linked threads yet</T>
                </EmptyTitle>
                <EmptyDescription>
                  <T>Conversations shared with your account will appear here.</T>
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent />
            </Empty>
          </div>
        ) : (
          <ul className="divide-y divide-border/60 rounded-lg border border-border/70 bg-background/40">
            {threads.map((thread) => {
              const timestamp = thread.updatedAt ?? thread.linkedAt;
              return (
                <li
                  key={thread.threadId}
                  className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{thread.title}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge variant={portalThreadStatusBadgeVariant(thread.status)} size="sm">
                        {resolveMessage(PORTAL_THREAD_STATUS_LABELS[thread.status])}
                      </Badge>
                      {thread.archivedAt !== null ? (
                        <Badge variant="outline" size="sm">
                          <T>Archived</T>
                        </Badge>
                      ) : null}
                      <span className="text-xs text-muted-foreground">
                        <T>
                          Updated <Var>{formatAccessTimestamp(timestamp)}</Var>
                        </T>
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0">
                    <Button
                      size="xs"
                      variant="outline"
                      render={
                        <Link
                          to="/popout/thread/$threadId"
                          params={{ threadId: thread.threadId }}
                          search={primaryEnvironmentId ? { env: primaryEnvironmentId } : {}}
                        />
                      }
                    >
                      <T>Open thread</T>
                      <ArrowUpRightIcon />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </StandalonePage>
  );
}
