import { test, expect, type Page } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   闸门这条流：**"还差什么"必须说得出口。**

   走的是启动一个中心真正要走的路：
     我的中心 → 打开一个停在「合同签署」的 → 闸门拦下并逐条列出 →
     顺着"去处理"进启动清单 → 逐项清阻塞 → 回详情 → 闸门放行 → 推进。

   最后一步刻意分两次点：先不填原因（推进按钮不亮），再填上（亮）。
   推进在 SENSITIVE_ACTIONS 里，**每一次**都要写原因 ——
   半年后核查问「为什么这天启动」，
   审计轨迹里只有一个人名和一个时刻是答不上来的。
   ════════════════════════════════════════════════════════════════════ */

/** 逐项勾掉阻塞项，每一项都等服务端回写后再点下一个。 */
async function clearBlockers(page: Page) {
  const blocking = page.locator('[data-testid=startup-item][data-blocking="1"] '
    + 'input[type=checkbox]:not(:checked)');
  for (let n = await blocking.count(); n > 0; n = await blocking.count()) {
    await blocking.first().click();
    await expect(blocking).toHaveCount(n - 1);
  }
}

test("启动一个中心：闸门拦下 → 清阻塞项 → 放行 → 推进到 SIV", async ({ page }) => {
  /* `?as=boss` 换成有 advance 动作权限的身份。
     mock 里的 CRC **没有** advance —— 那是种子里的真实口径，
     不能为了让测试跑通而把它抹平（下一个测试正是验这条差别）。 */
  await page.goto("/sites?as=boss");

  /* ① 从台账进详情。SS-14 停在「合同签署」，下一步正是 siv */
  await page.getByRole("link", { name: "SS-14" }).click();
  await expect(page.getByTestId("flow")).toBeVisible();
  await expect(page.getByTestId("flow").locator("li.now")).toHaveText("合同签署");

  /* ② 闸门拦下，且**逐条**说得出还差什么 —— 不是一个变灰的按钮 */
  await expect(page.getByTestId("gate-blocked")).toBeVisible();
  const unmet = page.getByTestId("unmet");
  await expect(unmet).toContainText("启动清单仍有");
  await expect(unmet).toContainText("startup");
  await expect(page.getByTestId("advance")).toBeDisabled();

  /* ③ 顺着"去处理"进清单 —— 这条链接才是"说得出去哪儿办"的那一半 */
  await page.getByTestId("go-startup").click();
  await expect(page.getByTestId("blocking-banner")).toContainText("不能推进");
  const open = Number(await page.getByTestId("blocking-open").innerText());
  expect(open).toBeGreaterThan(0);

  /* ④ 逐项清零。非阻塞项**不需要**清 —— 闸门只看阻塞项 */
  await clearBlockers(page);
  await expect(page.getByTestId("blocking-banner")).toContainText("已全部清零");
  /* 清掉最后一个阻塞项时，后端顺带告诉你"现在可以推进了" */
  await expect(page.getByTestId("checklist-effects")).toContainText("可以推进");
  /* 而非阻塞项确实还留着 —— 证明闸门看的不是"全部做完" */
  await expect(page.locator('[data-testid=startup-item][data-blocking="0"] '
    + 'input:not(:checked)').first()).toBeVisible();

  /* ⑤ 回详情：闸门放行 */
  await page.getByRole("link", { name: /中心详情/ }).click();
  await expect(page.getByTestId("gate-open")).toBeVisible();

  /* ⑥ 推进是敏感动作 → 不填原因，按钮仍然不亮 */
  await expect(page.getByTestId("advance")).toBeDisabled();
  await expect(page.getByTestId("irreversible")).toBeVisible();
  await page.getByTestId("advance-reason").fill("启动阻塞项已全部清零，机构同意排期");
  await expect(page.getByTestId("advance")).toBeEnabled();

  /* ⑦ 推进 → 状态机走了一格，副作用摊开 */
  await page.getByTestId("advance").click();
  await expect(page.getByTestId("advance-effects")).toContainText("SiteStateChanged");
  await expect(page.getByTestId("flow").locator("li.now")).toHaveText("SIV启动");
});

test("交接：逐项确认之前，'完成'点下去会逐条告诉你还差什么", async ({ page }) => {
  await page.goto("/handovers");

  const card = page.getByTestId("handover").first();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("handover-progress")).toHaveText("0/8");
  /* 最容易漏的那一项被单独标出来 —— 它不在 EDC 里，只在上一个 CRC 脑子里 */
  await expect(card.getByTestId("critical-item")).toBeVisible();

  /* 按钮**不禁用**：点下去拿到的是后端逐条列出的未确认项。
     前端不替后端做闸门判定 —— 两边各判一次，迟早长出分歧。 */
  await card.getByTestId("finish-handover").click();
  await expect(page.getByTestId("handover-unmet")).toContainText("在组受试者逐例交底");

  /* 逐项确认后再完成 → 派工转移作为副作用摊开 */
  const boxes = card.locator(".tasks input[type=checkbox]:not(:checked)");
  for (let n = await boxes.count(); n > 0; n = await boxes.count()) {
    await boxes.first().click();
    await expect(boxes).toHaveCount(n - 1);
  }
  await card.getByTestId("finish-handover").click();
  await expect(page.getByTestId("handover-effects")).toContainText("派工已由");
});


test("CRC 把清单做完了，按钮仍然点不动 —— 而界面说得出为什么", async ({ page }) => {
  /* 上一个测试已经把 SS-14 推到 siv 了，所以这里看的是 SS-01：
     它在「入组中」，下一步 enrolled 没有闸门 —— 前置条件天然满足。
     于是按钮点不动的原因**只剩一个**：这个人没有 advance。
     这正是要单独拿出来说的那一半：
     "还差什么" 和 "轮不轮得到你" 是两件事，混成一个灰按钮就都说不清。 */
  await page.goto("/sites?as=crc");
  await page.getByRole("link", { name: "SS-01" }).click();

  await expect(page.getByTestId("gate-open")).toBeVisible();
  await expect(page.getByTestId("no-advance-action")).toContainText("advance");
  await expect(page.getByTestId("advance")).toBeDisabled();
  /* 填不了的原因框干脆不出现 —— 一个永远提交不了的输入框只会浪费人的时间 */
  await expect(page.getByTestId("advance-reason")).toHaveCount(0);
});
