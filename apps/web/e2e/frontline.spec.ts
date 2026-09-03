import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   一线那四页。

   每一页盯的都是它**唯一要回答的那个问题**：
     受试者窗口 —— 谁的下一次访视超窗了
     预筛登记   —— 漏斗最上面两格有没有人在记
     受试者补偿 —— 哪几笔还没落地（以及哪几笔发了没凭证）
     伦理事务   —— 哪个中心还差一份批件
   ════════════════════════════════════════════════════════════════════ */

test.describe("CRC", () => {
  test("受试者窗口：超窗的顶到最上面，出组的沉到最下面", async ({ page }) => {
    await page.goto("/subjects");
    const rows = page.getByTestId("subject-row");
    await expect(rows.first()).toBeVisible();
    /* S-0203 的下一次访视超窗 6 天 */
    await expect(rows.first()).toContainText("S-0203");
    await expect(rows.first()).toContainText("已超窗");
    await expect(page.getByTestId("subj-summary")).toContainText("已超窗");
  });

  test("受试者窗口：默认只看还在流程里的，去掉勾才看得到筛败的", async ({ page }) => {
    await page.goto("/subjects");
    await expect(page.getByTestId("subject-row").first()).toBeVisible();
    await expect(page.getByTestId("subject-row").filter({ hasText: "P0099" })).toHaveCount(0);
    await page.getByTestId("open-only").uncheck();
    const failed = page.getByTestId("subject-row").filter({ hasText: "P0099" });
    await expect(failed).toContainText("筛败");
    /* 已经出组的没有下一步，所以排最后 */
    await expect(page.getByTestId("subject-row").last()).toContainText("P0099");
  });

  test("预筛登记 → 签知情 → 筛选期访视生成", async ({ page }) => {
    await page.goto("/prescreen");
    await expect(page.getByTestId("pre-row").first()).toBeVisible();
    const before = await page.getByTestId("pre-row").count();

    await page.getByTestId("pre-site").selectOption({ index: 1 })   // 第一个中心（0 是「— 选一个 —」）;
    await page.getByTestId("pre-no").fill("SS-01-P0500");
    await page.getByTestId("pre-create").click();
    await expect(page.getByTestId("pre-row")).toHaveCount(before + 1);
    await expect(page.getByTestId("pre-said")).toContainText("SS-01-P0500");

    /* 新登记的是预筛，下一步只有"签知情" */
    const row = page.getByTestId("pre-row").filter({ hasText: "SS-01-P0500" });
    await expect(row).toContainText("预筛");
    await row.getByRole("button", { name: "签知情" }).click();
    await page.getByTestId("icf-form-go").click();
    await expect(page.getByTestId("pre-said")).toContainText("筛选期访视");
    await expect(page.getByTestId("pre-row").filter({ hasText: "SS-01-P0500" }))
      .toContainText("筛选中");
  });

  test("预筛登记：筛选中的人两个下一步都在，筛败要选受控原因", async ({ page }) => {
    await page.goto("/prescreen");
    const row = page.getByTestId("pre-row").filter({ hasText: "P0102" });
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: "入组" })).toBeVisible();
    await row.getByRole("button", { name: "筛败" }).click();

    /* 原因是受控取值 —— 自由文本统计不出「入排标准与病源不匹配」 */
    await expect(page.getByTestId("fail-go")).toBeDisabled();
    await page.getByTestId("fail-reason").selectOption({ label: "影像学不符合" });
    await page.getByTestId("fail-go").click();
    /* 筛败不是失败，是收入 —— 界面要说出来 */
    await expect(page.getByTestId("pre-said")).toContainText("I8′");
  });

  test("补偿：欠得最久的排最前，发了没凭证的单独报警", async ({ page }) => {
    await page.goto("/payments");
    await expect(page.getByTestId("pay-row").first()).toBeVisible();
    await expect(page.getByTestId("pay-row").first()).toContainText("48 天");
    await expect(page.getByTestId("pay-summary")).toContainText("超过 30 天");

    /* 发了但没凭证 —— 比"还没发"更麻烦，要单独一条 */
    await page.getByTestId("unpaid-only").uncheck();
    await expect(page.getByTestId("no-receipt")).toContainText("没有签收凭证");
    await expect(page.getByTestId("missing-receipt").first()).toBeVisible();
  });

  test("补偿：登记发放必须同时给凭证编号", async ({ page }) => {
    await page.goto("/payments");
    const row = page.getByTestId("pay-row").first();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "登记发放" }).click();

    /* 只填日期点不动 —— 只记「发了」而没有凭证，关闭中心时对不上 */
    await expect(page.getByTestId("pay-go")).toBeDisabled();
    await page.getByTestId("receipt-ref").fill("RC-2026-0500");
    await page.getByTestId("pay-go").click();
    await expect(page.getByTestId("pay-said")).toContainText("RC-2026-0500");
  });

  test("伦理：待批复按天数分色，久的刷红", async ({ page }) => {
    await page.goto("/ethics");
    await expect(page.getByTestId("ethics-site").first()).toBeVisible();
    await expect(page.getByTestId("ethics-summary")).toContainText("待批复");
    /* 递上去 74 天那一份 —— 和刚递的 12 天那份必须分得开 */
    const stale = page.getByTestId("ethics-row").filter({ hasText: "方案修正案" });
    await expect(stale.locator(".chip.crit")).toBeVisible();
    const fresh = page.getByTestId("ethics-row").filter({ hasText: "年度" });
    await expect(fresh.locator(".chip.warn")).toBeVisible();
  });

  test("伦理：登记递交默认待批复；登记批复之后才算数", async ({ page }) => {
    await page.goto("/ethics");
    await expect(page.getByTestId("ethics-site").first()).toBeVisible();
    const before = await page.getByTestId("ethics-row").count();

    await page.getByTestId("add-SS-01").click();
    await page.getByTestId("sub-kind").selectOption({ label: "结题报告" });
    await page.getByTestId("sub-go").click();
    await expect(page.getByTestId("ethics-row")).toHaveCount(before + 1);

    /* **递交了不等于批下来了** —— 新建的一律待批复 */
    const row = page.getByTestId("ethics-row").filter({ hasText: "结题报告" });
    await expect(row).toContainText("待批复");

    await row.getByRole("button", { name: "登记批复" }).click();
    await page.getByTestId("dec-go").click();
    await expect(page.getByTestId("ethics-row").filter({ hasText: "结题报告" }))
      .toContainText("已批准");
  });
});

test("经营层看得到补偿金额，看不到是给谁的", async ({ page }) => {
  await page.goto("/payments?as=boss");
  await expect(page.getByTestId("pay-masked")).toContainText("是给谁的");
  /* 金额那一列照给 —— 遮的是 L3 的筛选号，不是整页 */
  await expect(page.getByTestId("pay-row").first()).toContainText("¥");
});
