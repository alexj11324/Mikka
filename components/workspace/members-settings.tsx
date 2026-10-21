"use client";

import { Fragment, useRef, useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import {
  ArrowDown,
  ArrowUp,
  Download,
  Info,
  MoreHorizontal,
  Search,
  Users,
} from "lucide-react";
import type { WorkspaceSettings } from "@/lib/workspace-access";
import { memberCsv } from "@/lib/invitation-csv";
import {
  revokeWorkspaceInvitation,
  updateWorkspaceMember,
} from "@/app/actions/workspace";
import { useActionError } from "@/lib/use-action-error";
import { InviteMembersDialog } from "@/components/workspace/invite-members-dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/reui/badge";
import { UserAvatar } from "@/components/user-avatar";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@/components/ui/empty";


type Change = {
  userId: string;
  name: string;
  role: "admin" | "member";
  status: "active" | "suspended";
};

export function MembersSettings({
  data,
  inviteInitially,
  fetchError,
  mutate,
}: {
  data: WorkspaceSettings;
  inviteInitially: boolean;
  fetchError?: Error;
  mutate: () => Promise<unknown>;
}) {
  const t = useTranslations("Members");
  const commonT = useTranslations("Common");
  const format = useFormatter();
  const locale = useLocale();
  const translateError = useActionError();
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [ascending, setAscending] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(
    inviteInitially && data.role === "admin",
  );
  const [change, setChange] = useState<Change | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const downloadRef = useRef<HTMLAnchorElement>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | undefined>();
  const canManage = data.role === "admin" && !fetchError;
  const query = search.trim().toLowerCase();
  const filters = [
    { value: "all", label: t("filters.all") },
    { value: "active", label: t("filters.active") },
    { value: "invited", label: t("filters.invited") },
    { value: "suspended", label: t("filters.suspended") },
  ];
  const date = (value: string) =>
    format.dateTime(new Date(value), {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  const members = data.members
    .filter((member) =>
      `${member.name} ${member.email}`.toLowerCase().includes(query),
    )
    .sort(
      (a, b) =>
        (ascending ? 1 : -1) *
        (a.name || a.email).localeCompare(b.name || b.email, locale),
    );
  const invitations = data.invitations
    .filter((invite) => invite.email.toLowerCase().includes(query))
    .sort((a, b) => (ascending ? 1 : -1) * a.email.localeCompare(b.email));
  const groups = [
    { status: "active", label: t("status.active") },
    { status: "suspended", label: t("status.suspended") },
  ].map((group) => ({
    ...group,
    members: members.filter(
      (member) =>
        member.status === group.status &&
        (filter === "all" || filter === group.status),
    ),
  }));
  const visibleInvitations =
    canManage && (filter === "all" || filter === "invited") ? invitations : [];
  const visibleCount = groups.reduce(
    (count, group) => count + group.members.length,
    visibleInvitations.length,
  );

  async function applyChange() {
    if (!change || pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await updateWorkspaceMember({
        workspaceId: data.workspace.id,
        ...change,
      });
      if ("error" in result) {
        setError(translateError(result.error));
        return;
      }
      setChange(null);
      setNotice(t("memberUpdated"));
      await mutate();
    } catch {
      setError(t("updateFailed"));
    } finally {
      setPending(false);
    }
  }
  async function revoke(id: string) {
    if (pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const result = await revokeWorkspaceInvitation(data.workspace.id, id);
      if ("error" in result) {
        setError(translateError(result.error));
        return;
      }
      setNotice(t("invitationRevoked"));
      await mutate();
    } catch {
      setError(t("revokeFailed"));
    } finally {
      setPending(false);
    }
  }
  function exportCsv() {
    if (!downloadRef.current || fetchError) return;
    const rows = [
      [
        t("csv.name"),
        t("csv.email"),
        t("csv.role"),
        t("csv.status"),
        t("csv.joined"),
      ],
      ...groups.flatMap((group) =>
        group.members.map((member) => [
          member.name,
          member.email,
          member.role === "admin" ? t("role.admin") : t("role.member"),
          group.label,
          member.createdAt,
        ]),
      ),
      ...visibleInvitations.map((invite) => [
        "",
        invite.email,
        invite.role === "admin" ? t("role.admin") : t("role.member"),
        t("status.invited"),
        invite.expiresAt,
      ]),
    ];
    const url = URL.createObjectURL(
      new Blob([memberCsv(rows)], { type: "text/csv;charset=utf-8" }),
    );
    setDownloadUrl(url);
    downloadRef.current.href = url;
    downloadRef.current.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="flex min-w-0 flex-col gap-6" aria-label={t("title")}>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex w-full items-center gap-2 sm:w-auto">
                <div className="min-w-0 flex-1 sm:w-72">
                  <InputGroup>
                    <InputGroupAddon>
                      <Search />
                    </InputGroupAddon>
                    <InputGroupInput
                      aria-label={t("searchLabel")}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={t("searchPlaceholder")}
                    />
                  </InputGroup>
                </div>
                <Select
                  value={filter}
                  items={
                    canManage
                      ? filters
                      : filters.filter((item) => item.value !== "invited")
                  }
                  onValueChange={(value) => setFilter(value ?? "all")}
                >
                  <SelectTrigger aria-label={t("filterLabel")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {filters
                        .filter((item) => canManage || item.value !== "invited")
                        .map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  variant="outline"
                  className="rounded-full"
                  disabled={!visibleCount || Boolean(fetchError)}
                  onClick={exportCsv}
                >
                  <Download data-icon="inline-start" />
                  {t("exportCsv")}
                </Button>
                <Button
                  className="rounded-full bg-workspace-accent text-workspace-accent-foreground hover:bg-workspace-accent/90"
                  disabled={!canManage}
                  onClick={() => setInviteOpen(true)}
                >
                  {t("invite")}
                </Button>
              </div>
              <a
                ref={downloadRef}
                href={downloadUrl}
                className="sr-only"
                download="members.csv"
                tabIndex={-1}
                aria-hidden="true"
              >
                {t("downloadCsv")}
              </a>
            </div>
            {(error || fetchError) && (
              <Alert variant="destructive">
                <AlertTitle>{t("operationFailed")}</AlertTitle>
                <AlertDescription>
                  {error || t("refreshFailed")}
                </AlertDescription>
              </Alert>
            )}
            {notice && (
              <p role="status" className="text-sm text-muted-foreground">
                {notice}
              </p>
            )}
            <Table className="min-w-xl">
              <TableHeader>
                <TableRow className="border-0 hover:bg-transparent">
                  <TableHead className="w-2/5">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="-ml-2"
                      aria-label={
                        ascending ? t("sortDescending") : t("sortAscending")
                      }
                      onClick={() => setAscending(!ascending)}
                    >
                      {t("table.name")}
                      {ascending ? (
                        <ArrowDown data-icon="inline-end" />
                      ) : (
                        <ArrowUp data-icon="inline-end" />
                      )}
                    </Button>
                  </TableHead>
                  <TableHead>{t("table.email")}</TableHead>
                  <TableHead>{t("table.statusRole")}</TableHead>
                  <TableHead className="hidden lg:table-cell">
                    {t("table.joined")}
                  </TableHead>
                  <TableHead>
                    <span className="sr-only">{t("table.actions")}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map(
                  (group) =>
                    group.members.length > 0 && (
                      <Fragment key={group.status}>
                        <TableRow className="border-0 bg-muted/40 hover:bg-muted/40">
                          <TableCell
                            colSpan={5}
                            className="rounded-lg py-2 text-xs text-muted-foreground"
                          >
                            {group.label}
                            <span className="ml-2 tabular-nums">
                              {group.members.length}
                            </span>
                          </TableCell>
                        </TableRow>
                        {group.members.map((member) => (
                          <TableRow key={member.userId} className="border-0">
                            <TableCell className="py-4">
                              <div className="flex items-center gap-3">
                                <UserAvatar user={member} size="md" />
                                <div className="flex min-w-0 flex-col gap-0.5">
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium">
                                      {member.name || member.email}
                                    </span>
                                    {member.userId === data.currentUserId && (
                                      <span className="text-xs text-muted-foreground">
                                        {t("you")}
                                      </span>
                                    )}
                                  </div>
                                  <span className="text-xs text-muted-foreground">
                                    {member.email.split("@")[0]}
                                  </span>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {member.email}
                            </TableCell>
                            <TableCell>
                              {member.status === "suspended" ? (
                                <span className="text-xs text-muted-foreground">
                                  {t("status.suspended")}
                                </span>
                              ) : member.role === "admin" ? (
                                <Badge
                                  variant="secondary"
                                  className="bg-workspace-accent/15 text-workspace-accent"
                                >
                                  {t("role.admin")}
                                </Badge>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {t("role.member")}
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                              {date(member.createdAt)}
                            </TableCell>
                            <TableCell className="text-right">
                              {canManage && (
                                <DropdownMenu>
                                  <DropdownMenuTrigger
                                    render={
                                      <Button
                                        size="icon-sm"
                                        variant="ghost"
                                        aria-label={t("manageMember", {
                                          name: member.name || member.email,
                                        })}
                                        disabled={pending}
                                      />
                                    }
                                  >
                                    <MoreHorizontal />
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end">
                                    <DropdownMenuGroup>
                                      <DropdownMenuItem
                                        onClick={() =>
                                          setChange({
                                            userId: member.userId,
                                            name: member.name,
                                            role:
                                              member.role === "admin"
                                                ? "member"
                                                : "admin",
                                            status: member.status,
                                          })
                                        }
                                      >
                                        {member.role === "admin"
                                          ? t("menu.makeMember")
                                          : t("menu.makeAdmin")}
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        onClick={() =>
                                          setChange({
                                            userId: member.userId,
                                            name: member.name,
                                            role: member.role,
                                            status:
                                              member.status === "active"
                                                ? "suspended"
                                                : "active",
                                          })
                                        }
                                      >
                                        {member.status === "active"
                                          ? t("menu.suspend")
                                          : t("menu.restore")}
                                      </DropdownMenuItem>
                                    </DropdownMenuGroup>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </Fragment>
                    ),
                )}
                {visibleInvitations.length > 0 && (
                  <>
                    <TableRow className="border-0 bg-muted/40 hover:bg-muted/40">
                      <TableCell
                        colSpan={5}
                        className="rounded-lg py-2 text-xs text-muted-foreground"
                      >
                        {t("status.invited")}
                        <span className="ml-2 tabular-nums">
                          {visibleInvitations.length}
                        </span>
                      </TableCell>
                    </TableRow>
                    {visibleInvitations.map((invite) => (
                      <TableRow key={invite.id} className="border-0">
                        <TableCell className="py-4">
                          <div className="flex items-center gap-3">
                            <UserAvatar user={invite} size="md" />
                            <div className="flex flex-col gap-0.5">
                              <span>{invite.email.split("@")[0]}</span>
                              <span className="text-xs text-muted-foreground">
                                {new Date(invite.expiresAt).getTime() >
                                Date.now()
                                  ? t("invitation.pending")
                                  : t("invitation.expired")}
                              </span>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {invite.email}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {invite.role === "admin"
                            ? t("role.admin")
                            : t("role.member")}
                        </TableCell>
                        <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
                          {date(invite.expiresAt)}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={pending || !canManage}
                            onClick={() => void revoke(invite.id)}
                          >
                            {t("invitation.revoke")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </>
                )}
              </TableBody>
            </Table>
            {!visibleCount && (
              <Empty className="py-14">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Users />
                  </EmptyMedia>
                  <EmptyTitle>
                    {query ? t("empty.noResults") : t("empty.noMembers")}
                  </EmptyTitle>
                  <EmptyDescription>
                    {query
                      ? t("empty.noResultsHint")
                      : t("empty.noMembersHint")}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            <div className="mt-6 flex max-w-2xl items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <p>
                {canManage ? t("footer.admin") : t("footer.member")}
              </p>
            </div>
      <InviteMembersDialog
        key={data.workspace.id}
        workspaceId={data.workspace.id}
        workspaceName={data.workspace.name}
        currentUser={data.currentUser}
        open={inviteOpen && canManage}
        onOpenChange={setInviteOpen}
        onCreated={async () => {
          setFilter("invited");
          await mutate();
        }}
      />
      <AlertDialog
        open={Boolean(change)}
        onOpenChange={(value) => {
          if (!value && !pending) {
            setChange(null);
            setError("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {change?.status === "suspended"
                ? t("confirmSuspend", {
                    name: change?.name || t("thisMember"),
                  })
                : t("confirmRole", {
                    name: change?.name || t("thisMember"),
                    role:
                      change?.role === "admin"
                        ? t("role.admin")
                        : t("role.member"),
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>
              {commonT("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() => void applyChange()}
            >
              {pending ? t("updating") : t("confirmUpdate")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
