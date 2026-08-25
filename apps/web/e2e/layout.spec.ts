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
  "/handovers", "/quality", "/timesheets", "/sites/s1/pnl", "/rate-cards"];

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
