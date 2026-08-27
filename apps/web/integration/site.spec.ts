import { test, expect, type Page } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   Site & Staffing 的纵切：DB → API → Backend → Frontend → 集成。

   这里**不打 mock**。同一条闸门流程在 e2e 上已经走通了，
   现在换成真库真接口 —— 差别在于两件 mock 永远证明不了的事：

   ① 真实的启动清单有 16 项、其中 9 项阻塞，
      而 mock 里那份是照着同一个常量铺的 —— 只有真库能验证
      「建档时铺开」这条真的执行了，且 RLS 让当事人看得见自己的那份。
   ② **权限是两个人的事。** CRC 把清单做完，PM 才按得动推进 ——
      这条分工在 mock 上是我自己编的，在真库上是种子里的 role_action。
   ════════════════════════════════════════════════════════════════════ */

async function devLogin(page: Page, testid: string) {
  await page.goto("/login");
  await page.getByTestId("dev-panel").locator("summary").click();
  await page.getByTestId(testid).click();
  await expect(page).toHaveURL(/\/today$/);
}

/** 开发登录只列了 5 个账号；其余账号走一次性链接这条真实路径。 */
async function linkLogin(page: Page, login: string) {
  await page.goto("/login");
  await page.getByTestId("login-input").fill(login);
  await page.getByTestId("request-link").click();
  await page.getByTestId("redeem").click();
  await expect(page).toHaveURL(/\/today$/);
}

async function openSite(page: Page, code: string) {
  await page.goto("/sites");
  await expect(page.getByTestId("site-row").first()).toBeVisible();
  await page.getByRole("link", { name: code, exact: true }).click();
  await expect(page.getByTestId("flow")).toBeVisible();
}

/** 逐项勾掉阻塞项，每一项都等服务端回写后再点下一个。 */
async function clearBlockers(page: Page) {
  const boxes = page.locator('[data-testid=startup-item][data-blocking="1"] '
    + 'input[type=checkbox]:not(:checked)');
  for (let n = await boxes.count(); n > 0; n = await boxes.count()) {
    await boxes.first().click();
    await expect(boxes).toHaveCount(n - 1);
  }
}

test.describe("SIV 闸门：说得出还差什么，也说得出轮不轮得到你", () => {
  test("CRC 打开 SS-14：闸门拦下，且列的是真实的清单项名字", async ({ page }) => {
    await linkLogin(page, "fengle");                 // SS-14 的 CRC
    await openSite(page, "SS-14");

    await expect(page.getByTestId("flow").locator("li.now")).toHaveText("合同签署");
    await expect(page.getByTestId("gate-blocked")).toBeVisible();

    const unmet = page.getByTestId("unmet");
    await expect(unmet).toContainText("启动清单仍有");
    await expect(unmet).toContainText("startup");
    /* 关键：消息里是**真实的清单项**，不是「该模块尚未交付」那种占位 */
    await expect(unmet).not.toContainText("尚未交付");
    await expect(page.getByTestId("advance")).toBeDisabled();
  });

  test("CRC 把阻塞项清零：闸门放行，但按钮仍然点不动 —— 界面说得出为什么",
    async ({ page }) => {
      await linkLogin(page, "fengle");
      await openSite(page, "SS-14");

      await page.getByTestId("go-startup").click();
      await expect(page.getByTestId("blocking-banner")).toContainText("不能推进");
      expect(Number(await page.getByTestId("blocking-open").innerText()))
        .toBeGreaterThan(0);

      await clearBlockers(page);
      await expect(page.getByTestId("blocking-banner")).toContainText("已全部清零");
      /* 清掉最后一个阻塞项时，后端顺带告诉你"现在可以推进了" */
      await expect(page.getByTestId("checklist-effects")).toContainText("可以推进");
      /* 非阻塞项仍然开着 —— 证明闸门看的是阻塞项，不是"全部做完" */
      await expect(page.locator('[data-testid=startup-item][data-blocking="0"] '
        + 'input:not(:checked)').first()).toBeVisible();

      await page.getByRole("link", { name: /中心详情/ }).click();
      await expect(page.getByTestId("gate-open")).toBeVisible();

      /* **这才是这条测试真正要证明的：** 事做完了，按钮还是不能点，
         因为种子里的 CRC 没有 advance 动作权限 —— 而界面说得出这件事，
         不是给一个没有解释的灰按钮。 */
      await expect(page.getByTestId("no-advance-action")).toContainText("advance");
      await expect(page.getByTestId("advance")).toBeDisabled();
      await expect(page.getByTestId("advance-reason")).toHaveCount(0);
    });

  test("经营层接手：填原因才推得动，推完状态机走一格", async ({ page }) => {
    await devLogin(page, "dev-lingyuan");
    await openSite(page, "SS-14");

    /* 上一条测试已经把阻塞项清零了 —— 闸门对这个人也一样放行 */
    await expect(page.getByTestId("gate-open")).toBeVisible();
    await expect(page.getByTestId("advance")).toBeDisabled();   // 还没写原因

    await page.getByTestId("advance-reason")
      .fill("启动阻塞项已全部清零，机构同意本周排期");
    await expect(page.getByTestId("advance")).toBeEnabled();
    await page.getByTestId("advance").click();

    await expect(page.getByTestId("advance-effects")).toContainText("SiteStateChanged");
    await expect(page.getByTestId("flow").locator("li.now")).toHaveText("SIV启动");
    /* 真库上推进到 siv 会回填 siv_on —— 界面上的"实际 SIV"随之有值 */
    await expect(page.getByTestId("gate")).toContainText("入组中");
  });
});

test.describe("交接：签了字但受试者没交底，等于没交接", () => {
  test("未逐项确认时点完成 → 逐条列出还差哪几项", async ({ page }) => {
    await linkLogin(page, "fengle");                 // 他是这笔交接的接手人

    /* 前置：**交接进行中，他已经看得到 SS-13 了**（迁移 0021）。
       这条断言曾经是 `toHaveCount(0)` —— 那是 0021 之前的行为，
       而它恰好是"接手人勾『逐例交底』时其实一张名单都对不上"的根源。

       写成断言而不是删掉，是因为这条通道有边界：它只在
       `handover.status = 'pending'` 时成立。下面那条测试证明的
       正是边界的另一半 —— 单子一离开 pending，这条通道就关了，
       而 SS-13 仍然在，说明真派工确实转过来了。 */
    await page.goto("/sites");
    await expect(page.getByTestId("site-row").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "SS-13", exact: true })).toBeVisible();

    await page.goto("/handovers");
    const card = page.getByTestId("handover").first();
    await expect(card).toBeVisible();
    /* 种子里这笔已确认 2 项（含"逐例交底"那一项），还差 6 项 */
    await expect(card.getByTestId("handover-progress")).toHaveText("2/8");
    /* 「最要命的一项」的角标只在它**还开着**时出现。
       这笔种子里它已经确认了，所以角标不该在 —— 这条断言验的是
       角标是有条件的，不是一个永远挂着的装饰。 */
    await expect(card.getByTestId("critical-item")).toHaveCount(0);

    /* 按钮不禁用：点下去拿到的是后端逐条列出的未确认项。
       前端不替后端做闸门判定 —— 两边各判一次，迟早长出分歧。 */
    await card.getByTestId("finish-handover").click();
    const unmet = page.getByTestId("handover-unmet");
    await expect(unmet).toContainText("试验用药品实盘与账实核对");
    /* **关键**：已确认的两项不在未确认清单里。
       这证明这份清单是真实的开口集合，不是一份写死的八项 ——
       而"写死的八项"恰好会让这个测试用更宽松的断言照样通过。 */
    await expect(unmet).not.toContainText("在组受试者逐例交底");
    await expect(unmet.locator("li")).toHaveCount(6);
  });

  test("逐项确认后完成 → 派工真的转过去了", async ({ page }) => {
    await linkLogin(page, "fengle");
    await page.goto("/handovers");
    const card = page.getByTestId("handover").first();
    /* **先等列表渲染出来再数复选框。**
       `goto` 之后立刻 `count()` 拿到的是 0，循环一次都不进，
       然后直接点「完成」—— 拿到的是 422「还有 6 项未确认」，
       看起来像逐项确认坏了，其实是断言跑在数据前面。
       （integration/README 里记的是 `allInnerTexts()` 的同一个坑，
         换成 `count()` 之后它更隐蔽：0 不像空数组那样显眼。）

       **分两步等**：先等卡片本身出现，再断言它的内容。
       直接断言嵌套的 `handover-progress` 会把「列表还没回来」
       和「回来了但数字不对」挤进同一个 5 秒里 ——
       整套跑到这一条时接口明显更慢（listHandovers 是 N+1，已记在已知问题里），
       于是失败信息说的是"找不到元素"，指向完全错的方向。 */
    await expect(card).toBeVisible();
    await expect(card.getByTestId("handover-progress")).toHaveText("2/8");

    const boxes = card.locator(".tasks input[type=checkbox]:not(:checked)");
    await expect(boxes).toHaveCount(6);
    for (let n = await boxes.count(); n > 0; n = await boxes.count()) {
      await boxes.first().click();
      await expect(boxes).toHaveCount(n - 1);
    }
    await expect(card.getByTestId("handover-progress")).toHaveText("8/8");
    await card.getByTestId("finish-handover").click();
    await expect(page.getByTestId("handover-effects")).toContainText("派工已由");

    /* **闭环**，而且是**关掉另一条路之后**的闭环。

       "完成之后他看得到 SS-13"这句话单独拿出来证明不了任何事：
       交接期间他本来就看得到（迁移 0021 的预览通道）。
       要让它成为证明，得先确认那条预览通道已经关上 ——
       它的条件是 `status = 'pending'`，所以先断言单子不再是待接手。

       两条合起来才是那句话：预览没了，SS-13 还在，
       那它只能来自真的派工。 */
    await expect(card.getByText("已完成")).toBeVisible();

    await page.goto("/sites");
    await expect(page.getByTestId("site-row").first()).toBeVisible();
    await expect(page.getByRole("link", { name: "SS-13", exact: true })).toBeVisible();
  });
});
