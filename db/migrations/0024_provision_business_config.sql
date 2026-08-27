-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   开户不止到角色为止（欠账 D3）。

   `app.provision_tenant()` 给的是**权限模型**：租户 + 八个标准角色 +
   行/列/动作/模块授予。开完之后这个租户能登录、能看见界面，
   但**一件事也做不了**：

     · 建一个中心 → 启动清单模板是空的（迁移 0019 之后建档会直接拒绝，
       因为一份空模板意味着 SIV 闸门对每个新中心都天然成立）；
     · 填一条工时 → 没有生效的费率卡，填报被拒（no-effective-rate-card）。

   于是"开户成功"和"可以开始干活"之间隔着一段没有人负责的距离，
   而它只在第一个人试着干活时才暴露。

   ── 这一支补的与不补的 ────────────────────────────────────────────
   **补**：启动清单模板 v1、费率卡基线。两者都是**租户级**的作业规程，
   与具体项目无关，开户时就该有一份能用的。

   **不补**：SOA（访视计划表）。它挂在 `study` 上，而新租户还没有项目 ——
   开户时没有东西可挂。SOA 在建项目时由 `replaceSoa` 录入（迁移 0020）。
   把它硬塞进开户，只能塞一份编出来的：而一份编出来的访视计划
   比没有更危险，因为它看起来是真的。

   ── 费率卡的数是从哪来的 ──────────────────────────────────────────
   **它是一份必须被改掉的占位，而不是一个推荐值。**
   每家受托方的人力成本口径都不一样，我们没有立场替客户定这个数。
   所以：① note 里写明"开户占位，请按实际成本改"；
        ② 只开**不分级别**的通用行 —— 分级别的那几档更需要客户自己定；
        ③ 数字取一个明显偏保守的量级，宁可让人觉得"这不对"也不要
          让人觉得"差不多可以用"。

   已经有费率卡的租户不动（ON CONFLICT DO NOTHING 挡不住 EXCLUDE 约束，
   所以用 NOT EXISTS 显式判）。
   ══════════════════════════════════════════════════════════════════════ */

/* 原来的 provision_tenant 改名成 ..._roles：它做的一直是"权限模型"那一半，
   只是当时那一半就是全部。名字得跟着职责走，否则下一个人会以为
   开完户就齐了 —— 而那正是这条欠账的由来。 */
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'app' AND p.proname = 'provision_tenant_roles') THEN
    EXECUTE 'ALTER FUNCTION app.provision_tenant(text, text) RENAME TO provision_tenant_roles';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app.provision_business_config(p_tenant uuid)
  RETURNS TABLE (startup_items int, rate_cards int)
  LANGUAGE plpgsql SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_items int := 0;
  v_rates int := 0;
BEGIN
  /* ── 启动清单模板 v1 ──────────────────────────────────────────
     与迁移 0019 铺给演示租户的那一份同源。一字不改地复制过来 ——
     两份"标准清单"迟早会漂移，而漂移的表现是新租户少了两项阻塞。 */
  IF NOT EXISTS (SELECT 1 FROM startup_template_item WHERE tenant_id = p_tenant) THEN
    INSERT INTO startup_template_item
      (tenant_id, version, sort_order, category, item, is_blocking, due_offset, reason)
    VALUES
      (p_tenant, 1,  0, 'ethics',   '伦理初始审查递交（方案、ICF、IB 及研究者资质）', true,  -35, '开户初始模板'),
      (p_tenant, 1,  1, 'ethics',   '伦理会议答辩与补充材料',                     true,  -18, '开户初始模板'),
      (p_tenant, 1,  2, 'ethics',   '伦理批件取得并归档 ISF',                     true,  -12, '开户初始模板'),
      (p_tenant, 1,  3, 'contract', '三方协议定稿与签署（申办方 / 机构 / 受托方）',  true,  -14, '开户初始模板'),
      (p_tenant, 1,  4, 'contract', '受试者补偿标准报机构备案',                   false, -10, '开户初始模板'),
      (p_tenant, 1,  5, 'isf',      'ISF 建夹与目录页（按申办方模板）',            false, -20, '开户初始模板'),
      (p_tenant, 1,  6, 'isf',      '全体研究者 CV、执业证、GCP 证书收集',          true,   -8, '开户初始模板'),
      (p_tenant, 1,  7, 'training', '研究者授权分工表 DOA 由 PI 签署',             true,   -5, '开户初始模板'),
      (p_tenant, 1,  8, 'training', '方案与 ICF 培训及签到表',                    true,    0, '开户初始模板'),
      (p_tenant, 1,  9, 'training', '机构人员备案与门禁办理',                     false,  -7, '开户初始模板'),
      (p_tenant, 1, 10, 'ip',       '药品接收、温控启用与药房交接',                 true,   -3, '开户初始模板'),
      (p_tenant, 1, 11, 'ip',       'ICF 空白件、访视包、采血管到位',               false,  -4, '开户初始模板'),
      (p_tenant, 1, 12, 'lab',      '中心实验室资质与正常值范围收集',               false,  -9, '开户初始模板'),
      (p_tenant, 1, 13, 'lab',      '离心机 / 冰箱校准证书，影像科排期对接',         false,  -6, '开户初始模板'),
      (p_tenant, 1, 14, 'systems',  'EDC / IWRS 账号开通与权限确认',               true,   -4, '开户初始模板'),
      (p_tenant, 1, 15, 'meeting',  'SIV 议程、参会人确认、会议室预订',             false,  -5, '开户初始模板');
    GET DIAGNOSTICS v_items = ROW_COUNT;
  END IF;

  /* ── 费率卡基线 ────────────────────────────────────────────────
     **占位，不是推荐值。** note 里写死这句话：
     一个不带说明的数字会被当成"系统给的标准"，然后一直用下去，
     而成本口径错了，这个系统在钱这一侧输出的每一个数都是错的。 */
  IF NOT EXISTS (SELECT 1 FROM rate_card WHERE tenant_id = p_tenant) THEN
    INSERT INTO rate_card (tenant_id, role_kind, level, day_cost_cents, valid_from, note)
    SELECT p_tenant, k, NULL, 100000, CURRENT_DATE,
           '开户占位费率，**必须**按实际人力成本改掉 —— 这个数决定成本侧的一切'
      FROM unnest(ARRAY['CRA','CRC','PM','QA','DM']) AS k;
    GET DIAGNOSTICS v_rates = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT v_items, v_rates;
END $$;

COMMENT ON FUNCTION app.provision_business_config(uuid) IS
  '开户的**业务配置**那一半：启动清单模板与费率卡基线。
   与权限模型分开是刻意的 —— 权限模型由迁移维护，业务配置由客户改。
   SOA 不在这里：它挂在 study 上，开户时没有东西可挂。';

/* ── 开户时自动带上 ─────────────────────────────────────────────
   `provision_tenant` 末尾调它。分成两个函数而不是写在一起，
   是因为两者的**维护者不同**：权限模型由迁移维护（改它要动代码），
   业务配置由客户自己改（改它是日常操作）。
   写在一起的话，"重新开一次户会不会把客户改过的费率覆盖掉"
   就成了一个每次都要重新读代码才能回答的问题。 */
CREATE OR REPLACE FUNCTION app.provision_tenant(p_code text, p_name text)
  RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = public, app, pg_temp
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  v_tenant := app.provision_tenant_roles(p_code, p_name);
  PERFORM app.provision_business_config(v_tenant);
  RETURN v_tenant;
END $$;

COMMENT ON FUNCTION app.provision_tenant(text, text) IS
  '开户：权限模型（provision_tenant_roles）+ 业务配置（provision_business_config）。
   幂等：已有的模板与费率卡不会被覆盖 —— 客户改过的东西，重新开户不该动它。';

/* 已有租户补齐。演示租户在 0019 里已经有模板了，NOT EXISTS 会跳过；
   费率卡演示种子里也有 —— 同样跳过。 */
SELECT app.provision_business_config(t.id) FROM tenant t;

-- Down Migration
/* 回滚可能从一个不完整的状态开始（例如上一次 up 半途失败）。
   直接 `ALTER FUNCTION ... RENAME` 在那种状态下会报
   "function does not exist" —— 而那句话指不到真正的原因，
   于是整个 down 99 卡住，连带把没关系的迁移一起拖下水。
   （0017 / 0018 已经栽过一次，这里不再栽第二次。） */
DROP FUNCTION IF EXISTS app.provision_tenant(text, text);
DROP FUNCTION IF EXISTS app.provision_business_config(uuid);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'app' AND p.proname = 'provision_tenant_roles') THEN
    EXECUTE 'ALTER FUNCTION app.provision_tenant_roles(text, text) RENAME TO provision_tenant';
  END IF;
END $$;
