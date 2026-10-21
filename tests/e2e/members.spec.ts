import { randomUUID } from "node:crypto";
import { test, expect, register, watchRuntime, browserClientHeaders } from "./fixtures";

test("成员导航、邀请取消、角色选择、创建和撤销邀请、管理员保护", async ({
  page,
}) => {
  await register(page);
  await page.getByRole("link", { name: "邀请成员", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "邀请成员", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole("button", { name: "邀请成员", exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("邮箱地址", { exact: true }).fill("不是邮箱");
  await dialog
    .getByRole("button", { name: "创建邀请链接", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  const email = `invited-${randomUUID()}@example.com`;
  await dialog.getByLabel("邮箱地址", { exact: true }).fill(email);
  await dialog
    .getByRole("combobox", { name: "工作区角色", exact: true })
    .click();
  await page.getByRole("option", { name: "管理员", exact: true }).click();
  await dialog
    .getByRole("button", { name: "创建邀请链接", exact: true })
    .click();
  const inviteLink = await dialog
    .getByLabel(`${email} 的邀请链接`, { exact: true })
    .inputValue();
  expect(new URL(inviteLink).pathname).toMatch(/^\/invite\/[a-f0-9]{64}$/);
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const invitation = page.getByRole("row").filter({ hasText: email });
  await expect(invitation).toContainText("管理员");
  await invitation
    .getByRole("button", { name: "撤销邀请", exact: true })
    .click();
  await expect(invitation).not.toBeVisible();
  await expect(page.getByRole("status")).toHaveText(
    "邀请已撤销，原链接已失效。",
  );
  await page
    .getByRole("combobox", { name: "成员状态筛选", exact: true })
    .click();
  await page.getByRole("option", { name: "启用中", exact: true }).click();
  await page
    .getByRole("button", { name: "管理 回归测试成员", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "设为成员", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await confirmation
    .getByRole("button", { name: "确认更新", exact: true })
    .click();
  await expect(confirmation.getByRole("alert")).toContainText("管理员");
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await page.getByRole("link", { name: "返回工作台", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "项目", exact: true }),
  ).toBeVisible();
});

test("CSV 拖拽去重、导入错误保护、批量邀请和导出", async ({ page }) => {
  await register(page, "/settings/members");
  await page.getByRole("button", { name: "邀请成员", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "邀请成员", exact: true });
  const first = `csv-${randomUUID()}@example.com`;
  const second = `csv-${randomUUID()}@example.com`;
  const transfer = await page.evaluateHandle(
    ({ first, second }) => {
      const data = new DataTransfer();
      data.items.add(
        new File(
          [
            `name,email\r\n"Doe, Jane",${first.toUpperCase()}\r\nJane,${first}\r\nAlex,${second}`,
          ],
          "members.csv",
          { type: "text/csv" },
        ),
      );
      return data;
    },
    { first, second },
  );
  await dialog
    .getByTestId("invite-csv-dropzone")
    .dispatchEvent("drop", { dataTransfer: transfer });
  await transfer.dispose();
  await expect(dialog.getByRole("status")).toContainText("已去重 1 个");
  await expect(dialog.getByLabel("邮箱地址", { exact: true })).toHaveValue(
    `${first}\n${second}`,
  );
  await dialog
    .getByLabel("上传 CSV 文件", { exact: true })
    .setInputFiles({
      name: "bad.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("email\nnot-an-email"),
    });
  await expect(dialog.getByRole("alert")).toContainText("第 2 行");
  await expect(dialog.getByLabel("邮箱地址", { exact: true })).toHaveValue(
    `${first}\n${second}`,
  );
  await dialog
    .getByRole("button", { name: "创建邀请链接", exact: true })
    .click();
  await expect(
    dialog.getByText("已创建 2 个邀请链接", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByLabel(`${first} 的邀请链接`, { exact: true }),
  ).toHaveValue(/\/invite\/[a-f0-9]{64}$/);
  await expect(
    dialog.getByLabel(`${second} 的邀请链接`, { exact: true }),
  ).toHaveValue(/\/invite\/[a-f0-9]{64}$/);
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: first })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: second })).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出 CSV", exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe("members.csv");
  const stream = await download.createReadStream();
  if (!stream) throw new Error("CSV 导出没有文件内容");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString("utf8")).toContain(first);
  await page.getByRole("button", { name: "邀请成员", exact: true }).click();
  await expect(dialog.getByLabel("邮箱地址", { exact: true })).toBeEmpty();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
});

test("受邀邮箱加入后，管理员可停用并恢复成员", async ({
  page,
  browser,
  baseURL,
}) => {
  await register(page, "/settings/members");
  await page.getByRole("button", { name: "邀请成员", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "邀请成员", exact: true });
  const email = `member-${randomUUID()}@example.com`;
  await dialog.getByLabel("邮箱地址", { exact: true }).fill(email);
  await dialog
    .getByRole("button", { name: "创建邀请链接", exact: true })
    .click();
  const inviteURL = new URL(
    await dialog
      .getByLabel(`${email} 的邀请链接`, { exact: true })
      .inputValue(),
  );
  await dialog.getByRole("button", { name: "完成", exact: true }).click();
  const memberContext = await browser.newContext({ baseURL, extraHTTPHeaders: browserClientHeaders() });
  const errors = watchRuntime(memberContext);
  try {
    const memberPage = await memberContext.newPage();
    await register(memberPage, inviteURL.pathname, email);
    await memberPage
      .getByRole("button", { name: "接受邀请并加入", exact: true })
      .click();
    await expect(memberPage).toHaveURL(/\/settings\/members\?workspace=/);
    await expect(
      memberPage.getByRole("button", { name: "邀请成员", exact: true }),
    ).toBeDisabled();
    await expect(
      memberPage.getByRole("button", { name: /^管理 / }),
    ).toHaveCount(0);
    await page.reload();
    await page
      .getByRole("combobox", { name: "成员状态筛选", exact: true })
      .click();
    await page.getByRole("option", { name: "启用中", exact: true }).click();
    const member = page.getByRole("row").filter({ hasText: email });
    await member
      .getByRole("button", { name: "管理 回归测试成员", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "停用成员", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "确认更新", exact: true })
      .click();
    await expect(member).not.toBeVisible();
    await page
      .getByRole("combobox", { name: "成员状态筛选", exact: true })
      .click();
    await page.getByRole("option", { name: "已停用", exact: true }).click();
    await expect(member).toBeVisible();
    await member
      .getByRole("button", { name: "管理 回归测试成员", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "恢复成员", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "确认更新", exact: true })
      .click();
    await expect(member).not.toBeVisible();
    await page
      .getByRole("combobox", { name: "成员状态筛选", exact: true })
      .click();
    await page.getByRole("option", { name: "启用中", exact: true }).click();
    await expect(member).toBeVisible();
  } finally {
    await memberContext.close();
    expect(errors, "受邀成员页面不得有运行异常").toEqual([]);
  }
});
