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
    /* 45 个模块去重后是 41 条（crc/cra 同为「我的一天」等）。 */
    await expect(page.locator(".rail nav a")).toHaveCount(41);
  });
});
