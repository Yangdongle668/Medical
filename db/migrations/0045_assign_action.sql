-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   第十九个动作权限：`assign` —— 把人接到中心上。

   ── 0039 结尾那句话是错的 ──────────────────────────────────────────
   它写着「到此为止，动作权限共十八个……45 个模块全部有页面之后，
   没有新的动词了」。那句话的推理是「模块 ↔ 页面 ↔ 动词」，
   而它漏掉的东西正好不是一个模块：

     `site_assignment` 是行规则 `assigned` 的**唯一来源**
     （迁移 0002：「由 site_assignment 推导 —— CRA / CRC」），
     它没有自己的页面，因为它不是一片要看的数据，
     是**别人能看见什么**这件事本身。

   于是这张表从 0004 建起到现在，**全系统没有一处往里写**：
   种子灌了 30 行，`app.transfer_handover_assignments()` 在两个人之间
   挪行 —— 挪的是已经存在的那些。第一行从哪来，没有答案。

   ── 这不是理论上的缺口，它已经咬过一次 ────────────────────────────
   开发库的审计轨迹里躺着这一条：

     09-06 11:13  admin  调整角色权限  crc
                  rowRule: assigned → team     理由：「改为按组切行」

   把整个 CRC 角色的行规则从「被指派的中心」改成「本组的项目」——
   那不是一次配置，那是绕过。派不了工，就只好把门槛整个挪走：
   从此每个 CRC 看得到本组全部项目的全部中心，包括他从没去过的那些。
   **一个建不出来的东西，会被人用改规则的方式绕过去**，
   而绕过去之后没有任何地方是红的。

   ── 为什么是一个新动词，而不是借 manage ──────────────────────────
   `manage`（管理人员与权限）只有 admin 与 boss 有，PM 没有。
   而「这个中心归谁跑」正是 PM 每天在做的决定 —— 借 manage，
   派一次工要找系统管理员；这种流程在真实世界里的结局是
   「管理员账号全组共用」。

   借 `advance`（推进中心阶段）同样不行：QA 也在推进的链条上，
   而派工与质量岗无关。

   所以单开一个：admin / boss / pm。它管两件事，因为它们是同一件事 ——
   **把一个人接到一个中心上，从此他看得见它**：
     · `site_assignment` —— CRA / CRC 的 `assigned` 行范围
     · `study_site.pi_account_id` —— PI 的 `pi` 行范围

   PM 不在这两个范围里（他按 `team` 切行），所以派工不会扩大他自己
   看得到的东西 —— 它只扩大别人的。这一点下面那条策略要管住。
   ══════════════════════════════════════════════════════════════════════ */

INSERT INTO action_key (code, label) VALUES
  ('assign', '派工到中心 / 指定 PI')
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
SELECT r.id, 'assign', r.code IN ('admin', 'boss', 'pm') FROM role r
ON CONFLICT (role_id, action_key) DO UPDATE SET allowed = EXCLUDED.allowed;

/* ── 给了动作，还得给那一页 ────────────────────────────────────────
   PM 拿到了 `assign`，而「派工与产能」（module_key = `staff`）
   **不在他的模块清单里** —— admin 与 boss 有它，pm 没有。

   路由照通（前端的 BUILT 表按路径登记，不按角色），所以直接敲地址
   进得去；但侧栏上没有那一行。于是一个每天都在决定「这个中心归谁跑」
   的人，拿到了权限，找不到入口 —— 和这条迁移要修的那件事同一个形状，
   只是换了一层：那一层是「有页面没动作」，这一层是「有动作没页面」。

   ── 为什么**整份重发**，而不是往末尾追加一行 ──────────────────────
   第一版是 `sort_order = max(...) + 1`，理由是"侧栏按组重排（navFor），
   落在哪个数字上不影响显示"。显示上确实不影响，但它把已有租户和
   **新开的租户**排出了两种顺序：

     现有租户（追加）  … change:9, qa:10,   pnl:11, trail:12, staff:13
     新开租户（目录）  … change:9, staff:10, qa:11,  pnl:12,  trail:13

   `db/test/tenant.test.js` 当场红了 ——「新租户的行/列/动作/模块授予
   与演示租户逐条一致」。那条断言写着它自己的理由：
   **两个租户拿到的必须是同一套权限模型，否则每开一户就是一次手抄。**

   所以这里照着上面 catalogue 里那一串重发一遍，顺序一模一样。
   两处各写一份是有代价的，而代价由那条测试兜着：数组一旦对不上，
   它就是红的。 */
INSERT INTO role_module (role_id, module_key, sort_order)
SELECT r.id, x.key, (x.ord - 1)::smallint
  FROM role r,
       LATERAL unnest(ARRAY['pm','team','approve','intake','feas','sites','enr',
                            'screen','mon','change','staff','qa','pnl','trail'])
         WITH ORDINALITY AS x(key, ord)
 WHERE r.code = 'pm'
ON CONFLICT (role_id, module_key) DO UPDATE SET sort_order = EXCLUDED.sort_order;

/* ══════════════════════════════════════════════════════════════════════
   顺手补上一个在「没人写这张表」的年代看不出来的洞。

   `site_assignment_scope`（迁移 0005）的 WITH CHECK 只写了一句
   `tenant_id = app.current_tenant_id()` —— 也就是说，**只要同租户，
   谁都能往这张表里写任何一行**。读那一侧收得很紧（看得到中心，
   或者这行是自己的），写那一侧等于没有。

   在开发库上实测过（PM hanxue 属 G-01）：

     SELECT code FROM study_site WHERE id = '…SS-09…'   → 0 行（看不到）
     INSERT INTO site_assignment (…同一个 SS-09…)        → INSERT 0 1

   看不见的中心，照样能把别人派上去。而 `site_assignment` 就是
   `assigned` 行范围本身 —— 这一句的意思是「把一个我自己都看不到的中心，
   给了另一个人去看」。在此之前没有端点写这张表，所以它一直没有发作；
   现在要开写端点了，**先把 WITH CHECK 补齐再开**。

   补法与 `study_site_scope` 一致：写进去的那一行，它的中心必须在
   写入者的行范围内。`app.site_visible` 是那五条规则的唯一实现，
   这里直接调它 —— 不另写一份判定。

   `account_id = app.current_account_id()` 那一支**不进 WITH CHECK**：
   读那一侧留着它是对的（我要看得到自己的派工，哪怕中心已经不在范围里），
   写那一侧留着它就是「谁都能把自己派到任何一个中心上」——
   一条自助的提权通道。

   `app.transfer_handover_assignments()` 不受影响：它是 SECURITY DEFINER，
   以表的属主身份跑，而表没有 FORCE ROW LEVEL SECURITY —— 属主绕开策略。
   交接照旧能把派工转给一个此刻还看不见那些中心的接手人，
   那正是它当初被收进函数的原因（迁移 0011）。
   ══════════════════════════════════════════════════════════════════════ */
DROP POLICY IF EXISTS site_assignment_scope ON site_assignment;
CREATE POLICY site_assignment_scope ON site_assignment FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (account_id = app.current_account_id() OR EXISTS (
      SELECT 1 FROM study_site s
       WHERE s.id = site_assignment.study_site_id
         AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))))
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM study_site s
       WHERE s.id = site_assignment.study_site_id
         AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id)));

COMMENT ON TABLE site_assignment IS
  '行规则 assigned 的唯一来源：谁被派到哪个中心、从哪天到哪天。
   写它就是在给别人开可见范围，所以 WITH CHECK 要求目标中心在写入者的行范围内 ——
   读那一侧放行「这行是我自己的」，写那一侧不放行，否则谁都能把自己派到任何中心上。';

-- Down Migration
/* 开户目录里的代号不回滚 —— 理由与 0034 / 0036 / 0039 相同：
   动作键没了，目录数组里多出来的字符串是惰性的。 */
DELETE FROM role_action WHERE action_key = 'assign';
DELETE FROM action_key  WHERE code       = 'assign';
/* 模块那一行要回滚（动作键不回滚，理由见上）：它不是惰性的 ——
   留着的话，回滚之后 PM 的侧栏上挂着一页他没有动作权限的「派工与产能」。 */
DELETE FROM role_module WHERE module_key = 'staff'
   AND role_id IN (SELECT id FROM role WHERE code = 'pm');

DROP POLICY IF EXISTS site_assignment_scope ON site_assignment;
CREATE POLICY site_assignment_scope ON site_assignment FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (account_id = app.current_account_id() OR EXISTS (
      SELECT 1 FROM study_site s
       WHERE s.id = site_assignment.study_site_id
         AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))))
  WITH CHECK (tenant_id = app.current_tenant_id());
