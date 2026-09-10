-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   方案编号：按**最大号**取下一个，不按行数。

   ── 症状 ────────────────────────────────────────────────────────────
   批准第三份立项申请时返回 500「服务内部错误」。日志里是
   `duplicate key value violates unique constraint "study_tenant_id_code_key"`。
   前两份是好的。

   ── 原因 ────────────────────────────────────────────────────────────
   编号原来这么取（intake.service.ts）：

     SELECT count(*) + 1 FROM study WHERE code LIKE 'HJ-2026-%'

   **行数不是序号。** 序号一旦有缺口，行数就永远追不上最大号，
   而它每次都会撞在缺口后面那个已经用掉的号上：
   演示数据里有 HJ-2026-004 却没有 001/002/003，于是
   第一次批准得到 002、第二次 003、第三次 004 —— 撞。

   缺口不是异常情况，是常态：删掉一个项目、从别的系统迁一批进来、
   两个租户各自跑一遍，都会留下缺口。

   ── 还有一层：count 是**在 RLS 下**数的 ──────────────────────────
   `study` 上有行级策略，而 pm 也持有 approve 动作。行范围为 team 的
   人数出来的是"本组的项目数"，比全租户少一大截 —— 他批准的项目
   几乎必然撞号，而且撞的是别的组的项目编号，报出来是一个 500。
   所以取号这件事必须绕开 RLS：**它问的是"这个号有没有被人用过"，
   不是"你看得见谁"**。SECURITY DEFINER 就是为这种问句准备的。

   ── 并发 ────────────────────────────────────────────────────────────
   同时批准两份，两笔事务会算出同一个号，唯一约束把第二笔变成 500。
   按租户加事务级 advisory lock 串起来（与 0016 的 gc_expired 同一套
   办法），代价是两笔批准排一下队 —— 一年几百次的操作，不值得为它
   引入一个会留缺口的 sequence。

   唯一约束仍然留着：它是这条规则的兜底，不是它的实现。
   ══════════════════════════════════════════════════════════════════════ */

CREATE FUNCTION app.next_study_code(p_year int DEFAULT NULL)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
DECLARE
  v_tenant uuid := app.current_tenant_id();
  v_year   int  := coalesce(p_year, extract(year FROM CURRENT_DATE)::int);
  v_prefix text := 'HJ-' || v_year::text || '-';
  v_next   int;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION '取方案编号时没有租户上下文 —— app.current_tenant_id() 为空';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant::text || v_prefix, 0));

  SELECT coalesce(max(substring(code FROM char_length(v_prefix) + 1)::int), 0) + 1
    INTO v_next
    FROM study
   WHERE tenant_id = v_tenant
     AND code ~ ('^' || v_prefix || '[0-9]+$');

  RETURN v_prefix || lpad(v_next::text, 3, '0');
END $$;

COMMENT ON FUNCTION app.next_study_code(int) IS
  '下一个方案编号 HJ-年-序号。按最大号 + 1 取，不按行数 —— 行数在有缺口时
   会一直撞在已经用掉的号上。SECURITY DEFINER 是必需的：取号问的是
   "这个号有没有被人用过"，不是"你看得见谁"。同租户同年以 advisory lock 串行。';

GRANT EXECUTE ON FUNCTION app.next_study_code(int) TO sitedesk_app;

-- Down Migration
DROP FUNCTION IF EXISTS app.next_study_code(int);
