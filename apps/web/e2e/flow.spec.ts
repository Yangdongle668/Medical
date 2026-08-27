import { test, expect, type Page } from "@playwright/test";

/** 逐项勾掉访视任务，每一项都等服务端回写后再点下一个。 */
async function tickAllTasks(page: Page) {
  /* **先等任务列表真的出现。**
     不等的话 `count()` 立刻返回 0，`for` 一次都不执行，函数安安静静地返回 ——
     而"一个都没勾"和"全勾完了"在这个函数的出口处长得一模一样。
     后果落在很远的地方：提交按钮一直 disabled，看起来像功能坏了。

     这是同一条规则的第五次，也是最恶劣的一种形态：
     **0 既是"没有了"，也是"还没来"。** 用 count() 判空之前，
     必须先有一个"它已经来了"的锚点。 */
  await expect(page.locator(".tasks input[type=checkbox]").first()).toBeVisible();
  const boxes = page.locator(".tasks input[type=checkbox]:not(:checked)");
  for (let n = await boxes.count(); n > 0; n = await boxes.count()) {
    await boxes.first().click();
    await expect(boxes).toHaveCount(n - 1);
  }
}

/* ════════════════════════════════════════════════════════════════════
   Phase 5 退出标准③：**用 mock 可走通一条完整业务流。**

   走的是 CRC 每天真正要走的那条路：
     看今天谁到期 → 打开超窗的那一例 → 逐项勾任务 → 填超窗原因 →
     提交 → 看到一串后果 → 去质量台账确认偏离真的在那儿。

   为什么非要走到最后一步：**「提交成功」不等于「后果发生了」。**
   前端把 sideEffects 摊开给一线看，是这套设计的核心承诺之一 ——
   一线必须立刻知道「我刚才不只是打了个卡」。
   ════════════════════════════════════════════════════════════════════ */

test("CRC 的一天：从今日清单走到方案偏离进台账", async ({ page }) => {
  await page.goto("/today");

  /* ① 今日清单按窗口关闭日升序，超窗的排最上面 */
  const rows = page.getByTestId("visit-row");
  await expect(rows.first()).toBeVisible();
  await expect(page.getByTestId("today-summary")).toContainText("已超窗");
  await expect(rows.first()).toContainText("已超窗");

  /* ② 打开超窗那一例 */
  await rows.first().getByRole("link", { name: "打开" }).click();
  await expect(page.getByRole("heading", { level: 2 })).toBeVisible();

  /* ③ 任务没勾完 → 提交是禁用的，且旁边写清楚还差什么 */
  const submit = page.getByTestId("submit");
  await expect(submit).toBeDisabled();
  await expect(page.getByTestId("blocked-hint")).toContainText("还有");

  /* ④ 逐项勾掉。
        用 click 而不是 check：check() 会断言点完的**那一瞬间**已经勾上，
        而这里的勾选要等服务端确认后才回写 —— 那正是我们想要的行为
        （乐观更新会让一次失败的提交看起来像成功了）。 */
  await tickAllTasks(page);
  await expect(page.getByTestId("blocked-hint")).toHaveCount(0);

  /* ⑤ 今天已经超窗了 → 必须填原因，不填仍然提交不了 */
  await expect(page.getByTestId("oow-reason")).toBeVisible();
  await expect(submit).toBeDisabled();
  await page.getByTestId("oow-reason").fill("受试者外地务工，返院延迟");
  await expect(submit).toBeEnabled();

  /* ⑥ 提交 → 一串后果原样摊开 */
  await submit.click();
  const effects = page.getByTestId("effects");
  await expect(effects).toBeVisible();
  for (const type of ["DeviationDetected", "CompensationDue",
                      "TimesheetPosted", "CostPosted", "NextVisitScheduled"])
    await expect(effects).toContainText(type);

  /* 七个订阅者全接上了，界面上不该再出现"待接"那一块。
     它曾经挂着 RefreshProjections —— 断言它消失了，
     是为了防止有人把"已交付"改回去而没人发现。 */
  await expect(page.getByTestId("pending-subscribers")).toHaveCount(0);

  /* ⑦ 去质量台账确认偏离真的在那儿。
        「提交成功」不等于「后果发生了」，这一步才是闭环。 */
  await page.getByRole("link", { name: "质量台账" }).click();
  const item = page.getByTestId("quality-item").first();
  await expect(item).toContainText("访视超窗");
  await expect(item).toContainText("系统自动生成");
  await expect(item).toContainText("受试者外地务工");
});

test("窗口内完成不要求填原因，也不生成偏离", async ({ page }) => {
  await page.goto("/today");
  /* 挑一行「窗口内」的 */
  const row = page.getByTestId("visit-row").filter({ hasText: "窗口内" }).first();
  await row.getByRole("link", { name: "打开" }).click();

  await tickAllTasks(page);
  /* 把完成日改成目标日 —— 窗口正中 */
  const target = await page.getByTestId("actual-date").getAttribute("value");
  expect(target).toBeTruthy();

  await expect(page.getByTestId("oow-reason")).toHaveCount(0);
  /* 勾完最后一项到"提交"真的可按之间，还隔着一次回读 ——
     `tickAllTasks` 只等到复选框自己变了，那是**代理状态**，不是闸门本身。
     少了这一行会偶尔红在「submit 仍然 disabled」上，而且看起来像功能坏了。
     （同一条规则在这个仓库里栽过四次，都记在 integration/README.md。） */
  await expect(page.getByTestId("submit")).toBeEnabled();
  await page.getByTestId("submit").click();
  const effects = page.getByTestId("effects");
  await expect(effects).toBeVisible();
  await expect(effects).not.toContainText("DeviationDetected");
  await expect(effects).toContainText("NextVisitScheduled");
});
