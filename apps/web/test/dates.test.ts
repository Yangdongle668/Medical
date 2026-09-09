import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { today, daysSince } from "../src/shell/dates.js";

/* ════════════════════════════════════════════════════════════════════
   日历日 —— **每天早上那八个小时曾经是错的**。

   ── 这条测试是为哪个 bug 写的 ────────────────────────────────────
   `dates.ts` 原来统一用 UTC 零点：

       export const today = () => new Date().toISOString().slice(0, 10);

   理由写在文件头上：「日期串本来就是 toISOString() 切出来的，
   两端同源才谈得上相减」。那句话对**服务端怎么序列化**成立，
   但它把两件事当成了一件 —— 服务端给的是**无时区的日历日**，
   而用户的「今天」是**本地日历日**。绕一趟 UTC 就把两者错开了。

   北京（UTC+8）00:00–08:00 这八个小时里：
     · `today()` 返回**昨天** —— 十三个日期控件默认填错，
       工时那一栏的 `max` 还会直接卡住让人选不了今天；
     · `daysSince(今天)` 返回 **−1** 而不是 0 ——「今天到期」显示成还剩一天。

   而 CRC 是七点上工的人。**差一天的错误在访视窗口上就是一次方案偏离。**

   ── 为什么这条测试必须把时钟**和时区**都固定住 ──────────────────
   CI 跑在 UTC 上，本机开发也多半是 UTC —— 这个 bug 在那里永远不出现。
   只把时钟拨到「北京早上七点对应的那一刻」是不够的：进程仍然在 UTC 下，
   `today()` 照样给出正确答案，测试全绿，等于没写。
   所以下面把 `process.env.TZ` 也设成 Asia/Shanghai，
   并且**断言它确实生效了** —— 否则哪天 node 不再支持运行时改时区，
   这条测试会退化成一堆在 UTC 下自说自话的绿灯。
   ════════════════════════════════════════════════════════════════════ */

const 原时区 = process.env["TZ"];

beforeEach(() => {
  process.env["TZ"] = "Asia/Shanghai";
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  /* 时区是**进程级**的，同一个 worker 里还跑着别的测试文件。 */
  if (原时区 === undefined) delete process.env["TZ"];
  else process.env["TZ"] = 原时区;
});

/** 把时钟停在「北京时间某天某点」。 */
function 北京(y: number, m: number, d: number, h: number, min = 0) {
  /* 北京 = UTC+8，且中国不用夏令时，所以直接减八小时就是那一刻的 UTC。 */
  const t = new Date(Date.UTC(y, m - 1, d, h - 8, min));
  vi.setSystemTime(t);
  /* 时区没生效的话，下面每一条都会在 UTC 下"碰巧"通过。 */
  if (t.getTimezoneOffset() !== -480)
    throw new Error(
      `TZ 没生效：本地偏移是 ${-t.getTimezoneOffset()} 分钟，不是东八区的 +480。\n` +
      "这条测试必须在 Asia/Shanghai 下跑，否则它测不到任何东西。");
}

describe("today()：本地日历日", () => {
  it("北京时间凌晨到早上八点，仍然是今天 —— 这八小时原来返回昨天", () => {
    for (const h of [0, 3, 6, 7]) {
      北京(2026, 9, 9, h);
      expect(today(), `北京 ${h} 点`).toBe("2026-09-09");
    }
    北京(2026, 9, 9, 7, 59);
    expect(today(), "北京 07:59").toBe("2026-09-09");
  });

  it("八点之后当然也是今天（原来只有这一段是对的）", () => {
    for (const h of [8, 12, 18, 23]) {
      北京(2026, 9, 9, h);
      expect(today(), `北京 ${h} 点`).toBe("2026-09-09");
    }
  });

  it("跨月、跨年也对", () => {
    北京(2027, 1, 1, 0, 30);
    expect(today()).toBe("2027-01-01");
    北京(2026, 3, 1, 5);
    expect(today()).toBe("2026-03-01");
  });

  it("零填充：月和日都是两位", () => {
    北京(2026, 3, 5, 9);
    expect(today()).toBe("2026-03-05");
  });
});

describe("daysSince()：今天 = 0", () => {
  it("北京早上七点问「今天到期的那条挂了几天」，答案是 0 而不是 −1", () => {
    北京(2026, 9, 9, 7);
    expect(daysSince("2026-09-09")).toBe(0);
    expect(daysSince("2026-09-08")).toBe(1);
    expect(daysSince("2026-09-10")).toBe(-1);   // 还没到
  });

  it("一整天里都是同一个数 —— 上午下午不能差一天", () => {
    const got = new Set<number>();
    for (const h of [0, 4, 7, 8, 11, 15, 20, 23]) {
      北京(2026, 9, 9, h);
      got.add(daysSince("2026-08-19"));
    }
    expect([...got], "同一天之内 daysSince 变过").toEqual([21]);
  });

  it("跨月按日历日算，不按 30 天", () => {
    北京(2026, 3, 1, 10);
    expect(daysSince("2026-02-28")).toBe(1);
    expect(daysSince("2026-01-31")).toBe(29);   // 2026 不是闰年
  });
});

/* 光修一处不够：下一个人照样会写 `new Date().toISOString().slice(0,10)`，
   而它在 UTC 的开发机上完全正常 —— 错误只出现在用户那台机器上。
   这条守卫第一次跑就抓到了一处漏网的：HandoverPage 的 plannedOn。 */
describe("别再从 UTC 的此刻里切日期串", () => {
  it("apps/web/src 里只有 shell/dates.ts 提得起这个写法", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");

    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "mocks") walk(p, acc); }
        else if (/\.tsx?$/.test(e.name)) acc.push(p);
      }
      return acc;
    };

    /* 拦的是**从此刻切出日历日**，不是 toISOString() 本身：
       · `createdAt: new Date().toISOString()` 记的是一个**瞬间**，
         UTC 的 ISO-8601 正是它该有的样子（outbox / replay / session 就是这一类）；
       · `new Date().toISOString().slice(0, 10)` 把那个瞬间**降格成一个日历日**，
         而降格时用的是 UTC 的日界 —— 东八区早上八点前就差一天。
       纯日期串算术（`new Date(iso + "T00:00:00Z")` 再 getUTC*）也不在此列，
       它不碰"此刻"，自洽 —— SchedulePage 的 addDays 就是那一种。 */
    const 从此刻切日期 = /new Date\(\s*\)\s*\.toISOString\(\)\s*\.\s*(slice|substring|substr|split)\s*\(/;

    const bad = walk(SRC)
      .filter(f => path.basename(f) !== "dates.ts")
      .filter(f => {
        const src = fs.readFileSync(f, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n").filter(l => !/^\s*(\/\/|\*)/.test(l)).join("\n");
        return 从此刻切日期.test(src);
      })
      .map(f => path.relative(SRC, f));

    expect(bad, "这些地方从 UTC 的此刻里切日历日，用户在东八区早上八点前会差一天；改用 shell/dates.ts 的 today()")
      .toEqual([]);
  });
});
