-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   「登记递交」500：撞上一条自己看不见的受理记录。

   ── 复现 ────────────────────────────────────────────────────────────
   在 apps/api 的测试里跑通了（test/acceptance.test.ts 现在钉着它）：

     admin 向「探针医院」递交            → 201
     CRC 看得见这一条吗                  → false
     CRC 向同一个(项目, 医院)再递一次     → **500 服务内部错误**

   ── 为什么 ──────────────────────────────────────────────────────────
   `site_acceptance` 上有 `UNIQUE (tenant_id, study_id, hospital)`
   （迁移 0038：一家医院在同一个项目上只有一次立项受理，补正重交仍是同一条）。

   服务层在插入之前先查一遍，好给出一句说得清的话：

     SELECT code, state FROM site_acceptance WHERE study_id = $1 AND hospital = $2

   **而这句查询是带行策略的。** 行规则为 `assigned` 的 CRA / CRC 看不见
   别人递的那一条（`study_site_id` 还是空的，`app.site_visible` 判不出来），
   于是这句 pre-check 查回 0 行、一路放行，最后撞在唯一约束上 ——
   而 pg 的 23505 不是 ProblemException，落到兜底分支就是 500。

   一句"服务内部错误"教会用户的是**重试**，而重试一万次结果都一样。
   他真正需要知道的是：这家医院在这个项目上已经有一条受理了，编号是多少，
   谁递的 —— 那样他会去问那个人，而不是去刷新页面。

   ── 补法：一个只回答这一个问题的口子 ────────────────────────────────
   与 `app.site_staff_registry`（迁移 0028）同一个用法：
   **「一片数据」继续锁着，「一个问题」单独开一个口子。**

   这里开的口子只回答：*这个租户里，这个(项目, 医院)上有受理记录吗，
   编号多少，谁递的。* 不给状态、不给材料清单、不给受理日 ——
   那些仍然由行策略管。

   泄漏的边界值得说清：唯一约束本来就会泄漏"存在"这件事（撞上去就报错），
   这个函数只是把那次泄漏从一句 500 换成一句有用的话，
   并额外给出编号与递交人 —— 同一个租户内部，那正是"我该去找谁"的答案。
   ══════════════════════════════════════════════════════════════════════ */

CREATE FUNCTION app.acceptance_for(p_study uuid, p_hospital text)
  RETURNS TABLE (code text, submitted_by_name text, submitted_on date)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  SELECT a.code, COALESCE(ac.display_name, '（已离职）'), a.submitted_on
    FROM site_acceptance a
    LEFT JOIN account ac ON ac.id = a.submitted_by
   WHERE a.tenant_id = app.current_tenant_id()
     AND a.study_id = p_study
     AND a.hospital = p_hospital
$$;

COMMENT ON FUNCTION app.acceptance_for IS
  '这个(项目, 医院)上已经有受理记录吗 —— 只回答这一个问题。
   SECURITY DEFINER 绕开的是行策略，**不是租户**：唯一约束是按租户建的，
   而撞上它的人本来就会看到一句报错。把那句报错换成「编号是多少、谁递的」，
   他才知道该去找谁，而不是去刷新页面。';

GRANT EXECUTE ON FUNCTION app.acceptance_for(uuid, text) TO sitedesk_app;

/* ── 让应用读得到"库跑到哪一版了" ──────────────────────────────────
   `schema_migration` 是 node-pg-migrate **在迁移 0001 之前**自己建的，
   所以 0001 里那条 ALTER DEFAULT PRIVILEGES 没盖到它 —— 应用角色
   `SELECT` 它会得到 `permission denied for table schema_migration`。

   启动自检要比对"代码里的迁移文件"与"库里跑过的那些"（见 apps/api 的
   warnSchemaBehind）：代码部署了而迁移没跑时，症状不是起不来，
   是某几条端点回 500，而界面上只说「服务内部错误」。
   那句自检要能读到这张表才成立。

   **只给 SELECT。** 写它是迁移工具的事，应用一个字节都不该改。 */
GRANT SELECT ON schema_migration TO sitedesk_app;

-- Down Migration
REVOKE SELECT ON schema_migration FROM sitedesk_app;
DROP FUNCTION IF EXISTS app.acceptance_for(uuid, text);
