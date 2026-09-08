import { test, expect, type Page } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   Phase 5 退出标准②：**390 / 834 / 1500px 零横向溢出。**

   横向滚动条在 390px 上等于「这个页面没做手机」，而 CRC 一半时间
   是在医院走廊上用手机看的。这条只能量，不能看 —— 设计稿上永远不会溢出。

   量的是 documentElement：**页面本身**不许横向滚。
   表格自己在容器里横向滚是对的，那是刻意的（.table-wrap）。
   ════════════════════════════════════════════════════════════════════ */

const WIDTHS = [390, 834, 1500];
/* 新增的三条：流程条与未满足清单都是横向组件，
   在 390px 上最容易把整页顶出去 —— 正是这条断言要抓的东西。 */
const ROUTES = ["/today", "/sites", "/sites/s3", "/sites/s3/startup",
  "/handovers", "/quality", "/timesheets", "/sites/s1/pnl", "/rate-cards",
  "/outbox"];

async function overflow(page: Page) {
  return page.evaluate(() => {
    const el = document.documentElement;
    return { scroll: el.scrollWidth, client: el.clientWidth };
  });
}

/** 找出到底是哪个元素把页面撑出去了 —— 只报「溢出了 12px」没法修 */
async function culprits(page: Page, limit: number) {
  return page.evaluate((max) => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      const r = el.getBoundingClientRect();
      if (r.right > max + 1 && r.width > 0) {
        const id = el.tagName.toLowerCase() +
          (el.className && typeof el.className === "string"
            ? "." + el.className.trim().split(/\s+/).join(".") : "");
        bad.push(`${id} → right=${Math.round(r.right)}`);
      }
    }
    return bad.slice(0, 6);
  }, limit);
}

for (const width of WIDTHS) {
  for (const route of ROUTES) {
    test(`${width}px · ${route} 页面不横向溢出`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(route);
      await page.waitForLoadState("networkidle");

      const { scroll, client } = await overflow(page);
      const bad = scroll > client ? await culprits(page, client) : [];
      expect(scroll,
        `溢出 ${scroll - client}px，元凶：\n  ${bad.join("\n  ")}`)
        .toBeLessThanOrEqual(client);
    });
  }
}

test("390px 上表格自己横向滚，而不是把整页撑开 —— 那是刻意的", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/today");
  await page.waitForLoadState("networkidle");

  const wrap = page.locator(".table-wrap").first();
  const canScroll = await wrap.evaluate(el => el.scrollWidth > el.clientWidth);
  expect(canScroll, "窄屏上表格应当在自己的容器里可横向滚动").toBe(true);

  const { scroll, client } = await overflow(page);
  expect(scroll).toBeLessThanOrEqual(client);
});

/* ════════════════════════════════════════════════════════════════════
   展开的表单，提交按钮要够得着。

   实测（1440×900）：合同变更那张表展开后 732px 高，提交按钮落在 1213px；
   可行性 648px / 1144px。也就是**填完之后要往下滚三百来像素才知道按哪儿**。
   七张表里有三张这样；换到更常见的 1366×768 就是五张。

   处置是 `.form-go { position: sticky; bottom: 0 }` —— 对矮表单是个空操作，
   所以下面两条一起钉：高的要吸住，矮的不许平白多出一条吸底栏。
   ════════════════════════════════════════════════════════════════════ */
test("表单比一屏高时，提交按钮吸在视口底部", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/change?as=admin");
  await page.getByTestId("new-change").click();

  const go = page.getByTestId("new-change-submit");
  await expect(go).toBeInViewport();

  /* 展开后表单确实高过一屏 —— 不然这条测试测的是别的东西。 */
  const formH = await page.getByTestId("new-change-form")
    .evaluate(el => el.getBoundingClientRect().height);
  expect(formH, "这张表不高过一屏的话，这条断言就是空的").toBeGreaterThan(500);
});

test("表单矮的时候按钮待在原地 —— 吸底不是给每张表都加一条横栏", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto("/sites?as=admin");
  await page.getByTestId("new-site").click();

  const go = page.getByTestId("new-site-submit");
  await expect(go).toBeInViewport();
  /* 没吸住时它就在表单末尾：底边应当离视口底部还有一段。 */
  const gap = await go.evaluate(el => innerHeight - el.getBoundingClientRect().bottom);
  expect(gap, "矮表单的提交按钮不该被推到视口底边").toBeGreaterThan(40);
});

test("暗色模式下同样不溢出，且背景确实换了", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto("/today");
  await page.waitForLoadState("networkidle");

  const bg = await page.evaluate(() =>
    getComputedStyle(document.body).backgroundColor);
  /* 亮色是 #FFFFFF；暗色必须不是它，否则说明令牌没生效 */
  expect(bg).not.toBe("rgb(255, 255, 255)");

  const { scroll, client } = await overflow(page);
  expect(scroll).toBeLessThanOrEqual(client);
});
