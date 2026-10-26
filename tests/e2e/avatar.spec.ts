import { randomUUID } from "node:crypto";
import { test, expect, register, app } from "./fixtures";

test("新注册账号得到默认渐变头像，账号图片优先，没有图片的老账号与加载失败回退邮箱首字母（中文姓名不参与）", async ({ page }) => {
  const email = `alex-${randomUUID()}@example.com`;
  await register(page, "/settings/members", email);
  const label = `${email} 的头像`;
  const memberAvatar = page.getByRole("table").getByRole("row").filter({ hasText: email }).getByRole("img", { name: label, exact: true });
  // A new account without a picture gets a default avatar at sign-up, the same one wherever it appears.
  const defaultAvatar = /\/avatars\/(blue|green|purple|orange|red)\.webp$/;
  await expect(memberAvatar.locator("img")).toHaveAttribute("src", defaultAvatar);
  await expect(memberAvatar.locator("img")).toBeVisible();
  const defaultSrc = await memberAvatar.locator("img").getAttribute("src");
  await page.getByRole("button", { name: "邀请成员", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "邀请成员", exact: true });
  await expect(dialog.getByRole("img", { name: label, exact: true }).locator("img")).toHaveAttribute("src", defaultSrc!);
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

  await page.unroute(image);
  await page.route(image, route => route.fulfill({ contentType: "image/png", body: "invalid-image" }));
  await page.reload();
  await expect(memberAvatar).toHaveText("A");
  await page.getByRole("button", { name: "邀请成员", exact: true }).click();
  await expect(dialog.getByRole("img", { name: label, exact: true })).toHaveText("A");
  await dialog.getByRole("button", { name: "取消", exact: true }).click();

  // An account with no image (as every account made before default avatars) keeps its initial.
  const cleared = await page.request.post(app("/api/auth/update-user"), {
    headers: { Origin: new URL(page.url()).origin },
    data: { image: null },
  });
  expect(cleared.ok(), await cleared.text()).toBeTruthy();
  await page.reload();
  await expect(memberAvatar).toHaveText("A");
  await expect(memberAvatar.locator("img")).toHaveCount(0);
});
