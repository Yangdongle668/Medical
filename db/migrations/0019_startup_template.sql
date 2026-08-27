-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   启动清单模板变成数据（欠账 D1）。

   `DEFAULT_STARTUP_ITEMS` 在 packages/contracts 里当了五个阶段的常量，
   它自己的注释写着为什么先不做成表：

   > 模板一旦可配置就要回答「谁能改、改了对在途中心是否生效、
   > 历史清单如何追溯」

   三个问题都有答案了，所以做：

   ① **谁能改** —— `manage` 动作（经营层）。改模板是敏感动作，必须写原因，
      且逐条进审计。一份决定所有新中心怎么启动的清单，
      不能是任何一个人随手改掉的。

   ② **改了对在途中心是否生效** —— **不生效**。清单在建档那一刻
      按当时的模板**铺开成 startup_item 行**，此后与模板再无关系。
      这不是偷懒：一个已经做到第 12 项的中心，模板改一次就多出三项
      从来没人见过的阻塞，SIV 排期作废 —— 而没有人会认为那是"配置生效了"。

   ③ **历史清单如何追溯** —— 中心自己的 startup_item 行就是历史。
      另外在 study_site 上盖一个 `startup_template_version` 的戳，
      答"它是照着第几版铺的"。模板每改一次版本号加一，旧版本留在
      `startup_template_item` 里不删（`version` 是主键的一部分）。

   ── 为什么模板表按租户而不按项目 ──────────────────────────────────
   启动清单是**受托方自己的作业规程**，不是申办方的方案要求：
   同一家 CRO 在两个项目上用的是同一套 ISF 建夹、DOA 签署、EDC 开通流程。
   按项目拆会立刻长出十几份 95% 相同的清单，而它们会各自漂移。
   真出现项目级差异时再加一层 study_id 覆盖，那时是**加**一层，不是拆。
   ══════════════════════════════════════════════════════════════════════ */

CREATE TABLE startup_template_item (
  tenant_id   uuid    NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  version     int     NOT NULL,
  sort_order  int     NOT NULL,
  category    text    NOT NULL REFERENCES startup_category(code),
  item        text    NOT NULL,
  is_blocking boolean NOT NULL,
  /* 相对计划 SIV 日的天数，负数 = SIV 之前几天 */
  due_offset  int     NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES account(id),
  reason      text,
  PRIMARY KEY (tenant_id, version, sort_order)
);
COMMENT ON TABLE startup_template_item IS
  '启动清单模板。旧版本不删 —— 中心的 startup_template_version 要指得回去。';
COMMENT ON COLUMN startup_template_item.reason IS
  '这一版为什么这么改。改模板是敏感动作，必须写原因（规约：敏感动作必填理由）。';

ALTER TABLE startup_template_item ENABLE ROW LEVEL SECURITY;
/* 模板不含中心信息，行范围只到租户：看得见这个租户就看得见它的作业规程。 */
CREATE POLICY startup_template_item_tenant ON startup_template_item
  FOR ALL USING (tenant_id = app.default_tenant_id())
  WITH CHECK (tenant_id = app.default_tenant_id());

ALTER TABLE study_site ADD COLUMN startup_template_version int;
COMMENT ON COLUMN study_site.startup_template_version IS
  '建档时按第几版模板铺的清单。模板改版不回溯已建档的中心 —— 这个戳答"它是照着哪一版来的"。';

/* ── 第一版模板：从契约里的那份常量搬过来 ─────────────────────────
   一字不改。**搬迁不是改版的时机** —— 两件事混在一起，
   哪天有人发现清单少了一项，没人说得清是搬错了还是当初就没有。 */
INSERT INTO startup_template_item (version, sort_order, category, item, is_blocking, due_offset, reason)
VALUES
  (1,  0, 'ethics',   '伦理初始审查递交（方案、ICF、IB 及研究者资质）', true,  -35, '初版：由契约常量迁入'),
  (1,  1, 'ethics',   '伦理会议答辩与补充材料',                     true,  -18, '初版：由契约常量迁入'),
  (1,  2, 'ethics',   '伦理批件取得并归档 ISF',                     true,  -12, '初版：由契约常量迁入'),
  (1,  3, 'contract', '三方协议定稿与签署（申办方 / 机构 / 受托方）',  true,  -14, '初版：由契约常量迁入'),
  (1,  4, 'contract', '受试者补偿标准报机构备案',                   false, -10, '初版：由契约常量迁入'),
  (1,  5, 'isf',      'ISF 建夹与目录页（按申办方模板）',            false, -20, '初版：由契约常量迁入'),
  (1,  6, 'isf',      '全体研究者 CV、执业证、GCP 证书收集',          true,   -8, '初版：由契约常量迁入'),
  (1,  7, 'training', '研究者授权分工表 DOA 由 PI 签署',             true,   -5, '初版：由契约常量迁入'),
  (1,  8, 'training', '方案与 ICF 培训及签到表',                    true,    0, '初版：由契约常量迁入'),
  (1,  9, 'training', '机构人员备案与门禁办理',                     false,  -7, '初版：由契约常量迁入'),
  (1, 10, 'ip',       '药品接收、温控启用与药房交接',                 true,   -3, '初版：由契约常量迁入'),
  (1, 11, 'ip',       'ICF 空白件、访视包、采血管到位',               false,  -4, '初版：由契约常量迁入'),
  (1, 12, 'lab',      '中心实验室资质与正常值范围收集',               false,  -9, '初版：由契约常量迁入'),
  (1, 13, 'lab',      '离心机 / 冰箱校准证书，影像科排期对接',         false,  -6, '初版：由契约常量迁入'),
  (1, 14, 'systems',  'EDC / IWRS 账号开通与权限确认',               true,   -4, '初版：由契约常量迁入'),
  (1, 15, 'meeting',  'SIV 议程、参会人确认、会议室预订',             false,  -5, '初版：由契约常量迁入');

/* 已建档的中心补上戳：它们确实是照着第 1 版铺的。 */
UPDATE study_site SET startup_template_version = 1 WHERE startup_template_version IS NULL;

/* ── 当前版本号 ──────────────────────────────────────────────────
   SECURITY DEFINER：建档时要读它，而那一刻调用者未必看得见模板表
   （行策略只放行本租户，跨租户的 SECURITY DEFINER 函数里已经收窄到
   default_tenant_id()，不会因此扩大范围）。 */
CREATE FUNCTION app.startup_template_version() RETURNS int
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$ SELECT coalesce(max(version), 0) FROM startup_template_item
    WHERE tenant_id = app.default_tenant_id() $$;
COMMENT ON FUNCTION app.startup_template_version IS
  '当前生效的模板版本号 —— 建档时盖在 study_site 上，用于追溯。';

-- Down Migration
DROP FUNCTION IF EXISTS app.startup_template_version();
ALTER TABLE study_site DROP COLUMN IF EXISTS startup_template_version;
DROP TABLE IF EXISTS startup_template_item;
