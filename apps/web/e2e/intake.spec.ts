import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   立项与建档。

   这一组盯的是**这条流程最容易漏的几格**：
     · 提交人自己批自己 —— 门槛只是多点一次鼠标；
     · 批准了但项目档案没建 —— 批的人以为建了，做的人以为会自动建；
     · 退回不说理由 —— 提交人只能猜；
     · 只给毛利率不给保本合同额 —— 谈判桌上用不上。
   ════════════════════════════════════════════════════════════════════ */

test.describe("立项申请", () => {
  test("先说清「在立项时就算账」", async ({ page }) => {
    await page.goto("/intake?as=boss");
    await expect(page.locator(".derive").first()).toContainText("不等做完才知道亏");
    await expect(page.locator(".derive").first()).toContainText("那是决定");
  });

  test("**越线的排最前，并标出低于门槛**", async ({ page }) => {
    await page.goto("/intake?as=boss");
    const first = page.getByTestId("intake-row").first();
    await expect(first).toContainText("KY-207");
    await expect(first.getByTestId("intake-gm")).toContainText("低于门槛");
  });

  test("**保本合同额比毛利率更能推动谈判**", async ({ page }) => {
    await page.goto("/intake?as=boss");
    const note = page.getByTestId("intake-gate-note").first();
    await expect(note).toContainText("谈判桌上用得上的不是这个百分比");
    await expect(note).toContainText("对方能拿这个数回去算");
    /* 保本合同额确实比合同额大：604.2 万成本按 25% 门槛要 805.6 万，
       而合同只谈到 760 万 —— 差的那 45.6 万就是谈判要往回要的数。 */
    await expect(page.getByTestId("intake-breakeven").first())
      .toContainText("8,056,000");
    await expect(page.getByTestId("intake-row").first()).toContainText("7,600,000");
  });

  test("达标的那条不挂门槛提示", async ({ page }) => {
    await page.goto("/intake?as=boss");
    const ok = page.getByTestId("intake-row").filter({ hasText: "恒安宁" });
    await expect(ok.getByTestId("intake-gm")).not.toContainText("低于门槛");
    await expect(ok.getByTestId("intake-gate-note")).toHaveCount(0);
  });

  test("**外部方一条都看不到** —— 看得到毛利率，下一轮就不用谈了", async ({ page }) => {
    await page.goto("/intake?as=inst");
    await expect(page.getByTestId("intake-empty")).toBeVisible();
    await expect(page.getByTestId("intake-row")).toHaveCount(0);
  });

  test("CRC 看得到项目、看不到账，也批不了", async ({ page }) => {
    await page.goto("/intake");
    await expect(page.getByTestId("intake-row").first()).toBeVisible();
    await expect(page.getByTestId("intake-gm")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "批准立项" })).toHaveCount(0);
  });
});

test.describe("审批", () => {
  test("**提交人不能批准自己的申请** —— 而且按钮压根不给", async ({ page }) => {
    /* ── 这条测试原来钉的是坏行为 ────────────────────────────────
       上一版是：点「批准立项」→ 填确认 → 断言弹出「不能自己批自己」。
       也就是说它**要求那个按钮在**，而那正是现场报来的问题：

         「超级管理员和经营层都可以自己批自己的项目」

       服务端一直拦着（422 `intake-self-approval`），坏的是界面 ——
       这一页只看 `approve` 动作，于是两样动作都有的人在自己的申请上
       照样看得到按钮。**一个能点、点了必错的按钮，比没有按钮糟得多**：
       他看到按钮在那儿，就以为这条规矩不存在。

       所以断言翻面：按钮不该在，而该在的是一句说得清的话。 */
    await page.goto("/intake?as=pm");      // 韩雪提交的那两条
    const row = page.getByTestId("intake-row").first();
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: "批准立项" })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "退回重谈" })).toHaveCount(0);
    /* 一句"没有权限"会让人去要权限，而他要多少权限都批不了自己这一条。 */
    await expect(row.getByText("是你自己提交的")).toBeVisible();
    await expect(row.getByText("要两个人")).toBeVisible();
  });

  test("**退回必须写理由，短了点不动**", async ({ page }) => {
    await page.goto("/intake?as=boss");
    await page.getByTestId("intake-row").first()
      .getByRole("button", { name: "退回重谈" }).click();
    await expect(page.getByTestId("intake-form")).toContainText("退回必须写理由");
    await expect(page.getByTestId("intake-submit")).toBeDisabled();
    await page.getByTestId("intake-reason").fill("价高");
    await expect(page.getByTestId("intake-submit")).toBeDisabled();
    await page.getByTestId("intake-reason")
      .fill("毛利率低于门槛，需重谈价格或把 CRC 驻场 FTE 压到 0.4");
    await expect(page.getByTestId("intake-submit")).toBeEnabled();
    await page.getByTestId("intake-submit").click();
    await expect(page.getByTestId("intake-said")).toContainText("已退回 韩雪");
    await expect(page.getByTestId("intake-row").first()
      .getByTestId("intake-decided")).toContainText("重谈价格");
  });

  test("**批准会同时建出项目档案，而且它一个中心都还没建**", async ({ page }) => {
    await page.goto("/intake?as=boss");
    const rows = page.getByTestId("filing-row");
    await expect(rows).toHaveCount(2);

    await page.getByTestId("intake-row").filter({ hasText: "恒安宁" })
      .getByRole("button", { name: "批准立项" }).click();
    await expect(page.getByTestId("intake-form"))
      .toContainText("不存在「批准了但档案没建」这一格");
    await page.getByTestId("intake-submit").click();
    await expect(page.getByTestId("intake-said")).toContainText("一个都还没建档");

    /* 新项目进了下面那张表，而且顶在最前（差得最多） */
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText("恒安宁");
    await expect(rows.first().getByTestId("filing-gap")).toContainText("差 16 个");
  });
});

test.describe("建档滞后", () => {
  test("**合同写了 14 个中心、系统里只有 2 个**", async ({ page }) => {
    await page.goto("/intake?as=boss");
    const row = page.getByTestId("filing-row").filter({ hasText: "HJ-2024-017" });
    await expect(row.getByTestId("filing-gap")).toContainText("差 12 个");
  });

  test("建齐了的不挂角标", async ({ page }) => {
    await page.goto("/intake?as=boss");
    const row = page.getByTestId("filing-row").filter({ hasText: "HJ-2025-003" });
    await expect(row.getByTestId("filing-gap")).toHaveCount(0);
  });

  test("说清那几个中心的成本已经在发生", async ({ page }) => {
    await page.goto("/intake?as=boss");
    await expect(page.getByTestId("filing-note")).toContainText("成本已经在发生");
    await expect(page.getByTestId("filing-note")).toContainText("成本是手填的");
  });
});
