-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   开一个租户 —— 把「新客户要什么」和「演示数据长什么样」分开。

   ── 之前是什么状况 ────────────────────────────────────────────────
   角色矩阵（role / role_field / role_action / role_module，共 224 行）
   躺在 `db/seeds/001_demo.sql` 里，和恒济那 20 个人、15 个中心、
   598 个受试者混在同一个文件、同一次执行。于是：

     开第二个租户 = 把演示数据也灌一遍，或者手抄 224 行 INSERT。

   而且抄不过去：角色主键是 `uuid5('role:' + code)`，**不含租户**。
   两个租户的 `crc` 会算出同一个 UUID，第二个租户在
   `role_pkey` 上直接冲突。**今天这个系统开不出第二个租户** ——
   不是"要多做点工作"，是插不进去。

   ── 现在 ──────────────────────────────────────────────────────────
   `app.provision_tenant(code, name)` 建租户 + 整套角色矩阵，返回租户 id。
   角色 id 由 `gen_random_uuid()` 现生成，天然不撞。
   演示数据留在 seed 里，按 `code` 反查角色，不再写死 UUID。

   ── 目录为什么写成"授予了什么"而不是逐行 INSERT ────────────────────
   `field_key` / `action_key` 是全局注册表（迁移维护，与租户无关），
   所以目录只需要说**哪些是给的**，其余按注册表补 false。
   这样一个角色能做什么，是三行数组，看得完；
   224 行 INSERT 里同样的事实要拼很久才看得出来 ——
   而权限矩阵恰恰是最需要「一眼看出来」的那种东西。

   注意 role_module 只收敛导航，**不是安全边界**；
   安全边界是行 × 列 × 动作那三维。这里一并开出来只是因为它同属开户物料。
   ══════════════════════════════════════════════════════════════════════ */

CREATE FUNCTION app.provision_tenant(p_code text, p_name text)
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
    ('boss', '经营层',               false, 'all',      
     ARRAY['cost','margin','price','staff']::text[],
     ARRAY['advance','approve','bid','manage','rateWrite','subjRead','timeWrite']::text[],
     ARRAY['dash','intake','sites','enr','screen','client','cash','bid','change','staff','people','time','pnl','bill','qa','mon','price','org','trail']::text[]),
    ('pm',   '项目总监 PM',           false, 'team',     
     ARRAY['cost','margin','price','subject']::text[],
     ARRAY['advance','approve','bid','ethics','raiseQ','subjRead','subjWrite','timeWrite']::text[],
     ARRAY['pm','team','approve','intake','feas','sites','enr','screen','mon','change','qa','pnl','trail']::text[]),
    ('cra',  '临床监查员 CRA',         false, 'assigned', 
     ARRAY['subject']::text[],
     ARRAY['raiseQ','subjRead','timeWrite']::text[],
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
    /* 重复开户是幂等的：名称与规则以目录为准，已有的角色 id 不动 ——
       动了的话，所有引用它的账号就跟着断了。 */
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
  /* 数据修改型 CTE 在 PostgreSQL 里**一定会执行到底**，与主查询读不读它无关；
     这里要个destination 只是因为 plpgsql 不接受没有去处的 SELECT。 */
  SELECT count(*) INTO v_n FROM f;

  RETURN v_tenant;
END $$;

COMMENT ON FUNCTION app.provision_tenant(text, text) IS
  '开户物料：租户 + 八个标准角色及其行/列/动作/模块授予。幂等，可重复执行。';

/* 演示租户在 0001 里就已经插进去了（那时还没有这个函数）。
   这里补齐它的角色矩阵 —— 于是 seed 只管演示数据，不再管权限模型。 */
SELECT app.provision_tenant('hengji', '恒济临床研究');

-- Down Migration
DROP FUNCTION IF EXISTS app.provision_tenant(text, text);
