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
