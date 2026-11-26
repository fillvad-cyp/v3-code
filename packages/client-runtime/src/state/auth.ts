import {
  type ApiTokenCreateInput,
  type ApiTokenId,
  AuthAccessReadScope,
  AuthAccessWriteScope,
  type AuthAccessSnapshot,
  type AuthApproveConnectDeviceInput,
  type AuthEnvironmentScope,
  type AuthRevokeConnectDeviceInput,
  type AuthAccessStreamEvent,
  type AuthAccessStreamSnapshotEvent,
  type AuthCreatePairingCredentialInput,
  type AuthRevokeClientSessionInput,
  type AuthRevokePairingLinkInput,
  type EnvironmentId,
  type InvitationCreateInput,
  type ListAuditEventsInput,
  type MemberUpdateInput,
  type OwnerTransferInput,
  type PasswordSetInput,
  type PrincipalId,
  type ProjectId,
  type RecoveryIssueInput,
  sessionGrantsScope,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { subscribe } from "../rpc/client.ts";
import { executeConnectedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import {
  createEnvironmentCommand,
  createEnvironmentQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./runtime.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

const ACCESS_REQUEST_TIMEOUT_MS = 8_000;

export const EMPTY_AUTH_ACCESS_SNAPSHOT: AuthAccessSnapshot = {
  pairingLinks: [],
  clientSessions: [],
};

function upsertByKey<A>(
  values: ReadonlyArray<A>,
  next: A,
  key: (value: A) => string,
): ReadonlyArray<A> {
  const nextKey = key(next);
  return [...values.filter((value) => key(value) !== nextKey), next];
}

export function applyAuthAccessStreamEvent(
  current: AuthAccessSnapshot,
  event: AuthAccessStreamEvent,
): AuthAccessSnapshot {
  switch (event.type) {
    case "snapshot":
      return event.payload;
    case "pairingLinkUpserted":
      return {
        ...current,
        pairingLinks: upsertByKey(current.pairingLinks, event.payload, (value) => value.id),
      };
    case "pairingLinkRemoved":
      return {
        ...current,
        pairingLinks: current.pairingLinks.filter((value) => value.id !== event.payload.id),
      };
    case "clientUpserted":
      return {
        ...current,
        clientSessions: upsertByKey(
          current.clientSessions,
          event.payload,
          (value) => value.sessionId,
        ),
      };
    case "clientRemoved":
      return {
        ...current,
        clientSessions: current.clientSessions.filter(
          (value) => value.sessionId !== event.payload.sessionId,
        ),
      };
  }
}

function projectAuthAccessSnapshot(
  current: AuthAccessSnapshot,
  event: AuthAccessStreamEvent,
): readonly [AuthAccessSnapshot, ReadonlyArray<AuthAccessStreamEvent>] {
  const snapshot = applyAuthAccessStreamEvent(current, event);
  const projected: AuthAccessStreamSnapshotEvent = {
    version: 1,
    revision: event.revision,
    type: "snapshot",
    payload: snapshot,
  };
  return [snapshot, [projected]];
}

export interface AuthUpdateMemberCommandInput {
  readonly principalId: PrincipalId;
  readonly patch: MemberUpdateInput;
}

export interface AuthRemoveMemberCommandInput {
  readonly principalId: PrincipalId;
  readonly projectId?: ProjectId;
}

export interface AuthIssueMemberLoginCodeCommandInput {
  readonly principalId: PrincipalId;
}

export interface AuthSetMemberPasswordCommandInput {
  readonly principalId: PrincipalId;
  readonly password: string;
}

function createAuthScopePermissionAtom<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  label: string,
) {
  const sessionAtoms = createEnvironmentSessionAtoms(runtime);
  return Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const result = get(sessionAtoms.sessionStateAtom(environmentId));
      const session = AsyncResult.getOrElse(result, () => null);
      return (
        result._tag !== "Failure" &&
        session !== null &&
        session.authenticated &&
        scopes.every((scope) => sessionGrantsScope(session, scope))
      );
    }).pipe(Atom.withLabel(`${label}:${environmentId}`)),
  );
}

/** Access management runs on the chosen environment with this client's own session there. */
export function createAuthEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  const accessReadPermissionAtom = createAuthScopePermissionAtom(
    runtime,
    [AuthAccessReadScope],
    "environment-data:server:auth-access-read-permission",
  );
  const accessWritePermissionAtom = createAuthScopePermissionAtom(
    runtime,
    [AuthAccessWriteScope],
    "environment-data:server:auth-access-write-permission",
  );
  const authenticatedPermissionAtom = createAuthScopePermissionAtom(
    runtime,
    [],
    "environment-data:server:auth-authenticated-permission",
  );

  return {
    createPairingCredential: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-create-pairing-credential",
      execute: (input: AuthCreatePairingCredentialInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.pairingCredential(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.pairingCredential({ headers, payload: input }),
        }),
    }),
    revokePairingLink: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-pairing-link",
      execute: (input: AuthRevokePairingLinkInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.revokePairingLink(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.revokePairingLink({ headers, payload: input }),
        }),
    }),
    revokeClient: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-client",
      execute: (input: AuthRevokeClientSessionInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.revokeClient(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.revokeClient({ headers, payload: input }),
        }),
    }),
    signOutCurrentSession: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-sign-out-current-session",
      execute: (_input: null) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.revokeClient(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) =>
            client.revokeClient({ headers, payload: { current: true } }),
        }),
    }),
    revokeOtherClients: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-other-clients",
      execute: (_input: null) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.revokeOtherClients(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.revokeOtherClients({ headers }),
        }).pipe(Effect.map((result) => result.revokedCount)),
    }),
    approveConnectDevice: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-approve-connect-device",
      execute: (input: AuthApproveConnectDeviceInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.approveConnectDevice(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) =>
            client.approveConnectDevice({ headers, payload: input }),
        }),
    }),
    revokeConnectDevice: createEnvironmentCommand(runtime, {
      label: "environment-data:server:auth-revoke-connect-device",
      execute: (input: AuthRevokeConnectDeviceInput) =>
        executeConnectedEnvironmentHttpRequest({
          group: "auth",
          method: "POST",
          url: (urls) => urls.revokeConnectDevice(),
          timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
          request: ({ client, headers }) => client.revokeConnectDevice({ headers, payload: input }),
        }),
    }),
    listMembers: Object.assign(
      createEnvironmentQueryAtomFamily(runtime, {
        label: "environment-data:server:auth-list-members",
        staleTimeMs: 10_000,
        execute: (_input: null) =>
          executeConnectedEnvironmentHttpRequest({
            group: "auth",
            method: "GET",
            url: (urls) => urls.listMembers(),
            timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.listMembers({ headers }),
          }),
      }),
      { permissionAtom: accessReadPermissionAtom },
    ),
    updateMember: Object.assign(
      createEnvironmentCommand(runtime, {
        label: "environment-data:server:auth-update-member",
        execute: (input: AuthUpdateMemberCommandInput) =>
          executeConnectedEnvironmentHttpRequest({
            group: "auth",
            method: "PATCH",
            url: (urls) => urls.updateMember({ params: { principalId: input.principalId } }),
            timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) =>
              client.updateMember({
                headers,
                params: { principalId: input.principalId },
                payload: input.patch,
              }),
          }),
      }),
      { permissionAtom: accessWritePermissionAtom },
    ),
    removeMember: Object.assign(
      createEnvironmentCommand(runtime, {
        label: "environment-data:server:auth-remove-member",
        execute: (input: AuthRemoveMemberCommandInput) =>
          executeConnectedEnvironmentHttpRequest({
            group: "auth",
            method: "DELETE",
            url: (urls) =>
              urls.removeMember({
                params: { principalId: input.principalId },
                query: input.projectId === undefined ? {} : { projectId: input.projectId },
              }),
            timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) =>
              client.removeMember({
                headers,
                params: { principalId: input.principalId },
                query: input.projectId === undefined ? {} : { projectId: input.projectId },
              }),
          }),
      }),
      { permissionAtom: accessWritePermissionAtom },
    ),
    createInvitation: Object.assign(
      createEnvironmentCommand(runtime, {
        label: "environment-data:server:auth-create-invitation",
        execute: (input: InvitationCreateInput) =>
          executeConnectedEnvironmentHttpRequest({
            group: "auth",
            method: "POST",
            url: (urls) => urls.createInvitation(),
            timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.createInvitation({ headers, payload: input }),
          }),
      }),
      { permissionAtom: accessWritePermissionAtom },
    ),
    issueMemberLoginCode: Object.assign(
      createEnvironmentCommand(runtime, {
        label: "environment-data:server:auth-issue-member-login-code",
        execute: (input: AuthIssueMemberLoginCodeCommandInput) =>
          executeConnectedEnvironmentHttpRequest({
            group: "auth",
            method: "POST",
            url: (urls) =>
              urls.issueMemberLoginCode({ params: { principalId: input.principalId } }),
            timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) =>
              client.issueMemberLoginCode({
                headers,
                params: { principalId: input.principalId },
              }),
          }),
      }),
      { permissionAtom: authenticatedPermissionAtom },
    ),
    setOwnPassword: Object.assign(
      createEnvironmentCommand(runtime, {
        label: "environment-data:server:auth-set-own-password",
        execute: (input: PasswordSetInput) =>
          executeConnectedEnvironmentHttpRequest({
            group: "auth",
            method: "POST",
            url: (urls) => urls.setOwnPassword(),
            timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.setOwnPassword({ headers, payload: input }),
          }),
      }),
      { permissionAtom: authenticatedPermissionAtom },
    ),
    setMemberPassword: Object.assign(
      createEnvironmentCommand(runtime, {
        label: "environment-data:server:auth-set-member-password",
        execute: (input: AuthSetMemberPasswordCommandInput) =>
          executeConnectedEnvironmentHttpRequest({
            group: "auth",
            method: "POST",
            url: (urls) => urls.setMemberPassword({ params: { principalId: input.principalId } }),
            timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) =>
              client.setMemberPassword({
                headers,
                params: { principalId: input.principalId },
                payload: { password: input.password },
              }),
          }),
      }),
      { permissionAtom: accessWritePermissionAtom },
    ),
    issueRecoveryCode: Object.assign(
      createEnvironmentCommand(runtime, {
        label: "environment-data:server:auth-issue-recovery-code",
        execute: (input: RecoveryIssueInput) =>
          executeConnectedEnvironmentHttpRequest({
            group: "auth",
            method: "POST",
            url: (urls) => urls.issueRecoveryCode(),
            timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.issueRecoveryCode({ headers, payload: input }),
          }),
      }),
      { permissionAtom: authenticatedPermissionAtom },
    ),
    transferOwnership: Object.assign(
      createEnvironmentCommand(runtime, {
        label: "environment-data:server:auth-transfer-ownership",
        execute: (input: OwnerTransferInput) =>
          executeConnectedEnvironmentHttpRequest({
            group: "auth",
            method: "POST",
            url: (urls) => urls.transferOwnership(),
            timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.transferOwnership({ headers, payload: input }),
          }),
      }),
      { permissionAtom: accessWritePermissionAtom },
    ),
    listAuditEvents: Object.assign(
      createEnvironmentCommand(runtime, {
        label: "environment-data:server:auth-list-audit-events",
        execute: (input: ListAuditEventsInput) =>
          executeConnectedEnvironmentHttpRequest({
            group: "auth",
            method: "GET",
            url: (urls) => urls.listAuditEvents({ query: input }),
            timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.listAuditEvents({ headers, query: input }),
          }),
      }),
      { permissionAtom: accessReadPermissionAtom },
    ),
    listApiTokens: Object.assign(
      createEnvironmentQueryAtomFamily(runtime, {
        label: "environment-data:server:auth-list-api-tokens",
        staleTimeMs: 10_000,
        execute: (_input: null) =>
          executeConnectedEnvironmentHttpRequest({
            group: "auth",
            method: "GET",
            url: (urls) => urls.listApiTokens({ query: {} }),
            timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.listApiTokens({ headers, query: {} }),
          }),
      }),
      { permissionAtom: authenticatedPermissionAtom },
    ),
    createApiToken: Object.assign(
      createEnvironmentCommand(runtime, {
        label: "environment-data:server:auth-create-api-token",
        execute: (input: ApiTokenCreateInput) =>
          executeConnectedEnvironmentHttpRequest({
            group: "auth",
            method: "POST",
            url: (urls) => urls.createApiToken(),
            timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) => client.createApiToken({ headers, payload: input }),
          }),
      }),
      { permissionAtom: authenticatedPermissionAtom },
    ),
    revokeApiToken: Object.assign(
      createEnvironmentCommand(runtime, {
        label: "environment-data:server:auth-revoke-api-token",
        execute: (input: { readonly id: ApiTokenId }) =>
          executeConnectedEnvironmentHttpRequest({
            group: "auth",
            method: "DELETE",
            url: (urls) => urls.revokeApiToken({ params: { id: input.id } }),
            timeoutMs: ACCESS_REQUEST_TIMEOUT_MS,
            request: ({ client, headers }) =>
              client.revokeApiToken({ headers, params: { id: input.id } }),
          }),
      }),
      { permissionAtom: authenticatedPermissionAtom },
    ),
    accessChanges: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:auth-access-changes",
      subscribe: (_input: null) =>
        subscribe(WS_METHODS.subscribeAuthAccess, {}).pipe(
          Stream.mapAccum(() => EMPTY_AUTH_ACCESS_SNAPSHOT, projectAuthAccessSnapshot),
        ),
    }),
  };
}
