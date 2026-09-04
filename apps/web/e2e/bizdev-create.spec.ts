import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   商务四页的「发起」那一端。

   投标能复盘不能投、可行性能定选址不能登记、变更能结算不能提出 ——
   三页都只处理得了 seed 里已经躺着的记录。

   还有一条更要紧的：**回填实际月入组**。契约把它叫做
   「整套评分唯一能自我修正的地方」—— 没有它，评分只是一套自洽的说法，
   而自洽的说法在第一次争议里会被「我觉得这家不错」覆盖掉。
   ════════════════════════════════════════════════════════════════════ */

test.describe("投标登记", () => {
  test("登记之后落到台账，状态是待定", async ({ page }) => {
    await page.goto("/bid?as=boss");
    await expect(page.getByTestId("bid-row").first()).toBeVisible();
    const before = await page.getByTestId("bid-row").count();

    await page.getByTestId("new-bid").click();
    await page.getByTestId("nb-sponsor").fill("华拓生物");
    await page.getByTestId("nb-name").fill("ATC-301 III 期");
    await page.getByTestId("nb-date").fill("2026-09-01");
    await page.getByTestId("nb-sites").fill("18");
    await page.getByTestId("nb-subjects").fill("320");
    await page.getByTestId("nb-quote").fill("1600");
    await page.getByTestId("nb-days").fill("6400");

    /* 单人天报价当场算给他看 —— 「报了 1600 万」本身说明不了贵还是便宜。 */
    await expect(page.getByTestId("nb-perday")).toBeVisible();

    await page.getByTestId("new-bid-submit").click();
    await expect(page.getByTestId("toast")).toContainText("ATC-301");
    await expect(page.getByTestId("bid-row")).toHaveCount(before + 1);
  });

  test("人天不填就投不出去 —— 只记价格，丢标之后没法复盘", async ({ page }) => {
    await page.goto("/bid?as=boss");
    await page.getByTestId("new-bid").click();
    await page.getByTestId("nb-sponsor").fill("华拓生物");
    await page.getByTestId("nb-name").fill("只填价格不填人天");
    await page.getByTestId("nb-date").fill("2026-09-01");
    await page.getByTestId("nb-sites").fill("10");
    await page.getByTestId("nb-subjects").fill("100");
    await page.getByTestId("nb-quote").fill("800");

    /* 是人天估多了还是费率高了 —— 这两条要采取的行动完全不同，
       而只记价格的话事后一条也答不出来。 */
    await expect(page.getByTestId("new-bid-submit")).toBeDisabled();
  });
});

test.describe("可行性登记与回填", () => {
  test("八项问卷填完 → 落到候选列表 → 状态是评估中", async ({ page }) => {
    await page.goto("/feas?as=boss");
    await expect(page.getByTestId("feas-row").first()).toBeVisible();
    const before = await page.getByTestId("feas-row").count();

    await page.getByTestId("new-feas").click();
    await page.getByTestId("nf-study").selectOption({ index: 1 });
    await page.getByTestId("nf-hospital").fill("郑州大学第一附属医院");
    await page.getByTestId("nf-city").fill("郑州");
    await page.getByTestId("nf-dept").fill("肿瘤科");
    await page.getByTestId("nf-pi").fill("孙立行");
    await page.getByTestId("nf-date").fill("2026-08-28");

    for (const [id, v] of [["nf-ptyear", "1800"], ["nf-pastn", "4"],
      ["nf-pastbest", "6"], ["nf-compet", "2"], ["nf-ethics", "35"],
      ["nf-start", "62"], ["nf-team", "7"], ["nf-commit", "8"],
      ["nf-elig", "42"]] as const)
      await page.getByTestId(id).fill(v);

    await page.getByTestId("new-feas-submit").click();
    await expect(page.getByTestId("toast")).toContainText("郑州大学第一附属医院");
    await expect(page.getByTestId("feas-row")).toHaveCount(before + 1);

    const row = page.getByTestId("feas-row").filter({ hasText: "郑州大学第一附属医院" });
    await expect(row).toContainText("评估中");
  });

  test("「当时没问过」是一个明确的开关，不是留空", async ({ page }) => {
    await page.goto("/feas?as=boss");
    await page.getByTestId("new-feas").click();

    /* 默认是问了 —— 那一栏在 */
    await expect(page.getByTestId("nf-elig")).toBeVisible();

    await page.getByTestId("nf-asked").uncheck();
    /* 取消之后那一栏消失，并且说清楚它会被记成什么 ——
       null 是「当时没问过」，不是 0%，两者在评分里不是一回事。 */
    await expect(page.getByTestId("nf-elig")).toHaveCount(0);
    await expect(page.getByTestId("nf-elig-skipped")).toContainText("不是 0%");
  });

  test("回填实际月入组 —— 评分唯一能自我修正的地方", async ({ page }) => {
    await page.goto("/feas?as=boss");
    /* 只有已入选的中心谈得上实际入组速度 */
    const row = page.getByTestId("feas-row").filter({ hasText: "已入选" }).first();
    await expect(row).toBeVisible();

    const btn = row.getByRole("button", { name: /实际月入组/ });
    await btn.click();
    await row.getByLabel("实际月入组（例/月）").fill("2.5");
    await row.getByRole("button", { name: "存下来" }).click();

    await expect(row.getByTestId("feas-actual")).toContainText("2.5");
    /* 预测与实际摆在一起 —— 「是预测的百分之多少」才是下次报价的校准量。 */
    await expect(row.getByTestId("feas-actual")).toContainText("是预测的");
  });

  test("评估中的中心没有回填入口 —— 它还没开始", async ({ page }) => {
    await page.goto("/feas?as=boss");
    const row = page.getByTestId("feas-row").filter({ hasText: "评估中" }).first();
    await expect(row).toBeVisible();
    await expect(row.getByRole("button", { name: /实际月入组/ })).toHaveCount(0);
  });
});

test.describe("合同变更登记", () => {
  test("先记下来，再去谈 —— 新登记的是「待提出」", async ({ page }) => {
    await page.goto("/change?as=boss");
    await expect(page.getByTestId("change-row").first()).toBeVisible();
    const before = await page.getByTestId("change-row").count();

    await page.getByTestId("new-change").click();
    await page.getByTestId("nc-study").selectOption({ index: 1 });
    await page.getByTestId("nc-kind").selectOption("exam_add");
    await page.getByTestId("nc-date").fill("2026-08-30");
    await page.getByTestId("nc-what")
      .fill("第 3 周期起每例增加一次骨扫描，含预约、陪同与影像归档。");
    await page.getByTestId("nc-days").fill("0.5");
    await page.getByTestId("nc-per").selectOption("yes");

    await page.getByTestId("new-change-submit").click();
    await expect(page.getByTestId("toast")).toContainText("检查项增加");
    await expect(page.getByTestId("change-row")).toHaveCount(before + 1);
  });

  test("人天影响可以是负的 —— 只记加不记减的台账不可信", async ({ page }) => {
    await page.goto("/change?as=boss");
    await page.getByTestId("new-change").click();
    await page.getByTestId("nc-study").selectOption({ index: 1 });
    await page.getByTestId("nc-kind").selectOption("site_adj");
    await page.getByTestId("nc-date").fill("2026-08-30");
    await page.getByTestId("nc-what").fill("砍掉两个一直没入组的中心。");
    await page.getByTestId("nc-days").fill("-120");

    /* 负数照样能提交 —— 中心减了、例数砍了，人天是往下走的。 */
    await expect(page.getByTestId("new-change-submit")).toBeEnabled();
    await page.getByTestId("new-change-submit").click();
    await expect(page.getByTestId("toast")).toContainText("中心增减");
  });

  test("中心留空 = 全项目，那不是漏填", async ({ page }) => {
    await page.goto("/change?as=boss");
    await page.getByTestId("new-change").click();
    /* 默认就是空，而且下拉里第一项明说是「全项目」 */
    await expect(page.getByTestId("nc-site")).toHaveValue("");
    await expect(page.getByTestId("nc-site").locator("option").first())
      .toContainText("全项目");
  });
});
