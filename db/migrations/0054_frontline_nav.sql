-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   一线侧栏：前六项是每天用的，其余收进「更多」；CRA 补上日程、文件、伦理。

   ── 两个问题 ────────────────────────────────────────────────────────
   ① CRC 的侧栏 15 项，按「项目周期 / 现场 / 质量 / 机构办公室」这些
      **管理职能**分组。一线不按这个想事情 —— 「交接」在项目周期、
      「药品样本」在现场、SAE 在「我的整改」里，要先懂系统怎么拆的，
      才知道去哪找。每天真正要点的只有五六项。
   ② CRA 没有 `sched`（我的日程）、`isf`（中心文件）、`ethics`（伦理）。
      监查员最要紧的是行程，到了中心要核的是文件和批件 ——
      三样都没有入口，反倒给了可行性调查与筛选漏斗。

   ── 处置 ────────────────────────────────────────────────────────────
   侧栏按 `sort_order` 出（/v1/me 里 `ORDER BY m.sort_order`），
   前端把**去重后的前六项**平铺为主入口，其余收进默认折叠的「更多」
   （apps/web/src/shell/modules.ts 的 `PRIMARY`）。
   所以这条迁移只做两件事：**重排**，以及给 CRA **补三项**。

   CRA 补的三项都不会给他一个点了必错的按钮：
   `isf` 的写按 `isfWrite` 画（CRA 本来就有）；
   `ethics` 的两个写按钮按 `ethics` 动作画（CRA 没有，界面上不出现）。
   `feas` / `screen` 不删，排进「更多」。

   ── 不回填、不删除 ──────────────────────────────────────────────────
   0052 的做法是把两行整行重发 —— 那会把管理员在「组织与权限」里
   **勾掉的模块又加回来**。这里不这样做：
     · 已有的行只改 `sort_order`；
     · 目录之外的行（管理员自己加的）保留，排在目录之后，彼此顺序不变；
     · 新增只有 CRA 的那三项。
   ══════════════════════════════════════════════════════════════════════ */

CREATE OR REPLACE FUNCTION app.provision_tenant_roles(p_code text, p_name text)
  RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_tenant uuid;
  v_n      bigint;
BEGIN
  INSERT INTO tenant (code, name) VALUES (p_code, p_name)
  ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
  RETURNING id INTO v_tenant;

  WITH catalogue(code, name, is_external, row_rule, fields, actions, modules) AS (VALUES
    ('admin','系统管理员',            false, 'all',
     /* subject 不在这里 —— 理由见迁移 0046 文件头。要给，去「组织与权限」里给。 */
     ARRAY['cost','margin','price','staff']::text[],
     ARRAY['accept','advance','approve','assign','audit','bid','capaWrite','closeQ','closeQA',
           'ethics','isfWrite','manage','monitor','piConfirm','raiseQ','rateWrite',
           'subjRead','subjWrite','timeWrite']::text[],
     ARRAY['org','dash','sites','intake','enr','screen','client','cash',
           'feas','price','bid','change','staff','people','time','pnl','bill',
           'qa','mon','audit','capa','trail',
           'pm','team','approve','cra','mysites','crc','mysite','sched','subj','query',
           'startup','prescreen','ethics','handover','isf','material','pay',
           'dm','inst','instac','instqc','instreg','pi']::text[]),
    ('boss', '经营层',               false, 'all',
     ARRAY['cost','margin','price','staff']::text[],
     ARRAY['advance','approve','assign','bid','manage','rateWrite','subjRead','timeWrite']::text[],
     ARRAY['dash','intake','sites','enr','screen','client','cash','bid','change','staff','people','time','pnl','bill','qa','mon','price','org','trail']::text[]),
    ('pm',   '项目总监 PM',           false, 'team',
     ARRAY['cost','margin','price','subject']::text[],
     ARRAY['advance','approve','assign','bid','capaWrite','ethics','monitor','raiseQ','subjRead','subjWrite','timeWrite']::text[],
     ARRAY['pm','team','approve','intake','feas','sites','enr','screen','mon','change','staff','qa','pnl','trail']::text[]),
    /* CRA / CRC 这一版新增 `piConfirm` —— 他们本来就是唯一拿着那张
       签了字的纸的人。给了动作还要给得到入口：访视详情页（`sched`/`subj`
       进得去的那一页）上多一块「登记 PI 确认」，模块清单不用动。 */
    ('cra',  '临床监查员 CRA',         false, 'assigned',
     ARRAY['subject']::text[],
     ARRAY['advance','capaWrite','isfWrite','monitor','piConfirm','raiseQ','subjRead','timeWrite']::text[],
     /* 前六项是主入口（见文件头）。sched / isf / ethics 是 0054 补的。 */
     ARRAY['cra','sched','mon','mysites','query','capa',
           'isf','ethics','instac','material','time','qa','screen','feas','trail']::text[]),
    ('crc',  '临床协调员 CRC',         false, 'assigned',
     ARRAY['subject']::text[],
     ARRAY['advance','capaWrite','ethics','isfWrite','piConfirm','subjRead','subjWrite','timeWrite']::text[],
     ARRAY['crc','subj','sched','query','mysite','capa',
           'startup','prescreen','ethics','instac','handover','isf','material','pay','time']::text[]),
    ('dm',   '数据管理 DM',           false, 'all',
     ARRAY['subject']::text[],
     ARRAY['closeQ','raiseQ','subjRead']::text[],
     ARRAY['dm','query','screen','trail']::text[]),
    ('qa',   '质量保证 QA',           false, 'all',
     ARRAY['subject']::text[],
     ARRAY['audit','capaWrite','closeQA','raiseQ']::text[],
     ARRAY['audit','qa','screen','mon','trail']::text[]),
    ('inst', '机构办（外部）',           true,  'hospital',
     ARRAY['subject']::text[],
     ARRAY['accept','closeQA']::text[],
     /* **模块清单清空 —— 这是这条迁移的全部内容。**
        角色、动作、字段、行范围一个字没动：把模块勾回来，它立刻照旧能用。 */
     ARRAY[]::text[]),
    ('pi',   '研究者 PI（外部）',        true,  'pi',
     ARRAY['subject']::text[],
     ARRAY['piConfirm','subjRead']::text[],
     ARRAY[]::text[])
  ),
  ins AS (
    INSERT INTO role (tenant_id, code, name, is_external, row_rule)
    SELECT v_tenant, c.code, c.name, c.is_external, c.row_rule FROM catalogue c
    ON CONFLICT (tenant_id, code) DO UPDATE
      SET name = EXCLUDED.name,
          is_external = EXCLUDED.is_external,
          row_rule = EXCLUDED.row_rule
    RETURNING id, code
  ),
  f AS (
    INSERT INTO role_field (role_id, field_key, visible)
    SELECT ins.id, k.code, k.code = ANY(c.fields)
      FROM ins JOIN catalogue c ON c.code = ins.code CROSS JOIN field_key k
    ON CONFLICT (role_id, field_key) DO UPDATE SET visible = EXCLUDED.visible
    RETURNING 1
  ),
  a AS (
    INSERT INTO role_action (role_id, action_key, allowed)
    SELECT ins.id, k.code, k.code = ANY(c.actions)
      FROM ins JOIN catalogue c ON c.code = ins.code CROSS JOIN action_key k
    ON CONFLICT (role_id, action_key) DO UPDATE SET allowed = EXCLUDED.allowed
    RETURNING 1
  ),
  m AS (
    INSERT INTO role_module (role_id, module_key, sort_order)
    SELECT ins.id, x.key, (x.ord - 1)::smallint
      FROM ins JOIN catalogue c ON c.code = ins.code,
           LATERAL unnest(c.modules) WITH ORDINALITY AS x(key, ord)
    ON CONFLICT (role_id, module_key) DO UPDATE SET sort_order = EXCLUDED.sort_order
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM f;

  RETURN v_tenant;
END $$;

/* ── 现存租户 ──────────────────────────────────────────────────────── */

INSERT INTO role_module (role_id, module_key, sort_order)
SELECT r.id, x.key, 0
  FROM role r, unnest(ARRAY['sched', 'isf', 'ethics']) AS x(key)
 WHERE r.code = 'cra'
ON CONFLICT (role_id, module_key) DO NOTHING;

/* 在目录里的按目录排；不在的（管理员加的）排到 100 之后，保持原来的相对顺序。
   SET 右边读的是更新前的旧值，所以 `100 + m.sort_order` 是它原来的位次。 */
WITH cat(code, keys) AS (VALUES
  ('cra', ARRAY['cra','sched','mon','mysites','query','capa',
                     'isf','ethics','instac','material','time','qa','screen','feas','trail']),
  ('crc', ARRAY['crc','subj','sched','query','mysite','capa',
                     'startup','prescreen','ethics','instac','handover','isf','material','pay','time'])
)
UPDATE role_module m
   SET sort_order = coalesce(array_position(c.keys, m.module_key) - 1,
                             100 + m.sort_order)::smallint
  FROM role r JOIN cat c ON c.code = r.code
 WHERE m.role_id = r.id;

-- Down Migration
/* 只供本地迭代（规约 10）。那三项若是管理员在 0054 之前自己给过的，
   这里也会一并删掉 —— 本地库上可以接受。 */
DELETE FROM role_module
 WHERE module_key IN ('sched', 'isf', 'ethics')
   AND role_id IN (SELECT id FROM role WHERE code = 'cra');

WITH cat(code, keys) AS (VALUES
  ('cra', ARRAY['cra','mysites','mon','query','screen','feas',
                     'material','instac','time','qa','capa','trail']),
  ('crc', ARRAY['crc','mysite','startup','sched','subj','prescreen',
                     'ethics','instac','query','capa','isf','material',
                     'pay','handover','time'])
)
UPDATE role_module m
   SET sort_order = coalesce(array_position(c.keys, m.module_key) - 1,
                             100 + m.sort_order)::smallint
  FROM role r JOIN cat c ON c.code = r.code
 WHERE m.role_id = r.id;

/* provision_tenant_roles 不还原 —— 与 0046 / 0050 / 0051 / 0052 的 Down 同一个处理。 */
