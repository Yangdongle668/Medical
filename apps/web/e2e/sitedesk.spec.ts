import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   中心工作台（W9）：进了一个中心，它的受试者、质疑、SAE、文件、药品、监查
   都在页签里 —— 不必去侧栏找那一页、再选一次中心。

   每个页签就是侧栏里那一页本身，带上 studySiteId 只看这一个中心。
   所以这里要钉的是两件事：**只看这一个中心**，以及**页签按模块权限出**。
   ════════════════════════════════════════════════════════════════════ */

test("CRC：页签按他的模块出 —— 有受试者 / 质疑 / 质量 / 文件 / 药品，没有监查", async ({ page }) => {
  await page.goto("/sites/s1");
  const tabs = page.getByTestId("site-tabs");
  for (const t of ["subjects", "queries", "quality", "isf", "material"])
    await expect(tabs.getByTestId(`site-tab-${t}`)).toBeVisible();
  await expect(tabs.getByTestId("site-tab-monitoring")).toHaveCount(0);
});

test("受试者页签只有这一个中心的人；地址就是页签", async ({ page }) => {
  await page.goto("/sites/s1");
  await page.getByTestId("site-tab-subjects").click();
  await expect(page).toHaveURL(/\/sites\/s1\/subjects$/);
  const rows = page.getByTestId("subject-row");
  await expect(rows.first()).toBeVisible();
  for (const r of await rows.all()) await expect(r).toContainText("SS-01");

  /* 换到另一个中心的同一个页签：内容跟着换，不残留上一个中心的 */
  await page.goto("/sites/s2/subjects");
  await expect(page.getByTestId("subject-row").first()).toBeVisible();
  for (const r of await page.getByTestId("subject-row").all()) await expect(r).toContainText("SS-07");
});

test("文件页签只有这一个中心的文件", async ({ page }) => {
  await page.goto("/sites/s2/isf");
  const rows = page.getByTestId("isf-row");
  await expect(rows.first()).toBeVisible();
  for (const r of await rows.all()) await expect(r).toContainText("SS-07");
});

test("质量页签固定在这个中心上，不再出中心下拉", async ({ page }) => {
  await page.goto("/sites/s1/quality");
  await expect(page.getByTestId("sae-panel")).toBeVisible();
  await expect(page.getByTestId("quality-site")).toHaveCount(0);
});

test("CRA 有监查页签；页签里不画全范围的统计", async ({ page }) => {
  await page.goto("/sites/s1?as=cra");
  await page.getByTestId("site-tab-monitoring").click();
  await expect(page).toHaveURL(/\/sites\/s1\/monitoring/);
  await expect(page.getByTestId("mon-summary")).toHaveCount(0);
});

test("概览上有本中心的待办，而且只有这个中心的", async ({ page }) => {
  await page.goto("/sites/s1");
  const todo = page.getByTestId("site-todo");
  await expect(todo).toBeVisible();
  for (const r of await todo.getByTestId("inbox-item").all()) await expect(r).toContainText("SS-01");
});

test("没有的页签说清楚，并且给得回去", async ({ page }) => {
  await page.goto("/sites/s1/monitoring");
  await expect(page.getByTestId("site-tab-missing")).toBeVisible();
  await page.getByRole("link", { name: "回到概览" }).click();
  await expect(page).toHaveURL(/\/sites\/s1$/);
});

/* 受试者详情（W10）：「S-0203 现在什么情况」一页答完 ——
   访视、质疑、SAE、补偿排在一条时间线上，该动手的也在这里。 */
test.describe("受试者详情", () => {
  test("从受试者列表点筛选号进来；时间线有访视与质疑，都点得进去", async ({ page }) => {
    await page.goto("/subjects");
    const row = page.getByTestId("subject-row").filter({ hasText: "S-0203" }).first();
    await row.getByRole("link", { name: "S-0203" }).click();
    await expect(page).toHaveURL(/\/subjects\/[^/]+$/);
    await expect(page.getByTestId("subject-title")).toContainText("S-0203");

    const tl = page.getByTestId("subject-timeline");
    await expect(tl.locator('[data-kind="访视"]').first()).toBeVisible();
    await expect(tl.locator('[data-kind="质疑"]').first()).toBeVisible();
    await tl.locator('[data-kind="访视"]').first().getByRole("link", { name: "打开" }).click();
    await expect(page).toHaveURL(/\/visits\//);
  });

  test("在详情页登记脱落 —— 与列表同一个表单，后果在按下去之前说清", async ({ page }) => {
    await page.goto("/subjects");
    await page.getByTestId("subject-row").filter({ hasText: "S-0203" }).first()
      .getByRole("link", { name: "S-0203" }).click();
    await page.getByTestId("subject-withdraw").click();
    await expect(page.getByTestId("wd-consequence")).toContainText("一并作废");
  });

  test("范围外或不存在：说看不到，给得回去", async ({ page }) => {
    await page.goto("/subjects/nope");
    await expect(page.getByTestId("subject-gone")).toBeVisible();
  });
});

/* 全局搜索（W11）：知道名字、不知道在哪 —— 一个框找页面、中心、受试者。 */
test.describe("全局搜索", () => {
  test("Ctrl+K 打开，敲筛选号回车就到这个人的详情", async ({ page }) => {
    await page.goto("/today");
    await expect(page.getByTestId("today-summary")).toBeVisible();
    await page.keyboard.press("Control+k");
    const input = page.getByTestId("palette-input");
    await expect(input).toBeFocused();
    await input.fill("S-0203");
    await expect(page.getByTestId("palette-row").filter({ hasText: "S-0203" })).toBeVisible();
    await input.press("Enter");
    await expect(page).toHaveURL(/\/subjects\//);
    await expect(page.getByTestId("subject-title")).toContainText("S-0203");
  });

  test("页面名也找得到 —— 只找这个人侧栏上有的", async ({ page }) => {
    await page.goto("/today");
    await page.getByTestId("open-search").click();
    await page.getByTestId("palette-input").fill("工时");
    await page.getByTestId("palette-row").filter({ hasText: "工时与差旅" }).click();
    await expect(page).toHaveURL(/\/timesheets/);

    await page.getByTestId("open-search").click();
    await page.getByTestId("palette-input").fill("经营驾驶舱");
    await expect(page.getByTestId("palette-none")).toBeVisible();
  });

  test("中心按代号找，点进去是中心工作台", async ({ page }) => {
    await page.goto("/today");
    await page.getByTestId("open-search").click();
    await page.getByTestId("palette-input").fill("SS-07");
    await page.getByTestId("palette-row").filter({ hasText: "SS-07" }).first().click();
    await expect(page).toHaveURL(/\/sites\/s2$/);
  });

  test("经营层没有受试者列权限：筛选号搜不出人", async ({ page }) => {
    await page.goto("/sites?as=boss");
    await page.getByTestId("open-search").click();
    await page.getByTestId("palette-input").fill("S-0203");
    await expect(page.getByTestId("palette-none")).toBeVisible();
  });

  test("390px：搜索入口在顶上的身份条里", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/today");
    await page.getByTestId("open-search-bar").click();
    await expect(page.getByTestId("palette-input")).toBeVisible();
  });
});
