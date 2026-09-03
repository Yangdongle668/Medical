import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   立项受理与中心文件（ISF）。

   这一组盯的是三对**很容易被抹平**的区别：
     · 材料齐备 ≠ 已受理 —— 齐备是清单算出来的，受理是机构的一次决定；
     · 空清单有两种意思 —— 「八项都齐」与「没人在这儿查过」；
     · 缺失 ≠ 过期 —— 一个要去要，一个要去换。
   ════════════════════════════════════════════════════════════════════ */

test.describe("立项受理（机构办）", () => {
  test.beforeEach(async ({ page }) => { await page.goto("/inst/intake?as=inst"); });

  test("先说清它是一道真闸门，不是一张收发登记表", async ({ page }) => {
    const d = page.locator(".derive").first();
    await expect(d).toContainText("不评价科学性");
    await expect(d).toContainText("材料不齐就受理");
    await expect(d).toContainText("推不到「伦理递交」");
  });

  test("**缺件说的是名字，不是数目** —— 补正通知要写的正是那几个名字", async ({ page }) => {
    const row = page.getByTestId("ac-row").filter({ hasText: "AC-2026-038" });
    await expect(row.getByTestId("ac-missing")).toContainText("组长单位伦理批件");
    await expect(row.getByTestId("ac-missing")).toContainText("保险单");
  });

  test("材料不齐点受理会被拦下，而且拦的时候把名字列出来", async ({ page }) => {
    const row = page.getByTestId("ac-row").filter({ hasText: "AC-2026-038" });
    await row.getByRole("button", { name: "予以受理" }).click();
    const p = page.getByTestId("ac-problem");
    await expect(p).toContainText("不予受理");
    await expect(p).toContainText("组长单位伦理批件");
  });

  test("**齐备 ≠ 已受理** —— 八项都勾上了，状态仍然是形式审查中", async ({ page }) => {
    const row = page.getByTestId("ac-row").filter({ hasText: "AC-2026-041" });
    await expect(row.getByTestId("ac-missing")).toHaveCount(0);
    await expect(row).toContainText("形式审查中");
    await expect(row).toContainText("8/8");
  });

  test("勾掉一项，缺件立刻按名字显形", async ({ page }) => {
    const row = page.getByTestId("ac-row").filter({ hasText: "AC-2026-041" });
    /* click 而不是 uncheck：勾选要往接口走一趟，
       uncheck 读的是渲染前的 DOM，会在"点了却没变"上假红。 */
    await row.getByRole("checkbox").nth(6).click();
    await expect(row.getByTestId("ac-missing")).toContainText("保险单");
    await expect(row).toContainText("7/8");
  });

  test("走完一条：勾齐 → 受理 → 清单冻结", async ({ page }) => {
    const row = page.getByTestId("ac-row").filter({ hasText: "AC-2026-042" });
    await expect(row).toContainText("待补正");
    await expect(row.getByTestId("ac-amend-note")).toContainText("保险单");
    for (const i of [6, 7]) await row.getByRole("checkbox").nth(i).click();
    await expect(row.getByTestId("ac-missing")).toHaveCount(0);

    await row.getByRole("button", { name: "予以受理" }).click();
    await expect(page.getByTestId("ac-said")).toContainText("已受理并转伦理审查");
    await expect(row.getByTestId("ac-done")).toContainText("受理人 张慧敏");
    /* 受理通知发出去了，清单还能改，那张通知就不再对应任何一份材料。 */
    await expect(row.getByRole("checkbox").first()).toBeDisabled();
  });

  test("**受理了但中心还没进台账** —— 建档滞后在医院这一侧的样子", async ({ page }) => {
    const row = page.getByTestId("ac-row").filter({ hasText: "AC-2026-038" });
    await expect(row.getByTestId("ac-unfiled")).toContainText("还没进受托方台账");
  });

  test("**系统外登记的存根：空清单是「没人在这儿查过」**", async ({ page }) => {
    const row = page.getByTestId("ac-row").filter({ hasText: "AC-2024-001" });
    await expect(row.getByTestId("ac-registered")).toBeVisible();
    const note = row.getByTestId("ac-stub-note");
    await expect(note).toContainText("没有受理人，也没有材料清单");
    await expect(note).toContainText("不是「八项都齐」");
    /* 存根上没有勾选框，也没有受理按钮 —— 它记的是一件已经发生过的事。 */
    await expect(row.getByRole("checkbox")).toHaveCount(0);
    await expect(row.getByRole("button", { name: "予以受理" })).toHaveCount(0);
    await expect(row.getByTestId("ac-done")).toContainText("系统外受理，仅登记受理号");
  });

  test("补正通知要说清缺什么 —— 不写理由发不出去", async ({ page }) => {
    const row = page.getByTestId("ac-row").filter({ hasText: "AC-2026-038" });
    await row.getByRole("button", { name: "发出补正通知" }).click();
    const form = page.getByTestId("ac-form");
    /* 预填的正是缺的那两份 —— 让人改，而不是让人从头想。 */
    await expect(form.getByTestId("ac-reason")).toHaveValue(/组长单位伦理批件/);
    await form.getByTestId("ac-reason").fill("请");
    await expect(form.getByTestId("ac-submit")).toBeDisabled();
    await form.getByTestId("ac-reason").fill("请补齐组长单位伦理批件与保险单。");
    await form.getByTestId("ac-submit").click();
    await expect(page.getByTestId("ac-said")).toContainText("补正通知");
  });

  test("**我方看不到别家医院递的材料** —— 开放的是角色那一维，不是行那一维",
    async ({ page }) => {
      await page.goto("/inst/intake?as=crc");
      /* CRC 派在 SS-01（协和）上，所以协和那几条它看得见；
         但受理按钮没有 —— accept 只有机构办与管理员有。 */
      await expect(page.getByTestId("ac-row").first()).toBeVisible();
      await expect(page.getByRole("button", { name: "予以受理" })).toHaveCount(0);
      await expect(page.getByRole("checkbox").first()).toBeDisabled();
    });
});

test.describe("中心文件与物资", () => {
  test.beforeEach(async ({ page }) => { await page.goto("/isf?as=crc"); });

  test("先说清状态是算出来的，不是存下来的", async ({ page }) => {
    const d = page.locator(".derive").first();
    await expect(d).toContainText("只存事实");
    await expect(d).toContainText("存成枚举它会过期");
  });

  test("**缺失与过期分开数** —— 一个要去要，一个要去换", async ({ page }) => {
    const s = page.getByTestId("isf-summary");
    await expect(s).toContainText("缺失 2 项");
    await expect(s).toContainText("已过期 1 项");
  });

  test("**已过期说的是「已过期 N 天」，不是 0 天**", async ({ page }) => {
    const row = page.getByTestId("isf-row").filter({ hasText: "室间质评" });
    await expect(row).toContainText("已过期");
    await expect(row).toContainText("已过期 9 天");
  });

  test("临期说得出为什么现在就提醒 —— 提前量按类别不同", async ({ page }) => {
    const row = page.getByTestId("isf-row").filter({ hasText: "伦理年度跟踪" });
    await expect(row).toContainText("临期");
    await expect(row).toContainText("还剩 40 天");
    await expect(row).toContainText("提前 60 天提醒");
  });

  test("库存不足说得出补货线 —— 「少到多少算少」要有答案", async ({ page }) => {
    const row = page.getByTestId("isf-row").filter({ hasText: "知情同意书" });
    await expect(row).toContainText("库存不足");
    await expect(row).toContainText("补货线 10");
  });

  test("**缺失与过期排在最前** —— 顺序本身就是这一页的答案", async ({ page }) => {
    const first = page.getByTestId("isf-row").first();
    await expect(first).toContainText(/缺失|已过期/);
  });

  test("**齐备率按全部清单算** —— 只看不齐备的那一栏时它不该变成 0%",
    async ({ page }) => {
      const before = await page.getByTestId("isf-summary").textContent();
      await page.getByTestId("isf-open-only").click();
      await expect(page.getByTestId("isf-row").filter({ hasText: "齐备" }))
        .toHaveCount(0);
      expect(await page.getByTestId("isf-summary").textContent()).toBe(before);
    });

  test("补上一份缺失的文件，状态跟着事实走", async ({ page }) => {
    const row = page.getByTestId("isf-row").filter({ hasText: "GCP 证书" }).first();
    await expect(row).toContainText("缺失");
    await row.getByRole("button", { name: "核对" }).click();
    await page.getByTestId("isf-present").check();
    await page.getByTestId("isf-expires").fill("2028-06-30");
    await page.getByTestId("isf-save").click();
    await expect(page.getByTestId("isf-said")).toContainText("已核对");
    await expect(page.getByTestId("isf-row").filter({ hasText: "GCP 证书" }).first())
      .toContainText("齐备");
  });

  test("**标为缺失就不该还留着到期日** —— 先决定它到底在不在", async ({ page }) => {
    const row = page.getByTestId("isf-row").filter({ hasText: "离心机校准" });
    await row.getByRole("button", { name: "核对" }).click();
    /* 取消勾选后到期日输入框禁用，但已填的值还在 —— 提交时被拦下。 */
    await page.getByTestId("isf-present").uncheck();
    await page.getByTestId("isf-save").click();
    await expect(page.getByTestId("isf-problem")).toContainText("先决定它到底在不在");
  });

  test("机构办翻得到本院那摞纸 —— 但改不动", async ({ page }) => {
    await page.goto("/isf?as=inst");
    await expect(page.getByTestId("isf-row").first()).toBeVisible();
    for (const r of await page.getByTestId("isf-row").all())
      await expect(r).toContainText("SS-01");
    await expect(page.getByRole("button", { name: "核对" })).toHaveCount(0);
  });
});
