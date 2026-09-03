-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   第十七、十八个动作权限：`accept`（机构受理）与 `isfWrite`（维护中心文件）。

   ── accept 是**外部方唯一的一个写动作** ────────────────────────────
   到这一版为止，机构办手里只有 `closeQA`（关闭它自己提出的质量事件）。
   受理不一样：**它是医院对我方的一次准入决定**，
   而这个系统里"谁能代表医院受理一个项目"此前根本无处表达。

   借 `closeQA` 是不行的：QA 也有它 —— 借了等于我方的质量岗
   能替医院受理自己递上去的材料。

   ── isfWrite 为什么不借 subjWrite ─────────────────────────────────
   `subjWrite` 是受试者数据的写权限，而 CRA 没有它 ——
   但 ISF 完整性检查恰恰是每次监查的必查项（见监查跟进项模板）。
   借它，CRA 现场发现文件夹缺件却改不动台账。

   ── 到此为止，动作权限共十八个 ────────────────────────────────────
   这是最后两个：45 个模块全部有页面之后，没有新的动词了。
   ══════════════════════════════════════════════════════════════════════ */

INSERT INTO action_key (code, label) VALUES
  ('accept',   '机构受理立项材料'),
  ('isfWrite', '维护中心文件与物资台账')
ON CONFLICT (code) DO NOTHING;

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
     /* subject 不在这里 —— 理由见文件头。要给，去「组织与权限」里给。 */
     ARRAY['cost','margin','price','staff']::text[],
     ARRAY['accept','advance','approve','audit','bid','capaWrite','closeQ','closeQA',
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
     ARRAY['advance','approve','bid','manage','rateWrite','subjRead','timeWrite']::text[],
     ARRAY['dash','intake','sites','enr','screen','client','cash','bid','change','staff','people','time','pnl','bill','qa','mon','price','org','trail']::text[]),
    ('pm',   '项目总监 PM',           false, 'team',
     ARRAY['cost','margin','price','subject']::text[],
     ARRAY['advance','approve','bid','capaWrite','ethics','monitor','raiseQ','subjRead','subjWrite','timeWrite']::text[],
     ARRAY['pm','team','approve','intake','feas','sites','enr','screen','mon','change','qa','pnl','trail']::text[]),
    ('cra',  '临床监查员 CRA',         false, 'assigned',
     ARRAY['subject']::text[],
     ARRAY['capaWrite','isfWrite','monitor','raiseQ','subjRead','timeWrite']::text[],
     ARRAY['cra','mysites','mon','query','screen','feas','material','time','qa','capa','trail']::text[]),
    ('crc',  '临床协调员 CRC',         false, 'assigned',
     ARRAY['subject']::text[],
     ARRAY['capaWrite','ethics','isfWrite','subjRead','subjWrite','timeWrite']::text[],
     ARRAY['crc','mysite','startup','sched','subj','prescreen','ethics','query','capa','isf','material','pay','handover','time']::text[]),
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
     ARRAY['inst','instac','instqc','instreg']::text[]),
    ('pi',   '研究者 PI（外部）',        true,  'pi',
     ARRAY['subject']::text[],
     ARRAY['piConfirm','subjRead']::text[],
     ARRAY['pi','qa']::text[])
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

/* 现存租户的角色在这里直接补。 */
INSERT INTO role_action (role_id, action_key, allowed)
SELECT r.id, 'accept', r.code IN ('admin', 'inst') FROM role r
ON CONFLICT (role_id, action_key) DO UPDATE SET allowed = EXCLUDED.allowed;

INSERT INTO role_action (role_id, action_key, allowed)
SELECT r.id, 'isfWrite', r.code IN ('admin', 'crc', 'cra') FROM role r
ON CONFLICT (role_id, action_key) DO UPDATE SET allowed = EXCLUDED.allowed;

-- Down Migration
/* 开户目录里的两个代号不回滚 —— 理由与 0034 / 0036 相同：
   动作键没了，目录数组里多出来的字符串是惰性的。 */
DELETE FROM role_action WHERE action_key IN ('accept', 'isfWrite');
DELETE FROM action_key  WHERE code       IN ('accept', 'isfWrite');
