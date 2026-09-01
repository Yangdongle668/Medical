import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   外部角色那四页。

     研究者工作台 —— 等我签字的访视（PI 只有这一个动作）
     机构工作台   —— 本院承接的项目，合规不合规
     机构质控     —— 机构提出的事件，关闭权在机构
     人员备案     —— 我这几个中心上有谁、证书还有效吗

   ── 这一组测试真正要钉的是"看得窄" ────────────────────────────────
   四页存在的全部理由是**行范围比内部窄**。所以每一页都有一条
   "内部身份看得到、外部身份看不到"的对照 —— 只测"页面画得出来"，
   把行范围写漏了照样全绿。
   ════════════════════════════════════════════════════════════════════ */

test.describe("研究者工作台", () => {
  test("待确认的访视排在最上面，逾期的标出来", async ({ page }) => {
    await page.goto("/pi?as=pi");
    await expect(page.getByTestId("pi-summary")).toContainText("等你确认");
    const rows = page.getByTestId("pi-visit");
    await expect(rows.first()).toBeVisible();
    /* 等了 12 天那条排第一，且挂着角标 —— 不是按中心代号排的。 */
    await expect(rows.first().getByTestId("pi-stale")).toBeVisible();
  });

  test("已经签过字的那条不在队列里", async ({ page }) => {
    await page.goto("/pi?as=pi");
    await expect(page.getByTestId("pi-visit").first()).toBeVisible();
    /* v9 已确认。它出现在这里就说明 pendingPi 那个筛子没生效 ——
       而"少筛一条"在界面上和"多一条待办"长得一模一样。 */
    await expect(page.getByTestId("pi-visit").filter({ hasText: "C3D1" }))
      .toHaveCount(0);
  });

  test("确认一条 → 它从队列里消失", async ({ page }) => {
    await page.goto("/pi?as=pi");
    const rows = page.getByTestId("pi-visit");
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();
    await rows.first().getByRole("button", { name: "我确认" }).click();
    await expect(page.getByTestId("pi-said")).toContainText("已确认");
    await expect(rows).toHaveCount(before - 1);
  });

  test("说清「CRC 说做完了」和「PI 确认做完了」是两回事", async ({ page }) => {
    await page.goto("/pi?as=pi");
    await expect(page.locator(".derive").first())
      .toContainText("不计入「已完成」统计");
  });

  test("行范围：PI 只看自己签字的中心", async ({ page }) => {
    await page.goto("/pi?as=pi");
    const sites = page.getByTestId("pi-site");
    await expect(sites.first()).toBeVisible();
    /* 三个中心里只有 SS-01 的 pi_account_id 指到他。
       SS-07 / SS-14 出现在这里就是行范围漏了。 */
    await expect(sites).toHaveCount(1);
    await expect(sites.first()).toContainText("SS-01");
  });
});

test.describe("机构工作台", () => {
  test("按项目分组列本院的中心", async ({ page }) => {
    await page.goto("/inst?as=inst");
    await expect(page.getByTestId("inst-summary")).toContainText("北京协和医院");
    await expect(page.getByTestId("inst-study").first()).toBeVisible();
    await expect(page.getByTestId("inst-site").first()).toContainText("SS-01");
  });

  test("行范围：别家医院的中心一行都没有", async ({ page }) => {
    await page.goto("/inst?as=inst");
    await expect(page.getByTestId("inst-site").first()).toBeVisible();
    await expect(page.getByTestId("inst-site")).toHaveCount(1);
    for (const code of ["SS-07", "SS-14"])
      await expect(page.getByTestId("inst-site").filter({ hasText: code }))
        .toHaveCount(0);
  });

  test("一栏钱都不画，并说清为什么", async ({ page }) => {
    await page.goto("/inst?as=inst");
    /* 单价与启动费受 price 列权限管辖 —— 机构办拿不到。
       **整列不画**，不是画一列横杠：后者会让人以为将来会有数。 */
    await expect(page.locator("table")).not.toContainText("单价");
    await expect(page.locator(".derive").last()).toContainText("一栏钱都没有");
  });

  test("入组数看得到、受试者明细看不到 —— 这一条写在页面上", async ({ page }) => {
    await page.goto("/inst?as=inst");
    await expect(page.locator(".derive").last()).toContainText("是哪几例");
  });
});

test.describe("机构质控", () => {
  test("重的排前面，挂久了的标出来", async ({ page }) => {
    await page.goto("/inst/qc?as=inst");
    const rows = page.getByTestId("qc-row");
    await expect(rows.first()).toBeVisible();
    /* 重大（SAE）在前，其次严重（挂了 60 天那条偏离），轻微在后。
       按发现日排的那一版会让 60 天那条沉到底下去。 */
    await expect(rows.first()).toContainText("重大");
    await expect(page.getByTestId("qc-stale").first()).toBeVisible();
  });

  test("行范围：SS-07 那件药品不平衡，机构办看不到", async ({ page }) => {
    await page.goto("/inst/qc?as=inst");
    await expect(page.getByTestId("qc-row").first()).toBeVisible();
    await expect(page.getByTestId("qc-row").filter({ hasText: "SS-07" }))
      .toHaveCount(0);
  });

  test("关闭要写整改说明，短了按钮点不动", async ({ page }) => {
    await page.goto("/inst/qc?as=inst");
    const row = page.getByTestId("qc-row").filter({ hasText: "知情同意版本" });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "关闭" }).click();
    await expect(page.getByTestId("qc-form")).toBeVisible();

    const submit = page.getByTestId("qc-submit");
    await expect(submit).toBeDisabled();
    await page.getByTestId("qc-reason").fill("已");
    await expect(submit).toBeDisabled();
    await page.getByTestId("qc-reason")
      .fill("已重新签署 v3.1 版知情，并对全体研究人员做了版本管理培训。");
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByTestId("qc-said")).toContainText("已关闭");
    /* 默认只看未了结的 —— 关掉之后这一行就该从表上下去 */
    await expect(page.getByTestId("qc-row").filter({ hasText: "知情同意版本" }))
      .toHaveCount(0);
  });

  test("CRC 没有 closeQA：表还在，按钮不给", async ({ page }) => {
    await page.goto("/inst/qc");
    await expect(page.getByTestId("qc-forbidden")).toContainText("只读");
    await expect(page.getByTestId("qc-row").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "关闭" })).toHaveCount(0);
  });

  test("没有「新建事件」，且说清为什么缺", async ({ page }) => {
    await page.goto("/inst/qc?as=inst");
    await expect(page.getByRole("button", { name: /新建/ })).toHaveCount(0);
    await expect(page.locator(".derive").last()).toContainText("纸质质控报告");
  });
});

test.describe("人员备案与准入", () => {
  test("证书过期的顶在最上面，并单独说一句", async ({ page }) => {
    await page.goto("/inst/registry?as=inst");
    await expect(page.getByTestId("reg-expired")).toContainText("不得开展工作");
    const rows = page.getByTestId("reg-row");
    await expect(rows.first()).toBeVisible();
    await expect(rows.first().getByTestId("reg-expired-chip")).toBeVisible();
  });

  test("在岗中心只列范围内的 —— 别家医院那几个不该出现", async ({ page }) => {
    await page.goto("/inst/registry?as=inst");
    const duan = page.getByTestId("reg-row").filter({ hasText: "段志远" });
    await expect(duan).toBeVisible();
    /* 段志远同时带 SS-01 与 SS-14。机构办（协和）只该看到前者 ——
       看到两个就说明中心列表没按范围重算，
       而那等于告诉机构办"他在别家还带着一个"。 */
    await expect(duan).toContainText("SS-01");
    await expect(duan).not.toContainText("SS-14");
  });

  test("停用的人留在表上，并说清为什么", async ({ page }) => {
    await page.goto("/inst/registry?as=inst");
    await expect(page.getByTestId("reg-inactive").first()).toBeVisible();
    await expect(page.getByText("从表上抹掉")).toBeVisible();
  });

  test("只看要动手的：勾上之后剩下过期、快到期与无记录", async ({ page }) => {
    await page.goto("/inst/registry?as=inst");
    const rows = page.getByTestId("reg-row");
    await expect(rows.first()).toBeVisible();
    const before = await rows.count();
    await page.getByTestId("reg-problem-only").check();
    await expect(rows).not.toHaveCount(before);
    /* 剩下的每一行都要挂着两个角标之一，或者写着"无记录" */
    for (const row of await rows.all())
      await expect(row.locator(".chip.crit, .chip.warn").first()).toBeVisible();
  });

  test("说清这不是人事名册的一个筛子", async ({ page }) => {
    await page.goto("/inst/registry?as=inst");
    await expect(page.locator(".derive").last())
      .toContainText("不是人事名册的一个筛子");
    /* 职级这一列不该出现 —— 它在 /people，不在这里 */
    await expect(page.locator("table")).not.toContainText("职级");
  });
});

test.describe("导航", () => {
  test("机构办的侧栏只有机构办公室那一组", async ({ page }) => {
    await page.goto("/inst?as=inst");
    const nav = page.locator("nav");
    await expect(nav.getByRole("link", { name: "机构工作台" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "人员备案与准入" })).toBeVisible();
    /* 内部那些模块一个都不该在 —— 侧栏跟着 role_module 走 */
    await expect(nav.getByRole("link", { name: "经营驾驶舱" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "成本与毛利" })).toHaveCount(0);
  });

  test("研究者的侧栏只有两项", async ({ page }) => {
    await page.goto("/pi?as=pi");
    const nav = page.locator("nav");
    await expect(nav.getByRole("link", { name: "研究者工作台" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "质量事件与 CAPA" })).toBeVisible();
    await expect(nav.getByRole("link")).toHaveCount(2);
  });

  test("立项受理还没建：导航照出，点进去说清它将来长什么样", async ({ page }) => {
    await page.goto("/inst?as=inst");
    await page.getByRole("link", { name: "立项受理" }).click();
    await expect(page.getByText("受理与退回")).toBeVisible();
  });
});
