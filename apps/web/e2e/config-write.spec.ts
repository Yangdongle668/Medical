import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   两份「模板」——它们决定此后每一个新中心、每一次新访视长什么样。

   `getStartupTemplate` / `replaceStartupTemplate` /
   `getSoa` / `replaceSoa` 四个端点前端一个都没调过。
   于是那两份模板是什么样，只有直接读库才知道 ——
   而 CRC 每天在「今天」那一页看到的任务清单，正是从 SOA 落下来的；
   每个新中心开工前要做的十几件事，正是从启动清单模板铺开的。

   两份模板共有一条约束，也是这几条测试的重点：
   **改模板不追溯已经落成行的那些。**
   ════════════════════════════════════════════════════════════════════ */

test.describe("启动清单模板", () => {
  test("改一版：版本号加一，并说清它不影响在途中心", async ({ page }) => {
    await page.goto("/startup?as=boss");
    const panel = page.getByTestId("startup-template");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("第 3 版");

    /* 改它不影响在途中心 —— 清单在建档那一刻铺开成行，此后与模板无关。
       不说清楚的话，会有人指望改模板去解一个具体中心的锁。 */
    await expect(page.getByTestId("tpl-scope")).toContainText("建档那一刻");

    await page.getByTestId("tpl-edit").click();
    const before = await page.getByTestId("tpl-row").count();

    await page.getByTestId("tpl-add").click();
    await expect(page.getByTestId("tpl-row")).toHaveCount(before + 1);
    await page.getByTestId(`tpl-item-${before}`).fill("研究者资质审查表");
    await page.getByTestId(`tpl-block-${before}`).check();

    /* 变更理由必填 —— 它进变更史 */
    await expect(page.getByTestId("tpl-publish")).toBeDisabled();
    await page.getByTestId("tpl-reason-input")
      .fill("新增「研究者资质审查表」为阻塞项 —— 上一轮核查提出三个中心缺这一份。");
    await expect(page.getByTestId("tpl-publish")).toBeEnabled();

    await page.getByTestId("tpl-publish").click();
    await expect(page.getByTestId("toast")).toContainText("第 4 版");
    await expect(panel).toContainText("第 4 版");
  });

  test("没有 manage 的角色只看得到，改不了", async ({ page }) => {
    await page.goto("/startup?as=crc");
    await expect(page.getByTestId("startup-template")).toBeVisible();
    await expect(page.getByTestId("tpl-edit")).toHaveCount(0);
  });
});

test.describe("访视计划表", () => {
  test("已经排出过访视的那几次，删不掉且锚点锁住", async ({ page }) => {
    await page.goto("/intake?as=boss");
    await page.getByTestId("filing-row").first().waitFor();

    await page.getByTestId(/^soa-open-/).first().click();
    const soa = page.getByTestId("soa-editor");
    await expect(soa).toBeVisible();

    /* 改它不影响已排出去的访视 —— 访视在排期那一刻从模板落成行。 */
    await expect(page.getByTestId("soa-scope")).toContainText("落成行");
    /* 已排出过的那几次要标出来 */
    await expect(soa.getByTestId("soa-locked-0")).toBeVisible();

    await page.getByTestId("soa-edit").click();
    /* 锁住的那一行没有删除按钮 —— 不是按下去再被拒。
       删掉它，那些访视就指向了一个不存在的定义：
       报表里它们还在，SOA 上它们不存在。 */
    await expect(page.getByTestId("soa-del-0")).toHaveCount(0);
    /* 没排过的那几次可以删 */
    await expect(page.getByTestId("soa-del-3")).toBeVisible();
  });

  test("加一次访视并提交修订 —— 理由进变更史", async ({ page }) => {
    await page.goto("/intake?as=boss");
    await page.getByTestId("filing-row").first().waitFor();
    await page.getByTestId(/^soa-open-/).first().click();
    await page.getByTestId("soa-edit").click();

    const before = await page.getByTestId("soa-row").count();
    await page.getByTestId("soa-add").click();
    await expect(page.getByTestId("soa-row")).toHaveCount(before + 1);
    await page.getByTestId(`soa-code-${before}`).fill("M12");
    await page.getByTestId(`soa-label-${before}`).fill("M12 长期随访");

    /* 修订原因必填 —— 改 SOA 对应的是一次方案修订，前后快照进变更史。 */
    await expect(page.getByTestId("soa-publish")).toBeDisabled();
    await page.getByTestId("soa-reason")
      .fill("方案 v3.0 修订：末次随访由 M6 延至 M12。");

    await page.getByTestId("soa-publish").click();
    await expect(page.getByTestId("toast")).toContainText("只影响此后");
  });

  test("第 0 次锚定知情日，其余锚入组日 —— 不是一个可选的下拉", async ({ page }) => {
    /* 入组之前唯一确定的日期就是知情日。 */
    await page.goto("/intake?as=boss");
    await page.getByTestId("filing-row").first().waitFor();
    await page.getByTestId(/^soa-open-/).first().click();

    const rows = page.getByTestId("soa-row");
    await expect(rows.nth(0)).toContainText("知情日");
    await expect(rows.nth(1)).toContainText("入组日");
    /* 是标签不是下拉 */
    await expect(rows.nth(0).locator("select")).toHaveCount(0);
  });
});
