import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   组织与权限 —— 管理员那一页。

   盯三件事，每一件都是"看起来能用其实没用"的常见形状：
     ① 导航是按 role_module 出的，不是写死的六项；
     ② 三维权限改得动，而且界面说得出改了什么、要为什么；
     ③ 没有 manage 的人进来，得到的是一句话，不是一串 403。
   ════════════════════════════════════════════════════════════════════ */

test.describe("导航与页面一一对应", () => {
  /* 这里原来盯的是**还没建的那一页**：挑一个待建模块，点进去，
     断言它说得出自己将来要回答什么。那条测试响过五次 ——
     经营驾驶舱 → 合同变更 → 监查访视 → 立项与建档 → 中心文件与物资，
     每一次都红在"找不到 coming-soon"上，而每一次的原因都是它盯的那一页交付了。

     现在没有待建页了，于是它翻过来：**侧栏里的每一个入口都得落到真页面**。
     守的还是同一条不变量 —— 「库里给了这个模块」与「界面上有这个入口」
     必须一致 —— 只是从"待建的那一页在"变成了"一页都不待建"。
     往后再加模块，忘了在 main.tsx 登记路由，这条立刻会红。 */
  for (const [role, count] of [["crc", 14], ["inst", 4], ["boss", 19]] as const) {
    test(`${role} 的每一个入口都点得进真页面`, async ({ page }) => {
      /* **点链接，不是逐个 page.goto。** 整页重载会把 MSW 的 service worker
         连同 mock 场景一起重来一遍，十九次就是三十秒 —— 第一版正是这么写的，
         三条全部超时，而超时报的是"页面打不开"，跟它要盯的事毫无关系。
         点链接走的是客户端路由，也更接近用户真的在做的事。 */
      await page.goto(`/sites?as=${role}`);
      const links = page.locator(".rail nav a");
      await expect(links).toHaveCount(count);
      for (let i = 0; i < count; i++) {
        const link = links.nth(i);
        const name = (await link.textContent())?.trim();
        await link.click();
        await expect(page.getByTestId("coming-soon"),
          `「${name}」落回了「这一页还没建」`).toHaveCount(0);
      }
    });
  }
});

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

  /* ══════════════════════════════════════════════════════════════════
     建分组的入口一直都在（分组标签页），但**站在需要它的地方看不见**。

     人是在「新增人员」那张表上发现自己缺一个分组的：那里有一个分组
     下拉框，它只列现有的，答不出"没有我要的那个怎么办"。而顶上那三个
     分段按钮（人员账号 20 / 分组 2 / 角色权限 9）读起来像筛选器，
     不像"在这儿建东西"。

     一个存在但找不到的入口，和没有这个入口，对用的人是同一件事。
     ══════════════════════════════════════════════════════════════════ */
  test("**从「新增人员」那里找得到建分组的路**", async ({ page }) => {
    await page.getByRole("link", { name: "组织与权限" }).click();
    await expect(page.getByTestId("new-team")).toBeVisible();

    /* 分组下拉旁边就写着去哪儿建，而不是让人自己在三个标签里试 */
    await expect(page.getByTestId("new-team-hint")).toContainText("分组");
    await page.getByTestId("new-team-go").click();

    /* 点完人就站在建分组的表单上了 */
    await expect(page.getByTestId("team-name")).toBeVisible();
    await expect(page.getByTestId("create-team")).toBeVisible();
  });

  test("建一个分组：代号留空，落到列表上", async ({ page }) => {
    await page.getByRole("link", { name: "组织与权限" }).click();
    await expect(page.getByTestId("account-row").first()).toBeVisible();
    await page.getByTestId("tab-group").click();
    const before = await page.getByTestId("team-card").count();

    await page.getByTestId("team-name").fill("华南组");
    /* 代号一个字都不填 —— 服务端按 code_rule 发号 */
    await expect(page.getByTestId("create-team")).toBeEnabled();
    await page.getByTestId("create-team").click();

    await expect(page.getByTestId("org-said")).toContainText("华南组");
    await expect(page.getByTestId("team-card")).toHaveCount(before + 1);
    const 新组 = page.getByTestId("team-card").filter({ hasText: "华南组" });
    await expect(新组.locator(".mono").first()).toHaveText(/^G-\d{2,}$/);
  });

  test("**一个分组都没有时，那一栏不能只显示「不分组」**", async ({ page }) => {
    /* 新装的系统就是这个样子。而空着的下拉框长得和"这个功能不存在"
       一模一样 —— 何况这一格空着的后果是实打实的：PM 的行范围规则是
       「本组承接的项目」，没有分组他登进来一个项目都看不到。 */
    await page.goto("/org?as=boss&empty=listTeams");
    await expect(page.getByTestId("new-team")).toBeVisible();
    await expect(page.getByTestId("new-team-empty")).toContainText("还一个分组都没有");
    /* 而且要说清后果，不能只说"没有" */
    await expect(page.getByTestId("new-team-empty")).toContainText("一个项目都看不到");
    /* 去路仍然在同一处 */
    await page.getByTestId("new-team-go").click();
    await expect(page.getByTestId("create-team")).toBeVisible();
  });

  /* ══════════════════════════════════════════════════════════════════
     把项目从 A 组划到 B 组。

     在此之前这件事**只能直接改库**：批准立项会把项目归给提交人所在
     的组，但归错了、要接手、要拆组并组，都没有入口。而它不是一个
     标签 —— `row_rule=team` 的定义就是「本组承接的项目」。
     ══════════════════════════════════════════════════════════════════ */
  test("**每个组列得出自己承接的项目**，不再只有一个数字", async ({ page }) => {
    await page.getByRole("link", { name: "组织与权限" }).click();
    await expect(page.getByTestId("account-row").first()).toBeVisible();
    await page.getByTestId("tab-group").click();
    await expect(page.getByTestId("team-study-row").first()).toBeVisible();
    expect(await page.getByTestId("team-study-row").count()).toBeGreaterThan(0);
  });

  test("**划走要写原因，而且当场说清后果**", async ({ page }) => {
    await page.getByRole("link", { name: "组织与权限" }).click();
    await expect(page.getByTestId("account-row").first()).toBeVisible();
    await page.getByTestId("tab-group").click();

    const 第一行 = page.getByTestId("team-study-row").first();
    const 编号 = (await 第一行.locator(".mono").first().textContent())!.trim();

    await page.getByTestId(`move-${编号}`).click();
    /* 后果写在按钮旁边，不是点完才知道 */
    await expect(page.getByText(/从确认那一刻起看不见/)).toBeVisible();
    /* 没写原因就按不下去 —— 这是权限变更 */
    await expect(page.getByTestId(`move-go-${编号}`)).toBeDisabled();

    await page.getByTestId(`move-to-${编号}`).selectOption({ index: 1 });
    await page.getByTestId(`move-reason-${编号}`).fill("华东组人手不足，本项目移交承接");
    await expect(page.getByTestId(`move-go-${编号}`)).toBeEnabled();
    await page.getByTestId(`move-go-${编号}`).click();

    await expect(page.getByTestId("org-said")).toContainText(编号);
    /* 划过去之后它出现在另一个组的卡片里 —— 台账上真的动了 */
    await expect(page.getByTestId("team-study-row").filter({ hasText: 编号 })).toHaveCount(1);
  });

  test("**项目怎么归到组里，页面上答得出来**", async ({ page }) => {
    await page.getByRole("link", { name: "组织与权限" }).click();
    await expect(page.getByTestId("account-row").first()).toBeVisible();
    await page.getByTestId("tab-group").click();
    /* 这句话从前写的是"只有直接改库"，而批准立项现在会自动归组。
       页面上留一句已经不对的说明，比不写更糟。 */
    await expect(page.locator(".derive")).toContainText("批准立项那一刻");
    /* 而仍然缺的那个入口也要说出来，不能假装它有 */
    await expect(page.locator(".derive")).toContainText("从 A 组划到 B 组");
  });
});

/* ══════════════════════════════════════════════════════════════════
   投递通道。

   通道本身早就写好了，缺的是**填它的地方** —— 在此之前
   SITEDESK_SMTP_URL 只能由能改环境变量、能重启进程的人来设。
   于是一套装好的系统里，管理员建得了账号、设得了口令、登记得了
   收件地址，唯独没法让登录链接真的发出去。
   ══════════════════════════════════════════════════════════════════ */
test.describe("投递通道", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("**没配的时候，标签页上就标出来，并说清后果**", async ({ page }) => {
    await page.goto("/org?as=boss");
    await expect(page.getByTestId("account-row").first()).toBeVisible();
    /* 标签上带一个"未配" —— 这一格是"人进不进得来"的前提 */
    await expect(page.getByTestId("tab-mail")).toContainText("未配");

    await page.getByTestId("tab-mail").click();
    await expect(page.getByTestId("mail-none")).toContainText("登录链接发不出去");
    /* 后果要说到底：签发权限现在等同于运维权限 */
    await expect(page.getByTestId("mail-none")).toContainText("运维权限");
  });

  test("**配完能自己验一次** —— 而且没写原因存不下去", async ({ page }) => {
    await page.goto("/org?as=boss");
    await expect(page.getByTestId("account-row").first()).toBeVisible();
    await page.getByTestId("tab-mail").click();

    await page.getByTestId("mail-kind").selectOption("smtp");
    await page.getByTestId("mail-url").fill("smtps://smtp.example.com:465");
    await page.getByTestId("mail-from").fill("中心台 <no-reply@example.com>");
    /* 没写原因：存不下去。改通道是权限变更，不是显示偏好。 */
    await expect(page.getByTestId("mail-save")).toBeDisabled();

    await page.getByTestId("mail-reason").fill("接入公司邮件服务器，登录链接不再靠运维代发");
    await expect(page.getByTestId("mail-save")).toBeEnabled();
    await page.getByTestId("mail-save").click();
    await expect(page.getByTestId("org-said")).toContainText("投递通道");

    /* 配完就能验 —— 否则真假要等第一个真人申请链接时才知道 */
    await page.getByTestId("mail-test").click();
    await expect(page.getByTestId("mail-test-said")).toContainText("发出去了");
    /* 收件地址掩码：试发结果不该把通讯录抄出来 */
    await expect(page.getByTestId("mail-test-said")).toContainText("*");
  });

  test("**口令读不回来** —— 页面上只说「存了没有」", async ({ page }) => {
    await page.goto("/org?as=boss");
    await expect(page.getByTestId("account-row").first()).toBeVisible();
    await page.getByTestId("tab-mail").click();
    await page.getByTestId("mail-kind").selectOption("smtp");
    /* 口令那一栏是 password 类型，且从不预填 —— 一个能把口令读回来的
       设置页，等于给每个管理员发了一份邮箱凭证。 */
    const pw = page.getByTestId("mail-secret");
    await expect(pw).toHaveAttribute("type", "password");
    await expect(pw).toHaveValue("");
  });

  test("**PM 进不去这一页** —— 这是 manage 动作", async ({ page }) => {
    await page.goto("/org?as=pm");
    await expect(page.getByTestId("org-forbidden")).toBeVisible();
  });
});

test("CRC 手敲进来：一句话，不是一串 403", async ({ page }) => {
  await page.goto("/org");
  await expect(page.getByTestId("org-forbidden")).toContainText("服务端不答应");
});
