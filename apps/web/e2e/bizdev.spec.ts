import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   商务两页：中心可行性调查 / 报价模型。

   两页在时间上都发生在**签合同之前**，但错的时候错法不同：
   报价报错，毛利薄一点；选址选错，那个中心一年入组 0 例。

   所以这一组测试盯的是两件事：
     · 可行性 —— 逐项拆解画不画得出来（拒绝一家医院要说得出凭什么）；
       以及"低分入选不拦、但必须写理由"这条规则在界面上成不成立。
     · 报价   —— 筛败率动一动，成本和收入**两边都动**。
   ════════════════════════════════════════════════════════════════════ */

test.describe("中心可行性调查", () => {
  test("先说清它和报价模型问的不是一个问题", async ({ page }) => {
    await page.goto("/feas?as=boss");
    await expect(page.locator(".derive").first()).toContainText("能不能出病人");
    await expect(page.locator(".derive").first()).toContainText("最没用的功能");
  });

  test("口径回顾在最上面 —— 没有回写就没有校准", async ({ page }) => {
    await page.goto("/feas?as=boss");
    const cal = page.getByTestId("feas-calibration");
    await expect(cal).toBeVisible();
    await expect(cal).toContainText("没有回写就没有校准");
    /* 种子里那两家低分入选的，实际月入组是 0.5 与 0 —— 都不到 1 例 */
    await expect(cal).toContainText("当初说了不行");
  });

  test("**逐项拆解画得出来** —— 一个 38 分的圆圈答不了「凭什么」", async ({ page }) => {
    await page.goto("/feas?as=boss");
    const row = page.getByTestId("feas-row").filter({ hasText: "西安交大" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "评分明细" }).click();
    const parts = row.getByTestId("feas-parts");
    await expect(parts).toBeVisible();
    /* 画的是问卷里那个数，不是解释文案 ——
       "病源不足"是判断，"年就诊 45 例"是事实。 */
    await expect(parts).toContainText("年就诊 45 例");
    await expect(parts).toContainText("从没做过同类试验");
  });

  test("入排匹配度为空要说清是「我们没问」，不是「这家不行」", async ({ page }) => {
    await page.goto("/feas?as=boss");
    const row = page.getByTestId("feas-row").filter({ hasText: "西安交大" });
    await row.getByRole("button", { name: "评分明细" }).click();
    await expect(row.getByTestId("feas-no-elig")).toContainText("我们没问");
  });

  test("撞到病源上限要标出来 —— 瓶颈是病人不是团队", async ({ page }) => {
    await page.goto("/feas?as=boss");
    /* 华西：年就诊 60 例，PI 却报 5 例/月 */
    const row = page.getByTestId("feas-row").filter({ hasText: "华西" });
    await expect(row.getByTestId("feas-capped")).toBeVisible();
    await expect(row).toContainText("瓶颈是病人");
  });

  test("**低分入选：不拦，但必须写理由**", async ({ page }) => {
    await page.goto("/feas?as=boss");
    const row = page.getByTestId("feas-row").filter({ hasText: "福建省立医院" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "入选" }).click();

    const form = page.getByTestId("feas-form");
    await expect(form).toBeVisible();
    await expect(page.getByTestId("feas-override-warn")).toContainText("不阻止");

    const submit = page.getByTestId("feas-submit");
    await expect(submit).toBeDisabled();
    await page.getByTestId("feas-reason-input")
      .fill("申办方指定：该 PI 是本适应症区域学术带头人，坚持纳入");
    await expect(submit).toBeEnabled();
    await submit.click();

    await expect(page.getByTestId("feas-said")).toContainText("入选");
    await expect(page.getByTestId("feas-row").filter({ hasText: "福建省立医院" })
      .getByTestId("feas-reason")).toContainText("学术带头人");
  });

  test("高分入选不用写理由", async ({ page }) => {
    await page.goto("/feas?as=boss");
    const row = page.getByTestId("feas-row").filter({ hasText: "浙江大学" });
    await row.getByRole("button", { name: "入选" }).click();
    await expect(page.getByTestId("feas-override-warn")).toHaveCount(0);
    await expect(page.getByTestId("feas-submit")).toBeEnabled();
    await page.getByTestId("feas-submit").click();
    await expect(page.getByTestId("feas-said")).toBeVisible();
  });

  test("CRC 没有 bid 动作：看得到表，定不了选址", async ({ page }) => {
    await page.goto("/feas");
    await expect(page.getByTestId("feas-row").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "入选" })).toHaveCount(0);
    await expect(page.getByText("你的角色不能定选址").first()).toBeVisible();
  });

  test("说清这张表外部方一行都看不到", async ({ page }) => {
    await page.goto("/feas?as=boss");
    await expect(page.locator(".derive").last()).toContainText("毁掉合作关系");
  });
});

test.describe("报价模型", () => {
  test("四个数出得来，且说清护城河在哪", async ({ page }) => {
    await page.goto("/price?as=boss");
    await expect(page.getByTestId("price-summary")).toContainText("护城河");
    await expect(page.getByTestId("price-line").first()).toBeVisible();
    await expect(page.getByTestId("price-v-sites")).toHaveText("12 个");
  });

  test("**筛败率一动，成本和收入两边都动**", async ({ page }) => {
    await page.goto("/price?as=boss");
    await expect(page.getByTestId("price-sf-note")).toBeVisible();
    const before = await page.getByTestId("price-sf-days").innerText();

    /* 滑块从 35% 拉到 60% */
    await page.getByTestId("price-f-screenFailRate").fill("0.6");
    await expect(page.getByTestId("price-v-screenFailRate")).toHaveText("60%");

    const after = await page.getByTestId("price-sf-days").innerText();
    expect(after).not.toBe(before);
    /* 收入那一半也要跟着动 —— 只动成本就是漏了一半 */
    await expect(page.getByTestId("price-sf-note")).toContainText("按筛败费带回");
  });

  test("CRC 驻场 FTE 是最敏感的一项，且旁边写着那次失标", async ({ page }) => {
    await page.goto("/price?as=boss");
    await expect(page.getByText("对手按 0.5")).toBeVisible();
    const stat = page.locator(".stat").first();
    const before = await stat.innerText();
    await page.getByTestId("price-f-crcFte").fill("1");
    await expect(stat).not.toHaveText(before);
  });

  test("历史基线只取入组完成度 ≥ 80% 的中心", async ({ page }) => {
    await page.goto("/price?as=boss");
    const card = page.getByText("历史基线 · 护城河在这里");
    await expect(card).toBeVisible();
    await expect(page.getByText("系统性偏高")).toBeVisible();
  });

  test("重置回到默认参数", async ({ page }) => {
    await page.goto("/price?as=boss");
    await page.getByTestId("price-f-sites").fill("30");
    await expect(page.getByTestId("price-v-sites")).toHaveText("30 个");
    await page.getByTestId("price-reset").click();
    await expect(page.getByTestId("price-v-sites")).toHaveText("12 个");
  });

  test("说清这一页故意没有自己的接口", async ({ page }) => {
    await page.goto("/price?as=boss");
    await expect(page.locator(".derive").last()).toContainText("没有自己的接口");
    await expect(page.locator(".derive").last()).toContainText("今天现行");
  });

  test("CRC 看不到人天成本：一句话，不是一屏零", async ({ page }) => {
    await page.goto("/price");
    await expect(page.getByTestId("price-no-rate")).toContainText("cost");
  });
});

test.describe("投标与报价闭环", () => {
  test("复盘在最上面 —— 不回写，报价模型就是自说自话", async ({ page }) => {
    await page.goto("/bid?as=boss");
    await expect(page.getByTestId("bid-review")).toBeVisible();
    await expect(page.locator(".derive").first()).toContainText("自说自话");
  });

  test("**失标偏差与总体偏差分开给，样本数一并给**", async ({ page }) => {
    await page.goto("/bid?as=boss");
    const rev = page.getByTestId("bid-review");
    await expect(rev).toContainText("失标偏差");
    await expect(rev).toContainText("总体偏差");
    await expect(rev).toContainText("个样本");
    await expect(rev).toContainText("稀释");
  });

  test("问不到对手价的那一标：写「问不到」，且不进统计", async ({ page }) => {
    await page.goto("/bid?as=boss");
    const row = page.getByTestId("bid-row").filter({ hasText: "HT-90" });
    await expect(row).toBeVisible();
    await expect(row.getByTestId("bid-unknown")).toBeVisible();
    await expect(row).toContainText("不进统计");
  });

  test("偏差大的标出来 —— 那一标输了 21%", async ({ page }) => {
    await page.goto("/bid?as=boss");
    const row = page.getByTestId("bid-row").filter({ hasText: "HY-207" });
    await expect(row.getByTestId("bid-gap")).toBeVisible();
  });

  test("**中标必须填成交价；失标可以说问不到**", async ({ page }) => {
    await page.goto("/bid?as=boss");
    const row = page.getByTestId("bid-row").filter({ hasText: "恒糖宁 IV" });
    await row.getByRole("button", { name: "回写结果" }).click();
    await expect(page.getByTestId("bid-form")).toBeVisible();

    /* 默认中标：没填价，按钮点不动 */
    await expect(page.getByTestId("bid-submit")).toBeDisabled();

    await page.getByTestId("bid-result").selectOption("lost");
    await page.getByTestId("bid-unknown-check").check();
    await expect(page.getByTestId("bid-form"))
      .toContainText("不会被记成「和我们报得一样」");
    await expect(page.getByTestId("bid-submit")).toBeEnabled();
    await page.getByTestId("bid-submit").click();
    await expect(page.getByTestId("bid-said")).toContainText("不进偏差统计");
  });

  test("CRC 看不到金额：价格列整列不画，偏差还在", async ({ page }) => {
    await page.goto("/bid");
    await expect(page.getByTestId("bid-row").first()).toBeVisible();
    await expect(page.getByTestId("bid-no-price")).toContainText("整列不画");
    await expect(page.locator("thead")).not.toContainText("我们报");
    /* 偏差是比例，不含金额 —— 它该留着 */
    await expect(page.locator("thead")).toContainText("偏差");
  });
});

test.describe("合同变更", () => {
  test("先说清它是亏损第二大原因", async ({ page }) => {
    await page.goto("/change?as=boss");
    await expect(page.locator(".derive").first()).toContainText("第二大");
    await expect(page.locator(".derive").first()).toContainText("要不到钱");
  });

  test("**每例的那条：入组越多白做越多**", async ({ page }) => {
    await page.goto("/change?as=boss");
    /* **这句话挂在「最大的每例变更」上，不是「最大的那张」** ——
       后者随数据变，而这一句是这一页最要紧的一条洞见。 */
    await expect(page.getByTestId("change-growing")).toContainText("入组越多");
    await expect(page.getByTestId("change-worst")).toContainText("人天");
    const row = page.getByTestId("change-row").filter({ hasText: "安全随访" });
    await expect(row.getByTestId("change-per-subject")).toContainText("每例 0.8");
  });

  test("未覆盖工作量：三种没有金额都算，已签的不算", async ({ page }) => {
    await page.goto("/change?as=boss");
    const creep = page.getByTestId("change-creep");
    await expect(creep).toContainText("三种「没有金额」都算");
    await expect(creep).toContainText("谈过之后的决定");
  });

  test("已签署的那条不显示「白做」", async ({ page }) => {
    await page.goto("/change?as=boss");
    const signed = page.getByTestId("change-row").filter({ hasText: "例数调整" });
    await expect(signed).toBeVisible();
    await expect(signed).not.toContainText("白做");
  });

  test("**签署要填金额，0 和不填是两件事**", async ({ page }) => {
    await page.goto("/change?as=boss");
    const row = page.getByTestId("change-row").filter({ hasText: "心肌酶" });
    await row.getByRole("button", { name: "推进" }).click();
    await page.getByTestId("change-next").selectOption("signed");
    await expect(page.getByTestId("change-form")).toContainText("填 0 和不填是两件事");
    await expect(page.getByTestId("change-submit")).toBeDisabled();
    await page.getByTestId("change-amount").fill("0");
    await expect(page.getByTestId("change-submit")).toBeEnabled();
  });

  test("未获批要说清它仍然算白做", async ({ page }) => {
    await page.goto("/change?as=boss");
    const row = page.getByTestId("change-row").filter({ hasText: "心肌酶" });
    await row.getByRole("button", { name: "推进" }).click();
    await page.getByTestId("change-next").selectOption("rejected");
    await expect(page.getByTestId("change-reject-note")).toContainText("仍然算白做");
    await page.getByTestId("change-submit").click();
    await expect(page.getByTestId("change-said")).toContainText("下次报价");
  });

  test("只看没有金额的", async ({ page }) => {
    await page.goto("/change?as=boss");
    const rows = page.getByTestId("change-row");
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();
    await page.getByTestId("change-uncovered-only").check();
    await expect(rows).toHaveCount(before - 1);
  });
});
