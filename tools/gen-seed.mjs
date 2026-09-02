/* 从 prototype/index.html 提取演示数据，生成 db/seeds/001_demo.sql。
   原型是需求基线：种子数据与它一致，才能保证"系统里看到的"和"当初谈的"是同一套。
   一次性生成并提交产物；不在运行时依赖 prototype。 */
import fs from "node:fs";
import crypto from "node:crypto";

const NS = "6f1e2a10-9c3b-4d5e-8a70-1b2c3d4e5f60";           // 固定命名空间
const hex = s => s.replace(/-/g, "");
function uuid5(name) {                                        // RFC 4122 v5
  const h = crypto.createHash("sha1");
  h.update(Buffer.from(hex(NS), "hex")); h.update(Buffer.from(name, "utf8"));
  const b = h.digest();
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.subarray(0, 16).toString("hex");
  return `${x.slice(0,8)}-${x.slice(8,12)}-${x.slice(12,16)}-${x.slice(16,20)}-${x.slice(20,32)}`;
}

/* 在隔离上下文里求值原型的数据段 */
const html = fs.readFileSync("prototype/index.html", "utf8");
const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");
/* deps：某些字面量会引用先前定义的常量（如 HANDOVER 引用 HO_ITEMS），
   隔离求值时必须把它们注入作用域。 */
const grab = (name, deps = {}) => {
  const re = new RegExp(`(?:^|\\n)(?:const|let)\\s+${name}\\s*=\\s*`, "m");
  const i = js.search(re); if (i < 0) throw new Error(`未找到 ${name}`);
  const start = js.indexOf("=", i) + 1;
  let d = 0, s = -1;
  for (let k = start; k < js.length; k++) {
    const c = js[k];
    if (c === "[" || c === "{") { if (s < 0) s = k; d++; }
    else if (c === "]" || c === "}") {
      d--;
      if (!d) return new Function(...Object.keys(deps),
        `return (${js.slice(s, k + 1)})`)(...Object.values(deps));
    }
  }
  throw new Error(`${name} 解析失败`);
};
const STUDIES = grab("STUDIES"), SITES = grab("SITES"),
      STAFF = grab("STAFF"), USERS = grab("USERS"),
      GROUPS = grab("GROUPS"), ROLE_DEF = grab("ROLE_DEF"),
      STARTUP = grab("STARTUP"), HO_ITEMS = grab("HO_ITEMS"),
      HANDOVER = grab("HANDOVER", { HO_ITEMS }), TALENT = grab("TALENT"),
      SIV_PLAN = grab("SIV_PLAN"),
      SOA = grab("SOA"), SUBJ = grab("SUBJ"), FUNNEL = grab("FUNNEL"),
      DROPS = grab("DROPS"), QUERIES = grab("QUERIES"),
      RATE = grab("RATE"), WORKTYPES = grab("WORKTYPES"), TIMESHEET = grab("TIMESHEET"),
      FEAS = grab("FEAS"), BIDS = grab("BIDS"), CHANGES = grab("CHANGES"),
      MILES = grab("MILES"), CLIENT_META = grab("CLIENT_META"),
      VISITS = grab("VISITS"), ISSUES = grab("ISSUES"), AUDIT = grab("AUDIT");

const q  = v => v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const d  = v => (!v || v === "—") ? "NULL" : `'${v}'`;
const cents = v => Math.round(Number(v) * 10000 * 100);        // 万元 → 分（整数）
/* 原型里的字段键沿用简写；schema 以可读全名为准，此处做唯一一次映射。
   规约 9（单一定义源）：今后以 field_key 表为准，前端类型由契约生成。 */
const FIELD = {subj:"subject", cost:"cost", margin:"margin", price:"price", staff:"staff"};
const STATE = {"立项":"intake","伦理递交":"irb_submit","伦理批件":"irb_approve",
  "合同签署":"contract","SIV启动":"siv","入组中":"enrolling","入组完成":"enrolled",
  "随访中":"followup","中心关闭":"closed"};

const L = [];
const P = s => L.push(s);
P(`-- 由 tools/gen-seed.mjs 从 prototype/index.html 生成，请勿手改。`);
P(`-- 只含演示数据。角色矩阵由 app.provision_tenant() 开出（0012 迁移），`);
P(`-- 因此本文件必须在迁移跑完之后执行 —— 它按 code 反查角色。`);
P(`-- 全部为虚构演示数据，不含任何真实受试者可识别信息。`);
P(`-- 受试者数据不在 Phase 1 范围内；届时录入的筛选号须重新生成，与原型脱钩。`);
P(`BEGIN;`);
P(`SET LOCAL client_min_messages = warning;`);
P(``);

/* ── 角色矩阵不在这里了 ────────────────────────────────────────────
   role / role_field / role_action / role_module 现在由
   `app.provision_tenant()` 开出来（见 db/migrations/0012_tenant_provisioning.sql）。

   为什么搬走：那 224 行是**开户物料**，不是演示数据。
   混在这个文件里的时候，开第二个租户等于把恒济那 20 个人、15 个中心、
   598 个受试者也灌一遍 —— 而且根本插不进去：
   角色主键当时是 `uuid5('role:' + code)`，不含租户，两个租户的 `crc`
   会算出同一个 UUID，直接在 role_pkey 上冲突。

   这个文件从此只管演示数据，角色一律**按 code 反查**，不写死 UUID。
   ──────────────────────────────────────────────────────────────── */
const roleId = code => `(SELECT id FROM role WHERE code = ${q(code)} AND tenant_id = app.default_tenant_id())`;

/* ── 分组 ── */
P(`-- ── 分组 ────────────────────────────────────────────────────`);
for (const g of GROUPS)
  P(`INSERT INTO team (id, code, name) VALUES ('${uuid5("team:"+g.id)}', ${q(g.id)}, ${q(g.name)});`);
P(``);

/* ── 账号 ── */
P(`-- ── 账号 ────────────────────────────────────────────────────`);
P(`-- 认证凭据不在此表：内部走 OIDC，外部走一次性魔法链接（Phase 3）。`);
for (const u of USERS) {
  const team = GROUPS.find(g => g.members.includes(u.n) || g.lead === u.n);
  /* PI 的所属机构由他担任研究者的中心推导，不硬编码 */
  const org = u.hosp ?? (u.role === "pi" ? SITES.find(s => s.pi === u.n)?.hosp : null);
  const disabled = u.st !== "在职";
  P(`INSERT INTO account (id, login, display_name, role_id, team_id, is_external, org_ref,` +
    ` status, joined_on, disabled_at, disabled_reason) VALUES (` +
    `'${uuid5("account:"+u.u)}', ${q(u.u)}, ${q(u.n)}, ${roleId(u.role)}, ` +
    `${team ? `'${uuid5("team:"+team.id)}'` : "NULL"}, ${u.ext ? "true":"false"}, ${q(org)}, ` +
    `${q(disabled ? "disabled" : "active")}, ${d(u.joined)}, ` +
    `${disabled ? `'${u.off || "2026-07-15"}'::timestamptz` : "NULL"}, ` +
    `${disabled ? q(u.offWhy || "已停用") : "NULL"});`);
}
P(``);
P(`-- 组长（account 建好后回填，避免建表环）`);
for (const g of GROUPS)
  if (USERS.some(u => u.n === g.lead))
    P(`UPDATE team SET lead_account_id = '${uuid5("account:"+USERS.find(u=>u.n===g.lead).u)}'` +
      ` WHERE code = ${q(g.id)};`);
P(``);

/* ── 客户 ── */
P(`-- ── 客户（申办方） ──────────────────────────────────────────`);
P(`-- 0004 的 sponsor_name 在 0031 变成了 client_id —— 那句"届时改为 FK"到期了。`);
P(`-- 账期是现金流预测里最要紧的一个数：月结 45 天和 90 天差一个半月进账。`);
/* 原型的 pay 写作「月结 60 天」；库里存整数天数 —— 界面上要按它算到期日，
   而"月结 60 天"这种串每次都要重新解析一遍。 */
const payDays = t => { const m = /(\d+)/.exec(t || ""); return m ? Number(m[1]) : 60; };
const SPONSORS = [...new Set(STUDIES.map(x => x.sponsor))];
for (const sp of SPONSORS) {
  const m = CLIENT_META[sp] || {};
  P(`INSERT INTO client (id, name, since_year, contact, payment_terms_days, nps, note)` +
    ` VALUES ('${uuid5("client:"+sp)}', ${q(sp)}, ${m.since ? Number(m.since) : "NULL"}, ` +
    `${q(m.contact)}, ${payDays(m.pay)}, ${m.nps ?? "NULL"}, ${q(m.note)});`);
}
P(``);

/* ── 项目与中心 ── */
P(`-- ── 项目 ────────────────────────────────────────────────────`);
P(`-- 金额一律以「分」存 bigint；原型的万元数值在此换算（见迁移 0006）。`);
for (const s of STUDIES)
  P(`INSERT INTO study (id, code, short_name, client_id, phase, indication,` +
    ` planned_subjects, contract_amount_cents, started_on, ends_on) VALUES (` +
    `'${uuid5("study:"+s.id)}', ${q(s.id)}, ${q(s.short)}, '${uuid5("client:"+s.sponsor)}', ${q(s.phase)}, ` +
    `${q(s.indication)}, ${s.planned}, ${cents(s.contract)}, '${s.start}-01', '${s.end}-01');`);
P(``);
P(`-- ── 分组承接项目：PM 行范围的来源 ────────────────────────────`);
for (const g of GROUPS) for (const sid of g.studies)
  P(`INSERT INTO team_study (team_id, study_id) VALUES ` +
    `('${uuid5("team:"+g.id)}', '${uuid5("study:"+sid)}');`);
P(``);
P(`-- ── 中心（StudySite：最小作业单元） ──────────────────────────`);
for (const s of SITES) {
  const piAcc = USERS.find(u => u.n === s.pi && u.role === "pi");
  P(`INSERT INTO study_site (id, study_id, code, hospital, dept, city, pi_account_id, pi_name,` +
    ` state, contracted, unit_price_cents, startup_fee_cents, irb_approved_on, siv_on, siv_planned_on, fpi_on) VALUES (` +
    `'${uuid5("site:"+s.id)}', '${uuid5("study:"+s.sid)}', ${q(s.id)}, ${q(s.hosp)}, ${q(s.dept)}, ` +
    `${q(s.city)}, ${piAcc ? `'${uuid5("account:"+piAcc.u)}'` : "NULL"}, ${q(s.pi)}, ` +
    `${q(STATE[s.st])}, ${s.contracted}, ${cents(s.unit)}, ${cents(s.startup||0)}, ` +
    `${d(s.ethics)}, ${d(s.siv)}, NULL, ${d(s.fpi)});`);
}
P(``);
P(`-- ── 派工：assigned 行范围的来源 ──────────────────────────────`);
for (const p of STAFF) {
  if (!["CRA","CRC"].includes(p.role)) continue;
  const u = USERS.find(x => x.n === p.n); if (!u) continue;
  for (const sid of p.sites)
    P(`INSERT INTO site_assignment (account_id, study_site_id, role_kind, effective) VALUES (` +
      `'${uuid5("account:"+u.u)}', '${uuid5("site:"+sid)}', ${q(p.role)}, ` +
      `daterange('2024-09-01', NULL, '[)'));`);
}
P(``);

/* ── 人员作业属性 ── */
P(`-- ── 人员：account 之外的作业属性 ──────────────────────────────`);
P(`-- account 回答「谁能登录、看得到什么」；staff 回答「他是什么工种、带谁、谁接他」。`);
const acc = n => { const u = USERS.find(x => x.n === n); return u ? `'${uuid5("account:"+u.u)}'` : "NULL"; };
for (const p of STAFF) {
  const u = USERS.find(x => x.n === p.n); if (!u) continue;
  const t = TALENT[p.n] || {};
  P(`INSERT INTO staff (account_id, role_kind, level, city, gcp_expires_on,` +
    ` mentor_account_id, successor_account_id) VALUES (` +
    `'${uuid5("account:"+u.u)}', ${q(p.role)}, ${q(p.lvl)}, ${q(p.city)}, ${d(p.gcp)}, ` +
    `${t.mentor ? acc(t.mentor) : "NULL"}, ${t.succ ? acc(t.succ) : "NULL"});`);
}
P(``);

/* ── 启动清单 ── */
const CAT = {"伦理与批件":"ethics","合同与预算":"contract","研究者文件夹":"isf",
  "人员与培训":"training","药品与物资":"ip","检验与设备":"lab",
  "系统与账号":"systems","启动会筹备":"meeting"};
P(`-- ── 启动清单：CRC 最忙的两个月，此前系统对它一无所知 ──────────`);
STARTUP.forEach((r, i) => {
  P(`INSERT INTO startup_item (study_site_id, category, item, owner_account_id, due_on,` +
    ` is_blocking, sort_order, done_at, done_by) VALUES (` +
    `'${uuid5("site:"+r.ss)}', ${q(CAT[r.cat])}, ${q(r.item)}, ${acc(r.owner)}, ${d(r.due)}, ` +
    `${r.block ? "true" : "false"}, ${i}, ` +
    `${r.done ? `'${r.due}T09:00:00+08'::timestamptz` : "NULL"}, ${r.done ? acc(r.owner) : "NULL"});`);
});
P(``);
P(`-- 计划 SIV 日期`);
for (const [ss, day] of Object.entries(SIV_PLAN))
  P(`UPDATE study_site SET siv_planned_on = ${d(day)} WHERE code = ${q(ss)};`);
P(``);

/* ── 交接 ── */
P(`-- ── 交接：系统此前提出过这个问题，却没有提供机制 ──────────────`);
HANDOVER.forEach(h => {
  const id = uuid5("handover:" + h.id);
  const done = h.st === "已完成";
  P(`INSERT INTO handover (id, from_account_id, to_account_id, reason, planned_on, status,` +
    ` completed_at) VALUES ('${id}', ${acc(h.from)}, ${acc(h.to)}, ${q(h.reason)}, ${d(h.d)}, ` +
    `${q(done ? "completed" : "pending")}, ${done ? `'${h.d}T18:00:00+08'::timestamptz` : "NULL"});`);
  for (const ss of h.ss)
    P(`INSERT INTO handover_site (handover_id, study_site_id) VALUES ('${id}', '${uuid5("site:"+ss)}');`);
  h.items.forEach((it, k) =>
    P(`INSERT INTO handover_item (handover_id, seq, item, done_at, done_by) VALUES (` +
      `'${id}', ${k}, ${q(it.t)}, ${it.done ? `'${h.d}T18:00:00+08'::timestamptz` : "NULL"}, ` +
      `${it.done ? acc(h.from) : "NULL"});`));
});
P(``);

/* ════════════════════════════════════════════════════════════════
   ClinicalOps —— 受试者是有生命周期的对象，不是一个计数。

   原型的 FUNNEL 是一组写死的计数（预筛 68 / 知情 41 / 筛败 13）。
   种子把它**展开成真实的受试者行**：漏斗接口由这些行聚合出来，
   而不是把计数存下来。存计数的看板迟早会和明细对不上，
   而对不上的那天，没人知道该信哪一个。
   ════════════════════════════════════════════════════════════════ */
P(`-- ── 访视计划表 SOA：完成一次访视自动生成下一次，靠的就是它 ────`);
const SF_CODES = ["lab","prior_therapy","imaging","comorbidity","withdrew_icf","other"];
const WD_CODES = {"受试者撤回知情":"withdrew_icf","失访":"lost_to_followup",
  "不良事件终止治疗":"adverse_event","研究者判断需终止":"investigator_decision",
  "死亡":"death","方案违背终止":"protocol_violation"};

/* 每例访视的受试者补偿：交通与误工，按访视复杂度粗分两档 */
const COMP = (sid, i) => i === 0 ? 30000 : 20000;      // 分：筛选期 300 元，其余 200 元

const soaOf = sid => SOA[sid] || SOA._default;
for (const st of STUDIES) {
  const so = soaOf(st.id);
  for (let i = 0; i <= so.last; i++) {
    const code = i === 0 ? "SCR" : (so.label(i).match(/^([A-Za-z]+\d*[A-Za-z]*\d*)/) || [, `V${i}`])[1];
    P(`INSERT INTO visit_template (study_id, seq, visit_code, visit_label, anchor,` +
      ` offset_days, window_days, compensation_cents) VALUES (` +
      `'${uuid5("study:"+st.id)}', ${i}, ${q(code === "SCR" ? "SCR" : code + "-" + i)}, ` +
      `${q(so.label(i))}, ${q(i === 0 ? "icf" : "enroll")}, ` +
      `${i === 0 ? -14 : (i - 1) * so.cycle}, ${so.win}, ${COMP(st.id, i)});`);
    so.tasks(i).forEach((t, k) =>
      P(`INSERT INTO visit_template_task (study_id, visit_seq, seq, task) VALUES (` +
        `'${uuid5("study:"+st.id)}', ${i}, ${k}, ${q(t)});`));
  }
}
P(``);

/* ── 受试者：把漏斗计数展开成行 ── */
P(`-- ── 受试者：漏斗由明细聚合，不存计数 ──────────────────────────`);
const site = id => SITES.find(x => x.id === id);
/** 按漏斗补出来的在组受试者 —— 访视在下面按 SOA 铺开（欠账 F2）。 */
const COHORT = [];
const dropsOf = id => DROPS.filter(x => x.ss === id);
/* 逐日回推一个稳定的日期，避免种子每次生成都不同 */
const dayBefore = (base, n) =>
  new Date(new Date(base).getTime() - n * 864e5).toISOString().slice(0, 10);
const TODAY = "2026-08-24";

let subjRows = 0;
for (const ss of SITES) {
  const f = FUNNEL[ss.id] || { pre: 0, icf: 0, sf: 0, sfr: [0,0,0,0,0,0] };
  const sid = uuid5("site:" + ss.id);
  const named = SUBJ.filter(x => x.ss === ss.id);
  const drops = dropsOf(ss.id);
  const crc = ss.crc && ss.crc[0] ? acc(ss.crc[0]) : "NULL";

  /* 具名受试者（原型里逐个写出来的那几例）先出，保留其筛选号与状态 */
  const namedNos = new Set(named.map(x => x.id));
  for (const x of named) {
    const state = x.st === "已入组" ? "enrolled" : "screening";
    P(`INSERT INTO subject (id, study_site_id, screening_no, randomization_no, state,` +
      ` icf_signed_on, enrolled_on, crc_account_id) VALUES ('${uuid5("subj:"+x.id)}', ` +
      `'${sid}', ${q(x.id)}, ${x.rnd && x.rnd !== "—" ? q(x.rnd) : "NULL"}, ${q(state)}, ` +
      `${d(x.icf)}, ${state === "enrolled" ? d(x.icf) : "NULL"}, ${x.crc ? acc(x.crc) : crc});`);
    subjRows++;
  }
  /* 脱落的那几例 */
  for (const dr of drops) {
    if (namedNos.has(dr.subj)) continue;
    namedNos.add(dr.subj);
    P(`INSERT INTO subject (id, study_site_id, screening_no, randomization_no, state,` +
      ` icf_signed_on, enrolled_on, exited_on, withdraw_reason, note, crc_account_id)` +
      ` VALUES ('${uuid5("subj:"+dr.subj)}', '${sid}', ${q(dr.subj)}, ` +
      `${q("R-" + dr.subj.slice(2))}, 'withdrawn', ${d(dayBefore(dr.d, 120))}, ` +
      `${d(dayBefore(dr.d, 90))}, ${d(dr.d)}, ${q(WD_CODES[dr.why] || "other")}, ` +
      `${q(dr.note)}, ${crc});`);
    subjRows++;
  }

  /* 其余按漏斗补齐：入组 / 筛败 / 在筛 / 预筛 */
  let n = 0;
  const nextNo = () => { let no; do { no = `${ss.id}-P${String(++n).padStart(3,"0")}`; }
                         while (namedNos.has(no)); return no; };
  const enrolledLeft = Math.max(0, ss.enrolled - named.filter(x => x.st === "已入组").length
                                   - drops.length);
  for (let i = 0; i < enrolledLeft; i++) {
    const no = nextNo(), icf = dayBefore(TODAY, 200 + i * 7);
    const enrolledOn = dayBefore(TODAY, 186 + i * 7);
    /* 显式给 id：下面铺访视时要按 uuid5("subj:"+筛选号) 找回这一行。
       让数据库随机生成的话，访视就挂不上去 —— 而那会表现成
       "插入成功但外键对不上"，只有跑完种子才看得见。 */
    P(`INSERT INTO subject (id, study_site_id, screening_no, randomization_no, state,` +
      ` icf_signed_on, enrolled_on, crc_account_id) VALUES ('${uuid5("subj:" + no)}', '${sid}', ${q(no)}, ` +
      `${q("R" + no.slice(2))}, 'enrolled', ${d(icf)}, ${d(enrolledOn)}, ${crc});`);
    /* 记下来，稍后给他们铺访视（欠账 F2）——
       只有状态没有访视的话，漏斗是真的而访视清单是空的，
       于是"今天要做什么"这一页在演示里永远只有十来行。 */
    COHORT.push({ ss: ss.id, sid: ss.sid, no, enrolledOn, crc, pi: ss.pi });
    subjRows++;
  }
  /* 筛败：按原型给出的原因分布逐条展开 —— 筛败也是收入（I8'） */
  let sfI = 0;
  f.sfr.forEach((cnt, k) => {
    for (let i = 0; i < cnt; i++, sfI++) {
      const no = nextNo(), icf = dayBefore(TODAY, 150 + sfI * 5);
      P(`INSERT INTO subject (study_site_id, screening_no, state, icf_signed_on, exited_on,` +
        ` screen_fail_reason, crc_account_id) VALUES ('${sid}', ${q(no)}, 'screen_failed', ` +
        `${d(icf)}, ${d(dayBefore(TODAY, 143 + sfI * 5))}, ${q(SF_CODES[k])}, ${crc});`);
      subjRows++;
    }
  });
  /* 在筛：签了知情但既未入组也未筛败 */
  const inScr = Math.max(0, f.icf - ss.enrolled - f.sf - named.filter(x => x.st === "筛选中").length);
  for (let i = 0; i < inScr; i++) {
    const no = nextNo();
    P(`INSERT INTO subject (study_site_id, screening_no, state, icf_signed_on, crc_account_id)` +
      ` VALUES ('${sid}', ${q(no)}, 'screening', ${d(dayBefore(TODAY, 10 + i * 3))}, ${crc});`);
    subjRows++;
  }
  /* 预筛：还没签知情 */
  const pre = Math.max(0, f.pre - f.icf);
  for (let i = 0; i < pre; i++) {
    const no = nextNo();
    P(`INSERT INTO subject (study_site_id, screening_no, state, crc_account_id)` +
      ` VALUES ('${sid}', ${q(no)}, 'prescreen', ${crc});`);
    subjRows++;
  }
}
P(``);

/* ── 具名受试者的当前访视：原型里的 due / win / tasks ── */
P(`-- ── 访视：窗口用 daterange 生成列，超窗查询走 GiST 索引 ────────`);
let visitRows = 0;
for (const x of SUBJ) {
  const ss = site(x.ss); if (!ss) continue;
  const so = soaOf(ss.sid);
  const vid = uuid5("visit:" + x.id + ":" + x.seq);
  P(`INSERT INTO subject_visit (id, subject_id, study_site_id, seq, visit_code, visit_label,` +
    ` target_date, window_days, status) VALUES ('${vid}', '${uuid5("subj:"+x.id)}', ` +
    `'${uuid5("site:"+x.ss)}', ${x.seq}, ${q(x.seq === 0 ? "SCR" : "V-" + x.seq)}, ` +
    `${q(so.label(x.seq))}, ${d(x.due)}, ${x.win}, 'planned');`);
  x.tasks.forEach((t, k) =>
    P(`INSERT INTO subject_visit_task (visit_id, seq, task, done_at, done_by) VALUES (` +
      `'${vid}', ${k}, ${q(t[0])}, ${t[1] ? `'${x.lastVisit}T10:00:00+08'::timestamptz` : "NULL"}, ` +
      `${t[1] ? acc(x.crc) : "NULL"});`));
  visitRows++;
}

/* ── 在组受试者的访视史（欠账 F2） ────────────────────────────────
   在此之前只有 10 位具名受试者有访视行，其余 500 多位**只有状态**。
   漏斗因此是真的，而访视清单是空的 —— 演示里"今天要做什么"永远只有
   十来行，谁也看不出这一页在几百例的中心上长什么样。

   按 SOA 铺：入组日 + offset 落在今天之前的，是已经做完并锁定的；
   第一个落在今天之后的，是**下一次**，画成 planned。
   全部在窗口内、无超窗 —— 偏离是刻意造的那几条（原型里的 DROPS 与
   QUERIES），不该被这里的批量数据淹掉。 */
P(``);
P(`-- ── 在组受试者的访视史：按 SOA 铺开（欠账 F2） ────────────────`);
/** 这一次是不是"最近一次已经做完的"访视 —— 用来给没有 PI 的中心
 *  只留一条待确认，而不是把整条 SOA 都变成积压。 */
function isLastPast(so, enrolled, today, seq) {
  for (let k = seq + 1; k <= so.last; k++) {
    const t = new Date(enrolled);
    t.setDate(t.getDate() + (k - 1) * so.cycle);
    if (t < today) return false;
  }
  return true;
}

for (const c of COHORT) {
  const so = soaOf(c.sid);
  const piAcc = USERS.find(u => u.n === c.pi && u.role === "pi");
  const enrolled = new Date(c.enrolledOn);
  const today = new Date(TODAY);
  let scheduled = 0;
  for (let seq = 1; seq <= so.last; seq++) {
    const target = new Date(enrolled);
    target.setDate(target.getDate() + (seq - 1) * so.cycle);
    const targetStr = target.toISOString().slice(0, 10);
    const past = target < today;
    /* 已过去的全部锁定，未来的只铺**第一次** —— 把整条 SOA 都铺成
       planned 的话，"今天要做什么"会被几百条一年后的访视淹掉。 */
    if (!past && scheduled > 0) break;
    /* 没有 PI 账号的中心，做完的访视只能停在 done_pending_pi。
       全铺的话演示库里会有一千多条卡着的访视 —— 而「待 PI 确认」
       是一个**信号**：85% 都是它的时候，它就什么也不说明了。
       所以这些中心只留最近一次做完的，其余不铺。 */
    if (past && !piAcc && !isLastPast(so, enrolled, today, seq)) continue;
    const vid = uuid5("cvisit:" + c.no + ":" + seq);
    const code = (so.label(seq).match(/^([A-Za-z]+\d*[A-Za-z]*\d*)/) || [, `V${seq}`])[1];
    /* locked 必须带 PI 的签字与时间（I3，visit_locked_needs_pi），
       entered 必须带录入日（visit_edc_entered_needs_date）——
       两条约束都在库里，绕不过去。这是好事：**演示数据不能比
       真实数据更宽松**，否则界面在演示上走得通、在真库上走不通。

       没有 PI 账号的中心（原型里有几个），做完的访视只能停在
       `done_pending_pi` —— 而那恰恰是 I3 想让人看见的那个积压：
       「访视做完了，但没有 PI 确认，所以它不算已完成」。 */
    const locked = past && !!piAcc;
    const status = !past ? "planned" : locked ? "locked" : "done_pending_pi";
    P(`INSERT INTO subject_visit (id, subject_id, study_site_id, seq, visit_code, visit_label,` +
      ` target_date, window_days, status, actual_date, out_of_window, hours,` +
      ` pi_confirmed_by, pi_confirmed_at, edc_status, edc_entered_on) VALUES (` +
      `'${vid}', '${uuid5("subj:" + c.no)}', '${uuid5("site:" + c.ss)}', ${seq}, ` +
      `${q(code + "-" + seq)}, ${q(so.label(seq))}, ${d(targetStr)}, ${so.win}, ` +
      `${q(status)}, ${past ? d(targetStr) : "NULL"}, false, ` +
      `${past ? "3.0" : "NULL"}, ` +
      `${locked ? `'${uuid5("account:" + piAcc.u)}'` : "NULL"}, ` +
      `${locked ? `'${targetStr}T18:00:00+08'::timestamptz` : "NULL"}, ` +
      `${locked ? "'entered'" : "'pending'"}, ${locked ? d(targetStr) : "NULL"});`);
    so.tasks(seq).forEach((t, k) =>
      P(`INSERT INTO subject_visit_task (visit_id, seq, task, done_at, done_by) VALUES (` +
        `'${vid}', ${k}, ${q(t)}, ` +
        `${past ? `'${targetStr}T10:00:00+08'::timestamptz` : "NULL"}, ` +
        `${past ? c.crc : "NULL"});`));
    visitRows++;
    if (!past) scheduled++;
  }
}
P(``);

/* ── 质量事件：原型的 QUERIES 是真实存在的数据质疑 ──
   三个状态**逐一映射**，不是"关了 / 没关"两分。
   此前这里写的是 `已关闭 ? closed : open` —— 于是「已回复待关闭」
   在库里变成了「待中心回复」，而那一格正是这套流程的全部意义：
   中心回复了不等于问题解决了，判定权在 DM。 */
const Q_STATE = {"待中心回复":"open", "已回复待关闭":"pending_review", "已关闭":"closed"};
/* 「已回复待关闭」必须带回复内容（迁移 0032 的 CHECK）。
   原型把回复框留在界面上、没有落到数据里，所以这里按它自己的
   placeholder 的形状补一句 —— 一条没有回复内容的"已回复"，
   DM 判定的是一片空白。 */
const Q_ANSWER = {
  "Q-1165": "已调阅原始护理记录：该次收缩压为 120 mmHg，eCRF 录入时多输一位，" +
            "已更正为 120，源文件见门诊病历第 7 页 2026-08-14 记录。"
};
P(`-- ── 质量事件：超窗必须生成方案偏离（I4），质疑同样进这张表 ─────`);
QUERIES.forEach(qy => {
  const subj = SUBJ.find(x => x.id === qy.subj);
  const state = Q_STATE[qy.st] ?? "open";
  const answer = state === "pending_review" ? Q_ANSWER[qy.id] ?? null : null;
  /* 提出方：原型的 by 是一个显示字符串。数据管理是这一版新增的来源
     （迁移 0032 给 raised_by 补了 'dm'）—— 此前它只能记成 cra，
     而"质疑是谁提的"因此答不出来。 */
  const dm = qy.by.startsWith("数据管理");
  const byName = dm ? "苗青" : qy.by.replace(/（.*）$/, "");
  P(`INSERT INTO quality_event (code, study_site_id, subject_id, kind, severity, state,` +
    ` title, detail, form, field_name, owner_account_id, answer, answered_on,` +
    ` raised_by, raised_by_account, raised_on) VALUES (${q(qy.id)}, '${uuid5("site:"+qy.ss)}', ` +
    `${subj ? `'${uuid5("subj:"+qy.subj)}'` : "NULL"}, 'query', ` +
    `${q(qy.age > 7 ? "major" : "minor")}, ${q(state)}, ` +
    `${q(qy.form + " · " + qy.field)}, ${q(qy.txt)}, ${q(qy.form)}, ${q(qy.field)}, ` +
    `${acc(qy.owner)}, ${q(answer)}, ` +
    /* 回复日期取"提出后一半的时间"：它落在提出日与今天之间，
       没有更精确的来源，但顺序必须对 —— 回复早于提出是不可能的事。 */
    `${answer ? d(dayBefore(TODAY, Math.floor(qy.age / 2))) : "NULL"}, ` +
    `${q(dm ? "dm" : "cra")}, ${acc(byName)}, ` +
    `${d(dayBefore(TODAY, qy.age))});`);
});
P(``);

/* ── 质量事件与 CAPA ───────────────────────────────────────────
   原型的 ISSUES 是**十条真实存在的质量事件**，此前一条都没进过种子 ——
   于是 `quality_event` 里只有 2 条 SAE 和 7 条质疑，
   而「质量事件与 CAPA」那一页打开是半空的，
   上一批种进去的 MVR 跟进项里还写着 QI-2026-0155 这样的编号，
   指向**库里根本不存在的记录**。

   category 存的是去掉「机构质控发现 · 」前缀之后的问题类型：
   CAPA 有效性按它分组，而 kind 只有五个取值，
   按 kind 分的话「源数据缺陷」和「知情同意版本错误」会落进同一格。 */
P(`-- ── 质量事件与 CAPA（原型 ISSUES） ─────────────────────────────`);
const ISS_SEV = { "重大": "critical", "严重": "major", "一般": "minor" };
/* 来源：0035 给 raised_by 补了 sponsor 与 site。
   「同类问题总是被谁发现的」本身就是一个结论 —— 某一类永远由申办方
   稽查发现、我方监查从来没查出来过，那要改的是 SDV 抽样策略。 */
const ISS_SRC = { "内部监查": "cra", "机构质控": "institution",
                  "申办方稽查": "sponsor", "中心自查": "site" };
/* 状态：待整改 与 CAPA进行中 都是 open —— 差别在**有没有措施**，
   而那由 capa_plan 是不是空表达，不需要第四个状态。 */
const ISS_STATE = { "待整改": "open", "CAPA进行中": "open",
                    "待验证": "pending_review", "已关闭": "closed" };
const ISS_KIND = t =>
  /SAE/.test(t) ? "sae_late" : /方案偏离/.test(t) ? "deviation" : "other";
/* 「（待受托方提交整改措施）」不是一份措施，是一句占位符。
   照原样存进 capa_plan，「还有几条欠着整改措施」这个数就永远是 0。 */
const ISS_CAPA = c => (!c || /^（待/.test(c)) ? null : c;
ISSUES.forEach(i => {
  const state = ISS_STATE[i.st] ?? "open";
  const capa = ISS_CAPA(i.capa);
  const closed = state === "closed";
  P(`INSERT INTO quality_event (code, study_site_id, kind, severity, state, title, detail,` +
    ` category, raised_by, raised_on, capa_plan, capa_owner_account_id, capa_due_on,` +
    ` closed_at, closed_by, resolution) VALUES (${q(i.id)}, '${uuid5("site:"+i.ss)}', ` +
    `${q(ISS_KIND(i.type))}, ${q(ISS_SEV[i.sev])}, ${q(state)}, ${q(i.type)}, ${q(i.desc)}, ` +
    `${q(i.type.replace(/^机构质控发现 · /, ""))}, ${q(ISS_SRC[i.src] ?? "qa")}, ${d(i.found)}, ` +
    `${q(capa)}, ${acc(i.own)}, ${d(i.due)}, ` +
    /* 关闭三件套同生共死（0009 的 CHECK）。关闭人是 QA —— 关闭要 closeQA，
       而整改责任人（capa_owner）并没有这个动作权限：**写措施的人不能自己验证**。 */
    `${closed ? `'${i.due} 17:00+08'::timestamptz` : "NULL"}, ` +
    `${closed ? acc("卫兰") : "NULL"}, ${closed ? q(capa) : "NULL"});`);
});
P(``);

/* ── 内部稽查与发现项 ──────────────────────────────────────────
   QA 是我方的第二道防线：机构质控是医院查我们，稽查是我们自己查自己。
   稽查的价值不在于又发现一批问题，**在于 CAPA 有效性验证**。 */
P(`-- ── 内部稽查（QA 的第二道防线） ────────────────────────────────`);
const AU_KIND = { "中心内部稽查": "site", "体系稽查": "system",
                  "CAPA 有效性验证": "capa_check", "核查前模拟稽查": "pre_inspection" };
const AU_STATE = { "进行中": "open", "待整改": "remediating", "已关闭": "closed" };
AUDIT.forEach(a => {
  const id = uuid5("audit:" + a.id);
  const state = AU_STATE[a.st] ?? "open";
  const closed = state === "closed";
  P(`INSERT INTO internal_audit (id, code, study_site_id, kind, audited_on,` +
    ` auditor_account_id, scope, state, closed_at, closed_by) VALUES (` +
    `'${id}', ${q(a.id)}, '${uuid5("site:"+a.ss)}', ${q(AU_KIND[a.type] ?? "site")}, ` +
    `${d(a.date)}, ${acc(a.by)}, ${q(a.scope)}, ${q(state)}, ` +
    `${closed ? `'${a.date} 17:00+08'::timestamptz` : "NULL"}, ` +
    `${closed ? acc(a.by) : "NULL"});`);
  a.findings.forEach((f, k) => {
    const fClosed = f.st === "已关闭";
    P(`INSERT INTO audit_finding (audit_id, seq, severity, finding, repeat_of, state,` +
      ` verification, closed_at, closed_by) VALUES ('${id}', ${k}, ` +
      `${q(ISS_SEV[f.sev])}, ${q(f.t)}, ` +
      /* 复发指向那条质量事件本身。原型记的是编号字符串，找不到就静默丢掉 ——
         而这个指标存在的全部理由就是抓复发。这里是外键。 */
      `${f.repeat ? `(SELECT id FROM quality_event WHERE code = ${q(f.repeat)})` : "NULL"}, ` +
      `${q(fClosed ? "closed" : "open")}, ` +
      /* 「已整改」三个字不是验证。已关闭的那条给一句说得出"怎么确认的"的话。 */
      `${fClosed ? q("已抽查复核，问题未再出现，整改证据已归档") : "NULL"}, ` +
      `${fClosed ? `'${a.date} 17:00+08'::timestamptz` : "NULL"}, ` +
      `${fClosed ? acc(a.by) : "NULL"});`);
  });
});
P(``);

/* ── 监查访视 ──────────────────────────────────────────────────
   原型的 VISITS 只有**未来四周**的六次排期。照搬进来，系统会得出
   「15 个中心里 13 个一次都没监查过」这个结论 —— 而那是假的：
   它们 2024 年底就启动了，两年里当然去过很多次。
   真相是**这张表刚建**，不是没去过。

   所以历史部分按一个说得清的规则回溯铺出来，而不是挑几个中心手工设：
     · 只给已经启动（有 SIV 日期）的中心铺；
     · 间隔按 70 天（normal 档的建议间隔）；
     · 最后一次距今 35 + 11i 天（i 是中心序号）——
       于是"该去了"和"还早"两种中心都有，且不是挑出来的。

   这些历史访视一律 reported（跟进项全关、报告已交）：
   **有争议的状态留给原型自己那六条**，历史只负责回答
   「上一次去是什么时候」。 */
P(`-- ── 监查访视：SIV / IMV / COV 与 MVR 跟进项 ────────────────────`);
const MV_KIND = { SIV: "siv", IMV: "imv", COV: "cov" };
const MV_STATE = { "待确认": "proposed", "已排期": "scheduled" };
/* 历史 IMV 的通用跟进项。它们是每次例行监查都会做的三件事 ——
   不是编的内容，是 SOP 上就有的那三项。 */
const MV_ROUTINE = [
  "SDV：本期新增受试者源数据核对",
  "试验用药品发放与回收记录清点",
  "未关闭质量事件与数据质疑跟进"
];
let mvSeq = 0;
const mvCode = () => `MV-2026-${String(++mvSeq).padStart(3, "0")}`;
const mvInsert = (o) => {
  const id = uuid5("mv:" + o.code);
  P(`INSERT INTO monitor_visit (id, code, study_site_id, kind, planned_on,` +
    ` monitor_account_id, days, state, confirmed_on, performed_on,` +
    ` report_submitted_on, sdv_sample_pct) VALUES (` +
    `'${id}', ${q(o.code)}, '${uuid5("site:"+o.ss)}', ${q(o.kind)}, ${d(o.planned)}, ` +
    `${o.monitor}, ${o.days}, ${q(o.state)}, ${d(o.confirmed)}, ${d(o.performed)}, ` +
    `${d(o.reported)}, ${o.sdv ?? "NULL"});`);
  o.items.forEach((it, k) =>
    P(`INSERT INTO monitor_visit_item (visit_id, seq, task, done_at, done_by) VALUES (` +
      `'${id}', ${k}, ${q(it.t)}, ` +
      `${it.done ? `'${o.performed ?? o.planned} 17:00+08'::timestamptz` : "NULL"}, ` +
      `${it.done ? o.monitor : "NULL"});`));
  return id;
};

/* 历史：每个已启动的中心两次例行监查。
   **判断"已启动"要看 siv 是不是一个真日期，不是它有没有值** ——
   原型里未启动的中心写的是 "—"，而 "—" 是真值：
   照 `s.siv` 这么筛，一个停在「伦理递交」的中心会长出两条监查记录，
   而那种数据在界面上看不出问题，只有人去问"我们什么时候去过 SS-13"才露馅。 */
SITES.filter(s => s.siv && s.siv !== "—").forEach((s, i) => {
  const last = 35 + i * 11;
  const cra = acc(s.cra);
  /* 没有派工 CRA 的中心跳过 —— 一次没有监查员的监查记录，
     "是谁去的"没有答案，而那正是这张表要回答的事之一。 */
  if (cra === "NULL") return;
  [last + 70, last].forEach(back => {
    const on = dayBefore(TODAY, back);
    mvInsert({
      code: mvCode(), ss: s.id, kind: "imv", planned: on, monitor: cra, days: 1,
      state: "reported", confirmed: dayBefore(TODAY, back + 10),
      performed: on, reported: dayBefore(TODAY, back - 5), sdv: 50,
      items: MV_ROUTINE.map(t => ({ t, done: true }))
    });
  });
});

/* 原型的六次排期。**两条已经过了计划日** ——
   SS-02 那次的跟进项已经勾了两项，说明现场其实去过了：
   于是它是 done 而不是 scheduled，报告压在 CRA 手上没交。
   「去过了但报告没交」是监查上最常见的欠账，而它此前在原型里
   连一个能表达它的状态都没有。 */
VISITS.forEach(v => {
  const cra = acc(v.who);
  const someDone = v.items.some(x => x.done);
  const state = someDone ? "done" : (MV_STATE[v.st] ?? "scheduled");
  mvInsert({
    code: mvCode(), ss: v.ss, kind: MV_KIND[v.kind], planned: v.d,
    monitor: cra === "NULL" ? acc("林敏") : cra, days: v.days,
    state,
    confirmed: state === "proposed" ? null : dayBefore(v.d, 10),
    performed: state === "done" ? v.d : null,
    reported: null,
    /* 抽样比例只在原型明写了的那一条上落库 —— 其余留空，
       表示"这次没有单独定过"，而不是默认 100%。 */
    sdv: /抽样 30%/.test(v.items.map(x => x.t).join("")) ? 30 : null,
    items: v.items
  });
});
P(``);

/* ════════════════════════════════════════════════════════════════
   Timesheet & Cost
   ════════════════════════════════════════════════════════════════ */
P(`-- ── 费率卡：生效区间不重叠由 EXCLUDE 约束保证（I2） ────────────`);
/* 原型只有一组当前费率。种子给出**两段**，才能真的验证
   「费率变更不回溯历史」——只有一段的话，这条不变量测不出来。 */
const RATES = [
  { role: "CRC", day: RATE.crcDay,        from: "2024-01-01", to: "2025-12-31",
    note: "2024–2025 年费率" },
  { role: "CRC", day: RATE.crcDay * 1.10, from: "2026-01-01", to: null,
    note: "2026 年调价 +10%" },
  { role: "CRA", day: RATE.craDay,        from: "2024-01-01", to: "2025-12-31",
    note: "2024–2025 年费率" },
  { role: "CRA", day: RATE.craDay * 1.10, from: "2026-01-01", to: null,
    note: "2026 年调价 +10%" },
  { role: "PM",  day: RATE.craDay * 1.15, from: "2024-01-01", to: null,
    note: "PM 按 CRA 上浮 15%" },
  { role: "QA",  day: RATE.craDay * 1.15, from: "2024-01-01", to: null, note: "同 PM" },
  { role: "DM",  day: RATE.craDay,        from: "2024-01-01", to: null, note: "同 CRA" }
];
RATES.forEach((r, i) => {
  P(`INSERT INTO rate_card (id, role_kind, day_cost_cents, valid_from, valid_to, note)` +
    ` VALUES ('${uuid5("rate:" + r.role + ":" + r.from)}', ${q(r.role)}, ` +
    `${cents(r.day)}, ${d(r.from)}, ${d(r.to)}, ${q(r.note)});`);
});
P(``);

P(`-- ── 工时：不可变事实，只能作废不能删（I1） ─────────────────────`);
const WT = { "受试者访视陪同": "visit_support", "源数据准备与核对": "sdv",
  "伦理递交与跟进": "ethics", "现场监查（IMV）": "monitoring",
  "药品与物资管理": "ip_mgmt", "内部培训": "training",
  "投标与商务支持": "bd", "返工与整改": "rework" };
const BILLABLE = Object.fromEntries(WORKTYPES.map(x => [WT[x.k], x.bill]));
const roleOf = name => {
  const st = STAFF.find(x => x.n === name);
  return st ? st.role : "CRC";
};
/* 8 小时 = 一个人天（与 packages/calc 的 HOURS_PER_DAY 同一口径） */
const HOURS_PER_DAY = 8;
let tsRows = 0;
TIMESHEET.forEach(t => {
  const role = roleOf(t.who);
  /* 与 app.rate_on() 同一套挑选规则：按 work_date 落在哪一段区间 */
  const card = RATES.find(r => r.role === role && t.d >= r.from && (!r.to || t.d <= r.to))
            ?? RATES.find(r => r.role === role);
  const dayCost = cents(card.day);
  const cost = Math.round((t.h / HOURS_PER_DAY) * dayCost) + cents(t.travel || 0);
  P(`INSERT INTO timesheet_entry (study_site_id, account_id, work_date, work_type,` +
    ` billable, hours, rate_card_id, day_cost_cents, travel_cents, cost_cents) VALUES (` +
    `'${uuid5("site:" + t.ss)}', ${acc(t.who)}, ${d(t.d)}, ${q(WT[t.type])}, ` +
    `${BILLABLE[WT[t.type]] ? "true" : "false"}, ${t.h}, ` +
    `'${uuid5("rate:" + card.role + ":" + card.from)}', ${dayCost}, ` +
    `${cents(t.travel || 0)}, ${cost});`);
  tsRows++;
});
P(``);

P(`-- ── 中心可行性调查：选址的账 ───────────────────────────────`);
P(`-- 报价模型算「这个项目要花多少人天」，这张表算「这家能不能出病人」。`);
/* 原型里 st 写的是「已入选（SS-04）」这样的中文串 —— 库里拆成
   status 与 study_site_id 两列：一个是状态机，一个是外键。
   保留原串去解析，等于把状态判断建在文案上，改一个字就全断。 */
let feasRows = 0;
FEAS.forEach(f => {
  const m = /已入选（(SS-\d+)）/.exec(f.st);
  const selected = !!m;
  const siteId = m ? `'${uuid5("site:" + m[1])}'` : "NULL";
  /* 决定日：原型没有这一栏。用调查日推 —— 入选的决定不会在调查当天下，
     但也不该编一个看起来很精确的日期。取调查日后 14 天，
     并在注释里说明它是推出来的，不是记录下来的。 */
  const decided = selected ? new Date(new Date(f.date).getTime() + 14 * 864e5)
    .toISOString().slice(0, 10) : null;
  P(`INSERT INTO feasibility (id, code, study_id, hospital, city, dept, pi_name,` +
    ` surveyed_on, surveyed_by, pt_year, past_n, past_best, compet, ethics_days,` +
    ` start_days, team_n, pi_commit, elig_pct, status, decided_on, decided_by,` +
    ` study_site_id, override_reason, reject_reason, actual_rate) VALUES (` +
    `'${uuid5("feas:" + f.id)}', ${q(f.id)}, '${uuid5("study:" + f.sid)}', ` +
    `${q(f.hosp)}, ${q(f.city)}, ${q(f.dept)}, ${q(f.pi)}, ` +
    `${d(f.date)}, ${acc(f.by)}, ${f.q.ptYear}, ${f.q.pastN}, ${f.q.pastBest}, ` +
    `${f.q.compet}, ${f.q.ethicsDays}, ${f.q.startDays}, ${f.q.teamN}, ` +
    `${f.q.piCommit}, ${f.q.eligPct == null ? "NULL" : f.q.eligPct}, ` +
    `${q(selected ? "selected" : "assessing")}, ${d(decided)}, ` +
    `${selected ? acc(f.by) : "NULL"}, ${siteId}, ${q(f.override)}, NULL, ` +
    `${f.actual == null ? "NULL" : f.actual});`);
  feasRows++;
});
P(``);

P(`-- ── 投标：报出去的价，赢没赢 ───────────────────────────────`);
P(`-- 不回写开标结果，报价模型就是自说自话。`);
/* 原型里 st 是中文串、金额是万元、win 是成交价（失标时是对手的价）。
   `win: null` 在原型里既表示"待定"也表示"问不到" —— 库里分得开：
   待定的 status='pending'（约束禁止有价），失标的 win 可以为 NULL。 */
const BID_ST = { "待定": "pending", "中标": "won", "失标": "lost" };
let bidRows = 0;
BIDS.forEach(b => {
  const st = BID_ST[b.st];
  /* 决定日：原型没有这一栏。投标 → 开标通常一到两个月，取投标日 + 45 天。
     它是推出来的，不是记录下来的 —— 和可行性的 decided_on 同一个处理。 */
  const decided = st === "pending" ? null
    : new Date(new Date(b.sub).getTime() + 45 * 864e5).toISOString().slice(0, 10);
  P(`INSERT INTO bid (id, code, sponsor, name, submitted_on, sites, subjects,` +
    ` our_quote_cents, our_person_days, status, decided_on, winning_price_cents,` +
    ` owner_account_id, note) VALUES (` +
    `'${uuid5("bid:" + b.id)}', ${q(b.id)}, ${q(b.sp)}, ${q(b.name)}, ${d(b.sub)}, ` +
    `${b.sites}, ${b.subjects}, ${cents(b.ours)}, ${b.md}, ${q(st)}, ${d(decided)}, ` +
    `${b.win == null ? "NULL" : cents(b.win)}, ${acc(b.by)}, ${q(b.note)});`);
  bidRows++;
});
P(``);

P(`-- ── 合同变更：亏损第二大原因就是 scope creep 没有变更单 ────────`);
const CHG_KIND = {
  "方案修订 · 访视增加": "visit_add", "方案修订 · 检查项增加": "exam_add",
  "例数调整": "subject_adj", "中心增减": "site_adj",
  "周期延长": "extend", "单价调整": "price_adj"
};
const CHG_ST = { "待提出": "draft", "已提交": "submitted",
  "已签署": "signed", "未获批": "rejected" };
let chgRows = 0;
CHANGES.forEach(c => {
  const st = CHG_ST[c.st];
  const decided = ["signed", "rejected"].includes(st)
    ? new Date(new Date(c.raised).getTime() + 30 * 864e5).toISOString().slice(0, 10)
    : null;
  /* 未获批的那条金额是 NULL —— **不是 0**。
     0 表示"谈过了，对方不给钱，我们认了"（已签署但零元）；
     NULL 表示"没有对应金额"，那正是 scope creep 的定义。 */
  P(`INSERT INTO contract_change (id, code, study_id, study_site_id, kind,` +
    ` raised_on, raised_by, what, person_days_impact, per_subject, amount_cents,` +
    ` status, decided_on, note) VALUES (` +
    `'${uuid5("chg:" + c.id)}', ${q(c.id)}, '${uuid5("study:" + c.sid)}', ` +
    `${c.ss ? `'${uuid5("site:" + c.ss)}'` : "NULL"}, ${q(CHG_KIND[c.kind])}, ` +
    `${d(c.raised)}, ${acc(c.by)}, ${q(c.what)}, ${c.mdImpact}, ` +
    `${c.perSubject ? "true" : "false"}, ${c.amt == null ? "NULL" : cents(c.amt)}, ` +
    `${q(st)}, ${d(decided)}, ${q(c.note || null)});`);
  chgRows++;
});
P(``);

P(`-- ── 里程碑：达成 → 开票 → 回款 ───────────────────────────────`);
P(`-- 只记**已达成**的。未来的里程碑是从入组速度推出来的预测，不落库 ——`);
P(`-- 预测混进台账会凭空造出现金流，而那正是现金流预测最容易骗人的地方。`);
const MS_CODE = { "合同签署": "contract", "中心启动 SIV": "siv", "入组过半": "half",
  "入组达成 80%": "eighty", "中心结题": "closeout" };
/* 原型的 inv 是中文串 + 一个 paid 布尔，两者有冗余（"已回款" 必然 paid）。
   库里收敛成一个三态：pending / invoiced / paid。 */
const MS_STATE = m => m.paid ? "paid" : m.inv === "已开票" ? "invoiced" : "pending";
let msRows = 0;
MILES.forEach(m => {
  const st = MS_STATE(m);
  /* 开票日：原型只给了到期日。按客户账期倒推 —— 到期日减账期。
     它是推出来的，不是记录下来的，和别处一样在注释里说明。 */
  const site = SITES.find(x => x.id === m.ss);
  const sponsor = site ? STUDIES.find(x => x.id === site.sid)?.sponsor : null;
  const terms = payDays((CLIENT_META[sponsor] || {}).pay);
  const dueOn = m.due && m.due !== "—" ? m.due : null;
  /* 到期日减账期。**再和达成日取较晚的那个** ——
     原型的 due 有几条只比 hit 晚 60 天，而那个客户的账期是 90 天，
     直接倒推会把开票日算到达成日之前。开不出那样的票，
     库里的 milestone_dates 约束也不让（它挡住的正是这种编造）。 */
  const invOn = st === "pending" ? null
    : dueOn
      ? [new Date(new Date(dueOn).getTime() - terms * 864e5).toISOString().slice(0, 10),
         m.hit].sort().at(-1)
      : m.hit;
  /* 回款日：已回款的按到期日当天记 —— 原型没有这一栏，
     而"回款日必须不早于开票日"这条约束需要一个值。 */
  const paidOn = st === "paid" ? (dueOn ?? m.hit) : null;
  P(`INSERT INTO milestone (id, code, study_site_id, plan_code, amount_cents,` +
    ` reached_on, state, invoiced_on, due_on, paid_on) VALUES (` +
    `'${uuid5("ms:"+m.id)}', ${q(m.id)}, '${uuid5("site:"+m.ss)}', ` +
    `${q(MS_CODE[m.name])}, ${cents(m.amt)}, ${d(m.hit)}, ${q(st)}, ` +
    `${d(invOn)}, ${d(st === "pending" ? null : dueOn ?? m.hit)}, ${d(paidOn)});`);
  msRows++;
});
P(``);

P(`-- ── 合同条款：筛败费率与管理分摊（原型里是两个写死的常量） ─────`);
P(`UPDATE study SET screen_fail_fee_rate = 0.350, overhead_rate = ${RATE.overhead};`);
P(``);
P(`COMMIT;`);

const OUT = "db/seeds/001_demo.sql";
const text = L.join("\n") + "\n";

/* ── --check：只比不写（欠账 F1） ──────────────────────────────────
   原型是**冻结的需求基线**，不是运行时依赖 —— 这一点没有变。
   变的是"漂了没有人知道"：在此之前，改一次 prototype/index.html
   而不重跑这个生成器，种子就和需求基线悄悄分了家，
   而分家的表现是几个月后有人问"系统里这个数为什么和当初谈的不一样"。

   `--check` 把那件事变成一次 CI 失败，并且直接说出该跑哪条命令。
   它**不自动重跑** —— 重新生成会覆盖 001_demo.sql，那应该是一次
   看得见的提交，不是构建的副作用。 */
if (process.argv.includes("--check")) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (cur === text) {
    console.log(`✓ ${OUT} 与 prototype/index.html 一致`);
    process.exit(0);
  }
  const curLines = cur.split("\n"), newLines = text.split("\n");
  const at = curLines.findIndex((l, i) => l !== newLines[i]);
  console.error(
    `✗ ${OUT} 与 prototype/index.html 不一致（第 ${at + 1} 行起）\n` +
    `    已提交：${JSON.stringify(curLines[at] ?? "（文件到此结束）").slice(0, 120)}\n` +
    `    原型生成：${JSON.stringify(newLines[at] ?? "（文件到此结束）").slice(0, 120)}\n\n` +
    `  原型是需求基线，改了它就要重跑生成器：\n` +
    `    node tools/gen-seed.mjs\n` +
    `  然后把 ${OUT} 一起提交 —— 那次提交本身就是"需求变了"的记录。`);
  process.exit(1);
}

fs.mkdirSync("db/seeds", { recursive: true });
fs.writeFileSync(OUT, text);
console.log(`db/seeds/001_demo.sql 已生成（${L.length} 行）` +
  `｜角色 ${Object.keys(ROLE_DEF).length} · 账号 ${USERS.length} · 分组 ${GROUPS.length}` +
  ` · 项目 ${STUDIES.length} · 中心 ${SITES.length} · 受试者 ${subjRows} · 访视 ${visitRows}` +
  ` · 费率卡 ${RATES.length} · 工时 ${tsRows} · 可行性 ${feasRows}` +
  ` · 投标 ${bidRows} · 变更 ${chgRows} · 客户 ${SPONSORS.length} · 里程碑 ${msRows}`);
