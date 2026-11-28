import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type MemberWithMemberships, type ProjectRole } from "@t3tools/contracts";
import { Link, useSearch } from "@tanstack/react-router";
import { CheckIcon, MinusIcon, ShieldAlertIcon } from "lucide-react";
import { T, useGT, useMessages } from "gt-react";

import { useSyncAccessRevision } from "../../state/accessRevision";
import { authEnvironment } from "../../state/auth";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentSessionState } from "../../state/session";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { ITEM_ROW_CLASSNAME } from "./itemRows";
import { isSessionOwner, PROJECT_ROLE_LABELS } from "./MembersSettings.logic";
import {
  buildRoleMatrix,
  resolveHighlightedRoles,
  type RoleMatrixData,
} from "./RolesAndAccess.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useAccessEnvironment } from "./useAccessEnvironment";

const EMPTY_MEMBERS: ReadonlyArray<MemberWithMemberships> = [];
const EMPTY_HIGHLIGHTED_ROLES: ReadonlySet<ProjectRole> = new Set();

function RolesPermissionsView({
  matrix,
  highlightedRoles,
  membersError,
}: {
  readonly matrix: RoleMatrixData;
  readonly highlightedRoles: ReadonlySet<ProjectRole>;
  readonly membersError: string | null;
}) {
  const gt = useGT();
  const m = useMessages();

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection
        id="roles-permissions"
        title={gt("Roles & permissions")}
        titleAction={
          <Badge variant="warning" size="sm">
            <ShieldAlertIcon aria-hidden />
            <T>L0 · Terminal sees host</T>
          </Badge>
        }
        headerAction={
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="xs" variant="outline" render={<Link to="/settings/my-access" />}>
              <T>My access</T>
            </Button>
            <Button size="xs" variant="ghost-muted" render={<Link to="/settings/access" />}>
              <T>Sharing &amp; access</T>
            </Button>
          </div>
        }
      >
        <div className="px-3 py-2.5 sm:px-4">
          <Alert variant="warning">
            <ShieldAlertIcon aria-hidden />
            <AlertDescription>
              <T>
                Host boundary (L0): terminal and agent processes run under this machine&apos;s OS
                user and see the host. Project roles enforce logical isolation inside V3 Code.
              </T>
            </AlertDescription>
          </Alert>
        </div>

        {membersError ? (
          <div className="px-3 py-2 sm:px-4">
            <Alert variant="error">
              <AlertDescription>{membersError}</AlertDescription>
            </Alert>
          </div>
        ) : null}

        {matrix.rows.length === 0 ? (
          <div className={ITEM_ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground">
              <T>No role capabilities are defined.</T>
            </p>
          </div>
        ) : (
          <div className="px-1 py-1 sm:px-2">
            <Table aria-label={gt("Role capability matrix")}>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">
                    <T>Capability</T>
                  </TableHead>
                  {matrix.roles.map((role) => {
                    const isHighlighted = highlightedRoles.has(role);
                    return (
                      <TableHead key={role} scope="col">
                        <div className="flex flex-col items-center gap-1 py-1 text-center">
                          <span>{m(PROJECT_ROLE_LABELS[role])}</span>
                          {isHighlighted ? (
                            <Badge variant="outline" size="sm">
                              <T>Your role</T>
                            </Badge>
                          ) : null}
                        </div>
                      </TableHead>
                    );
                  })}
                </TableRow>
              </TableHeader>
              <TableBody>
                {matrix.rows.map((row) => (
                  <TableRow key={row.capability}>
                    <TableCell>
                      <div className="flex flex-col gap-0.5 py-0.5">
                        <span className="font-medium text-foreground">{row.label}</span>
                        <code className="font-mono text-2xs text-muted-foreground">
                          {row.capability}
                        </code>
                      </div>
                    </TableCell>
                    {matrix.roles.map((role) => {
                      const allowed = row.roles[role];
                      return (
                        <TableCell key={role}>
                          <div className="flex items-center justify-center">
                            {allowed ? (
                              <>
                                <CheckIcon aria-hidden className="size-4 text-success" />
                                <span className="sr-only">
                                  {gt("Allowed", { $context: "permission state" })}
                                </span>
                              </>
                            ) : (
                              <>
                                <MinusIcon
                                  aria-hidden
                                  className="size-3.5 text-muted-foreground/40"
                                />
                                <span className="sr-only">{gt("Not granted")}</span>
                              </>
                            )}
                          </div>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={gt("Key rules & boundaries")}>
        <SettingsRow
          title={
            <span className="inline-flex flex-wrap items-center gap-2">
              <T>L0 host isolation</T>
              <Badge variant="warning" size="sm">
                <ShieldAlertIcon aria-hidden />
                <T>L0 · Terminal sees host</T>
              </Badge>
            </span>
          }
          description={gt(
            "Members with terminal or agent capabilities run processes under the host OS user and can see the host filesystem and environment.",
          )}
        />
        <SettingsRow
          title={gt("Owner bypasses project checks")}
          description={gt(
            "The environment owner stands outside project memberships and passes every project and environment check automatically.",
          )}
        />
        <SettingsRow
          title={gt("Creating a project: developer+")}
          description={gt(
            "Creating a new project requires the Developer role or higher (Developer, Admin, or Owner).",
          )}
        />
        <SettingsRow
          title={gt("Deleting a project: owner only")}
          description={gt(
            "Only the environment owner can delete a project. Project admins cannot delete projects.",
          )}
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function RolesPermissionsWithEnvironment({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const m = useMessages();
  const session = useEnvironmentSessionState(environmentId);
  const canReadMembers = useAtomValue(authEnvironment.listMembers.permissionAtom(environmentId));
  const shouldFetchMembers =
    session.data?.authenticated === true &&
    !isSessionOwner(session.data) &&
    session.data.binding?._tag !== "projects" &&
    canReadMembers;

  useSyncAccessRevision(environmentId, shouldFetchMembers);
  const membersQuery = useEnvironmentQuery(
    shouldFetchMembers ? authEnvironment.listMembers({ environmentId, input: null }) : null,
    m,
  );

  const matrix = buildRoleMatrix({ resolve: m });
  const highlightedRoles = resolveHighlightedRoles({
    session: session.data,
    members: membersQuery.data ?? EMPTY_MEMBERS,
  });

  return (
    <RolesPermissionsView
      matrix={matrix}
      highlightedRoles={highlightedRoles}
      membersError={shouldFetchMembers ? membersQuery.error : null}
    />
  );
}

export function RolesPermissionsPage() {
  const m = useMessages();
  const linkedEnvironmentId = useSearch({
    strict: false,
    select: (search) =>
      typeof search.machine === "string" ? EnvironmentId.make(search.machine) : null,
  });
  const { environment } = useAccessEnvironment(linkedEnvironmentId);

  if (environment === null) {
    return (
      <RolesPermissionsView
        matrix={buildRoleMatrix({ resolve: m })}
        highlightedRoles={EMPTY_HIGHLIGHTED_ROLES}
        membersError={null}
      />
    );
  }

  return (
    <RolesPermissionsWithEnvironment
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  );
}
