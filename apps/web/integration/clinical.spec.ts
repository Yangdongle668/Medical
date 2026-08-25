import { test, expect, type Page } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   ClinicalOps 的第一个完整纵切：DB → API → Backend → Frontend → 集成。

   这里**不打 mock**。同一条业务流在 Phase 5 已经在 MSW 上走通了，
   现在换成真库真接口 —— 差别就是这一阶段全部的价值所在：
   契约两侧真的对得上吗？字段名、分页游标、空数组与 null、
   列权限删字段之后前端还画得出来吗？

   这些在 mock 上永远不会暴露，因为 mock 是照着同一份契约写的。
   ════════════════════════════════════════════════════════════════════ */

/** 列表是异步取的：goto 之后立刻读 allInnerTexts() 会拿到空数组 ——
 *  而空数组会让断言以「行范围把人挡光了」的样子失败，指向完全错的方向。
 *  先等第一行出现，再读。 */
async function rowCodes(page: Page): Promise<string[]> {
  await expect(page.locator("tbody tr").first()).toBeVisible();
  return page.locator("tbody tr td:first-child").allInnerTexts();
}

async function loginAs(page: Page, testid: string) {
  await page.goto("/login");
  /* <details> 要点 <summary> 才会展开 —— 点 role=group（也就是 details 本身）
     不会切换它，于是里面的按钮一直不可见。 */
  await page.locator("details summary").click();
  await page.getByTestId(testid).click();
  await expect(page).toHaveURL(/\/today$/);
}

test.describe("认证", () => {
  test("未登录访问业务页会被送到登录页", async ({ page }) => {
    await page.goto("/today");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("一次性链接：申请 → 兑换 → 进入系统", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("login-input").fill("wutong");
    await page.getByTestId("request-link").click();

    /* 关键：**存在与不存在的账号返回同样的话** —— 这个接口不是账号枚举器 */
    await expect(page.getByTestId("link-sent")).toContainText("若该账号存在");

    await page.getByTestId("redeem").click();
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByTestId("who")).toContainText("吴桐");
  });

  test("不存在的账号也是同样的 202，看不出差别", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("login-input").fill("zhangsan-not-exist");
    await page.getByTestId("request-link").click();
    await expect(page.getByTestId("link-sent")).toContainText("若该账号存在");
    /* 而且不会给出可兑换的令牌 */
    await expect(page.getByTestId("redeem")).toHaveCount(0);
  });

  test("登出后回到登录页，且原令牌立刻失效", async ({ page }) => {
    await loginAs(page, "dev-wutong");
    await page.getByTestId("logout").click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto("/today");
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("行范围：同一个界面，不同的人看到不同的行", () => {
  test("CRC 只看得到被指派的中心", async ({ page }) => {
    await loginAs(page, "dev-wutong");
    await page.goto("/sites");
    const codes = await rowCodes(page);
    expect(codes.length).toBeGreaterThan(0);
    expect(codes.length).toBeLessThan(15);        // 全量是 15 个中心
    await expect(page.getByTestId("scope")).toContainText("中心");
  });

  test("经营层看得到全部 15 个", async ({ page }) => {
    await loginAs(page, "dev-lingyuan");
    await page.goto("/sites");
    const codes = await rowCodes(page);
    expect(codes.length).toBe(15);
  });
});

test.describe("列范围：同一个接口，有权限的多一列", () => {
  test("CRA 看不到单价那一列", async ({ page }) => {
    await loginAs(page, "dev-linmin");
    await page.goto("/sites");
    await rowCodes(page);                          // 等表格真的画出来再断言表头
    await expect(page.locator("thead")).not.toContainText("单例单价");
  });

  test("经营层看得到，且渲染成金额而不是分", async ({ page }) => {
    await loginAs(page, "dev-lingyuan");
    await page.goto("/sites");
    await rowCodes(page);
    await expect(page.locator("thead")).toContainText("单例单价");
    /* 后端给的是整数分；界面要换算成元，且不能出现小数点后一堆 0 */
    await expect(page.locator("tbody tr td").last()).toContainText("¥");
  });
});

test.describe("完成一次访视：真库上的一串后果", () => {
  test("勾任务 → 完成 → 副作用逐条落地", async ({ page }) => {
    await loginAs(page, "dev-wutong");

    const rows = page.getByTestId("visit-row");
    await expect(rows.first()).toBeVisible();
    await rows.first().getByRole("link", { name: "打开" }).click();

    /* 任务没勾完，提交是禁用的 */
    const submit = page.getByTestId("submit");
    await expect(submit).toBeDisabled();

    const boxes = page.locator(".tasks input[type=checkbox]:not(:checked)");
    for (let n = await boxes.count(); n > 0; n = await boxes.count()) {
      await boxes.first().click();
      await expect(boxes).toHaveCount(n - 1);
    }

    /* 种子里这一例是超窗的 → 必须填原因 */
    if (await page.getByTestId("oow-reason").count()) {
      await expect(submit).toBeDisabled();
      await page.getByTestId("oow-reason").fill("受试者外地务工，返院延迟");
    }
    await expect(submit).toBeEnabled();
    await submit.click();

    const effects = page.getByTestId("effects");
    await expect(effects).toBeVisible();
    /* 真后端的副作用集合：补偿、工时、成本、下一次访视一定有 */
    for (const t of ["CompensationDue", "TimesheetPosted", "CostPosted", "NextVisitScheduled"])
      await expect(effects).toContainText(t);
    /* 尚未接上的订阅者，后端 pending 字段照样透传到界面 */
    await expect(effects).toContainText("RefreshProjections");
  });
});
