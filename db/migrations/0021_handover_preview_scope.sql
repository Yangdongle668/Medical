-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   交接期间，接手人看得到那几个中心（欠账 E1）。

   ── 问题 ──────────────────────────────────────────────────────────
   交接清单里最要命的一项是「在组受试者逐例交底（含联系方式与依从性）」：
   哪个依从性差、哪个家属有顾虑、哪个只能周三来 —— 这些不在 EDC 里，
   只在上一个 CRC 脑子里。

   而在此之前，**接手人在交接完成之前看不到那些中心的任何东西**：
   `site_assignment` 要等 `:complete` 那一刻才转过去。于是"逐例交底"
   只能靠上一个 CRC 当面讲，而接手人连一张名单都对不上 ——
   他勾"已确认"的时候，确认的是自己听懂了，不是自己核对过。

   ── 这不是"放宽权限"，是把权限对准真实的工作 ──────────────────────
   三条边界，缺一条这件事就变味了：

   ① **只在交接进行中**。`status = 'pending'` 才成立。
      单子一旦完成或作废，这条通道立刻关上 —— 完成时正式派工已经转过去，
      作废时本来就不该有。它是**自己会过期的**，不需要谁记得回收。

   ② **只到接手人本人**。`to_account_id = 当前账号`，不是"参与交接的人"。
      发起人（上一个 CRC）本来就有正式派工。

   ③ **看的每一眼都进审计**。受试者明细的读取本来就写审计（I10），
      这条通道不改变那件事 —— 而这正是它可以被接受的原因：
      事后查得出"谁在交接期间看了哪些人"。

   ── 为什么走 site_assignment 分支而不是新加一条行规则 ────────────
   行规则（row_rule）是**角色**的属性，写在 role 表上。
   交接是**一个人在一段时间里的状态**，不是他换了个角色。
   把它做成第六条规则，等于说"接手中的 CRC 是另一种角色"——
   那会让角色矩阵多出一行只在几天内为真的东西。
   ══════════════════════════════════════════════════════════════════════ */

CREATE OR REPLACE FUNCTION app.site_visible(p_site_id uuid, p_study_id uuid,
                                            p_hospital text, p_pi_account_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  SELECT CASE app.current_row_rule()
    WHEN 'all'  THEN true
    WHEN 'none' THEN false
    WHEN 'team' THEN EXISTS (
      SELECT 1 FROM team_study ts
       WHERE ts.study_id = p_study_id AND ts.team_id = app.current_team_id())
    WHEN 'assigned' THEN EXISTS (
      SELECT 1 FROM site_assignment sa
       WHERE sa.study_site_id = p_site_id
         AND sa.account_id = app.current_account_id()
         AND sa.effective @> CURRENT_DATE)
      /* 交接进行中，接手人提前看得到 —— 见本迁移开头的三条边界。
         单子一完成或作废，这一段立刻不成立。 */
      OR EXISTS (
      SELECT 1 FROM handover h
        JOIN handover_site hs ON hs.handover_id = h.id
       WHERE hs.study_site_id = p_site_id
         AND h.to_account_id = app.current_account_id()
         AND h.status = 'pending')
    WHEN 'hospital' THEN p_hospital = app.current_org_ref()
    WHEN 'pi'       THEN p_pi_account_id = app.current_account_id()
    ELSE false
  END
$$;
COMMENT ON FUNCTION app.site_visible IS
  '五条行范围规则的唯一实现，外加一条会自己过期的：交接进行中，接手人提前看得到。
   packages/policy 里的 rowScope() 必须与它等价，并由一组共享测试用例双向验证 ——
   两处实现不一致就是数据泄漏。';

/* 接手人查自己"正在接手哪几个中心"要走这条索引 —— 每个请求装载主体时都问一次。 */
CREATE INDEX IF NOT EXISTS handover_to_pending_idx ON handover (to_account_id)
  WHERE status = 'pending';

-- Down Migration
DROP INDEX IF EXISTS handover_to_pending_idx;
CREATE OR REPLACE FUNCTION app.site_visible(p_site_id uuid, p_study_id uuid,
                                            p_hospital text, p_pi_account_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  SELECT CASE app.current_row_rule()
    WHEN 'all'  THEN true
    WHEN 'none' THEN false
    WHEN 'team' THEN EXISTS (
      SELECT 1 FROM team_study ts
       WHERE ts.study_id = p_study_id AND ts.team_id = app.current_team_id())
    WHEN 'assigned' THEN EXISTS (
      SELECT 1 FROM site_assignment sa
       WHERE sa.study_site_id = p_site_id
         AND sa.account_id = app.current_account_id()
         AND sa.effective @> CURRENT_DATE)
    WHEN 'hospital' THEN p_hospital = app.current_org_ref()
    WHEN 'pi'       THEN p_pi_account_id = app.current_account_id()
    ELSE false
  END
$$;
