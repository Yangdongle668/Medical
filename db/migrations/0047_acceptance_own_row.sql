-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   递交立项材料返回 500 —— 一线永远递不出去。

   ── 症状 ────────────────────────────────────────────────────────────
     POST /v1/site-acceptances → 500 Internal Server Error

   服务端日志里那一句是：

     new row violates row-level security policy for table "site_acceptance"

   RLS 拒绝不是 ProblemException，落到兜底分支就是 500 ——
   于是界面上那句话是"服务坏了"，而它其实是"你没资格写这一行"。

   ── 为什么，以及为什么它是**必然**而不是偶发 ──────────────────────
   `site_acceptance_scope`（迁移 0038）两侧都调

     app.site_visible(study_site_id, study_id, hospital, NULL)

   而**递交发生在建档之前**：这一行插进去时 `study_site_id` 是 NULL
   （0038 自己在那一列上写着「建档之后回填」）。再看 `app.site_visible`
   的 assigned 那一支（迁移 0005）：

     WHEN 'assigned' THEN EXISTS (
       SELECT 1 FROM site_assignment sa WHERE sa.study_site_id = p_site_id …)

   `p_site_id` 是 NULL，`= NULL` 永不为真 —— 所以行规则为 `assigned`
   的人（CRA / CRC）**一次都插不进去**。不是"有时候不行"，是从来不行。

   开发库上实测：

     CRA linmin  → ERROR: new row violates row-level security policy
     CRC wutong（被改成 team，且有组）→ 通过（撞的是别的唯一约束）

   在 `advance` 只有 admin / boss / pm 的年代这个洞碰不到 —— 动作权限
   先挡下了。迁移 0046 把 `advance` 给了一线，它当天就发作了。

   ── 补法：本人递交的那一行，本人写得进、看得见 ──────────────────────
   「递交」这个动作的对象就是一件**还不存在的事**：那家医院在我方台账里
   还没有中心。拿"你看不看得见那个中心"去判"你能不能记下你刚做的事"，
   问的不是同一个问题。

   所以两侧各加一支 `submitted_by = app.current_account_id()`：
   **你自己递交的那一份，你写得进去，也读得回来。**

   读那一侧同样要加 —— 否则插进去之后紧接着的那次回读（服务层要把
   刚建的那行装配成响应）会查回 0 行，变成一个同样说不清的 404。

   放宽的边界有多大，值得说清：它**只多放行"自己经手的那一行"**。
   别人递交的、别的项目的，照旧由 `app.site_visible` 判 ——
   机构办仍然只看得到本院的，PM 仍然只看得到本组的。
   而"自己做过的事自己看得见"本来就是审计的起点。
   ══════════════════════════════════════════════════════════════════════ */

DROP POLICY IF EXISTS site_acceptance_scope ON site_acceptance;
CREATE POLICY site_acceptance_scope ON site_acceptance FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND (site_acceptance.submitted_by = app.current_account_id()
              OR app.site_visible(site_acceptance.study_site_id,
                                  site_acceptance.study_id,
                                  site_acceptance.hospital, NULL)))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND (site_acceptance.submitted_by = app.current_account_id()
                   OR app.site_visible(site_acceptance.study_site_id,
                                       site_acceptance.study_id,
                                       site_acceptance.hospital, NULL)));

COMMENT ON TABLE site_acceptance IS
  '立项受理：递给医院机构办的那一份材料的存根。**递交发生在建档之前**，
   所以 study_site_id 可空，而行策略不能只按「看不看得见那个中心」判 ——
   那样行规则为 assigned 的人一次都递不出去。两侧都放行「自己递交的那一行」。';

-- Down Migration
DROP POLICY IF EXISTS site_acceptance_scope ON site_acceptance;
CREATE POLICY site_acceptance_scope ON site_acceptance FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND app.site_visible(site_acceptance.study_site_id,
                              site_acceptance.study_id,
                              site_acceptance.hospital, NULL))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.site_visible(site_acceptance.study_site_id,
                                   site_acceptance.study_id,
                                   site_acceptance.hospital, NULL));
