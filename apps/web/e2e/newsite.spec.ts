import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   中心建档 —— 这条流此前**在界面上根本走不了**。

   `createStudySite` 从 Phase 6 起就在服务端跑着（带幂等键、带审计），
   但台账页只有一张表，没有任何入口。于是系统里的中心只进得来
   seed 灌的那三个：一个跑起来的系统没法把第 16 个中心建进去。

   契约对这个端点的说明写清了它为什么要紧：
   「已建档 / 合同中心数」的差值 = 合同里写了但还没进系统的中心 ——
   它们的成本已经在发生，收入却挂不上号。

   这条测试走的是那条真正的路：台账 → 建档 → 新中心出现在台账上，
   且**停在「合同签署」**（不是直接就绪）—— 启动要另走闸门那条流。
   ════════════════════════════════════════════════════════════════════ */

test("建一个中心：填表 → 落到台账上 → 停在合同签署", async ({ page }) => {
  /* `?as=boss`：看得见价钱的身份，建档表单上才有那两栏。
     下面第二个用例验的正是"看不见价钱的人也能建档"。 */
  await page.goto("/sites?as=boss");

  /* 先等台账真的加载出来再数 —— 页面刚打开时表是空的，
     那时数到的 0 会让下面 `before + 1` 变成一句必然不成立的断言。 */
  await expect(page.getByTestId("site-row").first()).toBeVisible();
  const before = await page.getByTestId("site-row").count();

  await page.getByTestId("new-site").click();
  await expect(page.getByTestId("new-site-form")).toBeVisible();

  /* 项目是下拉选的 —— 中心必须挂在一个项目下，
     「挂不上号的成本」正是这个端点要消灭的东西。 */
  await page.getByTestId("ns-study").selectOption({ index: 1 });
  await page.getByTestId("ns-code").fill("SS-99");
  await page.getByTestId("ns-hospital").fill("四川大学华西医院");
  await page.getByTestId("ns-dept").fill("胸外科");
  await page.getByTestId("ns-city").fill("成都");
  await page.getByTestId("ns-pi").fill("罗明远");
  await page.getByTestId("ns-contracted").fill("24");
  await page.getByTestId("ns-price").fill("61000");

  await page.getByTestId("new-site-submit").click();

  /* 建完说一句 —— 这一页不会自己变个样子，没有这句话人会再按一次。 */
  await expect(page.getByTestId("toast")).toContainText("SS-99 已建档");

  /* 落到台账上：多一行，而且是刚才填的那一行。 */
  await expect(page.getByTestId("site-row")).toHaveCount(before + 1);
  const row = page.getByTestId("site-row").filter({ hasText: "SS-99" });
  await expect(row).toContainText("四川大学华西医院");
  await expect(row).toContainText("罗明远");
  await expect(row).toContainText("24");

  /* **停在「合同签署」** —— 建档不等于启动。
     直接就绪的话，启动清单那道闸门就被绕过去了。 */
  await expect(row).toContainText("合同签署");
});

test("必填没齐，建档按钮不亮 —— 而不是按下去再报错", async ({ page }) => {
  await page.goto("/sites?as=boss");
  await page.getByTestId("new-site").click();

  await expect(page.getByTestId("new-site-submit")).toBeDisabled();

  await page.getByTestId("ns-study").selectOption({ index: 1 });
  await page.getByTestId("ns-code").fill("SS-98");
  await page.getByTestId("ns-hospital").fill("浙江大学医学院附属第一医院");
  await page.getByTestId("ns-dept").fill("感染病科");
  await page.getByTestId("ns-city").fill("杭州");
  await page.getByTestId("ns-pi").fill("周敏");
  /* 合同例数还没填 —— 按钮仍然不该亮 */
  await expect(page.getByTestId("new-site-submit")).toBeDisabled();

  await page.getByTestId("ns-contracted").fill("18");
  await page.getByTestId("ns-price").fill("52000");
  await expect(page.getByTestId("new-site-submit")).toBeEnabled();
});

test("看不见价钱的人也能建档 —— 建档是运营动作，不是商务动作", async ({ page }) => {
  /* CRC 的列权限里没有 price。价钱那两栏应当**不出现**，
     而不是出现一个禁用的输入框：禁用的框在说"你本该填这个但不许"，
     而事实是这件事根本不归他管。 */
  await page.goto("/sites?as=crc");
  await page.getByTestId("new-site").click();

  await expect(page.getByTestId("ns-price")).toHaveCount(0);
  await expect(page.getByTestId("ns-startup-fee")).toHaveCount(0);

  await page.getByTestId("ns-study").selectOption({ index: 1 });
  await page.getByTestId("ns-code").fill("SS-97");
  await page.getByTestId("ns-hospital").fill("复旦大学附属中山医院");
  await page.getByTestId("ns-dept").fill("心内科");
  await page.getByTestId("ns-city").fill("上海");
  await page.getByTestId("ns-pi").fill("沈亦柔");
  await page.getByTestId("ns-contracted").fill("16");

  /* 没有价钱那两栏，必填也就齐了 —— 按钮该亮 */
  await expect(page.getByTestId("new-site-submit")).toBeEnabled();
  await page.getByTestId("new-site-submit").click();
  await expect(page.getByTestId("toast")).toContainText("SS-97 已建档");
});

test("中心编号撞车：服务端拦下，理由摆在表单上", async ({ page }) => {
  await page.goto("/sites?as=boss");
  await page.getByTestId("new-site").click();

  await page.getByTestId("ns-study").selectOption({ index: 1 });
  /* SS-01 是种子里就有的编号 */
  await page.getByTestId("ns-code").fill("SS-01");
  await page.getByTestId("ns-hospital").fill("重复编号医院");
  await page.getByTestId("ns-dept").fill("内科");
  await page.getByTestId("ns-city").fill("北京");
  await page.getByTestId("ns-pi").fill("测试");
  await page.getByTestId("ns-contracted").fill("10");
  await page.getByTestId("ns-price").fill("50000");
  await page.getByTestId("new-site-submit").click();

  /* 失败留在页面上，不用吐司 —— 吐司会自己消失，而失败要人读完再决定。 */
  await expect(page.getByTestId("new-site-problem")).toContainText("SS-01");
  await expect(page.getByTestId("new-site-form")).toBeVisible();
});
