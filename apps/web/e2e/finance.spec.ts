import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   钱那三页：里程碑结算 / 客户 / 现金流预测。

   这一组盯的是**这套数怎么骗人**：
     · 把「已达成但没开票」算成未来收入 —— 凭空造现金流；
     · 客户账期改了，历史发票的到期日跟着变 —— 应收账龄集体位移；
     · 已回款的能改回去 —— 钱到账变成一件可撤销的事。
   ════════════════════════════════════════════════════════════════════ */

test.describe("里程碑 · 结算", () => {
  test("先说清「达成了没开票」不需要跟客户谈", async ({ page }) => {
    await page.goto("/bill?as=boss");
    await expect(page.locator(".derive").first()).toContainText("只需要有人去做");
    await expect(page.locator(".derive").first()).toContainText("不在这张表上");
  });

  test("**逾期最久的排最前，已回款的沉到最后**", async ({ page }) => {
    await page.goto("/bill?as=boss");
    const rows = page.getByTestId("bill-row");
    await expect(rows.first()).toBeVisible();
    await expect(rows.first()).toContainText("逾期 94 天");
    await expect(rows.last()).toContainText("已回款");
  });

  test("逾期超过 60 天的标成红的，60 天以内的是黄的", async ({ page }) => {
    await page.goto("/bill?as=boss");
    const long = page.getByTestId("bill-row").filter({ hasText: "逾期 94 天" });
    await expect(long.locator(".chip.crit").first()).toBeVisible();
    const short = page.getByTestId("bill-row").filter({ hasText: "逾期 38 天" });
    await expect(short.getByTestId("bill-overdue")).toHaveClass(/warn/);
  });

  test("逾期占比与绝对额都给 —— 两者不是一回事", async ({ page }) => {
    await page.goto("/bill?as=boss");
    await expect(page.getByTestId("bill-share")).toContainText("逾期占比比绝对额有用");
  });

  test("**开票：到期日由客户账期算出来并固化**", async ({ page }) => {
    await page.goto("/bill?as=boss");
    const row = page.getByTestId("bill-row").filter({ hasText: "合同签署" });
    await expect(row.getByTestId("bill-not-invoiced")).toBeVisible();
    await row.getByRole("button", { name: "开票" }).click();
    await expect(page.getByTestId("bill-form")).toContainText("落库固化");
    await page.getByTestId("bill-submit").click();
    await expect(page.getByTestId("bill-said")).toContainText("账期");
    await expect(page.getByTestId("bill-row").filter({ hasText: "合同签署" }))
      .toContainText("已开票");
  });

  test("**已回款的不能改回去**", async ({ page }) => {
    await page.goto("/bill?as=boss");
    const paid = page.getByTestId("bill-row").filter({ hasText: "已回款" });
    await expect(paid.first()).toBeVisible();
    /* 已回款那一行不再给按钮 —— 界面上就没有那条路 */
    await expect(paid.first().getByRole("button", { name: "登记回款" }))
      .toHaveCount(0);
  });

  test("回款晚于约定要说出来", async ({ page }) => {
    await page.goto("/bill?as=boss");
    const row = page.getByTestId("bill-row").filter({ hasText: "逾期 94 天" });
    await row.getByRole("button", { name: "登记回款" }).click();
    await expect(page.getByTestId("bill-form")).toContainText("不可撤销");
    await page.getByTestId("bill-submit").click();
    await expect(page.getByTestId("bill-said")).toContainText("晚了");
  });

  test("CRC 看不到金额：金额列整列不画，逾期天数还在", async ({ page }) => {
    await page.goto("/bill");
    await expect(page.getByTestId("bill-row").first()).toBeVisible();
    await expect(page.getByTestId("bill-no-money")).toContainText("整列不画");
    await expect(page.locator("thead")).not.toContainText("金额");
    await expect(page.getByTestId("bill-overdue").first()).toBeVisible();
  });
});

test.describe("客户", () => {
  test("先说清它不是通讯录", async ({ page }) => {
    await page.goto("/clients?as=boss");
    await expect(page.locator(".derive").first()).toContainText("不是通讯录");
    await expect(page.locator(".derive").first()).toContainText("还要不要接他的项目");
  });

  test("**逾期最多的排最前** —— 不按合同额", async ({ page }) => {
    await page.goto("/clients?as=boss");
    const rows = page.getByTestId("client-row");
    await expect(rows.first()).toBeVisible();
    /* 安泰医药合同额比华拓小，但两笔逾期都出自它 */
    await expect(rows.first()).toContainText("安泰医药");
    await expect(rows.first().getByTestId("client-overdue")).toBeVisible();
  });

  test("账期长的要说出后果", async ({ page }) => {
    await page.goto("/clients?as=boss");
    const late = page.getByTestId("client-row").filter({ hasText: "安泰医药" });
    await expect(late.getByTestId("client-long-terms"))
      .toContainText("下次报价要把资金成本算进去");
  });

  test("**改账期不回溯历史发票** —— 界面上要写明", async ({ page }) => {
    await page.goto("/clients?as=boss");
    const row = page.getByTestId("client-row").filter({ hasText: "安泰医药" });
    await row.getByRole("button", { name: "改档案" }).click();
    await expect(page.getByTestId("client-form")).toContainText("不回溯历史发票");
    await page.getByTestId("client-terms-input").fill("120");
    await page.getByTestId("client-submit").click();
    await expect(page.getByTestId("client-said")).toContainText("到期日不受影响");
    await expect(page.getByTestId("client-row").filter({ hasText: "安泰医药" })
      .getByTestId("client-terms")).toContainText("120 天");
  });

  test("说清为什么要把 sponsor 从字符串升成一张表", async ({ page }) => {
    await page.goto("/clients?as=boss");
    await expect(page.locator(".derive").last()).toContainText("不是为了规范化");
  });

  test("CRC 改不了档案", async ({ page }) => {
    await page.goto("/clients");
    await expect(page.getByTestId("client-row").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "改档案" })).toHaveCount(0);
  });
});

test.describe("现金流预测", () => {
  test("先说清系统此前只有后视镜", async ({ page }) => {
    await page.goto("/cash?as=boss");
    await expect(page.locator(".derive").first()).toContainText("后视镜");
    await expect(page.locator(".derive").first()).toContainText("缺口出现在哪个月");
  });

  test("**记录缺口单列，一分钱不进曲线**", async ({ page }) => {
    await page.goto("/cash?as=boss");
    const gap = page.getByTestId("cash-gap");
    await expect(gap).toBeVisible();
    await expect(gap).toContainText("一分钱都没算进下面的曲线");
    await expect(gap).toContainText("不是未来收入");
  });

  test("逐月给出净额与累计，且累计是逐月累加的", async ({ page }) => {
    await page.goto("/cash?as=boss");
    const rows = page.getByTestId("cash-row");
    await expect(rows).toHaveCount(6);
    /* 每一行都有进账、支出、净额、累计四个数 */
    await expect(rows.first().locator("td.num")).toHaveCount(4);

    /* **「最低点」那个角标在这份 mock 上不出现，而那是对的：**
       mock 的班底是 4 个人（约 10 万/月），而里程碑动辄三四十万 ——
       现金一直是够的，页头也如实写着「这几个月现金是够的」。

       这是 mock 自己不自洽（4 人的班底配 15 个中心的合同额），
       不是页面少了分支。**编一笔数据去点亮那个角标，比不点亮更糟。**
       缺口那条分支由 calc 的单测钉住
       （cash.test.ts「最低点落在哪个月 —— 那就是要提前多久去谈的答案」）。 */
    await expect(page.getByTestId("cash-summary")).toContainText("现金是够的");
  });

  test("**压力情景不是悲观** —— 而且最低点更低", async ({ page }) => {
    await page.goto("/cash?as=boss");
    const note = page.getByTestId("cash-stress-note");
    await expect(note).toContainText("基准");
    await page.getByTestId("cash-stress").check();
    await expect(note).toContainText("压力情景不是悲观");
    await expect(note).toContainText("对方还没打算付");
  });

  test("换跨度会换掉月数", async ({ page }) => {
    await page.goto("/cash?as=boss");
    await expect(page.getByTestId("cash-row")).toHaveCount(6);
    await page.getByTestId("cash-months").selectOption("3");
    await expect(page.getByTestId("cash-row")).toHaveCount(3);
  });

  test("点开一个月看得到进账明细，且分四类", async ({ page }) => {
    await page.goto("/cash?as=boss");
    const btn = page.getByTestId("cash-row").locator("button").first();
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(page.getByTestId("cash-detail")).toBeVisible();
    await expect(page.getByTestId("cash-detail")).toContainText("不是承诺");
  });

  test("CRC 看不到钱：一句话，不是一屏零", async ({ page }) => {
    await page.goto("/cash");
    await expect(page.getByTestId("cash-no-money")).toContainText("对你是空的");
  });
});
