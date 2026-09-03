import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   内部稽查与 CAPA 有效性。

   这一组盯的是**这套判定怎么失去意义**：
     · 写措施的人自己验证关闭 —— 「已关闭」在核查时一文不值；
     · 机构办能对我方发起内部稽查 —— 自查变成他查；
     · 「待观察」里混着「根本没人写措施」；
     · 「已整改」三个字被当成验证。
   ════════════════════════════════════════════════════════════════════ */

test.describe("CAPA 有效性验证", () => {
  test("先说清 QA 的价值不在于再发现一批问题", async ({ page }) => {
    await page.goto("/audit?as=qa");
    await expect(page.locator(".derive").first()).toContainText("自己查自己");
    await expect(page.locator(".derive").first()).toContainText("同类问题是否复发");
  });

  test("**复发的类型判成无效，并说明纠正与预防的差别**", async ({ page }) => {
    await page.goto("/audit?as=qa");
    const row = page.getByTestId("capa-row").filter({ hasText: "源数据缺陷" });
    await expect(row.getByTestId("capa-verdict")).toContainText("无效");
    await expect(page.getByTestId("capa-warning")).toContainText("那是纠正，不是预防");
    await expect(page.getByTestId("capa-warning")).toContainText("往后推了一个季度");
  });

  test("**整改期内复发单独标出来** —— 它比「当初做错了」更急", async ({ page }) => {
    await page.goto("/audit?as=qa");
    await expect(page.getByTestId("capa-while-open").first()).toContainText("整改期内");
    await expect(page.getByTestId("capa-warning"))
      .toContainText("现在正在做的事没有用");
  });

  test("**「没人管」从「待观察」里拆出来**", async ({ page }) => {
    await page.goto("/audit?as=qa");
    const row = page.getByTestId("capa-row").filter({ hasText: "知情同意版本错误" });
    await expect(row.getByTestId("capa-verdict")).toContainText("没人管");
    await expect(page.getByTestId("capa-owed")).toContainText("不是「正在整改」");
  });

  test("全关且没复发的判成有效", async ({ page }) => {
    await page.goto("/audit?as=qa");
    const row = page.getByTestId("capa-row").filter({ hasText: "实验室资质过期" });
    await expect(row.getByTestId("capa-verdict")).toContainText("有效");
  });

  test("无效的排最前 —— 它是唯一要人立刻动手的那一行", async ({ page }) => {
    await page.goto("/audit?as=qa");
    await expect(page.getByTestId("capa-row").first()
      .getByTestId("capa-verdict")).toContainText("无效");
  });
});

test.describe("稽查与发现项", () => {
  test("复发那一条带得出源事件编号", async ({ page }) => {
    await page.goto("/audit?as=qa");
    await expect(page.getByTestId("audit-repeat").first())
      .toContainText("源自 QI-2026-0151");
    await expect(page.getByTestId("audit-repeat").first()).toContainText("整改期内");
  });

  test("**空范围的稽查发不出去**", async ({ page }) => {
    await page.goto("/audit?as=qa");
    await page.getByTestId("audit-new").click();
    await expect(page.getByTestId("audit-submit")).toBeDisabled();
    await page.getByTestId("audit-scope").fill("抽查");
    await expect(page.getByTestId("audit-form")).toContainText("空范围的稽查等于没查");
    await page.getByTestId("audit-scope")
      .fill("针对该中心质疑挂起超 7 天与源数据签名问题的专项稽查");
    await expect(page.getByTestId("audit-submit")).toBeEnabled();
    await page.getByTestId("audit-submit").click();
    await expect(page.getByTestId("audit-said")).toContainText("自动结案");
  });

  test("**「已整改」三个字不是验证**，短了点不动", async ({ page }) => {
    await page.goto("/audit?as=qa");
    const btn = page.getByTestId("audit-finding")
      .filter({ hasText: "筛选失败日志" })
      .getByRole("button", { name: "验证整改并关闭" });
    await btn.click();
    await expect(page.getByTestId("audit-close-form"))
      .toContainText("「已整改」三个字不是验证");
    await page.getByTestId("audit-verification-input").fill("已整改");
    await expect(page.getByTestId("audit-close-submit")).toBeDisabled();
    await page.getByTestId("audit-verification-input")
      .fill("已抽查复核 20 份筛选失败日志，失败原因逐例记录完整，证据已归档");
    await expect(page.getByTestId("audit-close-submit")).toBeEnabled();
    await page.getByTestId("audit-close-submit").click();
    await expect(page.getByTestId("audit-said")).toContainText("还剩 1 条");
  });

  test("**外部方一条都看不到** —— 自查报告给被查方看就查不出东西了",
    async ({ page }) => {
      await page.goto("/audit?as=inst");
      await expect(page.getByTestId("audit-summary")).toBeVisible();
      await expect(page.getByTestId("audit-row")).toHaveCount(0);
    });

  test("CRC 发起不了稽查，也关不了发现项", async ({ page }) => {
    await page.goto("/audit");
    await expect(page.getByTestId("audit-cannot")).toContainText("audit");
    await expect(page.getByTestId("audit-new")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "验证整改并关闭" })).toHaveCount(0);
  });
});

test.describe("中心质量评级", () => {
  test("**A 级也说话** —— 「无扣分项」是一个结论", async ({ page }) => {
    await page.goto("/audit?as=qa");
    const a = page.getByTestId("grade-row").filter({ hasText: "SS-14" });
    await expect(a.getByTestId("grade-letter")).toHaveText("A");
    await expect(a.getByTestId("grade-reasons")).toContainText("无扣分项");
  });

  test("扣分最高的排最前，复发排在理由的最前面", async ({ page }) => {
    await page.goto("/audit?as=qa");
    const first = page.getByTestId("grade-row").first();
    await expect(first.getByTestId("grade-reasons")).toContainText("复发");
  });

  test("说清复发的权重为什么最高", async ({ page }) => {
    await page.goto("/audit?as=qa");
    await expect(page.locator(".derive").last()).toContainText("体系失效");
    await expect(page.locator(".derive").last()).toContainText("每个中心都评");
  });
});

test.describe("CAPA：写措施的人不能自己验证关闭", () => {
  test("CRC 写得了措施，写完之后「欠着措施」那句话消失", async ({ page }) => {
    await page.goto("/quality");
    const item = page.getByTestId("quality-item").filter({ hasText: "知情同意版本" });
    await expect(item.getByTestId("capa-owed")).toContainText("措施还没提交");
    await item.getByRole("button", { name: "写整改措施" }).click();
    await expect(page.getByTestId("capa-form")).toContainText("写措施的人不能自己验证关闭");

    await page.getByTestId("capa-plan-input").fill("补签");
    await expect(page.getByTestId("capa-submit")).toBeDisabled();
    await page.getByTestId("capa-plan-input")
      .fill("全部在筛受试者 ICF 版本 100% 复核（纠正）；中心文件夹版本控制表上墙并纳入 CRC 每周自查（预防）");
    await page.getByTestId("capa-due-input").fill("2026-12-31");
    await expect(page.getByTestId("capa-submit")).toBeEnabled();
    await page.getByTestId("capa-submit").click();
    await expect(page.getByTestId("quality-said")).toContainText("不能自己关");
    await expect(page.getByTestId("quality-item").filter({ hasText: "知情同意版本" })
      .getByTestId("capa-plan")).toContainText("每周自查");
  });

  test("**整改期限过了会标出来**", async ({ page }) => {
    await page.goto("/quality");
    const item = page.getByTestId("quality-item").filter({ hasText: "源数据缺陷" });
    await expect(item.getByTestId("capa-overdue")).toContainText("逾期");
  });

  test("**经营层写不了措施** —— 没有 capaWrite", async ({ page }) => {
    await page.goto("/quality?as=boss");
    await expect(page.getByTestId("quality-item").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /整改措施/ })).toHaveCount(0);
  });
});
