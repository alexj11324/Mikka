"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useRouter } from "@/i18n/navigation";
import useSWR from "swr";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Building2,
  ChevronRight,
  Download,
  MoreHorizontal,
  Search,
  Shield,
  Users,
} from "lucide-react";
import type { WorkspaceSettings } from "@/lib/workspace-access";
import { memberCsv } from "@/lib/invitation-csv";
import {
  revokeWorkspaceInvitation,
  updateWorkspaceMember,
} from "@/app/actions/workspace";
import { InviteMembersDialog } from "@/components/workspace/invite-members-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { withBasePath } from "@/lib/base-path";
import { useActionError } from "@/lib/use-action-error";
import { SettingsDataState } from "@/components/settings/settings-data-state";
import { cn } from "@/lib/utils";

async function fetchSettings(url: string): Promise<WorkspaceSettings> {
  const response = await fetch(url);
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : "Failed to load members.";
    throw new Error(message);
  }
  return response.json();
}
type Change = {
  userId: string;
  name: string;
  role: "admin" | "member";
  status: "active" | "suspended";
};

export function MembersSettings({
  initial,
  workspaceId,
  inviteInitially,
  embedded = false,
}: {
  initial?: WorkspaceSettings;
  workspaceId?: string;
  inviteInitially: boolean;
  embedded?: boolean;
}) {
  const t = useTranslations("Members");
  const translateError = useActionError();
  const commonT = useTranslations("Common");
  const format = useFormatter();
  const locale = useLocale();
  const router = useRouter();
  const requestedWorkspaceId = initial?.workspace.id ?? workspaceId;
  const settingsUrl = requestedWorkspaceId
    ? `/api/workspace?workspace=${encodeURIComponent(requestedWorkspaceId)}`
    : "/api/workspace";
  const {
    data: fetchedData,
    error: fetchError,
    mutate,
  } = useSWR<WorkspaceSettings>(withBasePath(settingsUrl), fetchSettings, {
    fallbackData: initial,
    revalidateOnMount: true,
  });
  const ready = Boolean(fetchedData ?? initial);
  const data = fetchedData ?? initial ?? {
    workspace: { id: "", name: "" },
    choices: [],
    currentUserId: "",
    role: "member" as const,
    currentUser: { name: "", email: "", image: null },
    members: [],
    invitations: [],
  };
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [ascending, setAscending] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  useEffect(() => {
    if (inviteInitially && ready && data.role === "admin") setInviteOpen(true);
  }, [inviteInitially, ready, data.role]);
  const [change, setChange] = useState<Change | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const downloadRef = useRef<HTMLAnchorElement>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | undefined>();
  const canManage = data.role === "admin" && !fetchError;
  const query = search.trim().toLowerCase();
  const filterAll = t("filters.all")
  const filterActive = t("filters.active")
  const filterInvited = t("filters.invited")
  const filterSuspended = t("filters.suspended")
  const filters = useMemo(() => [
    { value: "all", label: filterAll },
    { value: "active", label: filterActive },
    { value: "invited", label: filterInvited },
    { value: "suspended", label: filterSuspended },
  ], [filterAll, filterActive, filterInvited, filterSuspended])
  const filterItems = useMemo(() => canManage ? filters : filters.filter((item) => item.value !== "invited"), [canManage, filters])
  const workspaceItems = useMemo(() => data.choices.map((item) => ({ value: item.id, label: item.name })), [data.choices])
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
  if (!ready) return <SettingsDataState title={t("title")} error={fetchError} onRetry={() => void mutate()} />
  const MainContent = embedded ? 'div' : 'main'
  return (
    <div data-settings-state={fetchError ? "error" : ready ? "ready" : "loading"} className={cn(!embedded && "flex min-h-dvh flex-col bg-background text-foreground md:flex-row", embedded && "w-full min-w-0")}>
      {!embedded && <aside
        className="flex shrink-0 flex-col gap-7 p-3 md:w-60 md:py-5"
        aria-label={t("navLabel")}
      >
        <Link
          href="/"
          className={buttonVariants({
            variant: "ghost",
            className: "justify-start text-muted-foreground",
          })}
        >
          <ArrowLeft data-icon="inline-start" />
          {t("backToWorkspace")}
        </Link>
        <div className="flex flex-col gap-3 px-1">
          <div className="flex items-center gap-2 px-2 text-sm text-muted-foreground">
            <Building2 className="size-4" />
            <span>{t("workspace")}</span>
          </div>
          <Select
            value={data.workspace.id}
            items={workspaceItems}
            onValueChange={(value) => {
              if (value) router.push(`/settings/members?workspace=${value}`);
            }}
          >
            <SelectTrigger aria-label={t("currentWorkspace")} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {data.choices.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <p className="px-3 text-xs text-muted-foreground">{t("manage")}</p>
          <Link
            href={`/settings/members?workspace=${data.workspace.id}`}
            className={buttonVariants({
              variant: "secondary",
              className: "justify-start rounded-lg",
            })}
            aria-current="page"
          >
            <Users data-icon="inline-start" />
            {t("title")}
          </Link>
        </div>
        <div className="mt-auto hidden flex-col gap-3 px-3 pb-2 md:flex">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Shield className="size-3.5" />
            {data.role === "admin" ? t("adminAccess") : t("memberAccess")}
          </div>
          <span className="text-xs text-muted-foreground">{t("brandFooter")}</span>
        </div>
      </aside>}
      <MainContent className={cn("min-w-0", embedded ? "w-full" : "flex flex-1 flex-col md:py-2 md:pr-2")}>
        <div className={cn("flex flex-col", embedded ? "gap-6" : "min-h-[calc(100dvh-1rem)] rounded-xl border bg-sidebar/40")}>
          {!embedded && <header className="flex h-12 items-center gap-2 px-5 text-xs text-muted-foreground md:px-8">
            <Users className="size-3.5" />
            <span>{t("breadcrumbSettings")}</span>
            <ChevronRight className="size-3" />
            <span>{t("title")}</span>
          </header>}
          <div className={cn("flex w-full flex-col gap-6 px-5 py-5 md:px-10 lg:px-14 lg:py-8", embedded && "px-0 py-0 md:px-0 lg:px-0 lg:py-0")}>
            <h1 className="text-2xl font-medium tracking-tight">{t("title")}</h1>
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
                  items={filterItems}
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
          </div>
        </div>
      </MainContent>
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
    </div>
  );
}
