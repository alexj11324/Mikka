import { z } from "zod";

export const MAX_INVITATION_EMAILS = 20;
export const MAX_INVITATION_CSV_BYTES = 1024 * 1024;
const emailSchema = z.email().max(254);
const emailHeaders = new Set([
  "email",
  "e-mail",
  "email address",
  "邮箱", // i18n-ignore CSV header value
  "邮箱地址", // i18n-ignore CSV header value
  "电子邮箱", // i18n-ignore CSV header value
  "电子邮件", // i18n-ignore CSV header value
]);

export type InvitationCsvErrorCode =
  | "emailRequired"
  | "tooManyEmails"
  | "invalidEmails"
  | "csvQuote"
  | "csvUnclosedQuote"
  | "csvEmpty"
  | "csvMissingHeader"
  | "csvHeaderOnly"
  | "csvInvalidRows";

export interface InvitationCsvErrorParams {
  max?: number;
  count?: number;
  line?: number;
  lines?: number[];
  emails?: string[];
}

export class InvitationCsvError extends Error {
  readonly code: InvitationCsvErrorCode;
  readonly params: InvitationCsvErrorParams;

  constructor(
    code: InvitationCsvErrorCode,
    params: InvitationCsvErrorParams = {},
  ) {
    super(code);
    this.name = "InvitationCsvError";
    this.code = code;
    this.params = params;
  }
}

export function invitationEmails(value: string) {
  return [
    ...new Set(
      value
        .split(/[\s,，;；]+/)
        .filter(Boolean)
        .map((email) => email.toLowerCase()),
    ),
  ];
}

export function validateInvitationEmails(emails: string[]) {
  if (!emails.length) throw new InvitationCsvError("emailRequired");
  if (emails.length > MAX_INVITATION_EMAILS)
    throw new InvitationCsvError("tooManyEmails", {
      max: MAX_INVITATION_EMAILS,
      count: emails.length,
    });
  const invalid = emails.filter(
    (email) => !emailSchema.safeParse(email).success,
  );
  if (invalid.length)
    throw new InvitationCsvError("invalidEmails", {
      emails: invalid.slice(0, 3),
    });
}

export function parseInvitationCsv(source: string): {
  emails: string[];
  duplicates: number;
} {
  const text = source.replace(/^\uFEFF/, "");
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = firstLine.includes(",")
    ? ","
    : firstLine.includes("\t")
      ? "\t"
      : ";";
  const rows: { cells: string[]; line: number }[] = [];
  let cells: string[] = [],
    cell = "",
    quoted = false,
    closed = false,
    line = 1,
    rowLine = 1;
  function finishRow() {
    cells.push(cell.trim());
    if (cells.some(Boolean)) rows.push({ cells, line: rowLine });
    cells = [];
    cell = "";
    closed = false;
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        cell += char;
        if (char === "\n") line++;
      }
    } else if (char === delimiter) {
      cells.push(cell.trim());
      cell = "";
      closed = false;
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      finishRow();
      line++;
      rowLine = line;
    } else if (char === '"' && !cell.trim() && !closed) {
      cell = "";
      quoted = true;
    } else {
      if (char === '"' || (closed && char.trim()))
        throw new InvitationCsvError("csvQuote", { line });
      if (!closed) cell += char;
    }
  }
  if (quoted) throw new InvitationCsvError("csvUnclosedQuote");
  finishRow();
  if (!rows.length) throw new InvitationCsvError("csvEmpty");
  const headerIndex = rows[0].cells.findIndex((value) =>
    emailHeaders.has(value.toLowerCase()),
  );
  if (headerIndex < 0 && rows.some((row) => row.cells.length !== 1))
    throw new InvitationCsvError("csvMissingHeader");
  const records = headerIndex < 0 ? rows : rows.slice(1);
  if (!records.length) throw new InvitationCsvError("csvHeaderOnly");
  const emails: string[] = [],
    invalidLines: number[] = [];
  for (const row of records) {
    const email = (row.cells[headerIndex < 0 ? 0 : headerIndex] ?? "")
      .trim()
      .toLowerCase();
    if (!emailSchema.safeParse(email).success) invalidLines.push(row.line);
    else emails.push(email);
  }
  if (invalidLines.length)
    throw new InvitationCsvError("csvInvalidRows", {
      lines: invalidLines.slice(0, 5),
    });
  const unique = [...new Set(emails)];
  validateInvitationEmails(unique);
  return { emails: unique, duplicates: emails.length - unique.length };
}

export function memberCsv(rows: string[][]) {
  return (
    "\uFEFF" +
    rows
      .map((row) =>
        row
          .map((value) => {
            const safe = /^[\s]*[=+\-@]/.test(value) ? `'${value}` : value;
            return `"${safe.replaceAll('"', '""')}"`;
          })
          .join(","),
      )
      .join("\r\n")
  );
}
