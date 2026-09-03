-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   第十五、十六个动作权限：`audit`（发起内部稽查）与 `capaWrite`（写整改措施）。

   ── 为什么是两个，不是一个 ────────────────────────────────────────
   它们是 CAPA 闭环的两端，而**两端不能是同一个人**：

     · `capaWrite` —— 写纠正与预防措施。写的人是**问题的责任人**：
       CRC、CRA、PM、QA 都可能是（原型的 ISSUES 里 own 就是这四种人）。
     · `audit` / `closeQA` —— 发起稽查、验证整改并关闭。只有 QA。

   写措施的人自己验证自己改完了，「已关闭」这三个字在核查时一文不值 ——
   这与数据质疑那条（回复的人不能自己关闭）是同一条规矩。

   ── 为什么 audit 不能借 closeQA ───────────────────────────────────
   `closeQA` 在**机构办**身上也有（他们要关自己提出的质量事件）。
   借它来发起内部稽查，等于让被稽查的一方能对我方发起内部稽查 ——
   而内部稽查的全部意义是"我方查自己"。

   ── 为什么 capaWrite 不能借 subjWrite ─────────────────────────────
   `subjWrite` 是受试者数据的写权限，PM 和 QA 都没有 ——
   而他们恰恰是 ISSUES 里出现最多的两类整改责任人。

   ── 开户目录只能整段重发 ──────────────────────────────────────────
   理由见迁移 0034。下面这一段与 0034 逐字相同，
   除了五个角色的动作数组各多了 'audit' / 'capaWrite'。
   同样是**用脚本从 0034 抄出来再改的**，不是手敲。
   ══════════════════════════════════════════════════════════════════════ */

INSERT INTO action_key (code, label) VALUES
  ('audit',     '发起内部稽查'),
  ('capaWrite', '写纠正与预防措施（CAPA）')
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
     ARRAY['advance','approve','audit','bid','capaWrite','closeQ','closeQA','ethics',
           'manage','monitor','piConfirm','raiseQ','rateWrite','subjRead','subjWrite',
           'timeWrite']::text[],
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
     ARRAY['capaWrite','monitor','raiseQ','subjRead','timeWrite']::text[],
     ARRAY['cra','mysites','mon','query','screen','feas','material','time','qa','capa','trail']::text[]),
    ('crc',  '临床协调员 CRC',         false, 'assigned',
     ARRAY['subject']::text[],
     ARRAY['capaWrite','ethics','subjRead','subjWrite','timeWrite']::text[],
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
     ARRAY['closeQA']::text[],
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

/* 现存租户的角色在这里直接补 —— 不补的话这两个动作对所有现存租户
   都是关的，而症状是"按钮不见了"，不是报错。 */
INSERT INTO role_action (role_id, action_key, allowed)
SELECT r.id, 'audit', r.code IN ('admin', 'qa') FROM role r
ON CONFLICT (role_id, action_key) DO UPDATE SET allowed = EXCLUDED.allowed;

INSERT INTO role_action (role_id, action_key, allowed)
SELECT r.id, 'capaWrite', r.code IN ('admin', 'qa', 'pm', 'cra', 'crc') FROM role r
ON CONFLICT (role_id, action_key) DO UPDATE SET allowed = EXCLUDED.allowed;

-- Down Migration
/* 开户目录里的两个代号不回滚 —— 理由与 0034 相同：
   动作键没了，目录数组里多出来的字符串是惰性的，
   为回滚它把 93 行目录再抄一遍，引入的转录风险比消除的大。 */
DELETE FROM role_action WHERE action_key IN ('audit', 'capaWrite');
DELETE FROM action_key  WHERE code       IN ('audit', 'capaWrite');
