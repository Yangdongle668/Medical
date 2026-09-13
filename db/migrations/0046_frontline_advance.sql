-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   `advance` 给 CRA 与 CRC —— 递交材料与推进阶段是一线的活，不是管理员的。

   ── 起因 ────────────────────────────────────────────────────────────
   「递交立项材料」（submitSiteAcceptance）的门是 `advance`，而 `advance`
   此前只有 admin / boss / pm 有。于是一条真实的路走不通：

     CRC 被派到某个中心 → 打开中心详情 → 闸门上写着「还没递交立项材料」
     → **而那张表不出现**（界面按 `advance` 决定给不给它）

   他看得见缺口、看得见这是他的活，就是交不上去 —— 得去找管理员代交。
   这类流程在真实世界里的结局有两个，都不好：材料在微信里流转，
   或者管理员账号全组共用。

   ── 这个动作**管两件事**，所以要把第二件说清楚 ──────────────────────
   `action: "advance"` 挂在两个端点上：

     · `POST /v1/site-acceptances`        递交立项材料   ← 起因是它
     · `POST /v1/study-sites/{id}:advance` 推进中心阶段

   所以这一条同时把**中心状态机的推进**交给了 CRA / CRC。这不是副作用，
   是一个应当说出口的决定：知道伦理递交出去了、批件拿到了、SIV 开完了的，
   本来就是现场那个人。管理员替他点那一下，点的是一件他没在场的事。

   ── 放开的是「谁来点」，不是「点了算数」 ────────────────────────────
   真正把关的三样一个没动：

     · **闸门**（gate.ts）—— 推进到 siv 要启动清单的阻塞项清零，
       推进到 closed 要七项前置全部满足。条件不满足时返回 422，
       逐条列出还差什么，谁点都一样拦。
     · **必填原因 + 审计**（SENSITIVE_ACTIONS 里的 advanceStudySite）——
       每一次推进都写下是谁、为什么，核查第一屏看得见。
     · **行范围** —— CRA / CRC 按「被指派的中心」切行，
       他们推得动的只有自己名下那几个。

   换句话说：这一条改的是"轮不轮得到你点"，没有改"点了算不算数"。

   ── 为什么不拆成两个动作 ────────────────────────────────────────────
   拆出一个只管递交的 `submit`，就得回答「谁有 submit 而没有 advance」——
   而现实里那个人不存在：能递交立项材料的人，正是知道这个中心走到哪一步的人。
   一个从来不会被单独授予的动作，只是一列没人勾的格子。
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
     /* `staff`（派工与产能）是这一版新给 PM 的一页 —— 理由在下面那段：
        给了动作不给页面，等于没给。 */
     ARRAY['pm','team','approve','intake','feas','sites','enr','screen','mon','change','staff','qa','pnl','trail']::text[]),
    ('cra',  '临床监查员 CRA',         false, 'assigned',
     ARRAY['subject']::text[],
     ARRAY['advance','capaWrite','isfWrite','monitor','raiseQ','subjRead','timeWrite']::text[],
     ARRAY['cra','mysites','mon','query','screen','feas','material','time','qa','capa','trail']::text[]),
    ('crc',  '临床协调员 CRC',         false, 'assigned',
     ARRAY['subject']::text[],
     ARRAY['advance','capaWrite','ethics','isfWrite','subjRead','subjWrite','timeWrite']::text[],
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

/* 现存租户的角色在这里直接补。
   **五个角色一起重发**，不是只写 cra / crc 两行：`allowed` 那一栏是
   按目录整体成立的，只改两行的话，将来有人在界面上给 qa 勾过 advance，
   这条迁移就悄悄把它留下了 —— 而新开的租户没有。两个租户拿到的
   必须是同一套权限模型（db/test/tenant.test.js 钉着这一条）。 */
INSERT INTO role_action (role_id, action_key, allowed)
SELECT r.id, 'advance', r.code IN ('admin', 'boss', 'pm', 'cra', 'crc') FROM role r
ON CONFLICT (role_id, action_key) DO UPDATE SET allowed = EXCLUDED.allowed;

-- Down Migration
/* 收回给一线的那两个，其余不动。 */
INSERT INTO role_action (role_id, action_key, allowed)
SELECT r.id, 'advance', r.code IN ('admin', 'boss', 'pm') FROM role r
ON CONFLICT (role_id, action_key) DO UPDATE SET allowed = EXCLUDED.allowed;
