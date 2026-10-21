"use client";

import { Fragment, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Building2,
  ChevronRight,
  Download,
  Info,
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
import { Separator } from "@/components/ui/separator";

async function fetchSettings(url: string): Promise<WorkspaceSettings> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("成员数据读取失败，请刷新页面确认权限。");
  return response.json();
}
const date = (value: string) =>
  new Date(value).toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const filters = [
  { value: "all", label: "全部" },
  { value: "active", label: "启用中" },
  { value: "invited", label: "待接受邀请" },
  { value: "suspended", label: "已停用" },
];
type Change = {
  userId: string;
  name: string;
  role: "admin" | "member";
  status: "active" | "suspended";
};

export function MembersSettings({
  initial,
  inviteInitially,
}: {
  initial: WorkspaceSettings;
  inviteInitially: boolean;
}) {
  const router = useRouter();
  const {
    data = initial,
    error: fetchError,
    mutate,
  } = useSWR(
    `/api/workspace?workspace=${initial.workspace.id}`,
    fetchSettings,
    { fallbackData: initial, revalidateOnMount: true },
  );
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [ascending, setAscending] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(
    inviteInitially && initial.role === "admin",
  );
  const [change, setChange] = useState<Change | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const downloadRef = useRef<HTMLAnchorElement>(null);
  const canManage = data.role === "admin" && !fetchError;
  const query = search.trim().toLowerCase();
  const members = data.members
    .filter((member) =>
      `${member.name} ${member.email}`.toLowerCase().includes(query),
    )
    .sort(
      (a, b) =>
        (ascending ? 1 : -1) *
        (a.name || a.email).localeCompare(b.name || b.email, "zh-CN"),
    );
  const invitations = data.invitations
    .filter((invite) => invite.email.toLowerCase().includes(query))
    .sort((a, b) => (ascending ? 1 : -1) * a.email.localeCompare(b.email));
  const groups = [
    { status: "active", label: "启用中" },
    { status: "suspended", label: "已停用" },
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
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setChange(null);
      setNotice("成员信息已更新。");
      await mutate();
    } catch {
      setError("更新失败，请重试。");
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
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setNotice("邀请已撤销，原链接已失效。");
      await mutate();
    } catch {
      setError("撤销失败，请重试。");
    } finally {
      setPending(false);
    }
  }
  function exportCsv() {
    if (!downloadRef.current || fetchError) return;
    const rows = [
      ["姓名", "邮箱", "角色", "状态", "加入时间 / 邀请有效期"],
      ...groups.flatMap((group) =>
        group.members.map((member) => [
          member.name,
          member.email,
          member.role === "admin" ? "管理员" : "成员",
          group.label,
          member.createdAt,
        ]),
      ),
      ...visibleInvitations.map((invite) => [
        "",
        invite.email,
        invite.role === "admin" ? "管理员" : "成员",
        "待接受邀请",
        invite.expiresAt,
      ]),
    ];
    const url = URL.createObjectURL(
      new Blob([memberCsv(rows)], { type: "text/csv;charset=utf-8" }),
    );
    downloadRef.current.href = url;
    downloadRef.current.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground md:flex-row">
      <aside
        className="flex shrink-0 flex-col gap-7 border-b p-3 md:w-60 md:border-0 md:py-5"
        aria-label="工作区设置导航"
      >
        <Link
          href="/"
          className={buttonVariants({
            variant: "ghost",
            className: "justify-start text-muted-foreground",
          })}
        >
          <ArrowLeft data-icon="inline-start" />
          返回工作台
        </Link>
        <div className="flex flex-col gap-3 px-1">
          <div className="flex items-center gap-2 px-2 text-sm text-muted-foreground">
            <Building2 className="size-4" />
            <span>工作区</span>
          </div>
          <Select
            value={data.workspace.id}
            items={data.choices.map((item) => ({
              value: item.id,
              label: item.name,
            }))}
            onValueChange={(value) => {
              if (value) router.push(`/settings/members?workspace=${value}`);
            }}
          >
            <SelectTrigger aria-label="当前工作区" className="w-full">
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
          <p className="px-3 text-xs text-muted-foreground">管理</p>
          <Link
            href={`/settings/members?workspace=${data.workspace.id}`}
            className={buttonVariants({
              variant: "secondary",
              className: "justify-start rounded-lg",
            })}
            aria-current="page"
          >
            <Users data-icon="inline-start" />
            成员
          </Link>
        </div>
        <div className="mt-auto hidden flex-col gap-3 px-3 pb-2 md:flex">
          <Separator />
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Shield className="size-3.5" />
            {data.role === "admin" ? "管理员访问权限" : "成员访问权限"}
          </div>
          <span className="text-xs text-muted-foreground">
            Orvilo3 · 工作区设置
          </span>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col md:py-2 md:pr-2">
        <div className="flex min-h-[calc(100dvh-1rem)] flex-col rounded-xl border bg-sidebar/40">
          <header className="flex h-12 items-center gap-2 px-5 text-xs text-muted-foreground md:px-8">
            <Users className="size-3.5" />
            <span>设置</span>
            <ChevronRight className="size-3" />
            <span>成员</span>
          </header>
          <div className="flex w-full flex-col gap-6 px-5 py-5 md:px-10 lg:px-14 lg:py-8">
            <h1 className="text-2xl font-medium tracking-tight">成员</h1>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex w-full items-center gap-2 sm:w-auto">
                <div className="min-w-0 flex-1 sm:w-72">
                  <InputGroup>
                    <InputGroupAddon>
                      <Search />
                    </InputGroupAddon>
                    <InputGroupInput
                      aria-label="搜索成员或邀请"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="搜索姓名或邮箱"
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
                  <SelectTrigger aria-label="成员状态筛选">
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
                  导出 CSV
                </Button>
                <Button
                  className="rounded-full bg-workspace-accent text-workspace-accent-foreground hover:bg-workspace-accent/90"
                  disabled={!canManage}
                  onClick={() => setInviteOpen(true)}
                >
                  邀请成员
                </Button>
              </div>
              <a
                ref={downloadRef}
                className="sr-only"
                download="members.csv"
                tabIndex={-1}
                aria-hidden="true"
              >
                下载成员 CSV
              </a>
            </div>
            {(error || fetchError) && (
              <Alert variant="destructive">
                <AlertTitle>操作未完成</AlertTitle>
                <AlertDescription>
                  {error || "无法刷新成员数据，请确认权限后重试。"}
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
                        ascending ? "按姓名降序排列" : "按姓名升序排列"
                      }
                      onClick={() => setAscending(!ascending)}
                    >
                      姓名
                      {ascending ? (
                        <ArrowDown data-icon="inline-end" />
                      ) : (
                        <ArrowUp data-icon="inline-end" />
                      )}
                    </Button>
                  </TableHead>
                  <TableHead>邮箱</TableHead>
                  <TableHead>状态 / 角色</TableHead>
                  <TableHead className="hidden lg:table-cell">
                    加入时间 / 有效期
                  </TableHead>
                  <TableHead>
                    <span className="sr-only">操作</span>
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
                                        你
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
                                  已停用
                                </span>
                              ) : member.role === "admin" ? (
                                <Badge
                                  variant="secondary"
                                  className="bg-workspace-accent/15 text-workspace-accent"
                                >
                                  管理员
                                </Badge>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  成员
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
                                        aria-label={`管理 ${member.name || member.email}`}
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
                                          ? "设为成员"
                                          : "设为管理员"}
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
                                          ? "停用成员"
                                          : "恢复成员"}
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
                        待接受邀请
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
                                  ? "待接受 · 链接邀请"
                                  : "已过期"}
                              </span>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {invite.email}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {invite.role === "admin" ? "管理员" : "成员"}
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
                            撤销邀请
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
                    {query ? "没有匹配的结果" : "暂无此状态的成员"}
                  </EmptyTitle>
                  <EmptyDescription>
                    {query
                      ? "试试其他姓名或邮箱。"
                      : "可以调整筛选，或邀请同事加入工作区。"}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
            <div className="mt-6 flex max-w-2xl items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <p>
                {canManage
                  ? "管理员可邀请、调整角色和停用成员。工作区须保留至少一位管理员。成员资格不改变已有任务的单独授权。"
                  : "仅管理员可邀请成员和更改权限。如需操作，请联系工作区管理员。"}
              </p>
            </div>
          </div>
        </div>
      </main>
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
            <AlertDialogTitle>确认更新成员权限？</AlertDialogTitle>
            <AlertDialogDescription>
              将「{change?.name || "该成员"}」
              {change?.status === "suspended"
                ? "停用。该成员将无法访问工作区成员目录；已有任务协作权限不变。"
                : `设置为${change?.role === "admin" ? "管理员" : "成员"}并保持启用。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={() => void applyChange()}
            >
              {pending ? "正在更新…" : "确认更新"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
