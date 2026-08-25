import { test, expect, type Page } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   Timesheet & Cost 纵切：DB → API → calc → Frontend → 集成。

   这一组要证明三件 mock 证明不了的事：

   ① **成本真的是按「填报当日生效的那张费率卡」算的**（I2）。
      种子里 CRC 2026 年的卡是 1298 元/人天，2025 年那张是 1180。
      界面上那个数必须能被 hours ÷ 8 × 1298 + 差旅 对上 ——
      对不上就说明取错了卡，而那种错误在总数里是看不出来的。

   ② **三层列权限在同一个接口上同时生效**：
      CRC 填得了工时（timeWrite），却看不到它折成多少钱（无 cost）。
      这不是边角情况 —— 他是这套系统里最常见的那个人。

   ③ **有 timeWrite 也不一定填得了**：经营层没有员工记录，
      因而没有任何费率卡匹配得上，服务端拒绝填报而不是拿个差不多的费率入账。
   ════════════════════════════════════════════════════════════════════ */

async function devLogin(page: Page, testid: string) {
  await page.goto("/login");
  await page.locator("details summary").click();
  await page.getByTestId(testid).click();
  await expect(page).toHaveURL(/\/today$/);
}

/** 种子：CRC 通用卡，2026-01-01 起，1298 元/人天。 */
const CRC_DAY_COST_CENTS = 129800;
const HOURS = 4;
const TRAVEL_YUAN = 120;
const expectedCents =
  Math.round((HOURS / 8) * CRC_DAY_COST_CENTS) + TRAVEL_YUAN * 100;
/** 与界面上的 zh-CN 货币格式对齐（无小数位） */
const asYuan = (cents: number) =>
  (cents / 100).toLocaleString("zh-CN",
    { style: "currency", currency: "CNY", maximumFractionDigits: 0 });

test.describe("工时：填得了，不一定看得到它值多少钱", () => {
  test("CRC 填一条工时 —— 成本那几列整列不在", async ({ page }) => {
    await devLogin(page, "dev-wutong");
    await page.goto("/timesheets");
    await expect(page.getByTestId("file-timesheet")).toBeVisible();

    await page.getByTestId("ts-site").selectOption({ index: 1 });
    await page.getByTestId("ts-type").selectOption("visit_support");
    await page.getByTestId("ts-hours").fill(String(HOURS));
    await page.getByTestId("ts-travel").fill(String(TRAVEL_YUAN));
    await page.getByTestId("ts-note").fill("集成测试：受试者陪同");
    await page.getByTestId("ts-submit").click();

    /* 按备注定位，**不靠位置**：`ORDER BY work_date DESC, id DESC`，
       而当天的几条 work_date 相同，于是先后由 uuid 决定 —— 等于随机。 */
    const row = page.getByTestId("timesheet-row")
      .filter({ hasText: "集成测试：受试者陪同" });
    await expect(row).toHaveCount(1);
    /* 他填的，他看不到钱 —— 不是 0，不是「—」，是整列不在 */
    await expect(page.getByTestId("cost-cell")).toHaveCount(0);
    await expect(page.getByTestId("why")).toHaveCount(0);
    await expect(page.getByTestId("cost-hidden")).toContainText("不在你的可见范围");
  });

  test("经营层看同一条工时：成本在，且推导得出那个数", async ({ page }) => {
    await devLogin(page, "dev-lingyuan");
    await page.goto("/timesheets");

    const row = page.getByTestId("timesheet-row")
      .filter({ hasText: "集成测试：受试者陪同" }).first();
    await expect(row).toBeVisible();

    /* **这一条是整组的核心**：界面上的金额必须等于
       hours ÷ 8 × 当日生效费率卡的人天单价 + 差旅。
       取错了卡（比如拿了 2025 年那张 1180 的）总数看起来照样"像个数"。 */
    await expect(row.getByTestId("cost-cell")).toHaveText(asYuan(expectedCents));

    await row.getByTestId("why").click();
    const d = row.getByTestId("derivation");
    await expect(d).toContainText(asYuan(CRC_DAY_COST_CENTS));
    await expect(d).toContainText(asYuan(TRAVEL_YUAN * 100));
    await expect(d).toContainText("快照");
  });

  test("经营层有 timeWrite，却填不了 —— 没有员工记录就没有费率卡", async ({ page }) => {
    await devLogin(page, "dev-lingyuan");
    await page.goto("/timesheets");

    await page.getByTestId("ts-site").selectOption({ index: 1 });
    await page.getByTestId("ts-hours").fill("2");
    await page.getByTestId("ts-submit").click();

    /* 拿一个"差不多的"费率入账比不入账更糟 —— 它会一直躺在报表里没人发现。
       所以服务端拒绝，而界面把拒绝的理由原样说出来。 */
    await expect(page.getByTestId("file-problem")).toContainText("费率卡");
  });
});

test.describe("损益：同一个接口，三层列权限同时生效", () => {
  test("经营层：I8' 四项都在，且标得出口径版本", async ({ page }) => {
    await devLogin(page, "dev-lingyuan");
    await page.goto("/sites");
    await expect(page.getByTestId("site-row").first()).toBeVisible();
    await page.getByRole("link", { name: "SS-01", exact: true }).click();
    await page.getByTestId("open-pnl").click();

    const rev = page.getByTestId("revenue");
    await expect(rev).toBeVisible();
    await expect(rev).toContainText("启动费");
    await expect(page.getByTestId("dropout-term")).toBeVisible();
    await expect(page.getByTestId("screenfail-term")).toBeVisible();
    await expect(page.getByTestId("revenue-total")).toBeVisible();
    await expect(page.getByTestId("cost-total")).toBeVisible();
    await expect(page.getByTestId("margin")).toBeVisible();
    await expect(page.getByTestId("calc-version")).toHaveText(/^\d{4}\.\d$/);
  });

  test("CRC：看得到例数，钱那一整块不在", async ({ page }) => {
    await devLogin(page, "dev-wutong");
    await page.goto("/sites");
    await expect(page.getByTestId("site-row").first()).toBeVisible();
    await page.getByRole("link", { name: "SS-01", exact: true }).click();
    await page.getByTestId("open-pnl").click();

    await expect(page.getByTestId("counts")).toBeVisible();
    await expect(page.getByTestId("revenue")).toHaveCount(0);
    await expect(page.getByTestId("cost")).toHaveCount(0);
    await expect(page.getByTestId("margin")).toHaveCount(0);
    await expect(page.getByTestId("no-money")).toBeVisible();
  });
});

test.describe("费率卡：调价是两步", () => {
  test("CRC：看得到卡在那儿，看不到单价，也没有收口入口", async ({ page }) => {
    await devLogin(page, "dev-wutong");
    await page.goto("/rate-cards");
    await expect(page.getByTestId("rate-row").first()).toBeVisible();
    await expect(page.getByTestId("no-rate-write")).toContainText("rateWrite");
    await expect(page.getByTestId("close-card")).toHaveCount(0);
    await expect(page.locator("th", { hasText: "人天单价" })).toHaveCount(0);
  });

  test("经营层：重叠被库拦下，收口后新卡才接得上", async ({ page }) => {
    await devLogin(page, "dev-lingyuan");
    await page.goto("/rate-cards");
    await expect(page.getByTestId("rate-row").first()).toBeVisible();

    /* 直接开一张与现行 CRC 卡重叠的 —— EXCLUDE 约束在数据库层直接拒绝 */
    await page.getByTestId("rate-role").selectOption("CRC");
    await page.getByTestId("rate-day-cost").fill("1400");
    await page.getByTestId("rate-valid-from").fill("2026-09-01");
    await page.getByTestId("rate-submit").click();
    await expect(page.getByTestId("new-rate-problem")).toBeVisible();

    /* 第一步：收口。收口的表单里没有单价那一栏 —— 收口不改价。 */
    await page.locator('[data-testid=rate-row][data-open="1"]')
      .filter({ hasText: "CRC" }).first().getByTestId("close-card").click();
    await expect(page.getByTestId("close-form")).toContainText("不动单价");
    await page.getByTestId("close-valid-to").fill("2026-08-31");
    await page.getByTestId("close-confirm").click();
    /* 收口的反馈来自**数据**，不是副作用 —— 服务端这个命令返回空数组。
       （注意后端存的是**右开区间**的上界，即收口日的次日；
        界面显示的仍是收口日当天，这一层换算由服务端负责。） */
    await expect(page.getByTestId("close-form")).toHaveCount(0);

    /* 第二步：新卡从次日接上 —— 中间不留缝，否则那一天填不了工时 */
    await page.getByTestId("rate-role").selectOption("CRC");
    await page.getByTestId("rate-day-cost").fill("1400");
    await page.getByTestId("rate-valid-from").fill("2026-09-01");
    await page.getByTestId("rate-note").fill("2026 下半年调价");
    await page.getByTestId("rate-submit").click();
    await expect(page.getByTestId("new-rate-problem")).toHaveCount(0);
    await expect(page.getByTestId("rate-row")
      .filter({ hasText: "2026 下半年调价" })).toBeVisible();
  });
});
