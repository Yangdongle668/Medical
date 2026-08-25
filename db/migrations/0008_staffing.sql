-- Up Migration
-- ════════════════════════════════════════════════════════════════════
-- Site & Staffing 补全：启动清单 · 人员 · 交接
--
-- 补上这三张表，两处 Phase 3 里写死的东西才能变成真的：
--   · SIV 闸门（当前是 unavailable 占位）→ 查启动清单的阻塞项
--   · 停用账号的「请先交接」→ 指向一笔真实的交接单
--
-- 「启动慢一个月，这个中心的整条收入曲线右移一个月」——
-- 而在此之前，系统对这一个月一无所知，连工时都归集不到具体动作上。
-- ════════════════════════════════════════════════════════════════════

/* ── 人员：账号之外的作业属性 ────────────────────────────────────── */
-- account 回答「谁能登录、看得到什么」；staff 回答「他是什么工种、带谁、谁接他」。
-- 两者一对一但语义不同：外部方（机构办 / PI）有账号无 staff 记录。
CREATE TABLE staff (
  account_id           uuid PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  tenant_id            uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  role_kind            text NOT NULL CHECK (role_kind IN ('CRA','CRC','PM','QA','DM')),
  level                text NOT NULL CHECK (level IN ('初级','中级','高级','经理','总监')),
  city                 text NOT NULL,
  gcp_expires_on       date,
  mentor_account_id    uuid REFERENCES account(id),
  successor_account_id uuid REFERENCES account(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- 自己不能是自己的带教或继任者
  CONSTRAINT staff_no_self_mentor    CHECK (mentor_account_id    IS DISTINCT FROM account_id),
  CONSTRAINT staff_no_self_successor CHECK (successor_account_id IS DISTINCT FROM account_id)
);
CREATE TRIGGER staff_touch BEFORE UPDATE ON staff
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
COMMENT ON COLUMN staff.successor_account_id IS
  '继任者。带 3 个以上中心却没有继任者，是「一旦离职就断档」的直接信号。';

/* ── 启动清单：CRC 最忙的两个月 ──────────────────────────────────── */
CREATE TABLE startup_category (
  code text PRIMARY KEY, seq smallint NOT NULL UNIQUE, label text NOT NULL
);
INSERT INTO startup_category (code, seq, label) VALUES
  ('ethics',   1, '伦理与批件'),
  ('contract', 2, '合同与预算'),
  ('isf',      3, '研究者文件夹'),
  ('training', 4, '人员与培训'),
  ('ip',       5, '药品与物资'),
  ('lab',      6, '检验与设备'),
  ('systems',  7, '系统与账号'),
  ('meeting',  8, '启动会筹备');

CREATE TABLE startup_item (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  study_site_id    uuid NOT NULL REFERENCES study_site(id) ON DELETE CASCADE,
  category         text NOT NULL REFERENCES startup_category(code),
  item             text NOT NULL,
  owner_account_id uuid REFERENCES account(id),
  due_on           date,
  is_blocking      boolean NOT NULL DEFAULT false,
  sort_order       smallint NOT NULL DEFAULT 0,
  done_at          timestamptz,
  done_by          uuid REFERENCES account(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (study_site_id, category, item),
  -- 完成必须同时有时间和人：只记「做完了」而不记「谁做的」，核查时说不清
  CONSTRAINT startup_done_needs_actor CHECK ((done_at IS NULL) = (done_by IS NULL))
);
CREATE INDEX startup_item_site_idx ON startup_item (study_site_id, category, sort_order);
CREATE INDEX startup_item_blocking_idx ON startup_item (study_site_id)
  WHERE is_blocking AND done_at IS NULL;
CREATE TRIGGER startup_item_touch BEFORE UPDATE ON startup_item
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
COMMENT ON COLUMN startup_item.is_blocking IS
  '阻塞项 = 「没有它就不能合法开展受试者相关工作」：伦理批件、合同、DOA 授权分工表、
   方案培训、药品接收、EDC 账号。未清零不得推进到 SIV启动。';

/* ── 交接：人会休假、会离职、会被调岗，中心不会因此停下 ──────────── */
CREATE TABLE handover (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  from_account_id   uuid NOT NULL REFERENCES account(id),
  to_account_id     uuid NOT NULL REFERENCES account(id),
  reason            text NOT NULL,
  planned_on        date NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'completed', 'cancelled')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT handover_not_self CHECK (from_account_id <> to_account_id),
  CONSTRAINT handover_completed_at CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX handover_from_idx ON handover (from_account_id) WHERE status = 'pending';
CREATE INDEX handover_to_idx   ON handover (to_account_id)   WHERE status = 'pending';
CREATE TRIGGER handover_touch BEFORE UPDATE ON handover
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE handover_site (
  handover_id   uuid NOT NULL REFERENCES handover(id) ON DELETE CASCADE,
  study_site_id uuid NOT NULL REFERENCES study_site(id) ON DELETE CASCADE,
  PRIMARY KEY (handover_id, study_site_id)
);

CREATE TABLE handover_item (
  handover_id uuid NOT NULL REFERENCES handover(id) ON DELETE CASCADE,
  seq         smallint NOT NULL,
  item        text NOT NULL,
  done_at     timestamptz,
  done_by     uuid REFERENCES account(id),
  PRIMARY KEY (handover_id, seq),
  CONSTRAINT handover_item_done_needs_actor CHECK ((done_at IS NULL) = (done_by IS NULL))
);
COMMENT ON TABLE handover_item IS
  '清单里最容易漏也最要命的一项是「在组受试者逐例交底」：
   哪个依从性差、哪个家属有顾虑、哪个只能周三来 —— 这些不在 EDC 里，只在上一个 CRC 脑子里。';

/* ── RLS ───────────────────────────────────────────────────────── */
ALTER TABLE staff         ENABLE ROW LEVEL SECURITY;
ALTER TABLE startup_item  ENABLE ROW LEVEL SECURITY;
ALTER TABLE handover      ENABLE ROW LEVEL SECURITY;
ALTER TABLE handover_site ENABLE ROW LEVEL SECURITY;
ALTER TABLE handover_item ENABLE ROW LEVEL SECURITY;

-- 员工名册对外部方无用；内部按租户可见
CREATE POLICY staff_scope ON staff FOR ALL
  USING (tenant_id = app.current_tenant_id() AND NOT app.current_is_external())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- 启动清单跟着中心的行范围走
CREATE POLICY startup_item_scope ON startup_item FOR ALL
  USING (tenant_id = app.current_tenant_id() AND EXISTS (
    SELECT 1 FROM study_site s WHERE s.id = startup_item.study_site_id
      AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id)))
  WITH CHECK (tenant_id = app.current_tenant_id());

/* ── 交接可见性 ───────────────────────────────────────────────────
   两个坑，都值得记下来：

   ① **策略互相引用会无限递归。** handover 的策略要查 handover_site，
      而 handover_site 的策略要回查 handover。解法与 app.site_visible() 相同：
      收进 SECURITY DEFINER 函数，以 owner 身份执行，内部读取不再触发策略。

   ② **策略辅助函数必须接收行的列值，不能按 id 回查本表。**
      FOR ALL 策略的 USING 会作用于 `INSERT ... RETURNING` 的返回行，
      而 STABLE 函数用的是命令开始时的快照 —— 看不到刚插入的那一行，
      于是插入报「new row violates row-level security policy」，
      而排查时会发现每个条件单独求值都是 true。
      app.site_visible() 从一开始就是接参数的形状，所以没踩到；
      本函数第一版按 id 回查，立刻踩了。 */
CREATE FUNCTION app.handover_visible(
  p_id uuid, p_tenant uuid, p_from uuid, p_to uuid
) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  SELECT p_tenant = app.current_tenant_id()
     AND NOT app.current_is_external()
     AND (p_from = app.current_account_id()
       OR p_to   = app.current_account_id()
       OR EXISTS (SELECT 1 FROM handover_site hs JOIN study_site s ON s.id = hs.study_site_id
                   WHERE hs.handover_id = p_id
                     AND app.site_visible(s.id, s.study_id, s.hospital, s.pi_account_id)))
$$;

/* 子表只有 handover_id，只能按 id 查父行 —— 但父行在此之前的命令里就已存在，
   STABLE 快照看得到它，因此不受 ② 影响。 */
CREATE FUNCTION app.handover_child_visible(p_handover_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  SELECT EXISTS (SELECT 1 FROM handover h WHERE h.id = p_handover_id
                  AND app.handover_visible(h.id, h.tenant_id,
                                           h.from_account_id, h.to_account_id))
$$;

GRANT EXECUTE ON FUNCTION app.handover_visible(uuid,uuid,uuid,uuid) TO sitedesk_app;
GRANT EXECUTE ON FUNCTION app.handover_child_visible(uuid)          TO sitedesk_app;

CREATE POLICY handover_scope ON handover FOR ALL
  USING (app.handover_visible(id, tenant_id, from_account_id, to_account_id))
  /* 只能发起「从自己出去」的交接 */
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND from_account_id = app.current_account_id());

CREATE POLICY handover_site_scope ON handover_site FOR ALL
  USING (app.handover_child_visible(handover_id))
  WITH CHECK (app.handover_child_visible(handover_id));

CREATE POLICY handover_item_scope ON handover_item FOR ALL
  USING (app.handover_child_visible(handover_id))
  WITH CHECK (app.handover_child_visible(handover_id));

-- Down Migration
-- 策略之间是循环依赖的：handover 的策略引用 handover_site，
-- 而 handover_site 的策略引用 handover。必须先把策略摘掉，再删表。
DROP POLICY IF EXISTS handover_item_scope ON handover_item;
DROP POLICY IF EXISTS handover_site_scope ON handover_site;
DROP POLICY IF EXISTS handover_scope      ON handover;
DROP POLICY IF EXISTS startup_item_scope  ON startup_item;
DROP POLICY IF EXISTS staff_scope         ON staff;
DROP FUNCTION IF EXISTS app.handover_child_visible(uuid);
DROP FUNCTION IF EXISTS app.handover_visible(uuid,uuid,uuid,uuid);
DROP TABLE IF EXISTS handover_item;
DROP TABLE IF EXISTS handover_site;
DROP TABLE IF EXISTS handover;
DROP TABLE IF EXISTS startup_item;
DROP TABLE IF EXISTS startup_category;
DROP TABLE IF EXISTS staff;
