-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   第十四个动作权限：`monitor`（排监查访视、提交监查报告）。

   ── 为什么不能借用一个现成的 ──────────────────────────────────────
   排监查是 CRA 与 PM 的活。找遍已有的十三个动作，没有一个对得上：

     · `timeWrite`  CRC 也有 —— 借它等于让 CRC 能给自己排监查；
     · `advance`    是推进中心状态的，CRA 根本没有；
     · `approve`    是审批别人提交的东西，方向反了。

   借一个"差不多"的动作，代价不是写起来别扭，是**权限矩阵从此说谎** ——
   「谁能排监查」这个问题在库里查不出答案，而它是一个组织问题，
   不是一个实现细节。

   ── 动作权限清单必须三处一致 ──────────────────────────────────────
   `action_key` 表、`packages/contracts` 的 ACTION_KEYS、开户目录。
   这份清单曾经落后过五个动作，症状是"权限管理界面少了五行，
   而不是报错"（见 kernel/actions.ts 的注释）。db/test 双向断言钉住。

   ── 开户目录只能整段重发 ──────────────────────────────────────────
   `role_action` 是 `CROSS JOIN action_key` 灌出来的，
   `allowed = 该动作是否列在目录里`。所以新加一个动作而不改目录，
   结果是**所有角色都拿不到它**，包括管理员。
   目录写在函数体里，只能 CREATE OR REPLACE 整段重发 ——
   下面这一段与迁移 0026 逐字相同，除了三个角色的动作数组各多了 'monitor'。
   ══════════════════════════════════════════════════════════════════════ */

INSERT INTO action_key (code, label) VALUES
  ('monitor', '排监查访视与提交监查报告')
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
     ARRAY['advance','approve','bid','closeQ','closeQA','ethics','manage','monitor',
           'piConfirm','raiseQ','rateWrite','subjRead','subjWrite','timeWrite']::text[],
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
     ARRAY['advance','approve','bid','ethics','monitor','raiseQ','subjRead','subjWrite','timeWrite']::text[],
     ARRAY['pm','team','approve','intake','feas','sites','enr','screen','mon','change','qa','pnl','trail']::text[]),
    ('cra',  '临床监查员 CRA',         false, 'assigned',
     ARRAY['subject']::text[],
     ARRAY['monitor','raiseQ','subjRead','timeWrite']::text[],
     ARRAY['cra','mysites','mon','query','screen','feas','material','time','qa','capa','trail']::text[]),
    ('crc',  '临床协调员 CRC',         false, 'assigned',
     ARRAY['subject']::text[],
     ARRAY['ethics','subjRead','subjWrite','timeWrite']::text[],
     ARRAY['crc','mysite','startup','sched','subj','prescreen','ethics','query','capa','isf','material','pay','handover','time']::text[]),
    ('dm',   '数据管理 DM',           false, 'all',
     ARRAY['subject']::text[],
     ARRAY['closeQ','raiseQ','subjRead']::text[],
     ARRAY['dm','query','screen','trail']::text[]),
    ('qa',   '质量保证 QA',           false, 'all',
     ARRAY['subject']::text[],
     ARRAY['closeQA','raiseQ']::text[],
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

/* 已经开出来的租户不会自动重跑开户函数 —— 现有角色在这里直接补。
   不补的话，这个动作对**所有现存租户**都是关的，
   而症状是"按钮不见了"，不是报错。 */
INSERT INTO role_action (role_id, action_key, allowed)
SELECT r.id, 'monitor', r.code IN ('admin', 'pm', 'cra')
  FROM role r
ON CONFLICT (role_id, action_key) DO UPDATE
  SET allowed = EXCLUDED.allowed;

-- Down Migration
/* 开户目录里的 'monitor' **不回滚**：目录是一个字符串数组，
   `role_action` 靠 `CROSS JOIN action_key` 生成，
   动作键没了，数组里多出来的那个代号就不会产生任何一行 —— 它是惰性的。
   为了回滚一个惰性字符串而把 93 行目录再抄一遍回去，
   引入的转录风险比它消除的大。 */
DELETE FROM role_action WHERE action_key = 'monitor';
DELETE FROM action_key  WHERE code = 'monitor';
