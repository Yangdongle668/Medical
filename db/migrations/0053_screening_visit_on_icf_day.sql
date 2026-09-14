-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   筛选期访视：排在签知情那一天，而且**每个在筛的人都得有一条**。

   ── 现场报来的原话 ──────────────────────────────────────────────────
   入组被拦下，提示叫他去受试者访视窗口看看访视排了没有。他去了：

     「但是页面没有可以操作的按钮，只有一个脱落」

   那一行是 `筛选中`、`0/0`、下一次访视空白。也就是说这一例除了作废，
   没有任何出路 —— 入组要求筛选期访视已完成并登记 PI 确认，
   而它连访视都没有；而访视只能由「签署知情同意」那一下排出来，
   知情却已经签过了，不会再签第二次。

   这一条底下是**两个**毛病，都在这条迁移里收拾。
   （第三个在服务端：`signIcf` 在项目没配 SOA 时会安静地造出同样的死角，
     已改成 fail-closed —— 见 clinical.service.ts。）

   ── 毛病一：SOA 的 seq 0 写的是 offset -14 ──────────────────────────
   `visit_template` 的筛选期那一行是 `anchor='icf', offset_days=-14`，
   意思是"锚点（知情签署日）往前 14 天"。于是 `signIcf` 排出来的
   筛选期访视**一生下来就已经超窗**：

     实测 ICF 2026-09-14 → target 2026-08-31，窗口 08-28 ~ 09-04，
     out_of_window = true，daysLeft = -10。

   而超窗完成必须生成方案偏离（I4）—— 换句话说，**每登记一个新受试者，
   系统都会给他记一次方案偏离**，而没有任何地方会说这是排期排错了。
   一个中心一年几十例，核查看到的就是几十条凭空的偏离。

   这个 -14 不是原型定的：原型的 SOA 只给了 cycle / win / last / label /
   tasks，一个 offset 都没有（prototype/index.html）。而它 seq 0 的任务
   清单第一项就是「知情同意签署（核对现行版本 V3.0）」——
   筛选期访视本来就发生在签知情那一天前后，不是它之前两周。
   所以 0：目标日 = 知情签署日，窗口前后各 win 天。
   生成器那一侧同时改掉了（tools/gen-seed.mjs），两边得一致。

   ── 毛病二：在筛的人有一批**根本没有访视** ──────────────────────────
   种子把漏斗计数展开成受试者行时，`screening` 那一批只插了受试者、
   没插访视 —— 而真实流程里 `signIcf` 一定会连它一起排出来。
   于是演示库里有 14 位**进得去出不来**的人，现场撞上的就是其中一位。

   生成器已经补上了，但那只对**重新灌种子**的库有效。已经在跑的库
   （包括线上那台）里那 14 行还在，而它们带着现场的真实使用痕迹，
   不能靠 db:reset 重来。所以这里按 SOA 把缺的那条补出来：
   target = 该例的知情签署日，与 `signIcf` 现在的算法逐字一致。

   ── 补出来的访视是**逾期**的，这是实话 ──────────────────────────────
   这 14 例的知情签在半个多月前，补出来的访视目标日就是那一天，
   今天看过去自然已经出了窗口。不把日期挪到今天：
   知情签署日是一张纸上的事实，挪它是改记录。
   逾期但**办得下去**（完成 → 登记 PI 确认 → 入组，超窗那一下照规矩生成
   方案偏离）比一个只有「登记脱落」的死角强 —— 前者是积压，后者是墙。

   ── 只补 `screening` ────────────────────────────────────────────────
   `prescreen` 还没签知情，本来就不该有访视；`screen_failed` / `withdrawn`
   已经出组；`enrolled` 早过了这道闸门，补一条 planned 的筛选期访视只会
   让访视清单多出 219 条永远做不完的活。
   ══════════════════════════════════════════════════════════════════════ */

UPDATE visit_template SET offset_days = 0
 WHERE seq = 0 AND anchor = 'icf' AND offset_days = -14;

/* 缺访视的在筛受试者 —— `icf_signed_on IS NOT NULL` 不是多余的：
   目标日要从它算，为空的话算出来是 NULL，而 target_date 是 NOT NULL，
   整条迁移会在这里失败。现存库里这样的行有 0 条（`signIcf` 两个字段
   一起写），但"现在没有"不等于"不会有"，而这里宁可漏掉一行也不要炸。
   真漏了的话它仍然是个死角，下面那句 RAISE WARNING 会把它数出来。 */
WITH missing AS (
  SELECT s.id AS subject_id, s.tenant_id, s.study_site_id,
         ss.study_id, s.icf_signed_on
    FROM subject s
    JOIN study_site ss ON ss.id = s.study_site_id
   WHERE s.state = 'screening'
     AND s.icf_signed_on IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM subject_visit v
                      WHERE v.subject_id = s.id AND v.seq = 0)
),
ins AS (
  INSERT INTO subject_visit (tenant_id, subject_id, study_site_id, seq, visit_code,
                             visit_label, target_date, window_days, status)
  SELECT m.tenant_id, m.subject_id, m.study_site_id, 0, t.visit_code, t.visit_label,
         /* 上面那句已经把 offset 改成 0 了，这里照样把它算进去 ——
            写死 `= icf_signed_on` 的话，哪天 SOA 真的给筛选期配了别的
            offset，这条补出来的访视就和 `signIcf` 排的不是一回事。 */
         m.icf_signed_on + t.offset_days, t.window_days, 'planned'
    FROM missing m
    JOIN visit_template t ON t.study_id = m.study_id AND t.seq = 0
  RETURNING id, study_site_id
)
/* 任务清单一起补 —— 「这次要做哪几项」不该靠 CRC 记忆，
   而一条 0/0 的访视和没有访视一样说不出下一步。 */
INSERT INTO subject_visit_task (visit_id, seq, task)
SELECT ins.id, vt.seq, vt.task
  FROM ins
  JOIN study_site ss ON ss.id = ins.study_site_id
  JOIN visit_template_task vt ON vt.study_id = ss.study_id AND vt.visit_seq = 0
 ORDER BY ins.id, vt.seq;

/* 补完了还剩下的死角报出来 —— 静悄悄跑完但一行没补，
   和这条迁移不存在是一个效果。 */
DO $$
DECLARE v_left bigint;
BEGIN
  SELECT count(*) INTO v_left FROM subject s
   WHERE s.state = 'screening'
     AND NOT EXISTS (SELECT 1 FROM subject_visit v
                      WHERE v.subject_id = s.id AND v.seq = 0);
  IF v_left > 0 THEN
    RAISE WARNING '仍有 % 位在筛受试者没有筛选期访视 —— 多半是缺 icf_signed_on 或该项目没配 SOA 的 seq 0', v_left;
  END IF;
END $$;

-- Down Migration
/* offset 退回 -14，只退还是 0 的那些 —— 之后有人把某个项目的筛选期
   配成别的值，那是他的配置，不该被回滚冲掉。 */
UPDATE visit_template SET offset_days = -14
 WHERE seq = 0 AND anchor = 'icf' AND offset_days = 0;

/* 补出来的那些访视**不删** —— 与 0050 的 Down 同一个处理：
   它们现在是合法的 planned 行，CRC 可能已经在上面勾了任务、
   填了日期；而"哪几条是这条迁移补的"这个判据已经没了。
   删错一条是丢现场记录，比留着一条多出来的访视严重得多。 */
