import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   监查访视。

   这一组盯的是**四个日期为什么不能压成一个状态**：
     · 排了没确认 —— 中心那边不知道我们要去；
     · 确认了没去 —— 计划日过了人还在办公室；
     · 去了没交报告 —— 最常见的欠账，原型里连一个状态都没有；
     · 跟进项没关就交报告 —— 报告和台账互相打脸。
   外加一条原型只写在公式框里、没有算过的：**该多久去一次。**
   ════════════════════════════════════════════════════════════════════ */

test.describe("排期与欠账", () => {
  test("先说清「去过了」和「报告交了」是两件事", async ({ page }) => {
    await page.goto("/monitoring?as=cra");
    await expect(page.locator(".derive").first()).toContainText("是两件事");
    await expect(page.locator(".derive").first()).toContainText("核查时看的是报告日期");
  });

  test("**两种欠账分开标** —— 计划日已过 vs 报告压着", async ({ page }) => {
    await page.goto("/monitoring?as=cra");
    await expect(page.getByTestId("mon-row").first()).toBeVisible();
    /* SS-07 那次确认过、计划日过了人还没去 */
    await expect(page.getByTestId("mon-visit-overdue").first()).toBeVisible();
    /* SS-01 那次去过了，报告压了 21 天 */
    await expect(page.getByTestId("mon-mvr-overdue").first()).toContainText("报告压了");
  });

  test("**平均报告滞后把没交的也算进去** —— 这句话要写在页面上", async ({ page }) => {
    await page.goto("/monitoring?as=cra");
    await expect(page.getByTestId("mon-lag-note")).toContainText("永远不进分母");
    await expect(page.getByTestId("mon-lag-note")).toContainText("压得越久这个数越好看");
  });

  test("**差旅估算受 cost 列权限管辖** —— CRA 排自己的班，看不到它值多少钱",
    async ({ page }) => {
      await page.goto("/monitoring?as=cra");
      await expect(page.getByTestId("mon-summary")).toBeVisible();
      await expect(page.getByTestId("mon-summary")).not.toContainText("预估差旅");
      await page.goto("/monitoring?as=boss");
      await expect(page.getByTestId("mon-summary")).toContainText("预估差旅");
    });

  test("外部方一条都看不到 —— 监查策略不能交给被监查的一方", async ({ page }) => {
    await page.goto("/monitoring?as=inst");
    await expect(page.getByTestId("mon-empty")).toBeVisible();
    await expect(page.getByTestId("mon-row")).toHaveCount(0);
  });
});

test.describe("四步各拦各的", () => {
  test("待确认那条只给「与中心确认」，不给「到现场」", async ({ page }) => {
    await page.goto("/monitoring?as=cra");
    await page.getByTestId("mon-row").filter({ hasText: "待确认" }).click();
    await expect(page.getByTestId("mon-confirm")).toBeVisible();
    await expect(page.getByTestId("mon-perform")).toHaveCount(0);
    await expect(page.getByTestId("mon-report")).toHaveCount(0);
  });

  test("确认之后按钮换成「登记已到现场」", async ({ page }) => {
    await page.goto("/monitoring?as=cra");
    await page.getByTestId("mon-row").filter({ hasText: "待确认" }).click();
    await page.getByTestId("mon-confirm").click();
    await expect(page.getByTestId("mon-said")).toContainText("已与");
    await expect(page.getByTestId("mon-perform")).toBeVisible();
  });

  test("**跟进项没关就交报告：拦下来，并说出拦在哪一项**", async ({ page }) => {
    await page.goto("/monitoring?as=cra");
    /* SS-01 那条已到现场、还剩两项没关 */
    await page.getByTestId("mon-row").filter({ hasText: "已到现场" }).click();
    await page.getByTestId("mon-report").click();
    await expect(page.getByTestId("mon-problem")).toContainText("跟进项未关闭");
    await expect(page.getByTestId("mon-problem")).toContainText("研究者文件夹");
  });

  test("**跟进项全关了才交得上，交完就冻结**", async ({ page }) => {
    await page.goto("/monitoring?as=cra");
    await page.getByTestId("mon-row").filter({ hasText: "已到现场" }).click();
    const boxes = page.getByTestId("mon-item").locator("input[type=checkbox]");
    const n = await boxes.count();
    for (let i = 0; i < n; i++) {
      const b = boxes.nth(i);
      if (await b.isChecked()) continue;
      /* **不能用 check()**：勾一下要走一趟接口再重取，
         而 check() 点完立刻断言状态已变 —— 它看到的是回包之前的那一帧。
         click() + 会重试的 toBeChecked() 才等得到那一趟往返。
         （同一个形状在 onsite.spec 上踩过：count() 读的是渲染前的 DOM。） */
      await b.click();
      await expect(b).toBeChecked();
    }
    await page.getByTestId("mon-report").click();
    await expect(page.getByTestId("mon-said")).toContainText("距现场");
    await expect(page.getByTestId("mon-frozen")).toContainText("跟进项已冻结");
    /* 冻结之后勾选框点不动 —— 界面上就没有那条路 */
    await expect(boxes.first()).toBeDisabled();
  });

  test("经营层只读：跟进项看得到，按钮一个不给", async ({ page }) => {
    await page.goto("/monitoring?as=boss");
    await expect(page.getByTestId("mon-item").first()).toBeVisible();
    await expect(page.getByTestId("mon-readonly")).toContainText("monitor");
    await expect(page.getByTestId("mon-confirm")).toHaveCount(0);
    await expect(page.getByTestId("mon-report")).toHaveCount(0);
  });
});

test.describe("该多久去一次", () => {
  test("**建议间隔与抽样比例一定带理由**", async ({ page }) => {
    await page.goto("/monitoring?as=cra");
    const rows = page.getByTestId("mon-site-row");
    await expect(rows.first()).toBeVisible();
    const n = await rows.count();
    for (let i = 0; i < n; i++)
      await expect(rows.nth(i).getByTestId("mon-reasons")).not.toBeEmpty();
  });

  test("**一次都没去过的单说一句，不是「0 天前」**", async ({ page }) => {
    await page.goto("/monitoring?as=cra");
    /* SS-14 停在合同签署，一次监查都没有 */
    const row = page.getByTestId("mon-site-row").filter({ hasText: "SS-14" });
    await expect(row.getByTestId("mon-never")).toContainText("一次都没去过");
  });

  test("逾期未监查的排在最前并标红", async ({ page }) => {
    await page.goto("/monitoring?as=cra");
    await expect(page.getByTestId("mon-site-row").first()).toBeVisible();
    const overdue = page.getByTestId("mon-overdue");
    await expect(overdue.first()).toContainText("逾期");
    /* 第一行就是逾期最久的那个 */
    await expect(page.getByTestId("mon-site-row").first()
      .getByTestId("mon-overdue")).toBeVisible();
  });

  test("说清不采纳建议是可以的，但要留得下来", async ({ page }) => {
    await page.goto("/monitoring?as=cra");
    await expect(page.locator(".derive").last()).toContainText("不采纳这件事本身要留得下来");
  });
});
