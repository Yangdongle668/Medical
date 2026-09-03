-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   立项受理与中心文件（ISF）—— 最后两张表。

   ── 受理是医院承接项目的第一道闸门 ────────────────────────────────
   形式审查只看材料是否齐备与合规，**不评价科学性**（那是伦理委员会
   与专业组的事）。但它是一道真闸门：**材料不齐就受理，
   后面所有环节都会带着这个缺口往下走。**

   所以受理接进中心状态机：未受理不能递伦理（gate.ts 的 irb_submit）。
   那个文件自己写着"再加检查项时，要么带着它的数据一起来，要么别加" ——
   这次带着数据来了。

   ── 受理是**双方共同的记录**，不对外部方关闭 ──────────────────────
   与前面几张表（立项申请、内部稽查、监查排期）相反：
   递交方要看到缺什么，受理方要出具受理通知。
   把它对机构办藏起来，这张表就只剩一半用处。

   ── 受理发生在**建档之前**，所以它不能挂在 study_site 上 ──────────
   原型那两条受理记录，一条指向一个我方台账里还没有的项目
   （HJ-2026-004），另一条指向协和还没建过的中心 ——
   两条都**找不到对应的 study_site**。

   这不是原型的数据错了，是流程本来如此：材料先递到医院，
   受理通过、伦理批下来、合同谈完，中心才进我方台账。
   （上一版那个「建档滞后」指标，正是这件事从我方一侧看到的样子。）

   所以这张表挂的是 (study_id, hospital)，study_site_id 建档之后回填。
   行策略因此用 app.site_visible 的四参数版本，而不是 site_visible_by_id ——
   后者要先有一行中心才判得出来。

   ── ISF 的状态**不能存**，只能算 ────────────────────────────────
   原型把它写成 `st: "good" | "warn" | "crit"`，而同一行的备注写着
   「2026-10-18 到期，需提前 60 天递交」—— 也就是说状态本来就是
   从到期日推出来的。

   存成枚举的后果是**它会过期**：六月标 good 的那一项，十月已经是 crit，
   而没有人会回去改。原型自己那句
   「人员资质缺失与药品效期……都能被日历提醒兜住，却经常没人管」，
   说的正是这件事 —— 而一个存着过期状态的系统，连日历都算不上。

   所以这里只存**事实**（在不在、什么时候到期），
   状态由 @sitedesk/calc 按今天算出来。
   ══════════════════════════════════════════════════════════════════════ */

/* ── 立项受理 ─────────────────────────────────────────────────── */
CREATE TABLE site_acceptance (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  code          text NOT NULL,
  /* 递交到哪家医院的哪个项目。**不是 study_site** —— 受理发生在建档之前，
     那时候还没有中心那一行（见文件头）。 */
  study_id      uuid NOT NULL REFERENCES study(id),
  hospital      text NOT NULL,
  /* 项目的那几项事实**抄在这一行上，不去 join**。

     不是图快 —— 是因为**受理发生在建档之前**：那时候医院在我方台账里
     一个中心都没有，于是 study 与 client 两张表按行策略对它一行都不可见
     （client 干脆对外部方整个关闭）。内联 join 过去，
     这张"给机构办看的表"会对机构办返回**空列表** ——
     一张为对方存在的表，对方看不见。

     而这几项本来就写在立项申请表上：**受理记录是一份递交材料的存根，
     不是我方 CRM 的一个视图。** 可行性调查（迁移 0029）同样把医院、
     科室、PI 抄在行上，理由一模一样：它也发生在建档之前。 */
  study_code    text NOT NULL,
  drug          text NOT NULL,
  sponsor_name  text NOT NULL,
  phase         text NOT NULL,
  /* 建档之后回填。空表示**受理了但中心还没进台账** ——
     那正是「建档滞后」在这一侧的样子。 */
  study_site_id uuid REFERENCES study_site(id),
  submitted_by  uuid NOT NULL REFERENCES account(id),
  submitted_on  date NOT NULL DEFAULT CURRENT_DATE,
  state         text NOT NULL DEFAULT 'review'
                  CHECK (state IN ('review','amend','accepted')),
  /* 补正通知的内容。**发了补正通知却不说缺什么**，
     递交方只能把八份材料重寄一遍。 */
  amend_note    text,
  accepted_on   date,
  accepted_by   uuid REFERENCES account(id),
  /* 这条受理是**在本系统里办的**，还是只登记了一个既成事实的受理号。

     台账里那十五个中心早就过了立项 —— 它们的受理发生在几年前的医院里，
     多数医院的机构办根本不是本系统的用户。原型自己就承认这件事：
     建档表单上「机构受理号」的提示写着「由医院机构办受理后回填，可留空」。

     两者必须分得开，因为**它们的材料清单意义完全相反**：
     in_system 的空清单是「八项都齐」，registered 的空清单是「没人在这儿查过」。
     混成一个状态，界面就会对着一条谁也没审过的记录报「材料齐备」。 */
  origin        text NOT NULL DEFAULT 'in_system'
                  CHECK (origin IN ('in_system','registered')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, code),
  /* 一家医院在同一个项目上只有一次立项受理。补正重交仍是同一条，
     两条的话「这个中心受理号是多少」就有两个答案。 */
  UNIQUE (tenant_id, study_id, hospital),

  /* 受理日必须有 —— 没有日期的「已受理」，伦理那边问起来答不出。 */
  CONSTRAINT acceptance_accepted_shape CHECK
    ((state = 'accepted') = (accepted_on IS NOT NULL)),
  /* 但**受理人只在本系统办的那一条上必填**：系统外的受理，
     受理人是医院里某个不在本系统的老师，填谁都是编的。
     accepted_by IS NULL 因此是一个有意义的事实，不是漏填。 */
  CONSTRAINT acceptance_actor_shape CHECK
    (origin = 'registered' OR state <> 'accepted' OR accepted_by IS NOT NULL),
  /* 登记一件没发生的事没有意义：既成事实的受理号只能是已受理的。 */
  CONSTRAINT acceptance_registered_is_accepted CHECK
    (origin <> 'registered' OR state = 'accepted'),
  CONSTRAINT acceptance_amend_needs_note CHECK
    (state <> 'amend' OR (amend_note IS NOT NULL AND length(btrim(amend_note)) >= 4))
);
CREATE TRIGGER site_acceptance_touch BEFORE UPDATE ON site_acceptance
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

/* 形式审查清单。**每一项都要能单独勾** ——
   一个"材料齐备 6/8"的进度条，说不出缺的是哪两份。 */
CREATE TABLE acceptance_doc (
  acceptance_id uuid NOT NULL REFERENCES site_acceptance(id) ON DELETE CASCADE,
  seq           int NOT NULL,
  name          text NOT NULL,
  present       boolean NOT NULL DEFAULT false,
  PRIMARY KEY (acceptance_id, seq)
);

/* ── 中心文件与物资（ISF） ─────────────────────────────────────── */
CREATE TABLE isf_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  study_site_id uuid NOT NULL REFERENCES study_site(id),
  category      text NOT NULL CHECK (category IN
                  ('dossier','credential','ip','equipment')),
  item          text NOT NULL,
  /* 在不在。**不在的东西没有到期日** —— 那是两种不同的缺，
     混起来会让"缺失"和"过期"在统计上互相顶替。 */
  present       boolean NOT NULL DEFAULT true,
  expires_on    date,
  /* 提前多少天预警。空表示按类别默认（写在 @sitedesk/calc 里）——
     伦理年度跟踪要提前 60 天递交，而药品效期提前 30 天换批就够。 */
  lead_days     integer CHECK (lead_days > 0 AND lead_days <= 365),
  /* 物资库存与补货线。**模块名就是「中心文件与物资」** ——
     知情同意书空白件、药品盒数这类东西只有到期日装不下：
     库存 4 份、低于 10 份补货线，是一个跟到期日无关的问题。
     两个一起有或一起没有：只有库存没有补货线，「少到多少算少」没有答案。 */
  quantity      integer CHECK (quantity >= 0),
  reorder_at    integer CHECK (reorder_at >= 0),
  note          text,
  checked_on    date,
  checked_by    uuid REFERENCES account(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (study_site_id, category, item),

  CONSTRAINT isf_missing_has_no_expiry CHECK (present OR expires_on IS NULL),
  CONSTRAINT isf_stock_shape CHECK ((quantity IS NULL) = (reorder_at IS NULL)),
  CONSTRAINT isf_checked_shape CHECK ((checked_on IS NULL) = (checked_by IS NULL))
);
CREATE INDEX isf_expiring_idx ON isf_item (expires_on)
  WHERE expires_on IS NOT NULL;
CREATE TRIGGER isf_item_touch BEFORE UPDATE ON isf_item
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMENT ON TABLE isf_item IS
  '中心文件与物资。**这里只存事实（在不在、什么时候到期），不存状态。**
   状态由 @sitedesk/calc 按今天算 —— 存成枚举它会过期：
   六月标"齐备"的那一项，十月已经是缺项，而没有人会回去改。';

ALTER TABLE site_acceptance ENABLE ROW LEVEL SECURITY;
ALTER TABLE acceptance_doc  ENABLE ROW LEVEL SECURITY;
ALTER TABLE isf_item        ENABLE ROW LEVEL SECURITY;

/* 受理**不对外部方关闭** —— 它是双方共同的记录。
   用四参数的 app.site_visible：中心那一行可能还不存在，
   而 site_visible_by_id 要先有它才判得出来（那时候会一律判成不可见，
   于是机构办看不到递给自己的材料 —— 这张表就废了一半）。
   PI 那一维传 NULL：立项阶段还没有指定主要研究者。 */
CREATE POLICY site_acceptance_scope ON site_acceptance FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND app.site_visible(site_acceptance.study_site_id,
                              site_acceptance.study_id,
                              site_acceptance.hospital, NULL))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.site_visible(site_acceptance.study_site_id,
                                   site_acceptance.study_id,
                                   site_acceptance.hospital, NULL));

CREATE POLICY acceptance_doc_scope ON acceptance_doc FOR ALL
  USING (EXISTS (SELECT 1 FROM site_acceptance a WHERE a.id = acceptance_id))
  WITH CHECK (EXISTS (SELECT 1 FROM site_acceptance a WHERE a.id = acceptance_id));

/* ISF 同样不关 —— **研究者文件夹是放在医院里的**，机构办本来就翻得到。
   对它藏起来，等于系统里的台账和现场那一摞纸对不上。 */
CREATE POLICY isf_item_scope ON isf_item FOR ALL
  USING (tenant_id = app.current_tenant_id()
         AND app.site_visible_by_id(isf_item.study_site_id))
  WITH CHECK (tenant_id = app.current_tenant_id()
              AND app.site_visible_by_id(isf_item.study_site_id));

-- Down Migration
DROP TABLE IF EXISTS isf_item;
DROP TABLE IF EXISTS acceptance_doc;
DROP TABLE IF EXISTS site_acceptance;
