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
    await expect(page.getByTestId("subject-row").filter({ hasText: "P099" })).toHaveCount(0);
    await page.getByTestId("open-only").uncheck();
    const failed = page.getByTestId("subject-row").filter({ hasText: "P099" });
    await expect(failed).toContainText("筛败");
    /* 已经出组的没有下一步，所以排最后 */
    await expect(page.getByTestId("subject-row").last()).toContainText("P099");
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
    const row = page.getByTestId("pre-row").filter({ hasText: "P102" });
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
    /* **两道都要等，而且顺序不能反。** 这一页分两轮取数：先拿中心列表把
       卡片画出来，再每个中心一条请求去拿递交记录。
       ① 等 `ethics-site` —— 第一轮回来了，卡片在了；
       ② 再等 `ethics-loading` 归零 —— 第二轮也回来了，记录在了。
       只做①，`before` 会在第二轮之前数到 0；只做②更糟：那一刻连卡片
       都还没有，`ethics-loading` 本来就是 0，断言当场通过，等于没等。
       这条为此红过两次，都是 expected 1 / received 5。 */
    await expect(page.getByTestId("ethics-site").first()).toBeVisible();
    await expect(page.getByTestId("ethics-loading")).toHaveCount(0);
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

/* ════════════════════════════════════════════════════════════════════
   被拦下来，要说得出**去哪儿办** —— 现场报来的那条通则。

     「我找不到这个对应的入口，我想 CRC 每一步点击如果被阻塞了，
       除了要有文字的提示，应该还要有一个跳转的链接，
       这样不用特地去找对应的入口和功能了。」

   在这之前**五个页面各自**把未满足项渲染成一行纯文字，一个链接都没有；
   而服务端发的 `module` 里，十条有八条是**模块表里根本没有的键**
   （clinical / regulatory / quality）—— 就算画链接也解析不出去处。
   两头都修了：shell/Unmet.tsx 统一渲染，apps/api/test/gate-module.test.ts
   钉住每个键都得是真键。
   ════════════════════════════════════════════════════════════════════ */
test.describe("被拦下来要给得出去处", () => {
  test("入组被拦：说得出还差什么，**并且给一个跳转链接**", async ({ page }) => {
    await page.goto("/prescreen?as=crc");
    /* SS-01-P102 签了知情、在筛选中，而它的筛选期访视还没登记 PI 确认。 */
    const row = page.getByTestId("pre-row").filter({ hasText: "SS-01-P102" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "入组" }).click();
    await page.getByTestId("enroll-no").fill("R-LINK-1");
    await page.getByTestId("enroll-go").click();

    const unmet = page.getByTestId("prescreen-unmet");
    await expect(unmet).toBeVisible();
    /* ① 文字要说得出下一步。SS-01-P102 这一例走的是"连访视都没有"那一支 ——
       **不许写「先去登记 ICF」**：他已经签过了（不然进不了筛选中），
       叫他再签一次是把一句办不到的事写成了下一步。
       也不许出现"等 PI"那种说法：PI 多数时候没有本系统的账号，等就是永远。 */
    await expect(unmet).toContainText("没有筛选期访视");
    await expect(unmet).not.toContainText("登记 ICF");
    await expect(unmet).not.toContainText("需 PI 确认");
    /* ② 链接 —— 这一条才是现场要的那一半。 */
    await expect(unmet.getByTestId("go-subj")).toBeVisible();
    await unmet.getByTestId("go-subj").click();
    await expect(page).toHaveURL(/\/subjects/);
  });

  test("角标写的是模块中文名，不是 `subj` 这种键", async ({ page }) => {
    /* 键是给程序看的。这张清单是给被拦下来的那个人看的。 */
    await page.goto("/prescreen?as=crc");
    const row = page.getByTestId("pre-row").filter({ hasText: "SS-01-P102" });
    await row.getByRole("button", { name: "入组" }).click();
    await page.getByTestId("enroll-no").fill("R-LINK-2");
    await page.getByTestId("enroll-go").click();
    const unmet = page.getByTestId("prescreen-unmet");
    await expect(unmet).toContainText("受试者访视窗口");
    await expect(unmet).not.toContainText("subj");
  });
});
