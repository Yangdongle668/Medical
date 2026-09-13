import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   派工 —— 这件事此前**在界面上根本做不了**。

   `site_assignment` 是行规则 `assigned` 的唯一来源（迁移 0002），
   而在这一版之前全系统没有一处往里写：种子灌了 30 行，
   交接（`app.transfer_handover_assignments`）在两个人之间挪行 ——
   挪的是已经存在的那些。第一行从哪来，没有答案。

   于是「派工与产能」这一页有「带中心」那一列、有「无人可接」的角标，
   **唯独没有那个动词**。开发库的审计轨迹里留着绕过去的痕迹：

     09-06 11:13  admin  调整角色权限  crc
                  rowRule: assigned → team    理由：「改为按组切行」

   派不了工，就把整个角色的行规则改掉 —— 从此每个 CRC 看得到本组
   全部项目的全部中心。**一个建不出来的东西，会被人用改规则的方式
   绕过去**，而绕过去之后没有任何地方是红的。

   下面这几条走的是那条真正的路：挑人 → 挑项目 → 勾中心 → 派 →
   那几个中心出现在他名下 → 撤下 → 不见了。
   ════════════════════════════════════════════════════════════════════ */

test.describe("派工与产能 · 派得动人", () => {
  test("挑人 → 挑项目 → 勾中心 → 派出去", async ({ page }) => {
    await page.goto("/staff?as=pm");
    await expect(page.getByTestId("staff-row").first()).toBeVisible();

    await page.getByTestId("assign").click();
    await expect(page.getByTestId("assign-form")).toBeVisible();

    /* 人只列 CRA / CRC —— PM 的范围来自项目归属组，不是派工。 */
    await page.getByTestId("assign-who").selectOption({ index: 1 });
    await page.getByTestId("assign-study").selectOption({ index: 1 });

    /* 中心是勾出来的，不是下拉选的：一次派一批是常态，
       而「这几家归他、那几家不归」正是这一步要表达的东西。 */
    await expect(page.getByTestId("assign-sites")).toBeVisible();
    const 勾 = page.getByTestId("assign-sites").locator("input[type=checkbox]:not([disabled])");
    await expect(勾.first()).toBeVisible();
    await 勾.first().check();

    /* 提交按钮在原因填够之前不该亮 —— 这是权限变更，必须写原因。 */
    await expect(page.getByTestId("assign-submit")).toBeDisabled();
    await page.getByTestId("assign-reason").fill("SS-02 的 CRA 休产假，这个中心转给他");
    await page.getByTestId("assign-submit").click();

    /* 说的是**后果**，不是「操作成功」—— 点这一下的人未必想到
       它连着受试者明细。 */
    await expect(page.getByTestId("toast")).toContainText("看得见");
  });

  test("已经在跑的中心标出来而不是藏起来 —— 「他在不在这个中心上」要答得出", async ({ page }) => {
    await page.goto("/staff?as=pm");
    await page.getByTestId("assign").click();
    /* 吴桐（CRC）在 mock 里已经跑着 SS-01 与 SS-07。 */
    await page.getByTestId("assign-who").selectOption({ index: 1 });
    await page.getByTestId("assign-study").selectOption({ index: 1 });
    await expect(page.getByTestId("assign-held").first()).toBeVisible();
    /* 已在跑的那几个勾不动：勾了也是白勾，服务端会跳过。 */
    await expect(
      page.getByTestId("assign-sites").locator("input[type=checkbox][disabled]").first()
    ).toBeVisible();
  });

  test("「带中心」那个数点得开，撤下之后当场少一个", async ({ page }) => {
    await page.goto("/staff?as=pm");
    await expect(page.getByTestId("staff-row").first()).toBeVisible();

    await page.getByTestId("open-sites").first().click();
    await expect(page.getByTestId("staff-sites")).toBeVisible();
    const 行 = page.getByTestId("assigned-sites").locator("li");
    const before = await 行.count();
    expect(before).toBeGreaterThan(0);

    /* 撤下要写原因，而且原因留在这一行上，不是弹一个对话框：
       对话框一关，"为什么撤的"就只剩审计里那一条。 */
    await page.getByTestId("staff-sites").getByRole("button", { name: "撤下" }).first().click();
    await expect(page.getByTestId("unassign-form")).toBeVisible();
    await expect(page.getByTestId("unassign-submit")).toBeDisabled();
    await page.getByTestId("unassign-reason").fill("他调去 HJ-2025-003 了");
    await page.getByTestId("unassign-submit").click();

    await expect(page.getByTestId("toast")).toContainText("看不见");
  });

  test("**没有 assign 动作的人，这一页上没有那个按钮** —— 不是点了才被拒", async ({ page }) => {
    /* CRC 没有 assign：给一个永远点不亮的按钮，
       等于把权限模型的复杂度转嫁给最没空琢磨它的人。 */
    await page.goto("/staff?as=crc");
    await expect(page.getByTestId("assign")).toHaveCount(0);
  });
});

test.describe("中心详情 · 这个中心上有谁", () => {
  test("两栏分开列，因为它们是两条不同的行规则", async ({ page }) => {
    await page.goto("/sites?as=pm");
    await page.getByTestId("open-site").first().click();
    await expect(page.getByTestId("site-crew")).toBeVisible();
    await expect(page.getByTestId("site-crew")).toContainText("site_assignment");
    await expect(page.getByTestId("site-crew")).toContainText("pi_account_id");
  });

  test("没绑账号的 PI **说清楚它只是一个名字** —— 他登进来一个中心也看不到",
    async ({ page }) => {
      /* mock 里 SS-07 / SS-14 的 piAccountId 是 null，
         而它们的 piName 照样有值 —— 那一栏看着是填好的。 */
      await page.goto("/sites?as=pm");
      const rows = page.getByTestId("site-row");
      await expect(rows.first()).toBeVisible();
      for (let i = 0; i < await rows.count(); i++) {
        await rows.nth(i).getByTestId("open-site").click();
        await expect(page.getByTestId("site-crew")).toBeVisible();
        if (await page.getByTestId("pi-unbound").count()) {
          await expect(page.getByTestId("pi-unbound")).toContainText("只是一个名字");
          return;
        }
        await page.goBack();
        await expect(rows.first()).toBeVisible();
      }
      throw new Error("mock 里应当有一个没绑 PI 账号的中心 —— 那一栏的空态没演出来");
    });

  test("绑一个研究者账号：绑完那一栏变成「已绑账号」", async ({ page }) => {
    await page.goto("/sites?as=pm");
    const rows = page.getByTestId("site-row");
    await expect(rows.first()).toBeVisible();
    for (let i = 0; i < await rows.count(); i++) {
      await rows.nth(i).getByTestId("open-site").click();
      await expect(page.getByTestId("site-crew")).toBeVisible();
      if (await page.getByTestId("pi-unbound").count()) break;
      await page.goBack();
      await expect(rows.first()).toBeVisible();
    }

    await page.getByTestId("edit-pi").click();
    await expect(page.getByTestId("pi-form")).toBeVisible();
    await page.getByTestId("pi-account").selectOption({ index: 1 });
    await expect(page.getByTestId("pi-submit")).toBeDisabled();
    await page.getByTestId("pi-reason").fill("机构发文确认由他担任本中心主要研究者");
    await page.getByTestId("pi-submit").click();

    await expect(page.getByTestId("toast")).toContainText("看得见");
    await expect(page.getByTestId("pi-bound")).toBeVisible();
  });
});
