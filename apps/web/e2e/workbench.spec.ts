import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   工作台那四页。

     待我审批 —— 现在等我点头的（不是全量台账）
     我的团队 —— 分组是权限的行维度，不是通讯录
     我的日程 —— 未来两周会不会撞车
     团队工作台 —— 我手上这几个中心，今天卡在哪
   ════════════════════════════════════════════════════════════════════ */

test.describe("待我审批", () => {
  test("经营层：列出别人填的，并说清审批不改金额", async ({ page }) => {
    await page.goto("/approvals?as=boss");
    await expect(page.getByTestId("approve-row").first()).toBeVisible();
    await expect(page.locator(".derive").first()).toContainText("不改变任何金额");
    /* 按钮写的是「我看过了」不是「通过」—— 它陈述一件已经发生的事 */
    await expect(page.getByTestId("approve-row").first()
      .getByRole("button", { name: "我看过了" })).toBeVisible();
  });

  test("自己填的不出现在表里，但要说出来", async ({ page }) => {
    await page.goto("/approvals?as=boss");
    await expect(page.getByTestId("own-entries")).toContainText("自审等于没有审批流");
    /* 凌远自己那条（ts-4，monitoring）不该在待审表里 */
    await expect(page.getByTestId("approve-row").filter({ hasText: "凌远" }))
      .toHaveCount(0);
  });

  test("审一条 → 它从这一页消失", async ({ page }) => {
    await page.goto("/approvals?as=boss");
    const rows = page.getByTestId("approve-row");
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();
    await rows.first().getByRole("button", { name: "我看过了" }).click();
    await expect(page.getByTestId("approve-said")).toContainText("已审");
    await expect(rows).toHaveCount(before - 1);
  });

  test("CRC 没有 approve 动作：一句话，不是一张空表", async ({ page }) => {
    await page.goto("/approvals");
    await expect(page.getByTestId("approve-forbidden")).toContainText("不归你审");
  });
});

test.describe("我的团队", () => {
  test("先说清分组是权限的行维度", async ({ page }) => {
    await page.goto("/team");
    /* 这句在页头，不在 .derive 里 —— 它是这一页的第一句话，
       而不是页尾的一段说明。 */
    await expect(page.locator(".page-head")).toContainText("权限的行维度");
    await expect(page.getByTestId("team-block").first()).toBeVisible();
  });

  test("自己那一组排最前且标出来", async ({ page }) => {
    await page.goto("/team");
    await expect(page.getByTestId("team-block").first()).toContainText("我在这一组");
  });

  test("不承接项目的组要说出后果", async ({ page }) => {
    await page.goto("/team");
    /* 职能组承接 0 个项目 —— 组里的 PM 一个中心都看不到 */
    await expect(page.getByTestId("no-study").first()).toContainText("一个中心都看不到");
  });
});

test.describe("我的日程", () => {
  test("按天铺开，撞车的那天标红并说明可以挪", async ({ page }) => {
    await page.goto("/sched");
    await expect(page.getByTestId("sched-day").first()).toBeVisible();
    /* 访视落在整个窗口里，所以连续几天都会出现同一条 —— 必然有满的那天 */
    await expect(page.getByTestId("crowded").first()).toContainText("可以往前后挪");
  });

  test("超窗的不在日程里，单独顶出来", async ({ page }) => {
    await page.goto("/sched");
    await expect(page.getByTestId("sched-late")).toContainText("过去没有可排的日子");
  });

  test("换跨度会换掉天数", async ({ page }) => {
    await page.goto("/sched");
    await expect(page.getByTestId("sched-day")).toHaveCount(14);
    await page.getByTestId("span-7").click();
    await expect(page.getByTestId("sched-day")).toHaveCount(7);
  });
});

test.describe("团队工作台", () => {
  test("按中心排，有事的在前，每条问题都指得出去处", async ({ page }) => {
    await page.goto("/pm?as=boss");
    await expect(page.getByTestId("pm-site").first()).toBeVisible();
    const first = page.getByTestId("pm-site").first();
    await expect(first.getByTestId("pm-trouble").first()).toBeVisible();
    await expect(first.getByTestId("pm-trouble").first().getByRole("link")).toBeVisible();
  });

  test("说清它看到什么由行范围决定", async ({ page }) => {
    await page.goto("/pm?as=boss");
    await expect(page.locator(".derive").last()).toContainText("行范围");
    await expect(page.getByTestId("pm-summary")).toContainText("个中心在你的范围里");
  });
});

/* 日历（W15）：「列表」按天往下排，「月」一格一天；监查员本人的监查访视也铺上去。 */
test.describe("我的日程 · 月", () => {
  test("切到月：一格一天；点一天，下面是那一天的明细", async ({ page }) => {
    await page.goto("/sched");
    await page.getByTestId("view-month").click();
    const grid = page.getByTestId("month-grid");
    await expect(grid).toBeVisible();
    const cells = grid.getByTestId("month-day");
    expect(await cells.count()).toBeGreaterThanOrEqual(28);
    await cells.last().click();
    await expect(page.getByTestId("month-picked").getByTestId("sched-day")).toBeVisible();
    /* 翻到下个月再翻回来，月份标签跟着变 */
    const label = await page.getByTestId("month-label").textContent();
    await page.getByTestId("month-next").click();
    await expect(page.getByTestId("month-label")).not.toHaveText(label!);
  });

  test("CRA：自己的监查访视在日程上；点一个将来的日子可以直接排一趟，计划日就是那一天", async ({ page }) => {
    await page.goto("/sched?as=cra");
    await expect(page.getByTestId("sched-summary")).toContainText("监查访视");
    await page.getByTestId("view-month").click();
    await page.getByTestId("month-next").click();
    const day = page.getByTestId("month-day").nth(10);
    const date = await day.getAttribute("data-date");
    await day.click();
    await page.getByTestId("plan-visit").click();
    await expect(page.getByTestId("pv-date")).toHaveValue(date!);
  });

  test("CRC 没有监查动作：月历上点一天，没有「排一次监查」", async ({ page }) => {
    await page.goto("/sched");
    await page.getByTestId("view-month").click();
    await page.getByTestId("month-next").click();
    await page.getByTestId("month-day").nth(10).click();
    await expect(page.getByTestId("month-picked")).toBeVisible();
    await expect(page.getByTestId("plan-visit")).toHaveCount(0);
  });

  test("390px：月历不把页面顶出去", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/sched");
    await page.getByTestId("view-month").click();
    await expect(page.getByTestId("month-grid")).toBeVisible();
    const { scroll, client } = await page.evaluate(() =>
      ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(scroll).toBeLessThanOrEqual(client);
  });
});
