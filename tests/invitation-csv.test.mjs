import assert from "node:assert/strict";
import { test } from "node:test";
import {
  invitationEmails,
  memberCsv,
  parseInvitationCsv,
  validateInvitationEmails,
} from "../lib/invitation-csv.ts";

test("识别 BOM、中文表头、CRLF，并规范化和去重邮箱", () => {
  assert.deepEqual(
    parseInvitationCsv(
      "\uFEFF姓名,邮箱\r\n甲,Alice@example.com\r\n乙,alice@example.com\r\n丙,bob@example.com\r\n",
    ),
    { emails: ["alice@example.com", "bob@example.com"], duplicates: 1 },
  );
});
test("支持带逗号、换行和转义引号的其他列", () => {
  assert.deepEqual(
    parseInvitationCsv(
      'name,email\n"Doe, Jane",jane@example.com\n"A ""quoted""\nname",second@example.com',
    ).emails,
    ["jane@example.com", "second@example.com"],
  );
});
test("支持单列无表头以及分号、制表符格式", () => {
  assert.deepEqual(parseInvitationCsv("a@example.com\nb@example.com").emails, [
    "a@example.com",
    "b@example.com",
  ]);
  assert.deepEqual(parseInvitationCsv("name;email\nA;a@example.com").emails, [
    "a@example.com",
  ]);
  assert.deepEqual(parseInvitationCsv("name\temail\nA\ta@example.com").emails, [
    "a@example.com",
  ]);
});
test("拒绝空文件、只有表头以及缺少邮箱列的多列文件", () => {
  for (const text of ["", "email\n", "name,address\nA,a@example.com"])
    assert.throws(() => parseInvitationCsv(text));
});
test("指出无效邮箱行且不部分导入", () => {
  assert.throws(
    () => parseInvitationCsv("name,email\nA,a@example.com\nB,wrong\nC,"),
    /第 3、4 行/,
  );
});
test("拒绝未闭合和不合法引号", () => {
  for (const text of [
    'email\n"a@example.com',
    'email\n"a@example.com"bad',
    'email\na"@example.com',
  ])
    assert.throws(() => parseInvitationCsv(text), /引号/);
});
test("按去重后的数量校验批量上限，手动输入同样校验", () => {
  const list = Array.from(
    { length: 21 },
    (_, index) => `person${index}@example.com`,
  );
  assert.throws(
    () => parseInvitationCsv(list.join("\n")),
    /一次最多邀请 20 人/,
  );
  assert.equal(
    parseInvitationCsv([...list.slice(0, 20), list[0]].join("\n")).emails
      .length,
    20,
  );
  assert.throws(() => validateInvitationEmails(["invalid"]), /邮箱格式/);
  assert.throws(() => validateInvitationEmails([]), /至少/);
  assert.deepEqual(
    invitationEmails("A@example.com，a@example.com; b@example.com\n"),
    ["a@example.com", "b@example.com"],
  );
});
test("CSV 导出保留中文并转义引号和公式注入", () => {
  assert.equal(
    memberCsv([
      ["姓名", "邮箱"],
      ["=1+1", "a@example.com"],
      ['甲"乙', "@formula"],
    ]),
    '\uFEFF"姓名","邮箱"\r\n"\'=1+1","a@example.com"\r\n"甲""乙","\'@formula"',
  );
});
