import { test, expect, type Page } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   地下室 —— 离线队列与幂等重放。

   **这一组只能放在集成层，不能放在 e2e 层。**
   MSW 是 Service Worker，它在 fetch 事件里直接应答，根本不碰网络；
   于是 `context.setOffline(true)` 对它毫无影响 —— 请求照样成功，
   队列一条也不会进。写在 e2e 里的那一版就是这么failing 的，
   而它"失败"的方式恰好证明了两层测试各自的边界：
   **离线行为只有在真的有网络的地方才试得出来。**

   验的是三件事：
   ① 断网提交不再静默丢失 —— 以前 fetch 抛出去没人接，
      按钮弹回来什么也没有，那次活就没了；
   ② 恢复联网后按原顺序自动重放；
   ③ **重放用的是入队时那把幂等键** —— 所以服务端只会记一笔。
      这一条是整个 Phase 7 的关键：每次重放换一把新键的话，
      服务端看到的就是两条不同的命令。

   ── 这套测试第一次跑就抓到了一个真问题 ───────────────────────────
   原本第三个用例连勾两下，落库只 +1。查下去不是重放的错：
   清单行的勾选状态**只来自服务端**，断网时那一勾发不出去，
   行上没有任何变化 —— 于是"勾第二项"实际上勾的还是**同一项**，
   进队列的是两条同样的命令、两把不同的幂等键。
   **幂等键防不了这个**：它防的是同一条命令发两遍，
   防不了客户端生成了两条命令。
   修在两处：入队时折叠重复命令，以及行上显示"待发"且勾不动。
   所以下面既验重放，也验"第二次点不下去"。
   ════════════════════════════════════════════════════════════════════ */

async function devLogin(page: Page, testid: string) {
  await page.goto("/login");
  await page.getByTestId("dev-panel").locator("summary").click();
  await page.getByTestId(testid).click();
  await expect(page).toHaveURL(/\/today$/);
}

/** 打开 SS-13 的启动清单 —— 16 项，其他 spec 都不碰它。 */
async function openChecklist(page: Page) {
  await page.goto("/sites");
  await expect(page.getByTestId("site-row").first()).toBeVisible();
  await page.getByRole("link", { name: "SS-13", exact: true }).click();
  await page.getByTestId("open-startup").click();
  await expect(page.getByTestId("startup-item").first()).toBeVisible();
}

const openBoxes = (page: Page) =>
  page.locator("[data-testid=startup-item] input[type=checkbox]:not(:checked)");

test("断网提交：不再静默丢失，而是进发件箱", async ({ page, context }) => {
  await devLogin(page, "dev-lingyuan");
  await openChecklist(page);
  const before = await openBoxes(page).count();
  expect(before).toBeGreaterThan(2);
  const doneBefore = Number(
    await page.getByTestId("counters").locator("b").nth(1).innerText());

  await context.setOffline(true);
  await openBoxes(page).first().click();

  /* 提交没有消失：页面明说它进了发件箱，侧栏也看得见 */
  await expect(page.getByTestId("checklist-problem")).toContainText("发件箱");
  await expect(page.getByTestId("checklist-problem")).toContainText("不会记成两笔");
  await expect(page.getByTestId("outbox-badge")).toContainText("1 条待发");

  /* **那一行自己也要说出来。** 全局角标回答不了"我刚勾的那行怎么了"，
     而看不出变化的人会再勾一次 —— 那就是第二条命令、第二把幂等键。
     恰好一行待发：不是零（没提示），也不是两行（勾串了）。 */
  const queuedRow = page.locator('[data-testid=startup-item][data-queued="1"]');
  await expect(queuedRow).toHaveCount(1);
  await expect(queuedRow.getByTestId("queued-chip")).toHaveText("待发");
  await expect(queuedRow.locator("input[type=checkbox]")).toBeDisabled();

  /* 待发 ≠ 已完成。勾是人的意思，落库还没发生 ——
     所以服务端那个"已完成"数一动不动，界面不替服务端把话说满。 */
  await expect(page.getByTestId("counters").locator("b").nth(1))
    .toHaveText(String(doneBefore));

  await context.setOffline(false);
});

test("发件箱：看得见待发的是什么，也看得见当前离线", async ({ page, context }) => {
  await devLogin(page, "dev-lingyuan");
  await openChecklist(page);

  await context.setOffline(true);
  await openBoxes(page).first().click();
  await expect(page.getByTestId("outbox-badge")).toBeVisible();
  await page.getByTestId("outbox-badge").click();

  await expect(page.getByTestId("net-state")).toContainText("当前离线");
  const item = page.getByTestId("pending-item").first();
  await expect(item).toBeVisible();
  /* 发件箱里要看得出那是哪次活，而不是一个 operationId */
  await expect(item).not.toContainText("completeStartupItem");
  await expect(item).toContainText("启动清单");
  /* 离线时"立即发送"是禁用的 —— 点了也发不出去，不如说清楚 */
  await expect(page.getByTestId("retry-now")).toBeDisabled();

  await context.setOffline(false);
});

test("恢复联网：按序重放，且服务端只记一笔", async ({ page, context }) => {
  await devLogin(page, "dev-lingyuan");
  await openChecklist(page);

  const doneBefore = Number(
    await page.getByTestId("counters").locator("b").nth(1).innerText());

  await context.setOffline(true);
  /* 连勾两项 —— 顺序在重放时必须保持。
     `:not(:checked)` 每次重新求值：第一项排队后就显示为已勾，
     nth(0) 自然落到**下一项**上。这正是行内状态该起的作用 ——
     没有它的时候，这两下点的是同一项。 */
  await openBoxes(page).nth(0).click();
  await expect(page.getByTestId("outbox-badge")).toContainText("1 条待发");
  await openBoxes(page).nth(0).click();
  await expect(page.getByTestId("outbox-badge")).toContainText("2 条待发");
  /* 两条待发落在**两行**上，而不是一行排了两次 */
  await expect(page.getByTestId("queued-chip")).toHaveCount(2);

  /* 恢复联网 → online 事件触发重放 */
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));

  /* 队列清空，角标随之消失 */
  await expect(page.getByTestId("outbox-badge")).toHaveCount(0, { timeout: 20_000 });

  /* **落库了才算。** 重新拉一次清单：已完成数正好 +2，不是 +4 ——
     +4 就说明重放换了新的幂等键，服务端把同一件事记了两遍。 */
  await page.reload();
  await expect(page.getByTestId("startup-item").first()).toBeVisible();
  await expect(page.getByTestId("counters").locator("b").nth(1))
    .toHaveText(String(doneBefore + 2));

  await page.goto("/outbox");
  await expect(page.getByTestId("outbox-empty")).toBeVisible();
});
