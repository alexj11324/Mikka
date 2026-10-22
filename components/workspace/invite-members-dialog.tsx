"use client";

import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { Copy, FileSpreadsheet, Loader2, Mail, Upload, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { createWorkspaceInvitation } from "@/app/actions/workspace";
import {
  InvitationCsvError,
  invitationEmails,
  MAX_INVITATION_CSV_BYTES,
  MAX_INVITATION_EMAILS,
  parseInvitationCsv,
  validateInvitationEmails,
} from "@/lib/invitation-csv";
import { useActionError } from "@/lib/use-action-error";
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
import { withBasePath } from "@/lib/base-path";

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
  const t = useTranslations("Invite");
  const commonT = useTranslations("Common");
  const format = useFormatter();
  const translateError = useActionError();
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
  const roleItems = [
    { value: "member", label: t("roles.member") },
    { value: "admin", label: t("roles.admin") },
  ];

  function csvErrorMessage(cause: unknown) {
    if (!(cause instanceof InvitationCsvError)) return t("errors.readFailed");
    switch (cause.code) {
      case "emailRequired":
        return t("errors.emailRequired");
      case "tooManyEmails":
        return t("errors.tooManyEmails", {
          max: cause.params.max ?? MAX_INVITATION_EMAILS,
          count: cause.params.count ?? 0,
        });
      case "invalidEmails":
        return t("errors.invalidEmails", {
          emails: format.list(cause.params.emails ?? [], {
            type: "conjunction",
          }),
        });
      case "csvQuote":
        return t("errors.csvQuote", { line: cause.params.line ?? 0 });
      case "csvUnclosedQuote":
        return t("errors.csvUnclosedQuote");
      case "csvEmpty":
        return t("errors.csvEmpty");
      case "csvMissingHeader":
        return t("errors.csvMissingHeader");
      case "csvHeaderOnly":
        return t("errors.csvHeaderOnly");
      case "csvInvalidRows":
        return t("errors.csvInvalidRows", {
          lines: format.list(
            (cause.params.lines ?? []).map(String),
            { type: "conjunction" },
          ),
        });
      default:
        return t("errors.readFailed");
    }
  }

  async function importFile(files: File[]) {
    if (busy) return;
    setDragging(false);
    setError("");
    setNotice("");
    if (files.length !== 1 || !files[0].name.toLowerCase().endsWith(".csv")) {
      setError(t("errors.notCsv"));
      return;
    }
    const file = files[0];
    if (file.size > MAX_INVITATION_CSV_BYTES) {
      setError(t("errors.fileTooLarge"));
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
        duplicates
          ? t("importedDuplicates", {
              count: parsed.emails.length,
              duplicates,
              total: merged.length,
            })
          : t("imported", {
              count: parsed.emails.length,
              total: merged.length,
            }),
      );
    } catch (cause) {
      setError(csvErrorMessage(cause));
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
      setError(
        cause instanceof InvitationCsvError
          ? csvErrorMessage(cause)
          : t("errors.checkEmails"),
      );
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
        setError(translateError(result.error));
        return;
      }
      setLinks(
        result.data.map((link) => ({
          email: link.email,
          url: new URL(withBasePath(link.path), window.location.origin).href,
        })),
      );
      try {
        await onCreated();
      } catch {
        setNotice(t("refreshFailed"));
      }
    } catch {
      setError(t("errors.createFailed"));
    } finally {
      setPending(false);
    }
  }
  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setNotice(t("linkCopied"));
    } catch {
      setNotice(t("copyManually"));
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
            <DialogTitle>{t("title")}</DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            {t("description", { workspace: workspaceName })}
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
              <AlertTitle>{t("linksCreated", { count: links.length })}</AlertTitle>
              <AlertDescription>{t("linksDescription")}</AlertDescription>
            </Alert>
            <FieldGroup>
              {links.map((link) => (
                <Field key={link.email}>
                  <FieldLabel>{link.email}</FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      aria-label={t("inviteLinkFor", { email: link.email })}
                      value={link.url}
                      readOnly
                      onFocus={(event) => event.currentTarget.select()}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={t("copyLinkFor", { email: link.email })}
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
                {t("done")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-6">
            <FieldGroup className="gap-5">
              <Field>
                <FieldLabel htmlFor="invite-emails">{t("emailLabel")}</FieldLabel>
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
                  {t("emailHelp", { max: MAX_INVITATION_EMAILS })}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="invite-csv" className="sr-only">
                  {t("csv.label")}
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
                      {dragging ? t("csv.dropNow") : t("csv.dropHint")}
                    </span>
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0"
                      disabled={busy}
                      onClick={() => fileRef.current?.click()}
                    >
                      {importing ? t("csv.reading") : t("csv.chooseFile")}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("csv.hint")}
                  </p>
                </div>
                {fileName && (
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="truncate">{fileName}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("csv.clear")}
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
                <FieldLabel htmlFor="invite-role">{t("roleLabel")}</FieldLabel>
                <Select
                  value={role}
                  onValueChange={(value) => setRole(value ?? "member")}
                  disabled={busy}
                  items={roleItems}
                >
                  <SelectTrigger id="invite-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="member">{t("roles.member")}</SelectItem>
                      <SelectItem value="admin">{t("roles.admin")}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
            <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
              <Mail className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <p>{t("noEmailService")}</p>
            </div>
            <DialogFooter className="m-0 mt-1 flex-row items-center justify-between border-0 bg-transparent p-0 sm:justify-between">
              <span className="text-xs text-muted-foreground">
                {recipients.length
                  ? t("pendingCount", { count: recipients.length })
                  : t("inviteHint")}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="rounded-full"
                  disabled={busy}
                  onClick={close}
                >
                  {commonT("cancel")}
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
                  {pending ? t("creating") : t("createLinks")}
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
