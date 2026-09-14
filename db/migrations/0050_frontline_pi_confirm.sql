-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   PI 确认访视：从「等 PI 登录来点」改成「一线登记 PI 已确认」。

   ── 这是全系统最大的一处卡死 ────────────────────────────────────────
   在开发库上查出来的：

     done_pending_pi : 189        ← 卡住的
     locked          : 240
     planned         : 172
     绑了 PI 账号的中心：1 / 15

   CRC 做完访视之后状态是 `done_pending_pi`，只有 `piConfirm` 动作能把它
   推到 `locked` —— 而那个动作**只有外部的 pi 角色有**，服务层还额外要求
   `study_site.pi_account_id = 当前账号`。15 个中心里 14 个没绑 PI 账号，
   那 14 个中心的访视**永远推不动**。

   而契约里写着 `done_pending_pi` **不计入「已完成」统计**（I3）——
   所以入组进度、完成率、成本归集全都是系统性偏低的，
   **而且没有任何地方会报错**。

   ── 前提错在哪 ──────────────────────────────────────────────────────
   「只有 PI 本人能确认」这条规矩本身是对的：CRC 说做完了和 PI 确认做完了，
   在核查时是两回事。错的是它假定**PI 会登录这套系统来点那一下**。

   这是一个对内的系统。院方的研究者和机构办、伦理委员会一样，
   不是它的用户 —— 他们是**要被登记下来的事实**。
   同一个仓库里已经有对的形状：伦理批复不是等伦理委员会登录来点，
   是 `decideRegulatorySubmission`「登记伦理批复」。

   所以 I3 的实质保留、形式改变：
   **PI 在纸上签的字仍然是放行条件，只是那件事由一线登记进来。**
   谁登记的进审计轨迹；PI 签字那一页可以作为凭证上传（与受理意见函同一条路）。

   ── 这条迁移做四件事 ────────────────────────────────────────────────
   ① `piConfirm` 给 CRA / CRC（pi 角色保留 —— 真绑了账号的 PI 照样自己点）。
   ② 目录里那一行的说法跟着改：「PI 确认访视」→「登记 PI 确认访视」。
   ③ 放松 `visit_locked_needs_pi`：`pi_confirmed_by` 可以为空。
   ④ 把开发库上已经卡住的那 189 条推过去（只动演示数据，判据见下）。

   第三件要单独说，因为它在放松一条约束。原来是

     (status = 'locked') = (pi_confirmed_by IS NOT NULL AND pi_confirmed_at IS NOT NULL)

   `pi_confirmed_by` 是一个 account 外键 —— 而 PI 多数时候**没有账号**。
   逼着填，只能填成登记人自己，那就是把「登记人」冒充成「确认人」，
   比空着糟得多。空着是一个有意义的事实：**PI 不在本系统里签的字。**

   `pi_confirmed_at`（签字日期）**仍然必填** —— 没有日期的"已确认"，
   核查问起来照样答不出。这一半一个字没动。

   与迁移 0048 对 `accepted_by` 做的是同一件事、同一个理由。
   ══════════════════════════════════════════════════════════════════════ */

UPDATE action_key SET label = '登记 PI 确认访视' WHERE code = 'piConfirm';

/* ── 新开的租户要拿到同一套 ────────────────────────────────────────────
   只写 `INSERT INTO role_action` 会补上现存租户，**新开的租户拿不到** ——
   角色目录是 `provision_tenant_roles` 那一份，不改它的话，
   下一个租户开出来 CRA / CRC 又是不能确认的。
   db/test/tenant.test.js「新租户与演示租户逐条一致」钉着这件事。
   （0045 在这上面栽过一次，0046 的注释里也写着同一句。） */
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
     /* subject 不在这里 —— 理由见迁移 0046 文件头。要给，去「组织与权限」里给。 */
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
     ARRAY['pm','team','approve','intake','feas','sites','enr','screen','mon','change','staff','qa','pnl','trail']::text[]),
    /* CRA / CRC 这一版新增 `piConfirm` —— 他们本来就是唯一拿着那张
       签了字的纸的人。给了动作还要给得到入口：访视详情页（`sched`/`subj`
       进得去的那一页）上多一块「登记 PI 确认」，模块清单不用动。 */
    ('cra',  '临床监查员 CRA',         false, 'assigned',
     ARRAY['subject']::text[],
     ARRAY['advance','capaWrite','isfWrite','monitor','piConfirm','raiseQ','subjRead','timeWrite']::text[],
     ARRAY['cra','mysites','mon','query','screen','feas','material','time','qa','capa','trail']::text[]),
    ('crc',  '临床协调员 CRC',         false, 'assigned',
     ARRAY['subject']::text[],
     ARRAY['advance','capaWrite','ethics','isfWrite','piConfirm','subjRead','subjWrite','timeWrite']::text[],
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

/* 现存租户的角色在这里直接补。**四个角色一起重发**，不是只写 cra / crc
   两行 —— 理由与 0046 同：`allowed` 那一栏是按目录整体成立的，
   只改两行的话，将来有人在界面上给别的角色勾过 piConfirm，
   这条迁移就悄悄把它留下了，而新开的租户没有。 */
INSERT INTO role_action (role_id, action_key, allowed)
SELECT r.id, 'piConfirm', r.code IN ('admin', 'pi', 'cra', 'crc') FROM role r
ON CONFLICT (role_id, action_key) DO UPDATE SET allowed = EXCLUDED.allowed;

ALTER TABLE subject_visit DROP CONSTRAINT visit_locked_needs_pi;
ALTER TABLE subject_visit ADD CONSTRAINT visit_locked_needs_pi CHECK
  ((status = 'locked') = (pi_confirmed_at IS NOT NULL));

COMMENT ON COLUMN subject_visit.pi_confirmed_by IS
  '在本系统里点下确认的那个账号。**为空是常态**：PI 多数时候没有本系统的账号，
   确认由一线登记 —— 填一个登记人自己进去，是把「登记人」冒充成「确认人」。
   谁登记的进审计轨迹；PI 签的那一页由凭证回答。';
COMMENT ON COLUMN subject_visit.pi_confirmed_at IS
  'PI 签字确认的日期。**锁定必须有它** —— 没有日期的「已确认」，核查问起来答不出。';

/* ── 存量：189 条卡住的访视 ────────────────────────────────────────────
   **这一条只在演示库上成立，而且只动演示数据。**

   种子生成器（tools/gen-seed.mjs）里 `locked` 是按「这个中心有没有 PI 账号」
   定的：`const locked = past && !!piAcc`。也就是说这 189 条不是业务事实，
   是旧模型的产物 —— 那 14 个没绑 PI 账号的中心，做完的访视只能停在这里。

   生成器已经跟着改（不再看 piAcc），所以**此后重新灌的演示库不会再有它们**。
   这一条处理的是已经灌过的那些。

   判据刻意收得很紧：只动 `pi_confirmed_by IS NULL`（从来没有人确认过）
   且 `actual_date` 在**今天之前**的行。真实业务里由人确认过的，
   `pi_confirmed_by` 非空，一条都不碰。

   `pi_confirmed_at` 取 `actual_date` —— 访视当天签的字，
   这是演示数据里唯一有依据的日期。**不取 now()**：那会让一份
   2024 年的访视记录挂上 2026 年的确认时间，而那种日期在核查时是刺眼的。 */
UPDATE subject_visit
   SET status = 'locked',
       pi_confirmed_at = actual_date::timestamptz + interval '18 hours'
 WHERE status = 'done_pending_pi'
   AND pi_confirmed_by IS NULL
   AND actual_date IS NOT NULL
   AND actual_date < CURRENT_DATE;

-- Down Migration
/* 回滚不把那 189 条推回去 —— 它们现在是合法的 locked 行，
   而"推回去"要重新判断哪些是这条迁移动过的，判据已经没了。
   约束加回来之前得先把 pi_confirmed_by 为空的 locked 行退回待确认，
   否则 ADD CONSTRAINT 直接失败，而一次失败的回滚比不回滚更难收拾。 */
UPDATE subject_visit SET status = 'done_pending_pi', pi_confirmed_at = NULL
 WHERE status = 'locked' AND pi_confirmed_by IS NULL;

ALTER TABLE subject_visit DROP CONSTRAINT visit_locked_needs_pi;
ALTER TABLE subject_visit ADD CONSTRAINT visit_locked_needs_pi CHECK
  ((status = 'locked') = (pi_confirmed_by IS NOT NULL AND pi_confirmed_at IS NOT NULL));

INSERT INTO role_action (role_id, action_key, allowed)
SELECT r.id, 'piConfirm', r.code IN ('admin', 'pi') FROM role r
ON CONFLICT (role_id, action_key) DO UPDATE SET allowed = EXCLUDED.allowed;

UPDATE action_key SET label = 'PI 确认访视' WHERE code = 'piConfirm';

/* provision_tenant_roles 不还原 —— 与 0046 的 Down 同一个处理：
   把上一版的函数体在这里再抄一遍，抄错的风险比留着它高，
   而多出来的那两个动作在 role_action 被重发之后对现存租户不生效。 */
