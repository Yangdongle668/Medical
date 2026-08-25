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
      DROPS = grab("DROPS"), QUERIES = grab("QUERIES");

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
P(`-- 全部为虚构演示数据，不含任何真实受试者可识别信息。`);
P(`-- 受试者数据不在 Phase 1 范围内；届时录入的筛选号须重新生成，与原型脱钩。`);
P(`BEGIN;`);
P(`SET LOCAL client_min_messages = warning;`);
P(``);

/* ── 角色（三维权限） ── */
P(`-- ── 角色：行 × 列 × 动作 ──────────────────────────────────────`);
for (const [code, r] of Object.entries(ROLE_DEF)) {
  P(`INSERT INTO role (id, code, name, is_external, row_rule) VALUES (` +
    `'${uuid5("role:"+code)}', ${q(code)}, ${q(r.t)}, ${r.ext ? "true":"false"}, ${q(r.rows)});`);
}
P(``);
P(`-- 列维度：外部角色默认拒绝，只有显式为 true 的才写入 visible=true`);
for (const [code, r] of Object.entries(ROLE_DEF))
  for (const [f, v] of Object.entries(r.fields))
    P(`INSERT INTO role_field (role_id, field_key, visible) VALUES (` +
      `'${uuid5("role:"+code)}', ${q(FIELD[f] ?? f)}, ${v ? "true":"false"});`);
P(``);
P(`-- 动作维度`);
for (const [code, r] of Object.entries(ROLE_DEF))
  for (const [a, v] of Object.entries(r.acts))
    P(`INSERT INTO role_action (role_id, action_key, allowed) VALUES (` +
      `'${uuid5("role:"+code)}', ${q(a)}, ${v ? "true":"false"});`);
/* DM 的关闭质疑权：原型里由角色隐含，这里显式化 */
P(`INSERT INTO role_action (role_id, action_key, allowed) VALUES ` +
  `('${uuid5("role:dm")}', 'closeQ', true);`);
for (const code of Object.keys(ROLE_DEF)) if (code !== "dm")
  P(`INSERT INTO role_action (role_id, action_key, allowed) VALUES ` +
    `('${uuid5("role:"+code)}', 'closeQ', false);`);

/* ClinicalOps 的三个动作：原型没有「查看受试者明细需要单独授权」这个概念，
   所以在这里显式给出，而不是从 ROLE_DEF 推。

   **QA 与机构办刻意不给 subjRead。** 他们按事件与计数工作：
   看得到漏斗（只有计数），看得到质量事件上的筛选号（列权限允许），
   但拉不出全院受试者名册 —— 明细与聚合是两种权限（I10）。 */
const CLIN_ACTS = {
  subjRead:  ["boss", "pm", "cra", "crc", "dm", "pi"],
  subjWrite: ["crc", "pm"],
  piConfirm: ["pi"]
};
P(`-- ClinicalOps 动作维度（见 db/migrations/0009_clinical.sql）`);
for (const [act, allow] of Object.entries(CLIN_ACTS))
  for (const code of Object.keys(ROLE_DEF))
    P(`INSERT INTO role_action (role_id, action_key, allowed) VALUES ` +
      `('${uuid5("role:"+code)}', ${q(act)}, ${allow.includes(code) ? "true" : "false"});`);
P(``);
P(`-- 可访问模块（收敛导航，不是安全边界）`);
for (const [code, r] of Object.entries(ROLE_DEF))
  r.mods.forEach((m, i) => P(`INSERT INTO role_module (role_id, module_key, sort_order) VALUES (` +
    `'${uuid5("role:"+code)}', ${q(m)}, ${i});`));
P(``);

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
    `'${uuid5("account:"+u.u)}', ${q(u.u)}, ${q(u.n)}, '${uuid5("role:"+u.role)}', ` +
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

/* ── 项目与中心 ── */
P(`-- ── 项目 ────────────────────────────────────────────────────`);
P(`-- 金额一律以「分」存 bigint；原型的万元数值在此换算（见迁移 0006）。`);
for (const s of STUDIES)
  P(`INSERT INTO study (id, code, short_name, sponsor_name, phase, indication,` +
    ` planned_subjects, contract_amount_cents, started_on, ends_on) VALUES (` +
    `'${uuid5("study:"+s.id)}', ${q(s.id)}, ${q(s.short)}, ${q(s.sponsor)}, ${q(s.phase)}, ` +
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
    P(`INSERT INTO subject (study_site_id, screening_no, randomization_no, state,` +
      ` icf_signed_on, enrolled_on, crc_account_id) VALUES ('${sid}', ${q(no)}, ` +
      `${q("R" + no.slice(2))}, 'enrolled', ${d(icf)}, ${d(dayBefore(TODAY, 186 + i * 7))}, ${crc});`);
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
P(``);

/* ── 质量事件：原型的 QUERIES 是真实存在的数据质疑 ── */
P(`-- ── 质量事件：超窗必须生成方案偏离（I4），质疑同样进这张表 ─────`);
QUERIES.forEach(qy => {
  const subj = SUBJ.find(x => x.id === qy.subj);
  P(`INSERT INTO quality_event (code, study_site_id, subject_id, kind, severity, state,` +
    ` title, detail, raised_by, raised_on) VALUES (${q(qy.id)}, '${uuid5("site:"+qy.ss)}', ` +
    `${subj ? `'${uuid5("subj:"+qy.subj)}'` : "NULL"}, 'query', ` +
    `${q(qy.age > 7 ? "major" : "minor")}, ${q(qy.st === "已关闭" ? "closed" : "open")}, ` +
    `${q(qy.form + " · " + qy.field)}, ${q(qy.txt)}, 'cra', ` +
    `${d(dayBefore(TODAY, qy.age))});`);
});
P(``);
P(`COMMIT;`);

fs.mkdirSync("db/seeds", { recursive: true });
fs.writeFileSync("db/seeds/001_demo.sql", L.join("\n") + "\n");
console.log(`db/seeds/001_demo.sql 已生成（${L.length} 行）` +
  `｜角色 ${Object.keys(ROLE_DEF).length} · 账号 ${USERS.length} · 分组 ${GROUPS.length}` +
  ` · 项目 ${STUDIES.length} · 中心 ${SITES.length} · 受试者 ${subjRows} · 访视 ${visitRows}`);
