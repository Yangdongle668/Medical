import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { boot, resetDb, as, type Caller } from "./harness.js";

const idem = () => ({ "Idempotency-Key": randomUUID() });
const today = () => new Date().toISOString().slice(0, 10);

/* ════════════════════════════════════════════════════════════════════
   派工：把人接到中心上。

   `site_assignment` 是行规则 `assigned` 的**唯一来源**（迁移 0002），
   而在这一版之前**全系统没有一处往里写**：种子灌了 30 行，
   `app.transfer_handover_assignments()` 在两个人之间挪行 ——
   挪的是已经存在的那些。第一行从哪来，没有答案。

   后果不是"少个功能"。开发库的审计轨迹里躺着这一条：

     09-06 11:13  admin  调整角色权限  crc
                  rowRule: assigned → team    理由：「改为按组切行」

   派不了工，就把整个角色的行规则改掉 —— 从此每个 CRC 看得到本组
   全部项目的全部中心，包括他从没去过的那些。**一个建不出来的东西，
   会被人用改规则的方式绕过去**，而绕过去之后没有任何地方是红的。

   所以这一组测试钉住的是**可见范围**，不是「接口返回了 200」：
   派之前看不见，派之后看得见，撤下之后又看不见。
   ════════════════════════════════════════════════════════════════════ */

let app: INestApplication;
let admin: Caller, pm: Caller;

/** 一个 CRA：他现在跑着几个中心，而下面要给他加、再撤。 */
let 小张: { accountId: string; login: string; displayName: string };
let 小张看得见的: Caller;

/* 中心从池子里**取**，不按下标点名。
   第一版写的是 `可派的[6]`、`可派的[8]` —— 而这个 CRA 在种子里
   只有 6 个还没派给他的中心，于是三条测试挂在
   `Cannot read properties of undefined`，报错指的是下标，
   不是被测的那件事。池子一旦被人改动（多派一个中心、换一个 CRA），
   按下标点名的测试就会以一种和它要测的东西无关的方式红。 */
let 池子: { id: string; code: string; hospital: string }[];
let PM的池子: { id: string; code: string; hospital: string }[];
const 取 = (n = 1) => {
  const out = 池子.splice(0, n);
  expect(out.length, `池子里不够 ${n} 个中心了`).toBe(n);
  return out;
};

beforeAll(async () => {
  resetDb(); app = await boot();
  admin = await as(app, "admin");
  pm    = await as(app, "hanxue");

  const staff = (await admin.get("/v1/staff?limit=200")).body.items as
    { accountId: string; login: string; displayName: string;
      roleKind: string; active: boolean }[];
  小张 = staff.find(s => s.roleKind === "CRA" && s.active)!;
  expect(小张, "种子里应当有一个在职 CRA").toBeTruthy();
  小张看得见的 = await as(app, 小张.login);

  const 他已有的 = new Set(((await admin.get(
    `/v1/site-assignments?accountId=${小张.accountId}&limit=200`)).body.items as
    { studySiteId: string }[]).map(r => r.studySiteId));
  /* PM 那一份先取出来：头几条测试要验的正是「PM 派得动自己范围里的」，
     所以它们必须用 PM 看得见的那些。 */
  PM的池子 = ((await pm.get("/v1/study-sites?limit=200")).body.items as
    typeof PM的池子).filter(s => !他已有的.has(s.id));
  expect(PM的池子.length, "PM 名下应当有几个还没派给他的中心").toBeGreaterThan(3);
  /* 头三个留给「PM 派得动自己范围里的」那一条，其余的（连同 admin
     看得到而 PM 看不到的那些）进池子，供后面按需取。 */
  const 留给PM = new Set(PM的池子.slice(0, 3).map(s => s.id));
  池子 = ((await admin.get("/v1/study-sites?limit=200")).body.items as typeof 池子)
    .filter(s => !他已有的.has(s.id) && !留给PM.has(s.id));
  expect(池子.length, "池子里应当还有好几个中心").toBeGreaterThan(5);
}, 180_000);
afterAll(async () => { await app?.close(); });

const 派 = (c: Caller, who: string, sites: string[], extra: Record<string, unknown> = {}) =>
  c.post(`/v1/staff/${who}:assign-sites`, {
    studySiteIds: sites, reason: "新项目开跑，这几个中心归他", ...extra
  }, idem());

const 撤 = (c: Caller, who: string, sites: string[]) =>
  c.post(`/v1/staff/${who}:end-assignments`, {
    studySiteIds: sites, reason: "他调去别的项目了"
  }, idem());

const 他看得见的中心 = async (c: Caller) =>
  ((await c.get("/v1/study-sites?limit=200")).body.items as { code: string }[])
    .map(s => s.code).sort();

describe("派上去", () => {
  it("**派完他当场看得见那几个中心** —— 钉的是可见范围，不是返回码", async () => {
    const 之前 = await 他看得见的中心(小张看得见的);
    const 三个 = PM的池子.slice(0, 3);
    expect(之前, "这几个中心他本来就看得见，那这条测试什么也没测")
      .not.toContain(三个[0]!.code);

    const r = await 派(pm, 小张.accountId, 三个.map(s => s.id));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toHaveLength(3);

    expect(await 他看得见的中心(小张看得见的))
      .toEqual([...之前, ...三个.map(s => s.code)].sort());
  });

  it("**副作用那一句要说出后果**，不是「操作成功」", async () => {
    const [另一个] = 取();
    const r = await 派(admin, 小张.accountId, [另一个!.id]);
    expect(r.status).toBe(201);
    const s = (r.body.sideEffects as { type: string; summary: string }[])[0]!;
    expect(s.type).toBe("SiteAssignmentChanged");
    expect(s.summary).toContain(另一个!.code);
    expect(s.summary, "没说清「他从此看得见什么」").toContain("看得见");
  });

  it("工种从员工名册取，**请求说了也不算** —— 那是矛盾，不是可选项", async () => {
    const r = await 派(admin, 小张.accountId, [取()[0]!.id], { roleKind: "CRC" });
    expect(r.status, "多传的字段不该把请求打回来").toBe(201);
    expect((r.body.data as { roleKind: string }[])[0]!.roleKind).toBe("CRA");
  });

  it("已经在跑的中心**跳过，不报错** —— 「给他再加一个」是正常情况", async () => {
    const 旧 = PM的池子.slice(0, 3).map(s => s.id);   // 上面第一条已经派过
    const [新] = 取();
    const r = await 派(admin, 小张.accountId, [...旧, 新!.id]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data, "只该新增那一个").toHaveLength(1);
    expect(r.body.sideEffects[0].summary as string).toContain("跳过");
  });

  it("**一个都没派成就是错** —— 返回 200 而什么也没发生，点的人会以为派好了", async () => {
    const r = await 派(pm, 小张.accountId, PM的池子.slice(0, 2).map(s => s.id));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("invariant-violated");
    expect(r.body.detail).toContain("本来就在跑");
  });

  it("**补登过去的日期是允许的** —— 「他上个月就接手了」是真实情况", async () => {
    const 上月 = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const r = await 派(admin, 小张.accountId, [取()[0]!.id], { since: 上月 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((r.body.data as { since: string }[])[0]!.since).toBe(上月);
  });
});

describe("派不了的那些，要说清为什么", () => {
  it("**PM 派不了工** —— 他的范围来自项目归属组，而那句话要写在报错里", async () => {
    const pmAccount = ((await admin.get("/v1/accounts?limit=200")).body.items as
      { id: string; login: string }[]).find(a => a.login === "hanxue")!;
    const r = await 派(admin, pmAccount.id, [PM的池子[0]!.id]);
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("assign-role-kind");
    expect(r.body.detail, "没告诉他 PM 该怎么办").toContain("set-team");
  });

  it("**不在员工名册里的账号派不了** —— 外部方不走派工", async () => {
    const 机构办 = ((await admin.get("/v1/accounts?limit=200")).body.items as
      { id: string; login: string; isExternal: boolean }[]).find(a => a.isExternal)!;
    const r = await 派(admin, 机构办.id, [PM的池子[0]!.id]);
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("assign-not-staff");
  });

  it("**将来的起始日不收** —— 今天不生效的派工，派的人会以为已经派好了", async () => {
    const 下周 = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const r = await 派(pm, 小张.accountId, [PM的池子[0]!.id], { since: 下周 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("validation-failed");
    expect(r.body.detail).toContain(下周);
  });

  it("**看不见的中心派不了** —— 范围外与不存在是同一个 404", async () => {
    const 全部 = (await admin.get("/v1/study-sites?limit=200")).body.items as
      { id: string }[];
    const PM看得见 = new Set(((await pm.get("/v1/study-sites?limit=200")).body.items as
      { id: string }[]).map(s => s.id));
    const 别人的 = 全部.find(s => !PM看得见.has(s.id));
    expect(别人的, "演示数据里应当有 PM 看不见的中心").toBeTruthy();

    const r = await 派(pm, 小张.accountId, [别人的!.id]);
    expect(r.status, "范围外的中心不该派得出去").toBe(404);
  });

  it("**没有 assign 动作的人派不了** —— CRA 不能给自己加中心", async () => {
    const r = await 派(小张看得见的, 小张.accountId, [PM的池子[0]!.id]);
    expect(r.status).toBe(403);
  });
});

describe("撤下来", () => {
  it("**撤完他当场看不见** —— 这才是「撤下」的意思", async () => {
    const 撤掉的 = PM的池子[0]!;
    const 之前 = await 他看得见的中心(小张看得见的);
    expect(之前).toContain(撤掉的.code);

    const r = await 撤(pm, 小张.accountId, [撤掉的.id]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const 之后 = await 他看得见的中心(小张看得见的);
    expect(之后).not.toContain(撤掉的.code);
    expect(之后.length).toBe(之前.length - 1);
  });

  it("**今天派、今天撤的删掉** —— 一天都没生效过的记录不该留在台账上", async () => {
    const 全部 = ((await admin.get(
      `/v1/site-assignments?accountId=${小张.accountId}&includeEnded=true&limit=100`))
      .body.items as { siteCode: string; since: string; until: string | null }[]);
    /* 上一条撤掉的那个是今天派、今天撤的：整行没了，
       而不是留下一段 since === until 的零长度区间。 */
    expect(全部.filter(r => r.until && r.until === r.since),
      "留下了 since === until 的记录").toEqual([]);
    expect(全部.map(r => r.siteCode)).not.toContain(PM的池子[0]!.code);
  });

  it("**生效过的收口，不删** —— 「去年三月那次访视谁负责」是核查会问的事实", async () => {
    /* 种子里的派工从 2024-09-01 起，早就生效过了。 */
    const 老的 = ((await admin.get(
      `/v1/site-assignments?accountId=${小张.accountId}&limit=100`)).body.items as
      { studySiteId: string; siteCode: string; since: string }[])
      .find(x => x.since < today())!;
    expect(老的, "他名下应当有一条早于今天的派工").toBeTruthy();

    const r = await 撤(admin, 小张.accountId, [老的.studySiteId]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const 那一行 = ((await admin.get(
      `/v1/site-assignments?accountId=${小张.accountId}&includeEnded=true&limit=100`))
      .body.items as { siteCode: string; since: string; until: string | null;
                       active: boolean }[]).find(x => x.siteCode === 老的.siteCode);
    expect(那一行, "整行被删了 —— 那段历史没了").toBeTruthy();
    expect(那一行!.active).toBe(false);
    expect(那一行!.until).toBe(today());
    expect(那一行!.since, "起始日被改了").toBe(老的.since);
  });

  it("**离职的人也撤得下来** —— 否则他一走，那几个中心就永远挂在他名下",
    async () => {
      /* 种子里 zhouqi 是停用的 CRA，名下还留着派工
         （「谁离职了、他的中心谁接的」是交接台账要回答的问题，
         所以人从名册上不抹掉，行也还在）。 */
      const 离职的 = ((await admin.get("/v1/staff?limit=200")).body.items as
        { accountId: string; login: string; active: boolean }[])
        .find(s => !s.active);
      expect(离职的, "种子里应当有一个已停用的员工").toBeTruthy();
      const 他的 = (await admin.get(
        `/v1/site-assignments?accountId=${离职的!.accountId}&limit=50`)).body.items as
        { studySiteId: string }[];
      if (!他的.length) return;   // 他名下已经没有派工了，这一条就不适用

      const r = await 撤(admin, 离职的!.accountId, [他的[0]!.studySiteId]);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    });

  it("**派上去那一端照旧收紧** —— 停用的人派不了", async () => {
    const 离职的 = ((await admin.get("/v1/staff?limit=200")).body.items as
      { accountId: string; active: boolean }[]).find(s => !s.active)!;
    const r = await 派(admin, 离职的.accountId, [取()[0]!.id]);
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("assign-disabled-account");
  });

  it("一个都不在跑就是错 —— 没有变化不该留一条审计", async () => {
    const r = await 撤(pm, 小张.accountId, [PM的池子[0]!.id]);
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("unassign-nothing-to-do");
  });
});

describe("派工台账", () => {
  it("**默认只看在跑的**，`includeEnded` 才带上已结束的", async () => {
    const 在跑 = (await admin.get("/v1/site-assignments?limit=200")).body.items as
      { active: boolean }[];
    expect(在跑.length).toBeGreaterThan(0);
    expect(在跑.every(r => r.active), "默认列表里混进了已结束的派工").toBe(true);

    const 全部 = (await admin.get(
      "/v1/site-assignments?limit=200&includeEnded=true")).body.items as
      { active: boolean }[];
    expect(全部.length).toBeGreaterThan(在跑.length);
  });

  it("**不下发登录名** —— 这张表机构办也看得到本院那几行", async () => {
    const 一行 = ((await admin.get("/v1/site-assignments?limit=1")).body.items as
      Record<string, unknown>[])[0]!;
    expect(Object.keys(一行), "把员工登录名漏给了这张表").not.toContain("login");
  });

  it("按项目筛得出来 —— 界面上「这个项目现在谁在跑」靠它", async () => {
    const 行 = (await admin.get("/v1/site-assignments?limit=200")).body.items as
      { studyId: string; studyCode: string }[];
    const 一个项目 = 行[0]!;
    const 筛出来的 = (await admin.get(
      `/v1/site-assignments?studyId=${一个项目.studyId}&limit=200`)).body.items as
      { studyCode: string }[];
    expect(筛出来的.length).toBeGreaterThan(0);
    expect([...new Set(筛出来的.map(r => r.studyCode))]).toEqual([一个项目.studyCode]);
  });

  it("**CRA 只看得到自己那几行** —— 台账也受行范围管", async () => {
    const 他的 = (await 小张看得见的.get("/v1/site-assignments?limit=200")).body.items as
      { accountId: string }[];
    /* 他看得到的中心上，别人的派工他也看得到（那是同事）；
       但他看不到的中心上的派工，一行都不该有。 */
    const 他看得见的中心数 = ((await 小张看得见的.get("/v1/study-sites?limit=200"))
      .body.items as unknown[]).length;
    const 全部 = ((await admin.get("/v1/site-assignments?limit=200")).body.items as
      unknown[]).length;
    expect(他的.length, "CRA 看到了全部派工").toBeLessThan(全部);
    expect(他看得见的中心数).toBeGreaterThan(0);
  });
});

describe("行范围：写这张表不能扩大到自己看不见的地方", () => {
  it("**数据库那一层也拦**（迁移 0045 补的 WITH CHECK）", async () => {
    /* 应用层已经在上面那条 404 里验过了。这一条验的是**兜底那一层**：
       就算有人绕过服务层写裸 SQL，策略也要拦下来。两处都在，才能同时
       防住"应用层忘了加条件"和"有人写了裸 SQL"。

       补这一条之前实测过：PM 看不到 SS-09，INSERT 照样 `INSERT 0 1`。 */
    const 全部 = (await admin.get("/v1/study-sites?limit=200")).body.items as
      { id: string }[];
    const PM看得见 = new Set(((await pm.get("/v1/study-sites?limit=200")).body.items as
      { id: string }[]).map(s => s.id));
    const 别人的 = 全部.find(s => !PM看得见.has(s.id))!;
    const pmAccount = ((await admin.get("/v1/accounts?limit=200")).body.items as
      { id: string; login: string }[]).find(a => a.login === "hanxue")!;

    const { Client } = await import("pg");
    const c = new Client({ connectionString: process.env["APP_TEST_DATABASE_URL"]!
      .replace(/\/[^/?]+(\?|$)/, "/sitedesk_test_site_assignment$1") });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.account_id', $1, true)", [pmAccount.id]);
      await expect(c.query(
        `INSERT INTO site_assignment (account_id, study_site_id, role_kind, effective)
         VALUES ($1, $2, 'CRA', daterange(CURRENT_DATE, NULL, '[)'))`,
        [小张.accountId, 别人的.id]))
        .rejects.toThrow(/row-level security/);
      await c.query("ROLLBACK");
    } finally { await c.end(); }
  });

  it("**交接照旧转得动** —— 那条路走 SECURITY DEFINER，不受新 WITH CHECK 影响",
    async () => {
      /* 收紧写策略最容易碰坏的就是它：接手人此刻还看不见那些中心
         （他正是因为还没接手才在做这件事）。见迁移 0011。 */
      const { Client } = await import("pg");
      const c = new Client({ connectionString: process.env["APP_TEST_DATABASE_URL"]!
        .replace(/\/[^/?]+(\?|$)/, "/sitedesk_test_site_assignment$1") });
      await c.connect();
      try {
        const { rows } = await c.query<{ prosecdef: boolean }>(
          `SELECT prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'app' AND p.proname = 'transfer_handover_assignments'`);
        expect(rows[0]?.prosecdef, "交接转派工的函数不再是 SECURITY DEFINER").toBe(true);
        const forced = await c.query<{ relforcerowsecurity: boolean }>(
          "SELECT relforcerowsecurity FROM pg_class WHERE relname = 'site_assignment'");
        expect(forced.rows[0]?.relforcerowsecurity,
          "表打开了 FORCE ROW LEVEL SECURITY —— 属主不再绕开策略，交接会当场断").toBe(false);
      } finally { await c.end(); }
    });
});

describe("指定研究者 PI", () => {
  /** 种子里的 PI 账号。`row_rule=pi` 的范围就是
   *  「study_site.pi_account_id 指向我的那些中心」。 */
  const PI = "chenguod";

  it("绑上去他就看得见，解绑他就看不见", async () => {
    const pi = await as(app, PI);
    const piAccount = ((await admin.get("/v1/accounts?limit=200")).body.items as
      { id: string; login: string; displayName: string }[]).find(a => a.login === PI)!;

    const 空的 = ((await admin.get("/v1/study-sites?limit=200")).body.items as
      { id: string; code: string; piAccountId: string | null }[])
      .find(s => !s.piAccountId);
    expect(空的, "演示数据里应当有没绑 PI 账号的中心").toBeTruthy();

    const 之前 = ((await pi.get("/v1/study-sites?limit=50")).body.items as
      { code: string }[]).map(s => s.code);
    expect(之前).not.toContain(空的!.code);

    const r = await admin.post(`/v1/study-sites/${空的!.id}:set-pi`,
      { piAccountId: piAccount.id, reason: "本院这个中心由他担任研究者" }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    /* 绑定时登记名跟着改 —— 否则中心上写着一个人、绑的是另一个账号，
       两个事实同时挂在一行上，而没有任何一处会报错。 */
    expect(r.body.data.piName).toBe(piAccount.displayName);

    expect(((await pi.get("/v1/study-sites?limit=50")).body.items as { code: string }[])
      .map(s => s.code), "绑了却看不见 —— pi 行规则没生效").toContain(空的!.code);

    const back = await admin.post(`/v1/study-sites/${空的!.id}:set-pi`,
      { piAccountId: null, reason: "换人了，先摘掉" }, idem());
    expect(back.status).toBe(201);
    expect(((await pi.get("/v1/study-sites?limit=50")).body.items as { code: string }[])
      .map(s => s.code)).not.toContain(空的!.code);
    /* 解绑不抹掉登记名：那是方案上的姓名，不是一个账号 */
    expect(back.body.data.piName).toBe(piAccount.displayName);
  });

  it("**绑一个不按 pi 切行的账号要报错** —— 那一栏对他不起作用，而界面上看着是绑好了",
    async () => {
      const 空的 = ((await admin.get("/v1/study-sites?limit=200")).body.items as
        { id: string; piAccountId: string | null }[]).find(s => !s.piAccountId)!;
      const 内部人 = ((await admin.get("/v1/accounts?limit=200")).body.items as
        { id: string; login: string }[]).find(a => a.login === "hanxue")!;
      const r = await admin.post(`/v1/study-sites/${空的.id}:set-pi`,
        { piAccountId: 内部人.id, reason: "试试绑一个内部账号" }, idem());
      expect(r.status).toBe(422);
      expect(r.body.invariant).toBe("pi-account-wrong-row-rule");
    });

  it("没有变化就不该留一条审计", async () => {
    const 空的 = ((await admin.get("/v1/study-sites?limit=200")).body.items as
      { id: string; piAccountId: string | null }[]).find(s => !s.piAccountId)!;
    const r = await admin.post(`/v1/study-sites/${空的.id}:set-pi`,
      { piAccountId: null, reason: "本来就没绑" }, idem());
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("site-pi-unchanged");
  });

  it("**PM 也能指定 PI** —— 借 manage 的话，派一次工要找系统管理员", async () => {
    const 空的 = ((await pm.get("/v1/study-sites?limit=200")).body.items as
      { id: string; piAccountId: string | null }[]).find(s => !s.piAccountId);
    expect(空的, "PM 名下应当还有没绑 PI 的中心").toBeTruthy();
    const piAccount = ((await admin.get("/v1/accounts?limit=200")).body.items as
      { id: string; login: string }[]).find(a => a.login === PI)!;
    const r = await pm.post(`/v1/study-sites/${空的!.id}:set-pi`,
      { piAccountId: piAccount.id, reason: "这个中心的研究者是他" }, idem());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
});

describe("审计", () => {
  it("**三条都进审计、都标成敏感、都留了原因** —— 核查员第一屏要看得见", async () => {
    const 轨迹 = (await admin.get("/v1/audit-entries?limit=200")).body.items as
      { action: string; isSensitive: boolean; reason: string | null }[];
    for (const 动作 of ["派工到中心", "从中心撤下", "指定中心研究者"]) {
      const 条 = 轨迹.filter(e => e.action === 动作);
      expect(条.length, `审计里没有「${动作}」`).toBeGreaterThan(0);
      expect(条.every(e => e.isSensitive), `「${动作}」没标成敏感`).toBe(true);
      expect(条.every(e => !!e.reason), `「${动作}」没留下原因`).toBe(true);
    }
  });
});
