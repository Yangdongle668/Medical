import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   组织与权限 —— 管理员那一页。

   盯三件事，每一件都是"看起来能用其实没用"的常见形状：
     ① 导航是按 role_module 出的，不是写死的六项；
     ② 三维权限改得动，而且界面说得出改了什么、要为什么；
     ③ 没有 manage 的人进来，得到的是一句话，不是一串 403。
   ════════════════════════════════════════════════════════════════════ */

test.describe("经营层：组织与权限", () => {
  test.beforeEach(async ({ page }) => { await page.goto("/sites?as=boss"); });

  test("侧栏按库里的授予出 —— 19 个模块，不是写死的六项", async ({ page }) => {
    const nav = page.locator(".rail nav");
    /* 原型里经营层是 19 个模块，去重后（sites 只出现一次）仍然远多于 6 */
    await expect(nav.locator("a")).toHaveCount(19);
    /* 分组标题在，说明侧栏是按 MOD_GROUP 铺的 */
    await expect(nav).toContainText("经营");
    await expect(nav).toContainText("系统");
    await expect(nav.getByRole("link", { name: "组织与权限" })).toBeVisible();
  });

  test("还没建的页有入口，点进去说得出它将来要回答什么", async ({ page }) => {
    /* 挑一个**还没建**的模块。这条测试已经响过三次了：
       经营驾驶舱 → 合同变更 → 监查访视 → 现在是「立项与建档」。
       每一次它都红在"找不到 coming-soon"上，
       报错看着像导航坏了，实际只是它盯的那一页交付了。

       **响是对的** —— 它是这条不变量的哨兵：
       「库里给了这个模块」和「界面上有这个入口」必须一致。
       建好一页却忘了从登记表里删 todo，这条同样会红。
       （nav.test.ts 里那条逐个点名的断言是它在单测一侧的对偶。） */
    await page.getByRole("link", { name: "立项与建档" }).click();
    await expect(page.getByTestId("coming-soon")).toBeVisible();
    /* 不是一句"敬请期待" —— 说的是这一页该有什么 */
    await expect(page.locator(".card")).toContainText("立项");
  });

  test("建号 → 台账里立刻有他 → 停用要理由", async ({ page }) => {
    await page.getByRole("link", { name: "组织与权限" }).click();
    /* **先等第一行出现再数。** 点完立刻 count() 拿到的是 0，
       于是下面那句变成"期望 1 行"，而失败信息说的是"收到 13 行"——
       看起来像建号建出了一堆，其实只是断言跑在数据前面。
       （integration/README 里记的是 allInnerTexts() 的同一个坑。） */
    await expect(page.getByTestId("account-row").first()).toBeVisible();
    const before = await page.getByTestId("account-row").count();

    await page.getByTestId("new-name").fill("周敏");
    await page.getByTestId("new-login").fill("zhoumin");
    await page.getByTestId("new-role").selectOption({ label: "临床协调员 CRC" });
    await page.getByTestId("create-account").click();

    await expect(page.getByTestId("account-row")).toHaveCount(before + 1);
    await expect(page.getByTestId("org-said")).toContainText("周敏");

    /* 停用要理由：不填就点不动。半年后"这个人三月为什么被停用"
       只有这一行答得出来。 */
    await page.getByTestId("disable-zhoumin").click();
    await expect(page.getByTestId("disable-zhoumin-go")).toBeDisabled();
    await page.getByTestId("disable-zhoumin-reason").fill("试用期未通过");
    await page.getByTestId("disable-zhoumin-go").click();
    await expect(page.getByTestId("org-said")).toContainText("已停用");
  });

  test("机构办角色不给所属机构，表单自己就不让提交", async ({ page }) => {
    await page.getByRole("link", { name: "组织与权限" }).click();
    await expect(page.getByTestId("account-row").first()).toBeVisible();
    await page.getByTestId("new-name").fill("测试机构老师");
    await page.getByTestId("new-login").fill("testinst");
    await page.getByTestId("new-role").selectOption({ label: "机构办（外部）" });
    /* 选了这个角色，所属机构那一栏才出现 —— 而且它出现就是必填 */
    await expect(page.getByTestId("new-orgref")).toBeVisible();
    await expect(page.getByTestId("create-account")).toBeDisabled();
    await page.getByTestId("new-orgref").fill("北京协和医院");
    await expect(page.getByTestId("create-account")).toBeEnabled();
  });

  test("改权限要理由，且界面说清改的是什么", async ({ page }) => {
    await page.getByRole("link", { name: "组织与权限" }).click();
    /* 同上：角色还没回来就切页签的话，权限矩阵是一张空表，
       下面那个复选框根本不存在。 */
    await expect(page.getByTestId("account-row").first()).toBeVisible();
    await page.getByTestId("tab-perm").click();
    await expect(page.getByTestId("role-row").first()).toBeVisible();

    /* 给 CRA 勾上「报价与合同金额」 */
    await page.getByTestId("field-cra-price").check();
    const confirm = page.getByTestId("confirm-change");
    await expect(confirm).toContainText("临床监查员 CRA 获得「报价与合同金额」");
    /* 没有理由，确认按钮不动 */
    await expect(page.getByTestId("change-go")).toBeDisabled();
    await page.getByTestId("change-reason").fill("本季度中心谈判需要");
    await page.getByTestId("change-go").click();

    await expect(page.getByTestId("org-said")).toContainText("获得");
    await expect(page.getByTestId("field-cra-price")).toBeChecked();
  });

  test("模块勾选说清自己不是安全边界", async ({ page }) => {
    await page.getByRole("link", { name: "组织与权限" }).click();
    await expect(page.getByTestId("account-row").first()).toBeVisible();
    await page.getByTestId("tab-perm").click();
    await expect(page.getByTestId("role-row").first()).toBeVisible();
    await page.getByRole("row", { name: /数据管理 DM/ }).getByRole("button", { name: /个模块/ }).click();
    const picker = page.getByTestId("module-picker");
    await expect(picker).toContainText("只收敛导航，不是安全边界");
    await expect(page.getByTestId("mod-dm-trail")).toBeChecked();
  });

  test("分组页说得出未分组的人是谁", async ({ page }) => {
    await page.getByRole("link", { name: "组织与权限" }).click();
    await expect(page.getByTestId("account-row").first()).toBeVisible();
    await page.getByTestId("tab-group").click();
    await expect(page.getByTestId("team-card")).toHaveCount(3);
    /* 分组不是通讯录 —— 这句话要在页面上，因为它是这一页存在的理由 */
    await expect(page.locator(".derive")).toContainText("权限的行维度");
  });
});

test("CRC 手敲进来：一句话，不是一串 403", async ({ page }) => {
  await page.goto("/org");
  await expect(page.getByTestId("org-forbidden")).toContainText("服务端不答应");
});
