import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   「发起」那一端。

   盘点写端点时发现的规律：每条流程「处理/判定」那一端都接了，
   **「发起」那一端没接**。能判定一份立项申请但提不了，
   能受理一份机构材料但交不了，能确认执行一次监查访视但排不了。

   于是系统只处理得了 seed 里已经躺着的记录 ——
   任何一件事都没法从界面上开一个头。这三条测试各走一条那样的路。
   ════════════════════════════════════════════════════════════════════ */

test.describe("提交立项申请", () => {
  test("填表 → 落到待审批列表 → 可以被批准", async ({ page }) => {
    /* `as=boss` 有 bid（提交）也有 approve（批准）。
       两个动作本来是两个人，这里一个人走完只是为了在一条用例里
       看到「提交之后确实进了待审批队列」。 */
    await page.goto("/intake?as=boss");
    await expect(page.getByTestId("intake-row").first()).toBeVisible();
    const before = await page.getByTestId("intake-row").count();

    await page.getByTestId("new-intake").click();
    await page.getByTestId("ni-drug").fill("洛塞那单抗");
    await page.getByTestId("ni-sponsor").fill("信达生物");
    await page.getByTestId("ni-phase").fill("II 期");
    await page.getByTestId("ni-indication").fill("系统性红斑狼疮");
    await page.getByTestId("ni-sites").fill("12");
    await page.getByTestId("ni-subjects").fill("180");
    await page.getByTestId("ni-months").fill("14");
    await page.getByTestId("ni-contract").fill("1200");
    await page.getByTestId("ni-cost").fill("900");

    /* 提交之前就把服务端会算出来的毛利率说了一遍 ——
       撞门槛这件事不该等到提交之后才知道。 */
    await expect(page.getByTestId("ni-preview")).toContainText("25%");

    await page.getByTestId("new-intake-submit").click();
    await expect(page.getByTestId("toast")).toContainText("洛塞那单抗");

    await expect(page.getByTestId("intake-row")).toHaveCount(before + 1);
    const row = page.getByTestId("intake-row").filter({ hasText: "洛塞那单抗" });
    await expect(row).toContainText("待审批");
    await expect(row).toContainText("信达生物");
  });

  test("低于毛利门槛的，提交前就说得出保本合同额", async ({ page }) => {
    await page.goto("/intake?as=boss");
    await page.getByTestId("new-intake").click();
    await page.getByTestId("ni-contract").fill("1000");
    await page.getByTestId("ni-cost").fill("900");

    /* 「毛利率 10%，低于 25% 门槛」这句话谈判桌上用不上。
       「按这个成本，合同额至少要 1200 万」——对方能拿它回去算。 */
    const preview = page.getByTestId("ni-preview");
    await expect(preview).toContainText("低于");
    await expect(preview).toContainText("保本合同额");
  });

  test("没有 bid 动作的角色看不到提交入口", async ({ page }) => {
    /* CRC 不做商务。看不到入口，而不是看到一个点不动的按钮。 */
    await page.goto("/intake?as=crc");
    await expect(page.getByTestId("new-intake")).toHaveCount(0);
  });
});

test.describe("递交立项材料", () => {
  /* 这张表瘦过一次。第一版要求先编一张八项清单才递得出去，而那套模型
     假定医院的机构办是本系统的用户 —— 迁移 0038 自己写着相反的事实。
     于是那张清单由递交方自己填、自己不勾、也没有第二个人来勾。
     现在默认只问项目、医院、递交日期三栏，清单折进一个按钮后面。 */
  test("默认只问三栏，不逼人先编一张清单", async ({ page }) => {
    await page.goto("/inst/intake?as=boss");
    await expect(page.getByTestId("ac-row").first()).toBeVisible();
    const before = await page.getByTestId("ac-row").count();

    await page.getByTestId("submit-acceptance").click();
    /* 清单默认**不展开**，也不预填 —— 预填一个默认折叠的区域，
       等于替人做了"要列清单"这个决定。 */
    await expect(page.getByTestId("sa-docs-items")).toHaveCount(0);

    await page.getByTestId("sa-study").selectOption({ index: 1 });
    await page.getByTestId("sa-hospital").fill("四川大学华西医院");
    await page.getByTestId("submit-acceptance-submit").click();
    await expect(page.getByTestId("toast")).toContainText("四川大学华西医院");

    await expect(page.getByTestId("ac-row")).toHaveCount(before + 1);
    const row = page.getByTestId("ac-row").filter({ hasText: "四川大学华西医院" });
    await expect(row).toContainText("形式审查中");
    /* **空清单不是「齐备」。** 0/0 在界面上长得像"全齐了"，
       所以那一行照实说：没列。 */
    await expect(row.getByTestId("ac-no-docs")).toContainText("没有列材料清单");
  });

  test("要列的照样列得出来 —— 收回的是「必经」，不是「能力」", async ({ page }) => {
    await page.goto("/inst/intake?as=boss");
    await page.getByTestId("submit-acceptance").click();
    await page.getByTestId("sa-study").selectOption({ index: 1 });
    await page.getByTestId("sa-hospital").fill("中南大学湘雅医院");

    /* 展开之后才预填 ACCEPTANCE_DOC_TEMPLATE 那八份 —— 默认值，不是规则。 */
    await page.getByTestId("sa-docs-open").click();
    await expect(page.getByTestId("sa-docs-items").locator("li")).toHaveCount(8);
    await page.getByTestId("sa-docs-draft").fill("本院伦理受理回执");
    await page.getByTestId("sa-docs-add").click();
    await expect(page.getByTestId("sa-docs-items").locator("li")).toHaveCount(9);

    await page.getByTestId("submit-acceptance-submit").click();
    await expect(page.getByTestId("toast")).toContainText("中南大学湘雅医院");

    const row = page.getByTestId("ac-row").filter({ hasText: "中南大学湘雅医院" });
    /* 九项全未勾：0/9。递交方自己勾完再递，形式审查就没意义了。 */
    await expect(row).toContainText("0/9");
  });

  /* 一线在这条流程上的第二件事，也是最后一件：那张纸。 */
  test("登记受理意向函：一个日期 + 一份 PDF", async ({ page }) => {
    await page.goto("/inst/intake?as=boss");
    await page.getByTestId("submit-acceptance").click();
    await page.getByTestId("sa-study").selectOption({ index: 1 });
    await page.getByTestId("sa-hospital").fill("郑州大学第一附属医院");
    await page.getByTestId("submit-acceptance-submit").click();

    const row = page.getByTestId("ac-row").filter({ hasText: "郑州大学第一附属医院" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "登记受理意向函" }).click();
    await expect(page.getByTestId("record-letter")).toBeVisible();

    /* 文件可以后补 —— 纸还没到手、先把日期登记上是常事。 */
    await page.getByTestId("rl-go").click();
    await expect(page.getByTestId("toast")).toContainText("已受理");

    /* 而**没传纸这件事要显眼**：核查看的是那张纸，不是台账上的一个日期。 */
    await expect(row.getByTestId("ac-letter-missing")).toContainText("还没传");
  });

  test("同一个项目对同一家医院不能递两次", async ({ page }) => {
    await page.goto("/inst/intake?as=boss");
    await page.getByTestId("submit-acceptance").click();
    await page.getByTestId("sa-study").selectOption({ index: 1 });
    /* 北京协和是 seed 里已经递过的那家 */
    await page.getByTestId("sa-hospital").fill("北京协和医院");
    await page.getByTestId("submit-acceptance-submit").click();

    await expect(page.getByTestId("submit-acceptance-problem")).toContainText("已经递过");
    await expect(page.getByTestId("submit-acceptance-form")).toBeVisible();
  });
});

test.describe("排一次监查访视", () => {
  test("排期 → 待确认 → 跟进项跟着落下来", async ({ page }) => {
    /* 排监查要 monitor 动作。CRA 是干这件事的人。 */
    await page.goto("/monitoring?as=cra");
    await expect(page.getByTestId("plan-visit")).toBeVisible();

    await page.getByTestId("plan-visit").click();
    await page.getByTestId("pv-site").selectOption({ index: 1 });

    /* 选中心就把板子算出来的建议抽样比例填进去，并把理由摆出来 ——
       没有理由的建议值没人照着做，核查时也解释不了。 */
    await expect(page.getByTestId("pv-advice")).toBeVisible();
    await expect(page.getByTestId("pv-pct")).not.toHaveValue("");

    await page.getByTestId("pv-kind").selectOption("imv");
    /* 换类型铺一份默认跟进项 —— 默认值，每一条都能删 */
    await expect(page.getByTestId("pv-items-items").locator("li")).toHaveCount(4);

    await page.getByTestId("pv-date").fill("2026-10-15");
    await page.getByTestId("pv-days").fill("2");
    await page.getByTestId("pv-items-draft").fill("复核上次监查提出的两项整改是否落实");
    await page.getByTestId("pv-items-add").click();
    await expect(page.getByTestId("pv-items-items").locator("li")).toHaveCount(5);

    await page.getByTestId("plan-visit-submit").click();
    await expect(page.getByTestId("toast")).toContainText("2026-10-15");
  });

  test("跟进项一条都没有时排不出去 —— 出发前就要定", async ({ page }) => {
    await page.goto("/monitoring?as=cra");
    await page.getByTestId("plan-visit").click();

    await page.getByTestId("pv-site").selectOption({ index: 1 });
    await page.getByTestId("pv-date").fill("2026-10-20");
    /* 类型没选 → 没有默认跟进项 → 按钮不该亮。
       「这次去要看什么」是出发前的决定，事后补的清单
       只会写成已经做过的事。 */
    await expect(page.getByTestId("plan-visit-submit")).toBeDisabled();
  });

  test("没有 monitor 动作的角色看不到排期入口", async ({ page }) => {
    await page.goto("/monitoring?as=crc");
    await expect(page.getByTestId("plan-visit")).toHaveCount(0);
  });
});
