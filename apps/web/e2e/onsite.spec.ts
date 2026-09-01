import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   现场那两页。

     启动清单汇总 —— 哪几个中心卡住了（按阻塞项，不按完成度）
     药品与样本   —— 账平不平、样本闭没闭环
   ════════════════════════════════════════════════════════════════════ */

test.describe("启动清单汇总", () => {
  test.beforeEach(async ({ page }) => { await page.goto("/startup"); });

  test("按阻塞项排，不按完成度", async ({ page }) => {
    const rows = page.getByTestId("startup-row");
    await expect(rows.first()).toBeVisible();
    /* mock 里只有三个中心（SS-01 / SS-07 / SS-14），SS-14 是唯一还在启动期的：
       0/16，9 项阻塞。它排第一 —— 哪怕另外两个"完成度"看起来是满的
       （它们根本没有清单，早就过了启动期）。 */
    await expect(rows.first()).toContainText("SS-14");
  });

  test("「已过启动期」不画成 0/0", async ({ page }) => {
    await expect(page.getByTestId("startup-row").first()).toBeVisible();
    /* 已入组的中心一行清单都没有 —— 那不是"一项都没做" */
    await expect(page.getByTestId("no-checklist").first()).toBeVisible();
    /* 而且它们排在最后 */
    await expect(page.getByTestId("startup-row").last()).toContainText("已过启动期");
  });

  test("只看有阻塞项的，会把已过启动期的都筛掉", async ({ page }) => {
    await expect(page.getByTestId("startup-row").first()).toBeVisible();
    const all = await page.getByTestId("startup-row").count();
    await page.getByTestId("blocked-only").check();
    const some = await page.getByTestId("startup-row").count();
    expect(some).toBeLessThan(all);
    await expect(page.getByTestId("no-checklist")).toHaveCount(0);
  });
});

test.describe("药品与样本", () => {
  test.beforeEach(async ({ page }) => { await page.goto("/material"); });

  test("在手数量是算出来的，记一笔就跟着变", async ({ page }) => {
    const chip = page.getByTestId("ip-balance");
    await expect(chip).toBeVisible();
    const before = Number((await chip.innerText()).replace(/\D/g, ""));

    await page.getByTestId("add-ip").click();
    await page.getByTestId("ip-kind").selectOption("receipt");
    await page.getByTestId("ip-qty").fill("12");
    await page.getByTestId("ip-go").click();

    await expect(page.getByTestId("mat-said")).toContainText("到货");
    await expect(chip).toContainText(String(before + 12));
  });

  test("台账只追加 —— 界面上没有编辑，也没有删除", async ({ page }) => {
    await expect(page.getByTestId("ip-row").first()).toBeVisible();
    /* 记错了要用反向流水冲销。有编辑按钮的话，那条规矩就形同虚设 */
    await expect(page.getByRole("button", { name: /编辑|删除/ })).toHaveCount(0);
  });

  test("样本：寄出没确认的顶到最上面，并单独报一条", async ({ page }) => {
    await page.getByTestId("tab-spec").click();
    await expect(page.getByTestId("spec-inflight")).toContainText("不知去向");
    /* 在途 21 天那一管排第一，且刷红 */
    const first = page.getByTestId("spec-row").first();
    await expect(first).toContainText("在途 21 天");
    await expect(first.locator(".chip.crit")).toBeVisible();
  });

  test("样本：登记收到之后就闭环了，不再出现在「在途」里", async ({ page }) => {
    await page.getByTestId("tab-spec").click();
    await expect(page.getByTestId("spec-row").first()).toBeVisible();
    await page.getByTestId("spec-row").first()
      .getByRole("button", { name: "收到" }).click();
    await expect(page.getByTestId("mat-said")).toContainText("闭环");
    /* 在途那条红条上的数字要跟着降 */
    await expect(page.getByTestId("spec-inflight")).toContainText("1 管");
  });

  test("样本：还没寄的只有「寄出」一个下一步", async ({ page }) => {
    await page.getByTestId("mat-site").selectOption({ index: 1 });   // SS-07
    await page.getByTestId("tab-spec").click();
    const row = page.getByTestId("spec-row").filter({ hasText: "R-0331" });
    await expect(row).toContainText("待寄出");
    await expect(row.getByRole("button", { name: "寄出" })).toBeVisible();
    /* 还没寄出就谈不上"收到" —— 那两个按钮不该在 */
    await expect(row.getByRole("button", { name: "收到" })).toHaveCount(0);
  });
});
