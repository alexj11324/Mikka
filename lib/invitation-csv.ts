import { z } from "zod";

export const MAX_INVITATION_EMAILS = 20;
export const MAX_INVITATION_CSV_BYTES = 1024 * 1024;
const emailSchema = z.email().max(254);
const emailHeaders = new Set([
  "email",
  "e-mail",
  "email address",
  "邮箱",
  "邮箱地址",
  "电子邮箱",
  "电子邮件",
]);

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
  if (!emails.length) throw new Error("请至少填写一个邮箱地址。");
  if (emails.length > MAX_INVITATION_EMAILS)
    throw new Error(
      `一次最多邀请 ${MAX_INVITATION_EMAILS} 人；当前有 ${emails.length} 个邮箱，请分批导入。`,
    );
  const invalid = emails.filter(
    (email) => !emailSchema.safeParse(email).success,
  );
  if (invalid.length)
    throw new Error(
      `邮箱格式不正确：${invalid.slice(0, 3).join("、")}${invalid.length > 3 ? "等" : ""}。请修正后再邀请。`,
    );
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
        throw new Error(`CSV 第 ${line} 行的引号格式不正确。`);
      if (!closed) cell += char;
    }
  }
  if (quoted) throw new Error("CSV 中有未闭合的引号，请检查文件格式。");
  finishRow();
  if (!rows.length) throw new Error("CSV 文件为空，请添加邮箱后重试。");
  const headerIndex = rows[0].cells.findIndex((value) =>
    emailHeaders.has(value.toLowerCase()),
  );
  if (headerIndex < 0 && rows.some((row) => row.cells.length !== 1))
    throw new Error("多列 CSV 需要包含 email 或「邮箱」表头。");
  const records = headerIndex < 0 ? rows : rows.slice(1);
  if (!records.length) throw new Error("CSV 只有表头，没有可邀请的邮箱。");
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
    throw new Error(
      `CSV 第 ${invalidLines.slice(0, 5).join("、")} 行邮箱为空或格式不正确${invalidLines.length > 5 ? "等" : ""}。未导入任何邮箱，请修正后重试。`,
    );
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
