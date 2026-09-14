import { test, expect } from "@playwright/test";

/* ════════════════════════════════════════════════════════════════════
   该登记的，登记了没有 —— 「派工与产能」那一页最上面那一块。

   ── 它补的是哪个洞 ────────────────────────────────────────────────
   迁移 0048 与 0050 把立项受理与 PI 确认改成了登记制。那一步是对的，
   但它把风险换了个地方：

     原来卡住的是**别人不点** —— 看得见，因为它明晃晃地卡在那里；
     现在卡住的是**自己人没登记** —— 看不见，因为它只是没有发生。

   团队工作台按中心排、经营驾驶舱按问题类型排，两者都不按人排，
   于是"这个 CRC 这周该登记的几件事登记了没有"没有一页回答得了。

   ── 这一组钉三件事 ────────────────────────────────────────────────
   ① 这一块在，而且说得出总数与"最久的一件挂了多久"；
   ② **换个身份，数跟着换** —— 它是按各自的行范围数的；
   ③ 不欠的人是「—」，不是一屏的 0。
   ════════════════════════════════════════════════════════════════════ */

test.describe("一线履职", () => {
  test("按人排，且说得出谁欠得最久", async ({ page }) => {
    await page.goto("/staff?as=boss");
    const board = page.getByTestId("duty-board");
    await expect(board).toBeVisible();
    await expect(board.getByTestId("duty-row").first()).toBeVisible();

    /* 排序用的是**最久的那一件**，不是件数 —— 按件数排，
       带三个大中心、每样欠一点的人会永远排第一。 */
    const first = board.getByTestId("duty-row").first();
    await expect(first.getByTestId("duty-stale")).toBeVisible();

    await expect(board.getByTestId("duty-summary")).toContainText("欠着");
  });

  test("**这四类之外的不收**，而且页面上说得出为什么", async ({ page }) => {
    await page.goto("/staff?as=boss");
    const why = page.getByTestId("duty-board").locator(".derive");
    /* 把「在等别人」混进「你欠着」，这张表会立刻失去说服力 ——
       而一张会冤枉人的清单，人只会学会忽略它。 */
    await expect(why).toContainText("现在就办得掉");
    await expect(why).toContainText("一律不收");
    /* 同一个人在 PM 和经营层眼里可以是两个数，那不是数错了。 */
    await expect(why).toContainText("行范围");
  });

  test("只看欠着的：勾上之后剩下的每一行都真的欠着", async ({ page }) => {
    await page.goto("/staff?as=boss");
    const board = page.getByTestId("duty-board");
    /* **先等第一行出现再数。** 点完立刻 count() 拿到的是 0，
       于是下面那句变成"期望少于 0 行"，而失败信息说的是"收到 1 行"——
       看起来像筛子把人筛没了，其实只是断言跑在数据前面。
       （org.spec.ts 里记的是同一个坑。） */
    await expect(board.getByTestId("duty-row").first()).toBeVisible();
    const all = await board.getByTestId("duty-row").count();

    await board.getByTestId("duty-owing-only").check();
    const owing = await board.getByTestId("duty-row").count();
    /* **默认不筛**：只列欠债的那张表说不出分母，而
       「十个人里两个欠着」和「两个人里两个欠着」是两件完全不同的事。 */
    expect(owing).toBeLessThan(all);
    expect(owing).toBeGreaterThan(0);
  });

  /* 「登记掉一条，这个人的数当场降一」**没有写成 e2e**，写不了：
     那要先在履职表上记下数、跳到访视页登记、再跳回来对 ——
     而 `page.goto` 是整页重载，MSW 的 service worker 连同整个 mock 场景
     会一起重来一遍，刚登记的那一条随之消失。第一版就是这么写的，
     报的是 30 秒导航超时，而那句话跟"数降没降"毫无关系。

     这条不变量由 API 那边的真库测试盯着
     （apps/api/test/registration-duty.test.ts「办掉一件，这个人的数跟着降」），
     那里数是真数出来的，登记也是真落库的。**写在这里说明它有人管**，
     免得下一个人以为漏了。 */

  test("**读不到时说「读不到」**，不许画成一张空表", async ({ page }) => {
    /* 读失败画成空表，说出来的是「都登记完了」—— 一句假话，
       而且恰好出现在最不该让人放心的时候。
       （中心详情页为这条栽过一次：任何一种失败都被画成
       「已是最后一个节点」，而一个正在入组的中心被那句话说成走到了头。） */
    await page.goto("/staff?as=boss&fail=listRegistrationDuties");
    await expect(page.getByTestId("duty-unavailable")).toContainText("读不到");
    await expect(page.getByTestId("duty-unavailable")).toContainText("不等于没有人欠着");
    await expect(page.getByTestId("duty-clear")).toHaveCount(0);
    await expect(page.getByTestId("duty-row")).toHaveCount(0);
  });

  test("不欠的那几类画成「—」，不是一屏的 0", async ({ page }) => {
    /* 一屏的 0 会把真正的那几个数淹掉，而这张表的全部作用
       就是让那几个数跳出来。 */
    await page.goto("/staff?as=boss");
    const board = page.getByTestId("duty-board");
    await expect(board.getByTestId("duty-row").first()).toBeVisible();
    await expect(board.locator("tbody")).toContainText("—");
    /* 表格里不该出现孤零零的 0 —— 有的话就是没画成「—」。 */
    const zeros = await board.locator("tbody td.num").allInnerTexts();
    expect(zeros.filter(t => t.trim() === "0")).toEqual([]);
  });
});
