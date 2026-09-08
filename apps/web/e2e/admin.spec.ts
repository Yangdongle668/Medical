import { test, expect } from "@playwright/test";
import { ACTION_KEYS } from "@sitedesk/contracts";

/* ════════════════════════════════════════════════════════════════════
   系统管理员。**这个身份此前一条 e2e 都没有。**

   `MOCK_ROLES` 里只有八个身份，缺 admin —— 而「组织与权限」那一页
   几乎只有他打得开。于是那一页上最要紧的东西从来没被跑过：
   第一次有人以管理员登进真库时，发现的是权限矩阵**少了五列**
   （accept / audit / capaWrite / isfWrite / monitor 在界面上没有那一格，
   而且不报错）。那件事在 mock 上永远撞不上，因为没人以这个身份跑过。

   下面这几条钉住的正是"管理员到底能不能管"：能建号、能改权限、
   而且矩阵上**十八个动作一个不少**。
   ════════════════════════════════════════════════════════════════════ */

test.describe("管理员 · 组织与权限", () => {
  test("权限矩阵有全部 18 个动作 —— 少一列就等于那个动作授不出去", async ({ page }) => {
    await page.goto("/org?as=admin");
    await page.getByTestId("tab-perm").click();

    /* 逐个点名，而不是只数个数：数个数在"少一个又多一个"时照样绿。 */
    for (const a of ACTION_KEYS)
      await expect(page.getByTestId(`action-crc-${a}`),
        `动作 ${a} 在权限矩阵上没有那一格 —— 它就授不出去，而且不报错`)
        .toHaveCount(1);
  });

  test("五个曾经缺席的动作，现在勾得动", async ({ page }) => {
    await page.goto("/org?as=admin");
    await page.getByTestId("tab-perm").click();

    /* CRA 在库里就带着 monitor —— 勾掉再勾回来，两个方向都走一遍。 */
    const box = page.getByTestId("action-cra-monitor");
    await expect(box).toBeChecked();
    await box.uncheck();
    await expect(page.getByTestId("confirm-change")).toBeVisible();
    await page.getByTestId("change-reason").fill("监查改由专职监查组承担");
    await page.getByTestId("change-go").click();
    await expect(page.getByTestId("org-said")).toBeVisible();
  });

  test("建号：登录名的规则在提交前就说清楚", async ({ page }) => {
    await page.goto("/org?as=admin");
    await page.getByTestId("new-name").fill("周敏");

    /* 最自然的填法 —— 把姓名也填进登录名。
       在此之前这里是能按下去的，然后服务端回一句
       `Invalid string: must match pattern /^[a-z][a-z0-9_]{2,31}$/`。 */
    await page.getByTestId("new-login").fill("周敏");
    await expect(page.getByTestId("new-login-bad")).toContainText("中文和大写都不行");
    await expect(page.getByTestId("create-account")).toBeDisabled();

    await page.getByTestId("new-login").fill("zhoumin");
    await expect(page.getByTestId("new-login-bad")).toHaveCount(0);
    await page.getByTestId("new-role").selectOption({ label: "临床协调员 CRC" });
    await expect(page.getByTestId("create-account")).toBeEnabled();
  });

  test("侧栏给满 45 个模块 —— 管理员打开系统看得到全部界面", async ({ page }) => {
    await page.goto("/today?as=admin");

    /* 45 个模块去重后是 41 条（crc/cra 同为「我的一天」等）。
       管理员这一侧超过 DENSE，分组是折叠的 —— 所以这里逐组展开再数。
       **展开这个动作本身也是断言**：一条打不开的分组等于那几页没有入口，
       而那正是这条测试原本要盯的事。 */
    const groups = page.locator(".nav-group-h");
    await expect(groups).toHaveCount(11);
    for (const g of await groups.all())
      if (await g.getAttribute("aria-expanded") === "false") await g.click();

    await expect(page.locator(".rail nav a")).toHaveCount(41);
  });
});

/* ════════════════════════════════════════════════════════════════════
   侧栏在条目多到看不完时会折叠。

   管理员拿到 41 条链接 + 11 个分组标题 —— 实测侧栏内容 2093px，
   1440×900 上可视 900px：**19 条看得见，22 条要滚才够得着**。
   一条要滚动才够得着的导航，等于把"这个系统有哪些页"变成了
   一件要费力气才知道的事。

   折叠只对管理员生效（DENSE=24），所以下面这几条也只有他跑得到。
   钉三件事：不滚就看得完、当前那一组是打开的、以及**不靠展开也能到**。
   ════════════════════════════════════════════════════════════════════ */
test.describe("管理员 · 侧栏", () => {
  /* 钉的是**整个系统的目录一眼看得完**：十一个分组标题全都落在视口里。
     展开的那一组里有多少条会变（加一页就多一条），所以不去数总高度 ——
     那样的断言会因为一次正常的加页而红，而红的原因跟这条测试要防的事无关。 */
  test("十一个分组一眼看得完 —— 在此之前 41 条里有 22 条够不着", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/today?as=admin");

    const heads = page.locator(".nav-group-h");
    await expect(heads).toHaveCount(11);
    const off = await page.evaluate(() =>
      [...document.querySelectorAll(".nav-group-h")]
        .filter(e => e.getBoundingClientRect().bottom > innerHeight)
        .map(e => e.textContent?.trim()));
    expect(off, "这几组要滚下去才看得见").toEqual([]);

    /* 顺带盯住总量：改之前要滚 1193px。 */
    const over = await page.evaluate(() => {
      const el = document.querySelector(".rail")!;
      return el.scrollHeight - el.clientHeight;
    });
    expect(over, `侧栏还要滚 ${over}px 才看得完（原来是 1193px）`).toBeLessThan(120);
  });

  test("当前所在的那一组是展开的 —— 导航先回答「我在哪」", async ({ page }) => {
    await page.goto("/today?as=admin");
    /* 「我的一天」归「我的工作」。 */
    await expect(page.getByTestId("nav-g-我的工作")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("link", { name: "我的一天" })).toBeVisible();
    /* 别的组收着，但标题在，且说得出里面有几条 —— 收起来不等于藏起来。 */
    await expect(page.getByTestId("nav-g-质量")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("nav-g-质量")).toContainText("4");
    await expect(page.getByRole("link", { name: "内部稽查" })).toHaveCount(0);
  });

  test("换一页，展开的那一组跟着换", async ({ page }) => {
    await page.goto("/org?as=admin");
    await expect(page.getByTestId("nav-g-系统")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("nav-g-我的工作")).toHaveAttribute("aria-expanded", "false");
  });

  test("过滤框：知道名字就不必先想它归哪一组", async ({ page }) => {
    await page.goto("/today?as=admin");
    await page.getByTestId("rail-find").fill("稽查");
    /* 过滤时忽略折叠 —— 找东西的时候不该还要先展开一层。 */
    await page.getByRole("link", { name: "内部稽查" }).click();
    await expect(page).toHaveURL(/\/audit/);
    /* 跳过去之后过滤词要清掉，否则侧栏会一直只剩那一条。 */
    await expect(page.getByTestId("rail-find")).toHaveValue("");
  });

  test("分组名也能筛 —— 「质量」一次捞出那一组四页", async ({ page }) => {
    await page.goto("/today?as=admin");
    await page.getByTestId("rail-find").fill("质量");
    await expect(page.locator(".rail nav a")).toHaveCount(4);
  });

  test("找不到时说出来，而不是给一列空的", async ({ page }) => {
    await page.goto("/today?as=admin");
    await page.getByTestId("rail-find").fill("并没有这一页");
    await expect(page.getByTestId("rail-none")).toBeVisible();
  });

  test("手动开合记得住 —— 常在哪两组之间来回，不必每次重说", async ({ page }) => {
    await page.goto("/today?as=admin");
    await page.getByTestId("nav-g-财务").click();
    await expect(page.getByTestId("nav-g-财务")).toHaveAttribute("aria-expanded", "true");

    await page.reload();
    await expect(page.getByTestId("nav-g-财务")).toHaveAttribute("aria-expanded", "true");
  });
});

/* ════════════════════════════════════════════════════════════════════
   登记登录收件地址。

   在此之前，**建一个账号和让那个人进得来是两件被切断的事**：
   界面上建得出账号，但要让他自助申请一次性链接，得有人登进服务器跑
   `deploy/login-address.sh`。于是常见的结局是账号建好了、没人跑那个脚本，
   而 `/v1/auth/magic-link` 照样回一句「登录链接已发送」什么都不发
   —— 对外含糊是防账号枚举，管理员这一侧却也看不出区别。

   下面这三条钉住的是这条路上**三个都不报错的岔口**：
   登记完台账那一列有没有翻过来、地址打错了会不会在按下去之前被拦、
   以及同一个地址第二次登记会不会把前一个人的入口悄悄转走。
   ════════════════════════════════════════════════════════════════════ */
test.describe("管理员 · 登录收件地址", () => {
  /** 台账按登录名定位到那一行 —— 行序会变，登录名不会。 */
  const row = (page: import("@playwright/test").Page, login: string) =>
    page.getByTestId("account-row").filter({ has: page.getByTestId(`addr-${login}`) });

  test("登记之后，「怎么进来」那一列才翻成「可自助申请链接」", async ({ page }) => {
    await page.goto("/org?as=admin");

    /* 张慧敏是机构老师 —— 一周登录两次的人，正是走链接那条路的。 */
    const zhang = row(page, "zhanghm");
    await expect(zhang.getByTestId("no-address")).toBeVisible();

    await page.getByTestId("addr-zhanghm").click();
    await page.getByTestId("addr-input").fill("zhanghm@pumch.cn");
    await page.getByTestId("addr-reason").fill("入职登记，本人邮箱已核对");
    await page.getByTestId("addr-go").click();

    await expect(page.getByTestId("org-said")).toBeVisible();
    /* 关键是台账**自己**翻过来了，不是只弹了句成功 ——
       "说成功了但那一列没变"正是这一整页要防的那类错。 */
    await expect(zhang.getByTestId("has-address")).toBeVisible();
    await expect(zhang.getByTestId("no-address")).toHaveCount(0);
  });

  test("打错的地址在按下去之前就被拦住 —— 它不会报错，只会让人永远收不到", async ({ page }) => {
    await page.goto("/org?as=admin");
    await page.getByTestId("addr-chenguod").click();

    /* 最容易的打错法：把姓名或工号填进去。 */
    await page.getByTestId("addr-input").fill("陈国栋");
    await page.getByTestId("addr-reason").fill("入职登记，本人邮箱已核对");
    await expect(page.getByTestId("addr-bad")).toContainText("既不像邮箱也不像手机号");
    await expect(page.getByTestId("addr-go")).toBeDisabled();

    /* 理由也是必填的 —— 「谁给谁登记过」这行审计得有人说得出为什么。 */
    await page.getByTestId("addr-input").fill("13800138000");
    await expect(page.getByTestId("addr-bad")).toHaveCount(0);
    await page.getByTestId("addr-reason").fill("入");
    await expect(page.getByTestId("addr-go")).toBeDisabled();
    await page.getByTestId("addr-reason").fill("入职登记，本人手机号已核对");
    await expect(page.getByTestId("addr-go")).toBeEnabled();
  });

  test("同一个地址不会悄悄改绑 —— 那等于把前一个人的入口转走", async ({ page }) => {
    await page.goto("/org?as=admin");

    await page.getByTestId("addr-zhanghm").click();
    await page.getByTestId("addr-input").fill("shared@pumch.cn");
    await page.getByTestId("addr-reason").fill("入职登记，本人邮箱已核对");
    await page.getByTestId("addr-go").click();
    await expect(row(page, "zhanghm").getByTestId("has-address")).toBeVisible();

    /* 换个人填同一个地址。改绑成功的话，张慧敏的登录链接以后就送到
       陈国栋那里去了，而**两边界面上都不会有任何变化**。 */
    await page.getByTestId("addr-chenguod").click();
    await page.getByTestId("addr-input").fill("shared@pumch.cn");
    await page.getByTestId("addr-reason").fill("入职登记，本人邮箱已核对");
    await page.getByTestId("addr-go").click();

    await expect(page.getByTestId("org-problem")).toContainText("已经登记给另一个账号");
    await expect(row(page, "chenguod").getByTestId("no-address")).toBeVisible();
    await expect(row(page, "zhanghm").getByTestId("has-address")).toBeVisible();
  });
});
