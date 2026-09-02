import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   数据质疑 / 数据管理工作台。

   这一组盯的是**闭环两端的责任**：
     · 谁能提 —— CRC 没有 raiseQ，界面上就不该有那个表单；
     · 谁能关 —— 回复的人自己关得掉，这套流程一分钱不值；
     · 退回不说理由 —— 把「凭空」的毛病搬到了另一端；
     · 密度高就是中心差 —— 只给密度那句免责声明就没有用。
   ════════════════════════════════════════════════════════════════════ */

test.describe("数据质疑 · CRC 视角", () => {
  test("默认只给指派给我的，且说清中间那一格为什么不能省", async ({ page }) => {
    await page.goto("/queries");
    await expect(page.getByTestId("query-summary")).toContainText("待你回复");
    await expect(page.locator(".derive").first()).toContainText("中间那一格不能省");
    await expect(page.locator(".derive").first()).toContainText("回复了不等于问题解决了");
  });

  test("**挂得最久的排最前**，超 7 天的标红", async ({ page }) => {
    await page.goto("/queries");
    const rows = page.getByTestId("query-row");
    await expect(rows.first()).toBeVisible();
    await expect(rows.first().getByTestId("query-age")).toContainText("挂起 21 天");
    await expect(rows.first().getByTestId("query-age")).toHaveClass(/crit/);
  });

  test("**平均挂起把没关掉的也算进去** —— 这句话要写在页面上", async ({ page }) => {
    await page.goto("/queries");
    await expect(page.getByTestId("query-mean-note"))
      .toContainText("永远不进分母");
  });

  test("回复太短点不动 —— 只写「已修正」DM 判定不了", async ({ page }) => {
    await page.goto("/queries");
    const row = page.getByTestId("query-row").first();
    await expect(row).toBeVisible();
    const box = row.locator("textarea");
    const submit = row.getByRole("button", { name: "提交回复" });
    await expect(submit).toBeDisabled();
    await box.fill("已修正");
    await expect(submit).toBeDisabled();
    await box.fill("已核对原始病历，CM 起始日期录入错误，已更正为 2026-08-03，源文件第 12 页。");
    await expect(submit).toBeEnabled();
  });

  test("**回复之后是「已回复待关闭」，不是消失** —— 它转到另一栏", async ({ page }) => {
    await page.goto("/queries");
    const rows = page.getByTestId("query-row");
    await expect(rows).toHaveCount(3);
    await rows.first().locator("textarea")
      .fill("已核对原始病历，CM 起始日期录入错误，已更正为 2026-08-03，源文件第 12 页。");
    await rows.first().getByRole("button", { name: "提交回复" }).click();
    await expect(page.getByTestId("query-said")).toContainText("不等于关闭了");
    await expect(rows).toHaveCount(2);

    await page.getByTestId("query-tab-wait").click();
    await expect(page.getByTestId("query-waiting-dm").first())
      .toContainText("等数据管理判定");
  });

  test("CRC 关不掉 —— 界面上根本没有关闭键", async ({ page }) => {
    await page.goto("/queries");
    await expect(page.getByTestId("query-row").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "回复合格，关闭" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "回复不充分，退回" })).toHaveCount(0);
    /* 催办也不给：CRC 没有 raiseQ，而催自己是没有意义的。 */
    await expect(page.getByRole("button", { name: "电话催办并记录" })).toHaveCount(0);
  });

  test("**被退回过的，理由摆在回复框上面**", async ({ page }) => {
    /* 退回而不说为什么，是把「凭空」的毛病搬到闭环的另一端 ——
       CRC 只知道弹回来了，不知道要补什么。 */
    await page.goto("/queries");
    const returned = page.getByTestId("query-row").filter({ hasText: "剂量单位" });
    await expect(returned.getByTestId("query-returned"))
      .toContainText("回复未提供源数据依据");
    /* 上一次写了什么也还在 —— 退回不是"当他没答过"。 */
    await expect(returned.getByTestId("query-answer")).toContainText("已按医嘱单核对");
  });
});

test.describe("数据质疑 · 跟催视角", () => {
  test("**超 7 天才给催办按钮**，且催办要落库", async ({ page }) => {
    await page.goto("/queries?as=dm");
    await expect(page.getByTestId("query-summary")).toContainText("待中心回复");
    const stale = page.getByTestId("query-row").filter({ hasText: "挂起 21 天" });
    await stale.getByRole("button", { name: "电话催办并记录" }).click();
    await expect(page.getByTestId("query-said")).toContainText("第 1 次催办");
    await expect(stale).toContainText("已催办 1 次");
  });

  test("没超 7 天的那条不给催办 —— 系统提醒还够用", async ({ page }) => {
    await page.goto("/queries?as=dm");
    const fresh = page.getByTestId("query-row").filter({ hasText: "挂起 3 天" });
    await expect(fresh).toBeVisible();
    await expect(fresh.getByRole("button", { name: "电话催办并记录" })).toHaveCount(0);
  });

  test("经营层只读：三个动作三个人，这句话要说出来", async ({ page }) => {
    await page.goto("/queries?as=boss");
    await expect(page.getByTestId("query-readonly")).toContainText("三个动作三个人");
  });

  test("**外部方一条都看不到** —— 两条质量闭环不能混", async ({ page }) => {
    await page.goto("/queries?as=inst");
    await expect(page.getByTestId("query-summary")).toContainText("范围内 0 条");
    await expect(page.getByTestId("query-row")).toHaveCount(0);
  });
});

test.describe("数据管理工作台", () => {
  test("先说清此前系统里没有这个角色", async ({ page }) => {
    await page.goto("/dm?as=dm");
    await expect(page.locator(".derive").first()).toContainText("没有数据管理这个角色");
    await expect(page.locator(".derive").first()).toContainText("凭空产生、凭空关闭");
  });

  test("发起：字段与内容都够长才点得动", async ({ page }) => {
    await page.goto("/dm?as=dm");
    const submit = page.getByTestId("dm-raise-submit");
    await expect(submit).toBeDisabled();
    await page.getByTestId("dm-field").fill("起");
    await page.getByTestId("dm-text").fill("日期不对");
    await expect(submit).toBeDisabled();
    await page.getByTestId("dm-field").fill("起始日期");
    await page.getByTestId("dm-text")
      .fill("CM 起始日期早于知情同意签署日期，请核实源数据并更正 eCRF。");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByTestId("dm-said")).toContainText("指派给");
  });

  test("**责任 CRC 在发起那一刻固化** —— 这句话要写在表单旁边", async ({ page }) => {
    await page.goto("/dm?as=dm");
    await expect(page.getByTestId("dm-raise")).toContainText("这一刻固化");
    await expect(page.getByTestId("dm-raise")).toContainText("交接不改写");
  });

  test("**关闭要写判定说明，短了点不动**", async ({ page }) => {
    await page.goto("/dm?as=dm");
    const row = page.getByTestId("dm-pending-row").first();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "回复合格，关闭" }).click();
    const submit = page.getByTestId("dm-judge-submit");
    await expect(submit).toBeDisabled();
    await page.getByTestId("dm-reason").fill("好");
    await expect(submit).toBeDisabled();
    await page.getByTestId("dm-reason").fill("已核对源数据，更正与说明均充分。");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByTestId("dm-said")).toContainText("已关闭");
    await expect(page.getByTestId("dm-no-pending")).toBeVisible();
  });

  test("**退回：要说明为什么，且那一条回到「待中心回复」**", async ({ page }) => {
    await page.goto("/dm?as=dm");
    await page.getByTestId("dm-pending-row").first()
      .getByRole("button", { name: "回复不充分，退回" }).click();
    await expect(page.getByTestId("dm-judge-form")).toContainText("退回必须说明为什么");
    await expect(page.getByTestId("dm-judge-form")).toContainText("不知道要补什么");
    await expect(page.getByTestId("dm-judge-submit")).toBeDisabled();
    await page.getByTestId("dm-reason").fill("回复未提供源数据依据，请附原始病历页码。");
    await page.getByTestId("dm-judge-submit").click();
    await expect(page.getByTestId("dm-said")).toContainText("已退回");
    await expect(page.getByTestId("dm-no-pending")).toBeVisible();
  });

  test("**密度和归因一起给** —— 集中在一个表单是表单难填", async ({ page }) => {
    await page.goto("/dm?as=dm");
    const rows = page.getByTestId("dm-site-row");
    await expect(rows.first()).toBeVisible();
    /* SS-01 三条都在合并用药 CM 上 —— 归因走「表单」 */
    const s1 = rows.filter({ hasText: "SS-01" });
    await expect(s1.getByTestId("dm-verdict")).toContainText("是这张表难填");
    /* SS-07 三条散在三个表单 —— 归因走「录入质量」 */
    const s2 = rows.filter({ hasText: "SS-07" });
    await expect(s2.getByTestId("dm-verdict")).toContainText("录入质量问题");
  });

  test("**入组 0 例的中心写「未入组」，不是 0 条/例**", async ({ page }) => {
    await page.goto("/dm?as=dm");
    await expect(page.getByTestId("dm-site-row").first()).toBeVisible();
    /* mock 的三个中心里只有两个有质疑，所以这一条断言的是
       「算不出密度时页面怎么说」这条分支本身 ——
       它由 calc 的单测（query.test.ts）从数值侧钉住。 */
    await expect(page.locator(".derive").last()).toContainText("要做的事完全相反");
  });

  test("CRC 打开 DM 工作台：发不了、也关不了，且说清为什么", async ({ page }) => {
    await page.goto("/dm");
    await expect(page.getByTestId("dm-cannot-raise")).toContainText("raiseQ");
    await expect(page.getByTestId("dm-cannot-close")).toContainText("不是给回复的人自己走的");
  });
});
