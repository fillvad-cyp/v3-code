import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, type MemberWithMemberships, type ProjectRole } from "@t3tools/contracts";
import { Link, useSearch } from "@tanstack/react-router";
import { CheckIcon, MinusIcon, ShieldAlertIcon } from "lucide-react";
import { Fragment } from "react";
import { T, useGT, useMessages } from "gt-react";

import { useSyncAccessRevision } from "../../state/accessRevision";
import { authEnvironment } from "../../state/auth";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentSessionState } from "../../state/session";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
        <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-warning sm:px-4">
          <ShieldAlertIcon aria-hidden className="size-3.5 shrink-0" />
          <span>
            <T>
              L0 host isolation: terminal and agent processes run under this machine&apos;s OS user
              and can see the host.
            </T>
          </span>
        </p>

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
                {matrix.sections.map((section) => (
                  <Fragment key={section.id}>
                    <TableRow>
                      <TableCell colSpan={matrix.roles.length + 1}>
                        <span className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
                          {section.label}
                        </span>
                      </TableCell>
                    </TableRow>
                    {section.rows.map((row) => (
                      <TableRow key={row.capability}>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span
                                  tabIndex={0}
                                  className="inline-block cursor-help py-0.5 font-medium text-foreground underline decoration-border/70 decoration-dotted underline-offset-4 outline-none focus-visible:text-primary"
                                />
                              }
                            >
                              {row.label}
                            </TooltipTrigger>
                            <TooltipPopup side="right">
                              <code className="font-mono text-xs">{row.capability}</code>
                            </TooltipPopup>
                          </Tooltip>
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
                  </Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={gt("Key rules & boundaries")}>
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
