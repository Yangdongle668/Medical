import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   一次性链接登录 —— 生产环境唯一的入口。

   ── 为什么必须有这一组 ──────────────────────────────────────────────
   在此之前，登录页**只认自己刚要来的那个令牌**（开发环境回显的那个）。
   真正从邮件里点进来的人，落在 `/login?token=…` 上看到的是一张空白表单，
   什么也不会发生 —— 而开发环境永远正常，因为开发环境根本不走链接。

   一键部署之后没有开发登录，这条路径就是唯一的入口。所以它必须有测试。

   这里用 `magic-link` 的开发回显只是为了**拿到**令牌；
   生产环境里同一个令牌由运维用 `deploy/login-link.sh` 签发、或由邮件通道发出。
   被测的那一段（页面读 URL → 兑换 → 落到今日）两边完全一样。
   ════════════════════════════════════════════════════════════════════ */

test.describe("从链接进来", () => {
  test("点开链接直接登进去，且令牌不留在地址栏里", async ({ page, request }) => {
    const r = await request.post("/v1/auth/magic-link", { data: { login: "wutong" } });
    expect(r.status()).toBe(202);
    const token = (await r.json()).devToken as string;
    expect(token, "开发回显应当给出令牌（后端需 SITEDESK_DEV_LOGIN=1）").toBeTruthy();

    await page.goto(`/login?token=${token}`);
    await expect(page).toHaveURL(/\/today$/);

    /* 令牌虽然一次性，留在地址栏与浏览历史里也没有任何好处
       （还会随 Referer 外泄）。兑换后 replace 掉那条记录。 */
    expect(page.url()).not.toContain("token=");
    await page.goBack();
    expect(page.url()).not.toContain("token=");
  });

  test("同一条链接点第二次：明确说已被使用，不是白屏", async ({ page, request }) => {
    const r = await request.post("/v1/auth/magic-link", { data: { login: "linmin" } });
    const token = (await r.json()).devToken as string;

    await page.goto(`/login?token=${token}`);
    await expect(page).toHaveURL(/\/today$/);

    /* 换一个干净的会话再点一次同一条链接 —— 令牌在库里原子消费，只能成一次。 */
    await page.context().clearCookies();
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(`/login?token=${token}`);
    await expect(page.getByTestId("login-error")).toContainText("已被使用");
  });

  test("坏令牌：停在登录页，并把它从 URL 上摘掉", async ({ page }) => {
    /* 不摘掉的话，用户一刷新就再撞一次同一个死令牌，
       看到的还是同一句"已过期"，会以为是系统坏了。 */
    await page.goto("/login?token=" + "x".repeat(43));
    await expect(page.getByTestId("login-error")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId("login-input")).toBeVisible();
  });
});
