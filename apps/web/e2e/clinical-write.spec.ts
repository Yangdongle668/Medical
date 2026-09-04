import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   临床与稽查那几个写端点。

   四条都在服务端跑着，界面上一个都按不到：
   · SAE 录不进去，也标不了「已上报」—— 于是 24 小时及时率永远只有分母；
   · 受试者退不了组 —— 于是他的剩余访视永远刷红超窗；
   · 访视标不了「已录入 EDC」—— 于是录入及时率同样只有分母；
   · 稽查记不下发现项 —— 于是一次稽查要么空着结案，要么只能靠 seed。

   共同点是：**这几步都不阻断任何东西**，所以缺了也不会有人报障。
   它们缺的时候，坏掉的是统计口径，而看板照样出数。
   ════════════════════════════════════════════════════════════════════ */

test.describe("SAE", () => {
  test("登记一条 SAE —— 发生时刻不预填成现在", async ({ page }) => {
    await page.goto("/quality?as=crc");
    await expect(page.getByTestId("sae-panel")).toBeVisible();

    await page.getByTestId("new-sae").click();
    /* **不预填当前时间。** 预填等于替人回答了那个决定及时率的问题，
       而他多半会直接按下去 —— 然后及时率永远是 100%。 */
    await expect(page.getByTestId("sae-occurred")).toHaveValue("");

    await page.getByTestId("sae-title").fill("III 度中性粒细胞减少伴发热");
    await page.getByTestId("sae-detail")
      .fill("第 2 周期 D8 出现寒战高热，ANC 0.4×10⁹/L，收入院予以升白与抗感染治疗。");
    await page.getByTestId("sae-occurred").fill("2026-09-01T09:30");

    await page.getByTestId("new-sae-submit").click();
    await expect(page.getByTestId("toast")).toContainText("III 度中性粒细胞减少");
  });

  test("超 24 小时的登记上报：按下去之前就说清会生成什么", async ({ page }) => {
    await page.goto("/quality?as=crc");

    /* 台账上「尚未上报（已超时）」的那一条 */
    const row = page.getByTestId("sae-row")
      .filter({ hasText: "尚未上报（已超时）" }).first();
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "登记已上报" }).click();

    /* 超时的后果不能等按下去之后才知道 —— 那条超时事件
       不可跳过、不能人工删除，只能整改关闭。 */
    await expect(page.getByTestId("sae-late-warn")).toContainText("不能人工删除");
  });
});

test.describe("受试者脱落", () => {
  test("登记脱落：两个后果都在按下去之前说出来", async ({ page }) => {
    await page.goto("/subjects?as=crc");
    const row = page.getByTestId("subject-row").first();
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "登记脱落" }).click();
    await expect(page.getByTestId("wd-form")).toBeVisible();

    /* ① 收入按已完成访视比例计，不按整例；
       ② 剩余未完成的访视一并作废 —— 不作废这一例会永远刷红超窗。 */
    const note = page.getByTestId("wd-consequence");
    await expect(note).toContainText("已完成访视比例");
    await expect(note).toContainText("一并作废");

    await page.getByTestId("wd-reason").selectOption("adverse_event");
    await page.getByTestId("wd-date").fill("2026-09-02");
    await page.getByTestId("wd-note")
      .fill("第 3 周期出现 III 度肝损伤，研究者判断需终止治疗，已完成末次安全性随访。");

    await page.getByTestId("wd-submit").click();
    await expect(page.getByTestId("toast")).toBeVisible();
  });

  test("说明不到 4 字提交不了 —— 「脱落」两个字答不了核查", async ({ page }) => {
    await page.goto("/subjects?as=crc");
    const row = page.getByTestId("subject-row").first();
    await row.getByRole("button", { name: "登记脱落" }).click();

    await page.getByTestId("wd-reason").selectOption("lost_to_followup");
    await page.getByTestId("wd-date").fill("2026-09-02");
    await page.getByTestId("wd-note").fill("失访");
    await expect(page.getByTestId("wd-submit")).toBeDisabled();
  });
});

test.describe("稽查发现", () => {
  test("记一条发现", async ({ page }) => {
    await page.goto("/audit?as=qa");
    const audit = page.getByTestId("audit-row").first();
    await expect(audit).toBeVisible();

    await audit.getByRole("button", { name: "记一条发现" }).click();
    await expect(page.getByTestId("audit-finding-form")).toBeVisible();

    await page.getByTestId("af-severity").selectOption("major");
    await page.getByTestId("af-text")
      .fill("抽查 20 份原始病历，3 份的合并用药记录与 EDC 不一致，且无更正说明。");

    await audit.getByTestId(/^af-submit-/).click();
    await expect(page.getByTestId("audit-said")).toBeVisible();
    await expect(audit.getByTestId("audit-finding").last())
      .toContainText("合并用药记录与 EDC 不一致");
  });

  test("指向一条不早于本次稽查的事件 —— 那不是复发，服务端说得出为什么",
    async ({ page }) => {
      /* 复发要指向具体那一条质量事件，**用外键不是编号字符串** ——
         原型拿字符串去找源事件，找不到就静默丢掉，
         而复发这个指标存在的全部理由就是抓这件事。

         而"指向了"还不够：源事件必须**早于本次稽查**。
         指向一条今天才提出的事件，那不是复发 —— 这条判定会把
         同类问题的 CAPA 判成「无效」，判错的代价不小。 */
      await page.goto("/audit?as=qa");
      const audit = page.getByTestId("audit-row").first();
      await audit.getByRole("button", { name: "记一条发现" }).click();

      await page.getByTestId("af-text")
        .fill("抽查发现同一份知情同意书版本号仍然是旧版，与上一轮问题相同。");
      await page.getByTestId("af-repeat").selectOption({ index: 1 });
      await audit.getByTestId(/^af-submit-/).click();

      /* 拦下来，并且说得出为什么 —— 不是一句"参数错误"。 */
      await expect(page.getByTestId("audit-problem")).toContainText("那不是复发");
    });

  test("发现不到 10 字记不下来", async ({ page }) => {
    await page.goto("/audit?as=qa");
    const audit = page.getByTestId("audit-row").first();
    await audit.getByRole("button", { name: "记一条发现" }).click();
    await page.getByTestId("af-text").fill("有问题");
    await expect(audit.getByTestId(/^af-submit-/)).toBeDisabled();
  });
});
