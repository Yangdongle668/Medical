-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   系统管理员：第九个角色，和一个开箱就在的账号。

   ── 为什么原来的八个角色里没有一个能当管理员 ──────────────────────
   `boss`（经营层）拿着 `manage`，看上去够了。但它是**业务角色**：
   模块只有 19 个，`row_rule` 是 all 但字段里没有 subject，
   而且它代表"公司老板"这个人 —— 把系统管理挂在他名下，等于说
   "谁管钱谁管权限"。这两件事在一个多租户系统里不该是同一个人，
   在一次干净部署里更不该是**同一个尚不存在的人**。

   `admin` 是纯管理角色：45 个模块全给（这样管理员打开系统能看到
   全部界面，而不是只看到自己那一角），13 个动作全给，
   行范围 all。

   ── 唯独 subject（L3 受试者字段）默认不给 ─────────────────────────
   系统管理员管的是账号、角色、租户，不是受试者。默认给上，
   等于每一个新装的系统都有一个能读全部受试者筛选号的账号，
   而且没有任何一次操作记录说"是谁决定给的"。

   默认不给，不是因为管理员绕不过去 —— 他拿着 `manage`，
   在「组织与权限」里点两下就能给自己加上。**那两下会进审计轨迹**，
   而这正是全部的差别：不是拦住他，是让这件事留下时间和人。

   ── 出厂账号 admin / admin ────────────────────────────────────────
   口令弱到不能再弱，配套的报警见迁移 0025 的说明。
   这里只多说一句为什么放在**迁移**里而不是 seed 里：
   seed 只在 `deploy.sh --demo` 时才灌。一次正式部署不带 --demo，
   而"正式部署"恰恰是最需要有人能登进去的那一次。
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
     /* subject 不在这里 —— 理由见文件头。要给，去「组织与权限」里给。 */
     ARRAY['cost','margin','price','staff']::text[],
     ARRAY['advance','approve','bid','closeQ','closeQA','ethics','manage','piConfirm',
           'raiseQ','rateWrite','subjRead','subjWrite','timeWrite']::text[],
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

/* ── 出厂管理员 ─────────────────────────────────────────────────────
   幂等：已经有 admin 账号就什么都不做 —— 尤其**不重置口令**。
   开户函数会调它，而开户是可以重复执行的；
   在这里"顺手把口令设回出厂值"，等于给每一次重新开户配一把万能钥匙。 */
CREATE FUNCTION app.provision_admin_account(p_tenant uuid, p_hash text)
  RETURNS uuid
  LANGUAGE plpgsql VOLATILE SET search_path = public, app, pg_temp AS
$$
DECLARE v_account uuid; v_role uuid;
BEGIN
  SELECT id INTO v_role FROM role WHERE tenant_id = p_tenant AND code = 'admin';
  IF v_role IS NULL THEN
    RAISE EXCEPTION '租户 % 还没有 admin 角色 —— 先跑 app.provision_tenant_roles', p_tenant;
  END IF;

  SELECT id INTO v_account FROM account WHERE tenant_id = p_tenant AND login = 'admin';
  IF v_account IS NOT NULL THEN RETURN v_account; END IF;

  INSERT INTO account (tenant_id, login, display_name, role_id, joined_on)
  VALUES (p_tenant, 'admin', '系统管理员', v_role, current_date)
  RETURNING id INTO v_account;

  INSERT INTO auth_password (account_id, tenant_id, hash, is_initial)
  VALUES (v_account, p_tenant, p_hash, true);

  RETURN v_account;
END $$;
/* 0012 那句 COMMENT 说的是"八个标准角色"。COMMENT 是**当前状态**，
   不是历史记录 —— 留着的话，任何人在 psql 里查这个函数都会读到一个已经不对的数字。 */
COMMENT ON FUNCTION app.provision_tenant_roles(text, text) IS
  '开户物料：租户 + 九个标准角色（含系统管理员）及其行/列/动作/模块授予。幂等，可重复执行。';

COMMENT ON FUNCTION app.provision_admin_account(uuid, text) IS
  '出厂管理员。已存在则原样返回，**不重置口令** —— 开户可重复执行，
   顺手重置等于给每次重新开户配一把万能钥匙。';

/* ── 开户带上管理员 ────────────────────────────────────────────────
   出厂哈希写死在这里，而不是让调用方传：开户的人手上没有 scrypt，
   而"你自己算一个哈希传进来"是一条没人会走的路 —— 结果就是没人建管理员。
   口令是 admin，哈希是它的 scrypt 派生值，盐固定（口令都公开了，
   盐随机对它一点保护都没有，换来的是迁移在任何机器上跑出同一行）。 */
CREATE OR REPLACE FUNCTION app.provision_tenant(p_code text, p_name text)
  RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = public, app, pg_temp
AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := app.provision_tenant_roles(p_code, p_name);
  PERFORM app.provision_business_config(v_tenant);
  PERFORM app.provision_admin_account(v_tenant,
    'scrypt$16384$8$1$c2l0ZWRlc2stZmFjdG9yeQ$T3TdlA6M_GhqU-Ska4h5t9w0FjWOOghdeuexb4TgYzI');
  RETURN v_tenant;
END $$;

COMMENT ON FUNCTION app.provision_tenant(text, text) IS
  '开户：权限模型（provision_tenant_roles）+ 业务配置（provision_business_config）
   + 出厂管理员（provision_admin_account）。幂等：已有的模板、费率卡与口令都不会被覆盖。';

/* 已经开出来的租户补上 admin 角色与账号。
   provision_tenant_roles 是幂等的，重跑只是把目录再写一遍。 */
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT code, name FROM tenant LOOP
    PERFORM app.provision_tenant_roles(t.code, t.name);
    PERFORM app.provision_admin_account(
      (SELECT id FROM tenant WHERE code = t.code),
      'scrypt$16384$8$1$c2l0ZWRlc2stZmFjdG9yeQ$T3TdlA6M_GhqU-Ska4h5t9w0FjWOOghdeuexb4TgYzI');
  END LOOP;
END $$;

-- Down Migration
/* 顺序要紧：先把 provision_tenant 还原回 0024 那一版，再删它现在调的东西。
   反过来的话，单独回滚这一条会留下一个「调用不存在的函数」的开户流程 ——
   而它要到下一次真的开户才炸，那时没人会想起是这次回滚留下的。
   （0017 / 0018 / 0024 都在"回滚从半截状态开始"上栽过，这里按同样的写法防。） */
CREATE OR REPLACE FUNCTION app.provision_tenant(p_code text, p_name text)
  RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = public, app, pg_temp
AS $$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := app.provision_tenant_roles(p_code, p_name);
  PERFORM app.provision_business_config(v_tenant);
  RETURN v_tenant;
END $$;

DELETE FROM auth_password WHERE account_id IN (SELECT id FROM account WHERE login = 'admin');
DELETE FROM account WHERE login = 'admin';
DELETE FROM role_module WHERE role_id IN (SELECT id FROM role WHERE code = 'admin');
DELETE FROM role_action WHERE role_id IN (SELECT id FROM role WHERE code = 'admin');
DELETE FROM role_field  WHERE role_id IN (SELECT id FROM role WHERE code = 'admin');
DELETE FROM role WHERE code = 'admin';
DROP FUNCTION IF EXISTS app.provision_admin_account(uuid, text);
/* provision_tenant_roles 不还原：它多出来的那一行目录在 admin 角色被删掉之后
   是死代码，而把 0012 的函数体在这里再抄一遍，抄错的风险比留着它高。 */
