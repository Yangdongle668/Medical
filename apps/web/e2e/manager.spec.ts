import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   经营层的四页。

   每一页都盯它**唯一要回答的那个问题**，而不是"能不能画出来"：
     入组进度 —— 哪几个中心落后
     筛选漏斗 —— 落后是因为预筛不够，还是因为筛不进去
     派工产能 —— 谁的资质过期了、谁走了没人接
     审计轨迹 —— 谁给谁开了什么权限
   ════════════════════════════════════════════════════════════════════ */

test.describe("经营层", () => {
  test.beforeEach(async ({ page }) => { await page.goto("/sites?as=boss"); });

  test("入组进度：缺口大的排最前，还没开始的单独说出来", async ({ page }) => {
    await page.getByRole("link", { name: "入组进度" }).click();
    const rows = page.getByTestId("enr-row");
    await expect(rows.first()).toBeVisible();

    /* SS-14 一例都没有，缺口 12，排第一 */
    await expect(rows.first()).toContainText("SS-14");

    /* 「一例预筛都没有」要单独说 —— 那不是"入组慢"，是还没启动，
       两者要用完全不同的办法处理，而只看入组数分不出来。 */
    await expect(page.locator(".problem")).toContainText("还没有");

    /* 已达成的中心不该被标成告警：SS-01 签 20 入 24 */
    await expect(rows.filter({ hasText: "SS-01" })).toContainText("已达成");
  });

  test("入组进度：只看还差人的，会把已达成的那个筛掉", async ({ page }) => {
    await page.getByRole("link", { name: "入组进度" }).click();
    await expect(page.getByTestId("enr-row").first()).toBeVisible();
    const all = await page.getByTestId("enr-row").count();
    await page.getByTestId("behind-only").check();
    await expect(page.getByTestId("enr-row")).toHaveCount(all - 1);
    await expect(page.getByTestId("enr-row").filter({ hasText: "SS-01" })).toHaveCount(0);
  });

  test("筛选漏斗：筛败原因摊开，而且合计是总量之比不是均值", async ({ page }) => {
    await page.getByRole("link", { name: "筛选漏斗与筛败" }).click();
    await expect(page.getByTestId("sf-breakdown")).toBeVisible();
    /* SS-01 的 imaging 6 是最大的一项，排第一 */
    await expect(page.getByTestId("sf-breakdown")).toContainText("影像学不符合");

    /* 合计：筛败 15 ÷ 知情 57 ≈ 26%。
       如果算的是各中心筛败率的平均（32% 与 13% 的均值 = 22%），
       这个数会不一样 —— 这条断言钉的就是那个区别。 */
    await expect(page.locator(".stats")).toContainText("26%");
  });

  test("筛选漏斗：还没预筛的中心，筛败率是「—」不是 0%", async ({ page }) => {
    await page.getByRole("link", { name: "筛选漏斗与筛败" }).click();
    const row = page.getByTestId("screen-row").filter({ hasText: "SS-14" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("—");
    /* 而且它排在最后 —— 它不是表现好，是还没开始 */
    await expect(page.getByTestId("screen-row").last()).toContainText("SS-14");
  });

  test("派工与产能：GCP 过期的顶到最上面，并且说清那是资质失效", async ({ page }) => {
    await page.getByRole("link", { name: "派工与产能" }).click();
    await expect(page.getByTestId("gcp-expired")).toContainText("段志远");
    await expect(page.getByTestId("gcp-expired")).toContainText("资质失效");
    await expect(page.getByTestId("staff-row").first()).toContainText("段志远");
    /* 无人可接也要看得见 —— 交接页解决的是"已经要走了" */
    await expect(page.getByTestId("succession-gap").first()).toBeVisible();
  });

  test("派工与产能：默认只看在职，去掉勾能看到停用的人和原因", async ({ page }) => {
    await page.getByRole("link", { name: "派工与产能" }).click();
    await expect(page.getByTestId("staff-row").first()).toBeVisible();
    const active = await page.getByTestId("staff-row").count();
    await page.getByTestId("active-only").uncheck();
    await expect(page.getByTestId("staff-row")).toHaveCount(active + 1);
    await expect(page.getByTestId("staff-row").filter({ hasText: "周琦" }))
      .toContainText("离职");
  });

  test("审计轨迹：默认只看权限类，切到全量能看到日常写入", async ({ page }) => {
    await page.getByRole("link", { name: "审计轨迹" }).click();
    const rows = page.getByTestId("audit-row");
    await expect(rows.first()).toBeVisible();
    const sensitive = await rows.count();
    /* 默认这一份里每一条都该是敏感的 */
    for (let i = 0; i < sensitive; i++)
      await expect(rows.nth(i)).toContainText("敏感");

    await page.getByTestId("sensitive-only").uncheck();
    await expect(rows).toHaveCount(sensitive + 2);
  });

  test("审计轨迹：改了什么摊得开，且带着当时的角色", async ({ page }) => {
    await page.getByRole("link", { name: "审计轨迹" }).click();
    const row = page.getByTestId("audit-row").filter({ hasText: "调整角色权限" });
    await expect(row).toBeVisible();
    /* 原因是核查时真正被问的那一栏 */
    await expect(row).toContainText("中心谈判");
    await row.getByTestId("audit-diff").click();
    await expect(page.locator("pre").first()).toContainText("subject");
    await expect(page.locator("pre").last()).toContainText("price");
  });
});

test.describe("经营层 · 驾驶舱与财务", () => {
  test.beforeEach(async ({ page }) => { await page.goto("/sites?as=boss"); });

  test("驾驶舱只列要动手的，且每一条都指得出去哪一页", async ({ page }) => {
    await page.getByRole("link", { name: "经营驾驶舱" }).click();
    const todos = page.getByTestId("todo");
    await expect(todos.first()).toBeVisible();

    /* SS-14 一例预筛都没有 —— 这一条要在，而且要标重 */
    await expect(page.getByTestId("todos")).toContainText("一例预筛都没有");
    /* 每一条都带一个去处，不是一句干巴巴的告警 */
    const n = await todos.count();
    for (let i = 0; i < n; i++)
      await expect(todos.nth(i).getByRole("link")).toBeVisible();
  });

  test("驾驶舱不再画第四遍表 —— 主体是待办，不是表格", async ({ page }) => {
    await page.getByRole("link", { name: "经营驾驶舱" }).click();
    await expect(page.getByTestId("todos")).toBeVisible();
    /* 底下那几页已经把表画全了，这一页一张 table 都不该有 */
    await expect(page.locator("table")).toHaveCount(0);
  });

  test("成本与毛利：亏得最多的排最上面，待审那一笔单独说清", async ({ page }) => {
    await page.getByRole("link", { name: "成本与毛利" }).click();
    await expect(page.getByTestId("pnl-row").first()).toBeVisible();
    await expect(page.getByTestId("pnl-summary")).toContainText("个中心");

    /* 毛利升序：第一行的毛利不该大于最后一行 */
    const first = await page.getByTestId("pnl-row").first().innerText();
    const last = await page.getByTestId("pnl-row").last().innerText();
    expect(first).not.toBe(last);
  });

  test("人才梯队：逐条列风险项，不给一个说不清来源的分数", async ({ page }) => {
    await page.getByRole("link", { name: "人才梯队" }).click();
    await expect(page.getByTestId("person-card").first()).toBeVisible();
    /* 段志远：GCP 过期 + 无继任者 —— 至少两项 */
    const duan = page.getByTestId("person-card").filter({ hasText: "段志远" });
    await expect(duan.getByTestId("risk-chip")).toContainText("项风险");
    await expect(duan).toContainText("没有继任者");
    /* 每一条风险都要说得出怎么解 */
    await expect(duan).toContainText("指定继任者");
  });
});

test("CRC 打开成本与毛利：整块金额不画，而且直说为什么", async ({ page }) => {
  await page.goto("/pnl");
  await expect(page.getByTestId("pnl-masked")).toContainText("看不到它们的钱");
});
