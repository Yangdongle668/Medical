import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   访视详情页 —— **在此之前一条 e2e 都没有覆盖到它。**

   这一页是 CRC 每天点得最多的那一页（勾任务、完成访视、录 EDC），
   而 339 条 e2e 里没有一条走进过 `/visits/:id`。
   这一组补的是其中最要紧的一块：**登记 PI 确认**。

   ── 为什么它最要紧 ──────────────────────────────────────────────
   访视做完之后状态是 `done_pending_pi`，而那个状态
   **不计入「已完成」统计**（I3）。把它推到 `locked` 的动作原来
   只有外部的 `pi` 角色有，服务层还要求
   `study_site.pi_account_id = 当前账号` —— 也就是说，
   只有绑了本系统账号的 PI 本人点得动。

   实测 15 个中心里 1 个绑了账号：另外 14 个中心的访视永远推不动，
   189 条卡着，入组进度 / 完成率 / 成本归集全都系统性偏低，
   **而且没有任何地方会报错**。

   迁移 0050 把它改成登记制：PI 签的字仍然是放行条件，
   只是那件事由一线带着日期登记进来 —— 与「登记伦理批复」同一个形状。
   这一组钉的就是那个形状在界面上成不成立。
   ════════════════════════════════════════════════════════════════════ */

/* 演示数据里 v7 = S-0331 的 C5D1，12 天前做完、还没登记确认。
   v9 = C3D1，20 天前做完且已由陈国栋（SS-01 的 PI）确认过。 */
const PENDING = "/visits/v7";
const LOCKED = "/visits/v9";

test.describe("登记 PI 确认", () => {
  test("CRC 登记得了 —— 这正是那 189 条卡住的原因", async ({ page }) => {
    await page.goto(`${PENDING}?as=crc`);
    const block = page.getByTestId("pi-confirm-block");
    await expect(block).toBeVisible();

    /* **日期默认成访视当天，不是今天。** 默认成今天的话，一份 12 天前
       做完的访视会挂上今天的确认日期 —— 而"确认日比访视日晚 12 天"
       这种记录，核查时是要被问的。 */
    const actual = await page.getByTestId("pi-confirm-date").inputValue();
    expect(actual, "应当默认成访视当天，而 v7 是 12 天前做完的")
      .not.toBe(new Date().toISOString().slice(0, 10));

    await page.getByTestId("pi-confirm-go").click();

    /* 登记之后这块消失，换成「PI 已确认」那一行 ——
       而**确认人一栏是空的**：一线登记的，不许冒充成确认人。 */
    await expect(page.getByTestId("pi-confirm-block")).toHaveCount(0);
    const done = page.getByTestId("pi-confirmed");
    await expect(done).toContainText("PI 已确认");
    await expect(done).toContainText("由一线登记");
    await expect(done).toContainText(actual);
  });

  test("签字日期不许早于访视日 —— PI 不会在访视发生前确认它", async ({ page }) => {
    await page.goto(`${PENDING}?as=crc`);
    const date = page.getByTestId("pi-confirm-date");
    await expect(date).toBeVisible();

    await date.fill("2020-01-01");
    await expect(page.getByTestId("pi-confirm-early")).toBeVisible();
    await expect(page.getByTestId("pi-confirm-go")).toBeDisabled();
  });

  test("签字日期不许在将来 —— 这一栏记的是「哪天签的」", async ({ page }) => {
    await page.goto(`${PENDING}?as=crc`);
    const date = page.getByTestId("pi-confirm-date");
    await expect(date).toBeVisible();

    const 明年 = `${new Date().getFullYear() + 1}-01-01`;
    await date.fill(明年);
    await expect(page.getByTestId("pi-confirm-future")).toBeVisible();
    await expect(page.getByTestId("pi-confirm-go")).toBeDisabled();
  });

  test("没有这个动作的角色看得到这一块，但点不了，并且说得出缺什么",
    async ({ page }) => {
      /* DM 的动作是 closeQ / raiseQ / subjRead —— 没有 piConfirm。
         **要说出缺的是什么**：一个灰掉的按钮教不会任何人去申请权限。 */
      await page.goto(`${PENDING}?as=dm`);
      await expect(page.getByTestId("pi-confirm-denied"))
        .toContainText("登记 PI 确认访视");
      await expect(page.getByTestId("pi-confirm-go")).toHaveCount(0);
    });

  test("真绑了账号的 PI 自己点，确认人记的是他本人", async ({ page }) => {
    /* SS-01 就是那 1 / 15 —— 陈国栋有账号。两条一起才说得清
       「确认人」这一栏什么时候有名字、什么时候是空的。 */
    await page.goto(`${PENDING}?as=pi`);
    await page.getByTestId("pi-confirm-go").click();
    const done = page.getByTestId("pi-confirmed");
    await expect(done).toContainText("陈国栋");
    await expect(done).toContainText("在本系统确认");
  });

  test("已锁定的访视不再显示登记块，只显示确认结果", async ({ page }) => {
    await page.goto(`${LOCKED}?as=crc`);
    await expect(page.getByTestId("pi-confirmed")).toContainText("PI 已确认");
    await expect(page.getByTestId("pi-confirm-block")).toHaveCount(0);
  });
});
