-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   立项受理那一页给 CRC / CRA —— 闸门叫他们去的地方，他们得进得去。

   ── 现场报来的原话 ──────────────────────────────────────────────────
   CRC 在中心详情页递交完立项材料，闸门上换成这一句：

     「AC-2026-004 还没登记《立项受理意见函》—— 拿到之后在受理台账上
       登记收到日期」

   然后：**「CRC 在受理台账找不到对应的入口」。**

   ── 为什么找不到 ────────────────────────────────────────────────────
   受理台账是模块 `instac`（路径 /inst/intake），而它在目录里只给了
   `admin` 与外部的 `inst`。CRC 的模块清单里从来没有它。

   这是前两步留下的一条缝：
     · 0046 把 `advance` 给了 CRA / CRC —— 递交立项材料成了一线的活；
     · 0048 / 0050 把受理改成登记制 —— 那张纸由一线登记；
     · 0051 把外部角色关掉 —— 机构办不再登录这套系统。

   三步走完，这条流程**整条都是一线的**，只有那一页还挂在机构办名下。
   于是系统对 CRC 说「去受理台账」，而他的侧栏上没有受理台账。
   一句指向不存在的入口的提示，比不给提示更糟：他会以为是自己没找到。

   ── 只给这一页，不给另外三页 ────────────────────────────────────────
   `inst`（机构工作台）、`instqc`（机构质控）、`instreg`（人员备案）
   **一页都不给**：那三页是院方视角的，与一线无关。

   页面上的「予以受理」按钮不用管 —— 它按 `accept` 动作画，
   而 CRC / CRA 没有那个动作（`accept` 仍然只有 admin 与 inst 持有）。
   他们在那一页上看得到的是自己递的那几条，以及「登记受理意向函」。
   行范围也照旧：`assigned` 的人只看得到自己中心上的那些。

   分组仍然留在「机构办公室」下 —— 那是原型冻结的分组
   （prototype/parts/04-nav.html 的 MOD_GROUP），这条迁移不动它。
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
     ARRAY['cra','mysites','mon','query','screen','feas','material','instac','time','qa','capa','trail']::text[]),
    ('crc',  '临床协调员 CRC',         false, 'assigned',
     ARRAY['subject']::text[],
     ARRAY['advance','capaWrite','ethics','isfWrite','piConfirm','subjRead','subjWrite','timeWrite']::text[],
     ARRAY['crc','mysite','startup','sched','subj','prescreen','ethics','instac','query','capa','isf','material','pay','handover','time']::text[]),
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

/* 现存租户直接补。`sort_order` 与目录里的位置对齐 —— 侧栏按它排，
   插在中间的话后面每一项都要往后挪一位，所以整两行重发最省事。 */
INSERT INTO role_module (role_id, module_key, sort_order)
SELECT r.id, x.key, (x.ord - 1)::smallint
  FROM role r,
       LATERAL unnest(CASE r.code
         WHEN 'cra' THEN ARRAY['cra','mysites','mon','query','screen','feas',
                               'material','instac','time','qa','capa','trail']
         WHEN 'crc' THEN ARRAY['crc','mysite','startup','sched','subj','prescreen',
                               'ethics','instac','query','capa','isf','material',
                               'pay','handover','time']
       END) WITH ORDINALITY AS x(key, ord)
 WHERE r.code IN ('cra', 'crc')
ON CONFLICT (role_id, module_key) DO UPDATE SET sort_order = EXCLUDED.sort_order;

-- Down Migration
DELETE FROM role_module
 WHERE module_key = 'instac'
   AND role_id IN (SELECT id FROM role WHERE code IN ('cra', 'crc'));

/* 删掉之后要把剩下那些的 sort_order 补回去 —— 中间挖掉一项，
   后面每一项的序号都比目录大一，侧栏顺序会整体错位。 */
INSERT INTO role_module (role_id, module_key, sort_order)
SELECT r.id, x.key, (x.ord - 1)::smallint
  FROM role r,
       LATERAL unnest(CASE r.code
         WHEN 'cra' THEN ARRAY['cra','mysites','mon','query','screen','feas',
                               'material','time','qa','capa','trail']
         WHEN 'crc' THEN ARRAY['crc','mysite','startup','sched','subj','prescreen',
                               'ethics','query','capa','isf','material',
                               'pay','handover','time']
       END) WITH ORDINALITY AS x(key, ord)
 WHERE r.code IN ('cra', 'crc')
ON CONFLICT (role_id, module_key) DO UPDATE SET sort_order = EXCLUDED.sort_order;

/* provision_tenant_roles 不还原 —— 与 0046 / 0050 / 0051 的 Down 同一个处理。 */
