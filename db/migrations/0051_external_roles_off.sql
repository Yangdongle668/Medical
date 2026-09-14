-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   外部角色降级为「默认不开」。

   ── 这一步在收尾，不是在动刀 ────────────────────────────────────────
   前面两条迁移（0048 立项受理、0050 PI 确认）把两条流程从「等院外的人
   在本系统里点一下」改成了「由院内的人带着日期登记进来」。改完之后，
   机构办与研究者在这套系统里**已经没有必须做的事了**。

   但那四页还挂在他们的侧栏上，账号也还在。于是系统在两件事上继续撒谎：
   一是它看起来仍然需要院方登录才转得动，二是任何人翻开「组织与权限」
   都会以为"我们是要给医院开账号的"。**而这套系统的默认假设恰恰相反。**

   ── 只清模块，不动别的 ──────────────────────────────────────────────
   `inst` 与 `pi` 两个角色的**模块清单清空** —— 角色还在，行范围、字段、
   动作一个字没改。也就是说：

     · 侧栏上没有任何入口（`role_module` 是导航的唯一来源）；
     · 那四页的代码、路由、端点**全部留在仓库里**；
     · 哪天真要给某家医院开账号，去「组织与权限」把模块勾回来就行 ——
       不用改代码、不用再发一版。

   为什么不是删：删掉省下的只有仓库体积，而"默认不开"已经拿到了全部的
   日常收益。反过来，删了再要就得重写 —— 而"某家医院的机构办愿意用系统"
   是一件会发生的事，只是不该是默认。

   `accept` 动作仍然只有 admin 与 inst 持有 —— 这是有意的：
   db/test/constraints.test.js 那条「每个动作至少被一个角色持有」还得成立，
   而更要紧的是，把 `accept` 挪给内部角色等于让我方替医院受理自己递上去的
   材料。一线走的是 0048 那条登记路（`submitSiteAcceptance` +
   `recordAcceptanceLetter`，动作是 `advance`），与 `accept` 两条路。

   ── 演示账号保留 ────────────────────────────────────────────────────
   `zhanghm`（机构办）与 `chenguod`（PI）不删。删了要一起改 e2e 里
   七个文件二十多条用例，而它们盯的是那四页本身还能不能打开 ——
   那件事这条迁移一点没变，**页面照旧打得开，只是侧栏上没有入口**
   （模块从来只收敛导航，不是安全边界，见 apps/web/src/shell/modules.ts）。
   chenguod 还是 SS-01 的 PI，他自己点确认那条路也照旧。
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
     ARRAY['cra','mysites','mon','query','screen','feas','material','time','qa','capa','trail']::text[]),
    ('crc',  '临床协调员 CRC',         false, 'assigned',
     ARRAY['subject']::text[],
     ARRAY['advance','capaWrite','ethics','isfWrite','piConfirm','subjRead','subjWrite','timeWrite']::text[],
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

/* ── 现存租户 ────────────────────────────────────────────────────────
   上面那个函数只管**新开的**租户。已经开出来的（演示租户就是一个）
   要在这里直接删 —— `provision_tenant_roles` 里的 role_module 是
   `INSERT ... ON CONFLICT DO UPDATE`，它加得了行、删不掉行。

   两边必须得出同一个结果：db/test/tenant.test.js 那条
   「新租户与演示租户逐条一致」就是钉这件事的，0045 在它上面栽过一次。 */
DELETE FROM role_module
 WHERE role_id IN (SELECT id FROM role WHERE code IN ('inst', 'pi'));

-- Down Migration
/* 把两个角色的模块清单原样放回去。**按目录写死，不靠"记住删了什么"** ——
   删的时候没有留副本，而这四页一页都没动过，抄回来就是抄回原样。
   `sort_order` 与 provision_tenant_roles 里一致（从 0 开始）。 */
INSERT INTO role_module (role_id, module_key, sort_order)
SELECT r.id, x.key, (x.ord - 1)::smallint
  FROM role r,
       LATERAL unnest(CASE r.code
         WHEN 'inst' THEN ARRAY['inst','instac','instqc','instreg']
         WHEN 'pi'   THEN ARRAY['pi','qa']
       END) WITH ORDINALITY AS x(key, ord)
 WHERE r.code IN ('inst', 'pi')
ON CONFLICT (role_id, module_key) DO UPDATE SET sort_order = EXCLUDED.sort_order;

/* provision_tenant_roles 不还原 —— 与 0046 / 0050 的 Down 同一个处理：
   把上一版的函数体在这里再抄一遍，抄错的风险比留着它高。
   而上面那条 INSERT 已经让现存租户回到了原样。 */
