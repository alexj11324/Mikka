"use client";

import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { Copy, FileSpreadsheet, Loader2, Mail, Upload, X } from "lucide-react";
import { createWorkspaceInvitation } from "@/app/actions/workspace";
import {
  invitationEmails,
  MAX_INVITATION_CSV_BYTES,
  MAX_INVITATION_EMAILS,
  parseInvitationCsv,
  validateInvitationEmails,
} from "@/lib/invitation-csv";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user-avatar";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function InviteMembersDialog({
  workspaceId,
  workspaceName,
  currentUser,
  open,
  onOpenChange,
  onCreated,
}: {
  workspaceId: string;
  workspaceName: string;
  currentUser: { email: string; image?: string | null };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<unknown>;
}) {
  const [emails, setEmails] = useState("");
  const [role, setRole] = useState("member");
  const [pending, setPending] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [links, setLinks] = useState<{ email: string; url: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const busy = pending || importing;
  const recipients = invitationEmails(emails);

  async function importFile(files: File[]) {
    if (busy) return;
    setDragging(false);
    setError("");
    setNotice("");
    if (files.length !== 1 || !files[0].name.toLowerCase().endsWith(".csv")) {
      setError("请选择一个 .csv 文件。");
      return;
    }
    const file = files[0];
    if (file.size > MAX_INVITATION_CSV_BYTES) {
      setError("CSV 文件不能超过 1 MB。");
      return;
    }
    setImporting(true);
    try {
      const parsed = parseInvitationCsv(await file.text());
      const merged = [...new Set([...recipients, ...parsed.emails])];
      validateInvitationEmails(merged);
      const duplicates =
        parsed.duplicates +
        recipients.length +
        parsed.emails.length -
        merged.length;
      setEmails(merged.join("\n"));
      setFileName(file.name);
      setNotice(
        `已导入 ${parsed.emails.length} 个有效邮箱${duplicates ? `，已去重 ${duplicates} 个` : ""}；共 ${merged.length} 位待邀请。`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "文件读取失败，请使用 UTF-8 编码的 CSV 文件。",
      );
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }
  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    void importFile(Array.from(event.dataTransfer.files));
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setNotice("");
    try {
      validateInvitationEmails(recipients);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请检查邮箱地址。");
      return;
    }
    setPending(true);
    try {
      const result = await createWorkspaceInvitation({
        workspaceId,
        emails: recipients,
        role,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setLinks(
        result.data.map((link) => ({
          email: link.email,
          url: new URL(link.path, window.location.origin).href,
        })),
      );
      try {
        await onCreated();
      } catch {
        setNotice(
          "邀请已创建，但列表刷新失败。请关闭弹窗后刷新页面，不要重复创建。",
        );
      }
    } catch {
      setError("邀请未完成，请稍后重试。");
    } finally {
      setPending(false);
    }
  }
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setNotice("邀请链接已复制。");
    } catch {
      setNotice("自动复制不可用，请选中链接后手动复制。");
    }
  }
  function close() {
    if (busy) return;
    setDragging(false);
    setError("");
    setNotice("");
    if (links.length) {
      setLinks([]);
      setEmails("");
      setFileName("");
      setRole("member");
    }
    onOpenChange(false);
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
        else onOpenChange(true);
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto p-5 sm:max-w-xl sm:p-6">
        <DialogHeader className="mb-3 pr-7">
          <div className="flex items-center gap-2.5">
            <UserAvatar user={currentUser} size="sm" />
            <DialogTitle>邀请成员</DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            邀请同事加入{workspaceName}，可输入邮箱或拖入 CSV 批量导入。
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {links.length ? (
          <div className="flex flex-col gap-4">
            <Alert>
              <Mail />
              <AlertTitle>已创建 {links.length} 个邀请链接</AlertTitle>
              <AlertDescription>
                尚未发送邮件。请将链接私下发送给对应成员；7
                天内有效，仅限对应邮箱登录后接受。
              </AlertDescription>
            </Alert>
            <FieldGroup>
              {links.map((link) => (
                <Field key={link.email}>
                  <FieldLabel>{link.email}</FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      aria-label={`${link.email} 的邀请链接`}
                      value={link.url}
                      readOnly
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={`复制 ${link.email} 的邀请链接`}
                      onClick={() => void copy(link.url)}
                    >
                      <Copy data-icon="inline-start" />
                    </Button>
                  </div>
                </Field>
              ))}
            </FieldGroup>
            {notice && (
              <p role="status" className="text-xs text-muted-foreground">
                {notice}
              </p>
            )}
            <DialogFooter className="m-0 mt-2 border-0 bg-transparent p-0">
              <Button
                className="rounded-full bg-workspace-accent text-workspace-accent-foreground hover:bg-workspace-accent/90"
                onClick={close}
              >
                完成
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-6">
            <FieldGroup className="gap-5">
              <Field>
                <FieldLabel htmlFor="invite-emails">邮箱地址</FieldLabel>
                <Textarea
                  id="invite-emails"
                  value={emails}
                  onChange={(event) => {
                    setEmails(event.target.value);
                    setError("");
                    setNotice("");
                    setFileName("");
                  }}
                  placeholder="email@gmail.com, email2@gmail.com…"
                  rows={3}
                  required
                  maxLength={5200}
                  disabled={busy}
                      aria-describedby="invite-email-help"
                  className="min-h-24 resize-y"
                />
                <FieldDescription id="invite-email-help">
                  用逗号或换行分隔，一次最多 {MAX_INVITATION_EMAILS} 人。
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="invite-csv" className="sr-only">
                  上传 CSV 文件
                </FieldLabel>
                <Input
                  ref={fileRef}
                  id="invite-csv"
                  type="file"
                  accept=".csv,text/csv"
                  className="sr-only"
                  disabled={busy}
                  onChange={(event) => {
                    void importFile(Array.from(event.target.files ?? []));
                  }}
                />
                <div
                  data-testid="invite-csv-dropzone"
                  onDragOver={(event) => {
                    event.preventDefault();
                    if (!busy) {
                      event.dataTransfer.dropEffect = "copy";
                      setDragging(true);
                    }
                  }}
                  onDragLeave={(event) => {
                    if (
                      !event.currentTarget.contains(
                        event.relatedTarget as Node | null,
                      )
                    )
                      setDragging(false);
                  }}
                  onDrop={drop}
                  className={cn(
                    "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-5 text-center transition-colors",
                    dragging
                      ? "border-workspace-accent bg-workspace-accent/10"
                      : "border-border bg-muted/20",
                  )}
                >
                  <FileSpreadsheet
                    className="size-5 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div className="flex flex-wrap items-center justify-center gap-1 text-sm">
                    <span>
                      {dragging
                        ? "松开即可导入 CSV"
                        : "将 CSV 文件拖到这里，或"}
                    </span>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0"
                      disabled={busy}
                      onClick={() => fileRef.current?.click()}
                    >
                      {importing ? "正在读取…" : "选择文件"}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    支持 email / 邮箱列 · UTF-8 · 最大 1 MB
                  </p>
                </div>
                {fileName && (
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="truncate">{fileName}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="清空导入邮箱"
                      disabled={busy}
                      onClick={() => {
                        setEmails("");
                        setFileName("");
                        setNotice("");
                        setError("");
                      }}
                    >
                      <X data-icon="inline-start" />
                    </Button>
                  </div>
                )}
                {notice && (
                  <p role="status" className="text-xs text-muted-foreground">
                    {notice}
                  </p>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="invite-role">工作区角色</FieldLabel>
                <Select
                  value={role}
                  onValueChange={(value) => setRole(value ?? "member")}
                  disabled={busy}
                  items={[
                    { value: "member", label: "成员" },
                    { value: "admin", label: "管理员" },
                  ]}
                >
                  <SelectTrigger id="invite-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="member">成员</SelectItem>
                      <SelectItem value="admin">管理员</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
            <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <Mail className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <p>
                当前未接入邮件服务，将生成邮箱专属邀请链接，不会自动发送邮件。
              </p>
            </div>
            <DialogFooter className="m-0 mt-1 flex-row items-center justify-between border-0 bg-transparent p-0 sm:justify-between">
              <span className="text-xs text-muted-foreground">
                {recipients.length
                  ? `${recipients.length} 位待邀请`
                  : "邀请同事一起协作"}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="rounded-full"
                  disabled={busy}
                  onClick={close}
                >
                  取消
                </Button>
                <Button
                  type="submit"
                  className="rounded-full bg-workspace-accent text-workspace-accent-foreground hover:bg-workspace-accent/90"
                  disabled={busy || !emails.trim()}
                >
                  {pending ? (
                    <Loader2
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  ) : (
                    <Upload data-icon="inline-start" />
                  )}
                  {pending ? "正在创建…" : "创建邀请链接"}
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
