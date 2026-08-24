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
const grab = name => {
  const re = new RegExp(`(?:^|\\n)(?:const|let)\\s+${name}\\s*=\\s*`, "m");
  const i = js.search(re); if (i < 0) throw new Error(`未找到 ${name}`);
  const start = js.indexOf(js[js.search(re)] === "\n" ? "=" : "=", i) + 1;
  let d = 0, s = -1;
  for (let k = start; k < js.length; k++) {
    const c = js[k];
    if (c === "[" || c === "{") { if (s < 0) s = k; d++; }
    else if (c === "]" || c === "}") { d--; if (!d) return eval("(" + js.slice(s, k + 1) + ")"); }
  }
  throw new Error(`${name} 解析失败`);
};
const STUDIES = grab("STUDIES"), SITES = grab("SITES"),
      STAFF = grab("STAFF"), USERS = grab("USERS"),
      GROUPS = grab("GROUPS"), ROLE_DEF = grab("ROLE_DEF");

const q  = v => v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`;
const d  = v => (!v || v === "—") ? "NULL" : `'${v}'`;
const wan = v => (Number(v) * 10000).toFixed(2);              // 万元 → 元
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
P(`-- 金额一律以「元」存 numeric(14,2)；原型的万元数值在此换算。`);
for (const s of STUDIES)
  P(`INSERT INTO study (id, code, short_name, sponsor_name, phase, indication,` +
    ` planned_subjects, contract_amount, started_on, ends_on) VALUES (` +
    `'${uuid5("study:"+s.id)}', ${q(s.id)}, ${q(s.short)}, ${q(s.sponsor)}, ${q(s.phase)}, ` +
    `${q(s.indication)}, ${s.planned}, ${wan(s.contract)}, '${s.start}-01', '${s.end}-01');`);
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
    ` state, contracted, unit_price, startup_fee, irb_approved_on, siv_on, siv_planned_on, fpi_on) VALUES (` +
    `'${uuid5("site:"+s.id)}', '${uuid5("study:"+s.sid)}', ${q(s.id)}, ${q(s.hosp)}, ${q(s.dept)}, ` +
    `${q(s.city)}, ${piAcc ? `'${uuid5("account:"+piAcc.u)}'` : "NULL"}, ${q(s.pi)}, ` +
    `${q(STATE[s.st])}, ${s.contracted}, ${wan(s.unit)}, ${wan(s.startup||0)}, ` +
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
P(`COMMIT;`);

fs.mkdirSync("db/seeds", { recursive: true });
fs.writeFileSync("db/seeds/001_demo.sql", L.join("\n") + "\n");
console.log(`db/seeds/001_demo.sql 已生成（${L.length} 行）` +
  `｜角色 ${Object.keys(ROLE_DEF).length} · 账号 ${USERS.length} · 分组 ${GROUPS.length}` +
  ` · 项目 ${STUDIES.length} · 中心 ${SITES.length}`);
