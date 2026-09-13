-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   立项受理：从「形式审查工作流」收回到「两个日期 + 一份意向函」。

   ── 这一版建错了什么 ────────────────────────────────────────────────
   0038 把立项受理建成了一条**双方在系统里协作**的流程：递交方列出八项
   材料清单 → 机构办逐项勾 → 齐备则受理、不齐则发补正通知。那套模型本身
   没错，错在它假定**医院的机构办是本系统的用户**。

   而 0038 自己在同一个文件里写着相反的事实：

     「台账里那十五个中心早就过了立项 —— 它们的受理发生在几年前的医院里，
       **多数医院的机构办根本不是本系统的用户**。」

   它把这件事安置在 `origin = 'registered'` 那一支里，当成少数派。
   实际用下来，那一支才是常态：一线 CRC 的活不是在系统里跟机构办对清单，
   是**把两件已经发生的事报给项目管理员**——

     · 哪天成功递交的
     · 哪天拿到立项受理意向函的（连同那份 PDF）

   「递交了哪八份材料」在这条路上是一份没人读的清单：它由递交方自己填、
   自己不勾、也没有第二个人来勾。**一张永远不会被勾的清单，
   不是记录，是每次递交都要重填一遍的仪式。**

   ── 所以这一条改三件事 ──────────────────────────────────────────────
   ① 材料清单**不再必填**（契约里 min(1) → 可省略）。要列的照样列得出来，
      机构办那条流程一行代码没动 —— 收回的是"必须先编一张清单才递得出去"。
   ② 受理意向函**存得进来**：一份 PDF，一个日期。
      在此之前「拿到受理意向函」这件事在系统里唯一的痕迹是一个日期，
      而核查要看的是那张纸。
   ③ 放松 `acceptance_actor_shape`：已受理不再强制 `accepted_by` 非空。

   ── 第三条要单独说，因为它是在放松一条约束 ──────────────────────────
   原约束：`origin = 'registered' OR state <> 'accepted' OR accepted_by IS NOT NULL`
   意思是「本系统里办的受理，必须说得清是谁受理的」。

   它的前提是"本系统里办的"——而上面刚说清，那是少数。一条由 CRC 登记的
   受理，受理人是医院里某个不在本系统的老师：**填谁都是编的**，
   而约束逼着填，得到的就是编的。

   0038 自己已经写过这句话，只是把它限定在 registered 那一支上：

     「受理人是医院里某个不在本系统的老师，填谁都是编的。
       accepted_by IS NULL 因此是一个有意义的事实，不是漏填。」

   现在把它推广到两支。**丢掉的问责没有真的丢**：
   「谁在系统里登记了这条受理」进审计轨迹（记的是登记人，不是受理人 ——
   这两件事本来就不该混），而「医院那边是谁受理的」由那份意向函 PDF 回答，
   它比一个下拉框里挑出来的名字可靠得多。

   `acceptance_accepted_shape`（已受理必须有日期）**一个字没动**：
   没有日期的「已受理」，伦理那边问起来照样答不出。
   ══════════════════════════════════════════════════════════════════════ */

ALTER TABLE site_acceptance DROP CONSTRAINT acceptance_actor_shape;

COMMENT ON COLUMN site_acceptance.accepted_by IS
  '在本系统里点下「予以受理」的那个人。**为空是常态**：多数医院的机构办
   不是本系统的用户，受理由一线登记，而医院那边是谁受理的由意向函回答 ——
   填一个下拉框里挑出来的名字，是编的。谁登记的进审计轨迹。';

/* ── 立项受理意向函 ────────────────────────────────────────────────────
   本仓库第一份落库的**二进制附件**。几条刻意的选择：

   · **单独一张表，不是 site_acceptance 上的一列。** 受理台账是逐页翻的，
     而这份 PDF 只在有人点开时才要。列在主表上的话，
     「不要 SELECT 到那一列」就成了一条要靠自觉维护的规矩；
     分出来之后它是结构性的。

   · **bytea，不是对象存储。** 一份受理意向函是几百 KB 的扫描件，一个中心
     一份。为它引入 S3 / MinIO，等于给部署加一个必须先配对才能启动的依赖 ——
     而这套系统现在一条 `docker compose up` 就起得来。
     落在库里还顺带白拿两件事：**它跟着事务走**（登记失败就没有孤儿文件），
     **它跟着 RLS 走**（看不见那条受理的人也取不到那份 PDF）。
     真到了"一个中心几百份影像"的那天，再换存储是一次有明确边界的迁移，
     而不是现在就背上一个依赖。

   · **大小在库里也卡一道。** 应用层会先拒（见 acceptance.service），
     这里是第二道：两处都在，才防得住"有人写了裸 SQL"。 */
CREATE TABLE acceptance_letter (
  acceptance_id uuid PRIMARY KEY REFERENCES site_acceptance(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  filename      text NOT NULL CHECK (length(btrim(filename)) BETWEEN 1 AND 200),
  /* 只收 PDF。收件箱里那张纸是扫描件，而 PDF 是医院那边唯一会给的格式；
     放开成"任意类型"就得回答"浏览器打不开的那些怎么办"。 */
  content_type  text NOT NULL DEFAULT 'application/pdf'
                  CHECK (content_type = 'application/pdf'),
  bytes         bytea NOT NULL,
  size_bytes    integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
  uploaded_by   uuid NOT NULL REFERENCES account(id),
  uploaded_at   timestamptz NOT NULL DEFAULT now(),
  /* 存的大小必须等于真实大小 —— 列表页报的是 size_bytes，
     而两者对不上时，界面上那个"1.2 MB"就是一句没有出处的话。 */
  CONSTRAINT acceptance_letter_size_matches CHECK (octet_length(bytes) = size_bytes)
);

COMMENT ON TABLE acceptance_letter IS
  '立项受理意向函的扫描件，一条受理一份。跟着 site_acceptance 的行策略走 ——
   看不见那条受理的人，也取不到这份 PDF。';

ALTER TABLE acceptance_letter ENABLE ROW LEVEL SECURITY;
/* 跟着父行走，与 acceptance_doc 同一条写法：附件的可见性**不另立规矩** ——
   另立一套的话，"谁看得到这条受理"就有了两个答案，而它们会漂。 */
CREATE POLICY acceptance_letter_scope ON acceptance_letter FOR ALL
  USING (EXISTS (SELECT 1 FROM site_acceptance a WHERE a.id = acceptance_id))
  WITH CHECK (EXISTS (SELECT 1 FROM site_acceptance a WHERE a.id = acceptance_id));

-- Down Migration
DROP POLICY IF EXISTS acceptance_letter_scope ON acceptance_letter;
DROP TABLE IF EXISTS acceptance_letter;

/* 约束加回来之前先把会违反它的行补上 —— 直接 ADD CONSTRAINT 会失败，
   而一次失败的回滚比不回滚更难收拾。把这些行退回「审查中」：
   没有受理人的"已受理"正是这条约束不允许的状态。 */
UPDATE site_acceptance SET state = 'review', accepted_on = NULL
 WHERE origin <> 'registered' AND state = 'accepted' AND accepted_by IS NULL;

ALTER TABLE site_acceptance ADD CONSTRAINT acceptance_actor_shape CHECK
  (origin = 'registered' OR state <> 'accepted' OR accepted_by IS NOT NULL);
