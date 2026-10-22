import { randomUUID } from "node:crypto";
import { test, expect, register, app } from "./fixtures";

test("中文姓名不参与头像，账号图片优先，加载失败回退邮箱首字母", async ({ page }) => {
  const email = `alex-${randomUUID()}@example.com`;
  await register(page, "/settings/members", email);
  const label = `${email} 的头像`;
  const memberAvatar = page.getByRole("img", { name: label, exact: true });
  await expect(memberAvatar).toHaveText("A");
  await page.getByRole("button", { name: "邀请成员", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "邀请成员", exact: true });
  await expect(dialog.getByRole("img", { name: label, exact: true })).toHaveText("A");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();

  const image = "https://avatars.githubusercontent.com/avatar-regression.png";
  await page.route(image, route => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="blue"/></svg>',
  }));
  const response = await page.request.post(app("/api/auth/update-user"), {
    headers: { Origin: new URL(page.url()).origin },
    data: { image },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  await page.reload();
  await expect(memberAvatar.locator("img")).toHaveAttribute("src", image);
  await expect(memberAvatar.locator("img")).toBeVisible();
  await page.getByRole("button", { name: "邀请成员", exact: true }).click();
  await expect(dialog.getByRole("img", { name: label, exact: true }).locator("img")).toBeVisible();
  await dialog.getByRole("button", { name: "取消", exact: true }).click();

  await page.getByRole("link", { name: "返回工作台", exact: true }).click();
  const menu = page.getByRole("button", { name: "账户菜单", exact: true });
  await expect(menu.getByRole("img", { name: label, exact: true }).locator("img")).toBeVisible();

  await page.unroute(image);
  await page.route(image, route => route.fulfill({ contentType: "image/png", body: "invalid-image" }));
  await page.reload();
  await expect(menu.getByRole("img", { name: label, exact: true })).toHaveText("A");
  await menu.click();
  await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  await page.getByRole("link", { name: "邀请成员", exact: true }).click();
  await expect(dialog.getByRole("img", { name: label, exact: true })).toHaveText("A");
});
