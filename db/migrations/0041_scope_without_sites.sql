-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   四条「只要有一个可见的中心」的策略，都答不出同一个问句。

   ── 症状 ────────────────────────────────────────────────────────────
   批准一份立项申请之后，项目档案建出来了（与批准在同一个事务里建，
   这一格没漏）。但在「中心可行性调查」里选不到它。在「中心建档」
   「立项受理递交」「合同变更」里同样选不到 —— 这四张表单第一栏
   都是「选项目」，而项目列表里没有它。

   ── 那个问句 ────────────────────────────────────────────────────────
     一个刚批下来、还一个中心都没有的项目，谁看得见？

   下面四条策略的范围都写成「存在一个我看得见的中心」，
   而 EXISTS 在空集上恒为假 —— 答案是"没有人"。于是

     项目要有中心才看得见，中心要先选中项目才建得出来。

   这是一个死锁，不是权限收紧：系统里永远只剩得下 seed 灌进去的项目。

     · study_scope        —— 项目本身
     · client_scope       —— 客户。listStudies 是 study JOIN client，
                             内连接，客户看不见时项目跟着从结果里消失，
                             **哪怕项目本身可见**
     · feasibility_scope  —— 可行性调查。用户卡住的正是这一页：
                             WITH CHECK 只管租户，登记得进去；
                             USING 管读取，登记完自己就看不见了
     · contract_change_scope —— 合同变更，同一形状

   `milestone` / `startup_item` 这类**挂在中心上**的表不在此列：
   它们的范围本来就由中心定义，没有中心就没有行，不存在死锁。

   ── 改的是 team 这一支 ──────────────────────────────────────────────
   `team_study` 的定义就是"本组承接的项目"，它挂在**项目**上，与中心
   无关（迁移 0004）。绕道 study_site 去问同一件事，在有中心时答案
   相同，在没有中心时答案是错的 —— 而"还没有中心"恰恰是项目组最
   需要看见它的那一段时间：**可行性调查是在建中心之前做的**，
   而 feas 模块正授予 pm。

   `row_rule = 'all'` 那一支本来就绕开了 EXISTS，所以数据库这一侧对
   管理员与经营层一直是对的；把他们也一起锁在外面的是应用层手写的
   那句 WHERE（site.service.ts 的 listStudies），它漏了这个短路 ——
   两处不一致时更严的那处赢。那一处一并在本次改掉。

   ── 为什么要写成 row_rule = 'team' AND …，而不是直接 OR 上去 ────────
   `app.current_team_id()` 不看行规则：CRA 也在组里。不加这个前置，
   assigned 规则的人会跟着看到本组全部项目与客户 —— 而 study 上有
   contract_amount_cents。范围规则是互斥的五选一，一支一支地答，
   才是它本来的形状。

   ── assigned / hospital / pi 保持原样 ──────────────────────────────
   这三条的范围本来就由中心定义（派工、本院、本人担任 PI）。一个还
   没有中心的项目对他们确实还不存在，这不是死锁：等中心建出来、
   派工下来，它自然出现。

   packages/policy/src/row.ts 的 canSeeStudy / studyScopeSql 是
   study_scope 的孪生实现，parity 测试穷举比对两者
   —— 且分母里特地放了一个没有中心的项目，否则这个 bug 一次也不显形。
   ══════════════════════════════════════════════════════════════════════ */

-- ── 项目 ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS study_scope ON study;
CREATE POLICY study_scope ON study FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.current_row_rule() = 'all'
      OR (app.current_row_rule() = 'team' AND EXISTS (
            SELECT 1 FROM team_study ts
             WHERE ts.study_id = study.id
               AND ts.team_id = app.current_team_id()))
      OR EXISTS (
            SELECT 1 FROM study_site s
             WHERE s.study_id = study.id
               AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))))
  WITH CHECK (tenant_id = app.current_tenant_id());

-- ── 客户 ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS client_scope ON client;
CREATE POLICY client_scope ON client FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND NOT app.current_is_external()
    AND (
      app.current_row_rule() = 'all'
      OR (app.current_row_rule() = 'team' AND EXISTS (
            SELECT 1 FROM study st JOIN team_study ts ON ts.study_id = st.id
             WHERE st.client_id = client.id
               AND ts.team_id = app.current_team_id()))
      OR EXISTS (
            SELECT 1 FROM study st JOIN study_site s ON s.study_id = st.id
             WHERE st.client_id = client.id
               AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))))
  WITH CHECK (
    tenant_id = app.current_tenant_id() AND NOT app.current_is_external());

-- ── 可行性调查 ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS feasibility_scope ON feasibility;
CREATE POLICY feasibility_scope ON feasibility FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND NOT app.current_is_external()
    AND (
      app.current_row_rule() = 'all'
      OR (app.current_row_rule() = 'team' AND EXISTS (
            SELECT 1 FROM team_study ts
             WHERE ts.study_id = feasibility.study_id
               AND ts.team_id = app.current_team_id()))
      OR EXISTS (
            SELECT 1 FROM study_site s
             WHERE s.study_id = feasibility.study_id
               AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))))
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND NOT app.current_is_external());

-- ── 合同变更 ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS contract_change_scope ON contract_change;
CREATE POLICY contract_change_scope ON contract_change FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND NOT app.current_is_external()
    AND (
      app.current_row_rule() = 'all'
      OR (app.current_row_rule() = 'team' AND EXISTS (
            SELECT 1 FROM team_study ts
             WHERE ts.study_id = contract_change.study_id
               AND ts.team_id = app.current_team_id()))
      OR EXISTS (
            SELECT 1 FROM study_site s
             WHERE s.study_id = contract_change.study_id
               AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))))
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND NOT app.current_is_external());

COMMENT ON TABLE team_study IS
  '本组承接的项目 —— row_rule=team 的唯一来源。由批准立项写入
   （intake.service.ts）：一个没有归属组的项目，项目组看不见它。';

-- Down Migration
DROP POLICY IF EXISTS contract_change_scope ON contract_change;
CREATE POLICY contract_change_scope ON contract_change FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND NOT app.current_is_external()
    AND (app.current_row_rule() = 'all' OR EXISTS (
      SELECT 1 FROM study_site s
       WHERE s.study_id = contract_change.study_id
         AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))))
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND NOT app.current_is_external());

DROP POLICY IF EXISTS feasibility_scope ON feasibility;
CREATE POLICY feasibility_scope ON feasibility FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND NOT app.current_is_external()
    AND (app.current_row_rule() = 'all' OR EXISTS (
      SELECT 1 FROM study_site s
       WHERE s.study_id = feasibility.study_id
         AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))))
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND NOT app.current_is_external());

DROP POLICY IF EXISTS client_scope ON client;
CREATE POLICY client_scope ON client FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND NOT app.current_is_external()
    AND (app.current_row_rule() = 'all' OR EXISTS (
      SELECT 1 FROM study st JOIN study_site s ON s.study_id = st.id
       WHERE st.client_id = client.id
         AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))))
  WITH CHECK (
    tenant_id = app.current_tenant_id() AND NOT app.current_is_external());

DROP POLICY IF EXISTS study_scope ON study;
CREATE POLICY study_scope ON study FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (app.current_row_rule() = 'all' OR EXISTS (
      SELECT 1 FROM study_site s
       WHERE s.study_id = study.id
         AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))))
  WITH CHECK (tenant_id = app.current_tenant_id());
