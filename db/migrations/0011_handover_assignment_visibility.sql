-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   交接完成时，派工没有真的转过去 —— 三层同一个缺口，症状各不相同。

   ① **静默丢单（最危险的一层）。**
      `POST /v1/handovers/{id}:complete` 返回 201，交接单变成「已完成」，
      `sideEffects` 是空数组。原负责人的派工仍然开着，接手人一个中心也没拿到。
      两个人都以为交完了 —— 而原负责人的账号此刻已经可以停用了。

      成因：`completeHandover` 以**接手人**的身份去查原负责人的派工，

        SELECT role_kind FROM site_assignment
         WHERE account_id = <原负责人> AND study_site_id = <中心>

      而 `site_assignment_scope` 只放行「这行是我自己的」或「这个中心在我的
      行范围里」。接手人此刻两条都不满足（他正是**因为还没接手**才在做这件事），
      查回 0 行，代码 `continue`，整个转移被跳过。

   ② **收单直接 500。** `handover_scope` 是一条 `FOR ALL` 策略，
      它 WITH CHECK 里那句 `from_account_id = app.current_account_id()`
      本意是「只能发起从自己出去的交接」—— 那是 INSERT 的规则，
      但 `FOR ALL` 让它**同样作用于 UPDATE**，于是只有原负责人能改这一行，
      包括把状态改成 completed。

   ③ **单子看起来不含任何中心。** 取中心列表时 JOIN 了 `study_site`，
      接手人不在那些中心的行范围里，JOIN 把行过滤成空数组。

   三层合起来是同一个设计假设：**交接是原负责人在驱动。**
   而真实场景里更常见的是接手人确认完清单顺手收单 ——
   逐例交底是他在听，清单是他在核，签收当然也该是他。

   ── 修法：放宽的是「命令」，不是「行范围」 ──────────────────────────
   第一版给 `study_site_scope` / `site_assignment_scope` 各加了一条
   「这个中心在一笔与我有关的交接单上」。功能通了，
   `packages/policy` 的等价性测试当场红一条：

     fengle(assigned) × SS-13：TS=false DB=true

   本项目有一条硬约束：**行范围的三处实现必须逐一致**
   —— TS 谓词、`siteScopeSql`、数据库 RLS。放宽 RLS 就要求另外两处
   也认识「交接」，而它们是所有中心相关表（受试者、访视、质量事件、工时…）
   共用的谓词。那等于交接单一发起，接手人立刻拿到那些中心的**受试者级**数据 ——
   那是一个产品决定，不该夹带在一次修 bug 里。

   **等价性测试没有阻碍修复，它指出了修复的形状错了**：
   要放宽的不是「谁能看见中心」，而是「这一个命令能不能做这一件事」。

   于是：
   · ① 与 ③ 收进两个窄口径 `SECURITY DEFINER` 函数，授权在函数内部自判
     （只有当事人双方能触发），**行范围策略一个字没动**；
   · ② 把那条 `FOR ALL` 拆成 insert / select / update / delete 四条，
     让「只能发起从自己出去的交接」只管 INSERT。
   ══════════════════════════════════════════════════════════════════════ */

/** 一笔交接单上的中心。当事人双方可读 —— 他们本来就在谈这些中心。
 *  与「行范围」无关：这里只回 id/编号/医院，不给受试者级数据。 */
CREATE FUNCTION app.handover_sites(p_handover uuid)
  RETURNS TABLE (id uuid, code text, hospital text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  SELECT s.id, s.code, s.hospital
    FROM handover h
    JOIN handover_site hs ON hs.handover_id = h.id
    JOIN study_site s     ON s.id = hs.study_site_id
   WHERE h.id = p_handover
     AND h.tenant_id = app.current_tenant_id()
     AND (h.from_account_id = app.current_account_id()
       OR h.to_account_id   = app.current_account_id()
       OR app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id))
   ORDER BY s.code
$$;

COMMENT ON FUNCTION app.handover_sites(uuid) IS
  '交接单上的中心列表。接手人此刻还看不见这些中心（他正是因为还没接手才在做这件事），
   直接 JOIN study_site 会被行范围过滤成空数组 —— 交接于是看起来像一笔不含中心的单子。';

/** 执行派工转移：原负责人的派工结束于今天，接手人从今天开始。
 *
 *  为什么是 SECURITY DEFINER：这一步要读**原负责人**在这些中心上的派工，
 *  而接手人不在那些行的可见范围里。放宽 RLS 会波及所有中心相关表；
 *  收进函数则把放宽限制在「这一个命令、这一笔交接单」上。
 *  授权在函数内部自己判：只有当事人双方能触发。
 *
 *  返回每个中心是否真的转移了 —— 调用方据此决定报成功还是报错。
 *  **不返回布尔总结**：一笔"部分转移"必须能被逐个中心看见。 */
CREATE FUNCTION app.transfer_handover_assignments(p_handover uuid)
  RETURNS TABLE (site_code text, moved boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
DECLARE h record; s record; k text;
BEGIN
  SELECT * INTO h FROM handover WHERE id = p_handover;
  IF NOT FOUND THEN
    RAISE EXCEPTION '交接单不存在：%', p_handover USING ERRCODE = 'no_data_found';
  END IF;
  IF h.tenant_id <> app.current_tenant_id()
     OR app.current_account_id() NOT IN (h.from_account_id, h.to_account_id) THEN
    RAISE EXCEPTION '只有交接单的当事人能转移派工' USING ERRCODE = 'insufficient_privilege';
  END IF;

  FOR s IN SELECT ss.id, ss.code FROM handover_site hs
             JOIN study_site ss ON ss.id = hs.study_site_id
            WHERE hs.handover_id = p_handover ORDER BY ss.code
  LOOP
    SELECT sa.role_kind INTO k FROM site_assignment sa
     WHERE sa.account_id = h.from_account_id AND sa.study_site_id = s.id
       AND sa.effective @> CURRENT_DATE;
    IF k IS NULL THEN
      /* 原负责人此刻确实可能已经没有这个中心（同一中心交接过两次，
         或他已被调离）。跳过是合理的，但必须报出来。 */
      site_code := s.code; moved := false; RETURN NEXT; CONTINUE;
    END IF;

    UPDATE site_assignment
       SET effective = daterange(lower(effective), CURRENT_DATE, '[)')
     WHERE account_id = h.from_account_id AND study_site_id = s.id
       AND effective @> CURRENT_DATE;
    INSERT INTO site_assignment (account_id, study_site_id, role_kind, effective)
    VALUES (h.to_account_id, s.id, k, daterange(CURRENT_DATE, NULL, '[)'));

    site_code := s.code; moved := true; RETURN NEXT;
  END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION app.handover_sites(uuid)                 TO sitedesk_app;
GRANT EXECUTE ON FUNCTION app.transfer_handover_assignments(uuid)  TO sitedesk_app;

/* ══════════════════════════════════════════════════════════════════════
   同一处设计缺口的另一半：**接手人收不了单。**

   `handover_scope` 是一条 `FOR ALL` 策略，它的 WITH CHECK 写着

     from_account_id = app.current_account_id()      -- 只能发起「从自己出去」的交接

   那句注释说的是 INSERT，但 `FOR ALL` 的 WITH CHECK **同样作用于 UPDATE**。
   于是只有原负责人能改这一行 —— 包括把状态改成 completed。
   接手人逐项确认清单是允许的（那在 handover_item 上，双方都放行），
   到最后一步收单时撞上策略，报的是
   `new row violates row-level security policy`，出口是 500。

   两半合起来才是完整的症状：接手人要么静默转移不了派工（见上），
   要么直接被策略挡在收单那一步 —— 而**接手人收单恰恰是常态**：
   逐例交底是他在听，清单是他在核，签收当然也该是他。

   拆成三条策略，把「谁能发起」和「谁能改」分开说：
   · 发起仍然只能是「从自己出去」；
   · 读维持原样（双方 + 中心在行范围里的人）；
   · 改放给**当事人双方**，且改完自己仍须是当事人之一 ——
     这拦住了「把自己写进一笔别人的交接单」。
   （改完之后仍可改动对方是谁，那需要触发器才拦得住；
     服务端从不这么做，先记在这里。）

   DELETE 保持原样（可见即可删）—— 目前没有任何代码删交接单，
   这里不顺手收紧，免得把一次修复混进一次未经讨论的行为变更。
   ══════════════════════════════════════════════════════════════════════ */

DROP POLICY handover_scope ON handover;

CREATE POLICY handover_insert ON handover FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND from_account_id = app.current_account_id());

CREATE POLICY handover_select ON handover FOR SELECT
  USING (app.handover_visible(id, tenant_id, from_account_id, to_account_id));

CREATE POLICY handover_update ON handover FOR UPDATE
  USING (app.handover_visible(id, tenant_id, from_account_id, to_account_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND (from_account_id = app.current_account_id()
                OR to_account_id   = app.current_account_id()));

CREATE POLICY handover_delete ON handover FOR DELETE
  USING (app.handover_visible(id, tenant_id, from_account_id, to_account_id));

-- Down Migration
/* 回滚可能从一个不完整的状态开始（例如上一次 up 半途失败），
   所以一律 IF EXISTS —— 与 0005 的写法一致。 */
DROP POLICY IF EXISTS handover_insert ON handover;
DROP POLICY IF EXISTS handover_select ON handover;
DROP POLICY IF EXISTS handover_update ON handover;
DROP POLICY IF EXISTS handover_delete ON handover;
DROP POLICY IF EXISTS handover_scope  ON handover;
CREATE POLICY handover_scope ON handover FOR ALL
  USING (app.handover_visible(id, tenant_id, from_account_id, to_account_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND from_account_id = app.current_account_id());

DROP FUNCTION IF EXISTS app.transfer_handover_assignments(uuid);
DROP FUNCTION IF EXISTS app.handover_sites(uuid);
