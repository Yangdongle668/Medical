import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   质量台账上的两本账：SAE 24 小时及时率（I6）与药品在手数量（I5）。

   这两个数是 `packages/calc/src/kernel.ts` 开头那段话的主角：
   原型里它们是写死的常量，而同一个页面下方就摆着一条超窗的 SAE。
   所以这里验的不是"页面能打开"，而是**数字与台账上的记录对得上**。
   ════════════════════════════════════════════════════════════════════ */

test.beforeEach(async ({ page }) => {
  await page.goto("/quality");
  await expect(page.getByTestId("sae-panel")).toBeVisible();
});

test("SAE 及时率由台账算出来，且带口径版本号", async ({ page }) => {
  const panel = page.getByTestId("sae-panel");
  /* 演示数据：一条 8.5 小时按时、一条 52 小时未报 → 1/2 = 50% */
  await expect(panel.getByTestId("sae-rate")).toHaveText("50%");
  await expect(panel).toContainText("1 按时 / 2 已到点");
  await expect(panel).toContainText("口径");
});

test("最坏的那一条晚了多久 —— 一个百分比促不成任何动作", async ({ page }) => {
  /* 52 小时未报，超过时限 52 − 24 = 28 小时。
     未上报的按"到现在为止"算 —— 它还在变大，这正是重点。 */
  await expect(page.getByTestId("sae-worst")).toContainText("28.0 小时");
});

test("超时未报的那条，台账上写着「尚未上报（已超时）」", async ({ page }) => {
  const chips = page.getByTestId("sae-chip");
  await expect(chips).toHaveCount(2);
  await expect(chips.filter({ hasText: "按时上报" })).toHaveCount(1);
  /* 关键：不上报**不能**换来"还没到点"的待遇 */
  await expect(chips.filter({ hasText: "已超时" })).toHaveCount(1);
});

test("上报耗时不四舍五入 —— 把 8.5 小时显示成 8 小时是在替人开脱", async ({ page }) => {
  await expect(page.getByTestId("sae-row").first()).toContainText("8.5");
});

test("药品在手数量说得出方向，且说得出关不掉中心的理由", async ({ page }) => {
  const ip = page.getByTestId("ip-panel");
  /* 30 收 − 12 发 = 18 在手 */
  await expect(ip.getByTestId("ip-balance-chip")).toContainText("18");
  await expect(ip.getByTestId("ip-remaining")).toContainText("退回申办方或登记销毁");
  /* 台账上一眼看得出加减方向 */
  await expect(ip.getByTestId("ip-row").first()).toContainText("+30");
});

test("换一个中心，两本账都跟着换 —— 没有跨中心的口径", async ({ page }) => {
  const select = page.getByTestId("quality-site");
  const values = await select.locator("option").evaluateAll(
    os => os.map(o => (o as HTMLOptionElement).value));
  test.skip(values.length < 2, "只有一个中心，换不了");

  await select.selectOption(values[1]!);
  /* 第二个中心没有 SAE：这里必须说"没有分母"，而不是画一个 100% */
  await expect(page.getByTestId("sae-none")).toBeVisible();
  await expect(page.getByTestId("sae-rate")).toHaveCount(0);
});
