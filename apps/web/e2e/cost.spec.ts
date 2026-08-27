import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   钱这一侧的两条线：

   ① **「这条工时为什么算成这么多钱」说得出来。**
      给一个数字让人回头去问财务，等于成本这一侧什么也没交付。
   ② **同一个接口，看得见钱的人和看不见钱的人拿到的不是同一份数据。**
      种子里 CRC 有 timeWrite（他填工时）却没有 cost（他看不到钱）——
      这不是边角情况，这是这套系统里最常见的那个人。
   ════════════════════════════════════════════════════════════════════ */

test("经营层：工时的成本能一路推导到底", async ({ page }) => {
  await page.goto("/timesheets?as=boss");

  const row = page.getByTestId("timesheet-row").first();
  await expect(row).toBeVisible();
  await expect(row.getByTestId("cost-cell")).toBeVisible();

  /* 展开推导链 —— 三步都要在，缺一步这个数字就又变回"从天上掉下来的" */
  await row.getByTestId("why").click();
  const d = row.getByTestId("derivation");
  await expect(d).toContainText("人天");
  await expect(d).toContainText("人天单价");
  /* I2：用的是**提交当日生效的费率卡快照**，不是今天的费率 */
  await expect(d).toContainText("快照");
  await expect(d).toContainText("费率卡明年调价，这条工时的成本不会变");
});

test("CRC：填得了工时，看不到它折成多少钱", async ({ page }) => {
  await page.goto("/timesheets?as=crc");

  await expect(page.getByTestId("timesheet-row").first()).toBeVisible();
  /* 成本那几列整列消失 —— 不是 0，也不是「—」 */
  await expect(page.getByTestId("cost-cell")).toHaveCount(0);
  await expect(page.getByTestId("why")).toHaveCount(0);
  /* 但要说清楚这是权限，不是系统坏了 */
  await expect(page.getByTestId("cost-hidden")).toContainText("不在你的可见范围");
  /* 他仍然填得了工时 —— timeWrite 与 cost 是两回事 */
  await expect(page.getByTestId("file-timesheet")).toBeVisible();
});

test("填一条工时，再作废它 —— 只能作废，不能删", async ({ page }) => {
  await page.goto("/timesheets?as=boss");
  /* **先等列表渲染出来再数。** `goto` 之后立刻 `count()` 拿到的是 0，
     于是 `before + 1` 变成 1，而页面上其实有 4 条 ——
     失败信息说的是"期望 1 实际 4"，看起来像业务逻辑错了。
     这是同一个坑第三次出现（见 integration/README 第 3 条）：
     **凡是拿 `count()` 取基线，前面必须有一条等待渲染的断言。**
     循环里的 `count()` 不受影响 —— 它们前面本来就有别的断言挡着。 */
  await expect(page.getByTestId("timesheet-row").first()).toBeVisible();
  const before = await page.getByTestId("timesheet-row").count();

  await page.getByTestId("ts-site").selectOption({ index: 1 });
  await page.getByTestId("ts-hours").fill("6");
  await page.getByTestId("ts-submit").click();
  await expect(page.getByTestId("timesheet-row")).toHaveCount(before + 1);

  /* 作废要写原因 */
  const row = page.getByTestId("timesheet-row").first();
  await row.getByTestId("void").click();
  await expect(row.getByTestId("void-confirm")).toBeDisabled();
  await row.getByTestId("void-reason").fill("填错了中心，重填一条");
  await row.getByTestId("void-confirm").click();

  /* 成本冲回；而那一条**还在台账里**（勾上"显示已作废"就看得见） */
  await expect(page.getByTestId("timesheet-effects")).toContainText("冲回");
  await expect(page.getByTestId("timesheet-row")).toHaveCount(before);
  await page.getByTestId("include-voided").check();
  await expect(page.getByTestId("timesheet-row")).toHaveCount(before + 1);
  await expect(page.getByTestId("void-note").first()).toContainText("填错了中心");
});

test("损益：I8' 四项逐条，方向相反的那两项看得出来", async ({ page }) => {
  await page.goto("/sites/s1/pnl?as=boss");

  const rev = page.getByTestId("revenue");
  await expect(rev).toBeVisible();
  /* 四项缺一不可 —— 少一项的界面看起来仍然是对的，这正是它危险的地方 */
  await expect(rev).toContainText("启动费");
  await expect(rev).toContainText("入组 × 单价");
  await expect(page.getByTestId("dropout-term")).toContainText("脱落扣减");
  await expect(page.getByTestId("screenfail-term")).toContainText("筛败费");
  await expect(page.getByTestId("revenue-total")).toBeVisible();

  await expect(page.getByTestId("cost-total")).toBeVisible();
  await expect(page.getByTestId("margin")).toBeVisible();
  /* 报表要标得出「按哪版口径算的」 */
  await expect(page.getByTestId("calc-version")).toHaveText(/\d{4}\.\d/);
});

test("损益：一线看得到例数，看不到钱", async ({ page }) => {
  await page.goto("/sites/s1/pnl?as=crc");

  await expect(page.getByTestId("counts")).toBeVisible();
  await expect(page.getByTestId("revenue")).toHaveCount(0);
  await expect(page.getByTestId("cost")).toHaveCount(0);
  await expect(page.getByTestId("margin")).toHaveCount(0);
  await expect(page.getByTestId("no-money")).toContainText("看不到它的价钱与成本");
});

test("费率卡：调价是两步，且重叠会被拦下", async ({ page }) => {
  await page.goto("/rate-cards?as=boss");
  await expect(page.getByTestId("rate-row").first()).toBeVisible();

  /* 直接开一张与现行卡重叠的新卡 → 被拦，并告诉你正确的两步 */
  await page.getByTestId("rate-role").selectOption("CRC");
  await page.getByTestId("rate-day-cost").fill("1300");
  await page.getByTestId("rate-valid-from").fill("2026-07-01");
  await page.getByTestId("rate-submit").click();
  await expect(page.getByTestId("new-rate-problem")).toContainText("重叠");
  await expect(page.getByTestId("new-rate-problem")).toContainText("先给它收口");

  /* 第一步：收口。这张表单里**没有单价那一栏** */
  await page.locator('[data-testid=rate-row][data-open="1"]')
    .first().getByTestId("close-card").click();
  await expect(page.getByTestId("close-form")).toContainText("不动单价");
  await expect(page.getByTestId("close-form")
    .locator('input[type="number"]')).toHaveCount(0);
  await page.getByTestId("close-valid-to").fill("2026-06-30");
  await page.getByTestId("close-confirm").click();
  /* 收口的反馈来自**数据**：那张卡不再「生效中」，也不再有收口入口。
     服务端这个命令返回的 sideEffects 是空数组，所以不能断言副作用文案 ——
     断言一条只有 mock 才产出的文案，等于让 mock 替真库作证。 */
  await expect(page.getByTestId("close-form")).toHaveCount(0);
  await expect(page.getByTestId("rate-row").filter({ hasText: "2026-06-30" }))
    .toBeVisible();
});

test("CRC 看得到费率卡的存在，看不到单价，也改不了", async ({ page }) => {
  await page.goto("/rate-cards?as=crc");
  await expect(page.getByTestId("rate-row").first()).toBeVisible();
  await expect(page.getByTestId("no-rate-write")).toContainText("rateWrite");
  await expect(page.getByTestId("close-card")).toHaveCount(0);
  /* 人天单价那一列整列消失 */
  await expect(page.locator("th", { hasText: "人天单价" })).toHaveCount(0);
});

/* ── 分月损益（欠账 D6） ─────────────────────────────────────────── */

test("分月：负毛利的那个月要一眼看得出来", async ({ page }) => {
  await page.goto("/sites/s1/pnl?as=boss");
  const trend = page.getByTestId("pnl-trend");
  await expect(trend).toBeVisible();
  await expect(trend.getByTestId("trend-row")).toHaveCount(12);

  /* 启动那几个月成本先出去、收入还没进来 —— 负毛利是这一页
     最该被看见的东西，所以它必须画得出来。 */
  await expect(trend.getByTestId("bar-negative").first()).toBeVisible();
  await expect(trend.getByTestId("bar-positive").first()).toBeVisible();
});

test("分月说清口径：按事件发生的月份归属，且各月之和不等于累计", async ({ page }) => {
  await page.goto("/sites/s1/pnl?as=boss");
  const trend = page.getByTestId("pnl-trend");
  await expect(trend).toContainText("按事件发生的那个月归属");
  /* 这句话是有人问「为什么加起来对不上」时唯一的答案 */
  await expect(trend).toContainText("不一定");
});

test("一线在分月上也只看得到例数", async ({ page }) => {
  await page.goto("/sites/s1/pnl?as=crc");
  const trend = page.getByTestId("pnl-trend");
  await expect(trend.getByTestId("trend-counts-only")).toBeVisible();
  await expect(trend.getByTestId("trend-gp")).toHaveCount(0);
});

/* ── 工时审批（欠账 D4） ─────────────────────────────────────────── */

test("审批状态是角标：已审 / 待审，而且不影响任何金额", async ({ page }) => {
  await page.goto("/timesheets?as=boss");
  await expect(page.getByTestId("timesheet-row").first()).toBeVisible();
  const chips = page.getByTestId("approve-chip");
  /* 两种状态都要有 —— 全是"已审"的话，那个角标写没写对没人知道 */
  await expect(chips.filter({ hasText: "已审" }).first()).toBeVisible();
  await expect(chips.filter({ hasText: "待审" }).first()).toBeVisible();
});

test("审批一条：成本不变，角标翻成「已审」", async ({ page }) => {
  await page.goto("/timesheets?as=boss");
  await expect(page.getByTestId("timesheet-row").first()).toBeVisible();
  const before = await page.getByTestId("cost-cell").allTextContents();
  expect(before.length).toBeGreaterThan(0);

  await page.getByTestId("approve").first().click();
  await expect(page.getByTestId("timesheet-effects")).toContainText("成本没有变化");

  /* 金额一个都不该动 —— 审批只说这一笔被第二个人看过了 */
  await expect(page.getByTestId("cost-cell")).toHaveText(before);
});

test("只看待审：筛掉已审的与已作废的", async ({ page }) => {
  await page.goto("/timesheets?as=boss");
  await page.getByTestId("unapproved-only").check();
  const chips = page.getByTestId("approve-chip");
  await expect(chips.filter({ hasText: "已审" })).toHaveCount(0);
  await expect(chips.filter({ hasText: "待审" }).first()).toBeVisible();
});

test("损益上说得出「其中多少还没审」，且它已经在合计里", async ({ page }) => {
  await page.goto("/sites/s1/pnl?as=boss");
  const note = page.getByTestId("unapproved-cost");
  await expect(note).toBeVisible();
  /* 关键是这句话：把它从合计里剔掉才是错的 */
  await expect(note).toContainText("已经计入上面的合计");
});
