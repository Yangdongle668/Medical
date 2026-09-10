-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   编号：一处规则，一处发号。

   ── 在此之前，同一个系统里有三套编号办法 ────────────────────────────

   ① 手输。中心编号、筛选号、分组编号、员工登录名都靠人现想现打。
      「增加工作量」只是它最轻的代价：**没有人能保证两个人想的是同一套**，
      于是台账上迟早并排出现 SS-16 和 16 号中心和 BJ-协和-01。

   ② `Date.now().toString(36)`：立项申请、监查访视、内部稽查、数据质疑、
      方案偏离、SAE 各一处。生成的是 NP-MTV8AZLR 这样的串 ——
      它唯一、它不撞，但它**不可读、不可排序、不可口述**。
      而演示数据里同一张表的编号是 NP-2026-011：
      **同一套台账上，seed 灌进去的和系统自己生成的长得完全不一样。**

   ③ `count(*) + 1`：可行性、投标、合同变更、立项受理各一处。
      格式是对的，取号方式是错的 —— 与 0042 修掉的方案编号同一个 bug：
      **行数不是序号**。序号一旦有缺口，行数永远追不上最大号，
      每次都撞在缺口后面那个已经用掉的号上，而那些 code 列上都有
      UNIQUE (tenant_id, code) —— 撞了就是一个 500。
      演示数据里 AC-2026 的号是 001、002、038、041 —— 缺口不是意外，
      是常态。而且那句 count 是**在 RLS 下数的**：行范围 team 的人
      数出来的是"本组的那几条"，撞得更早。

   ── 这一版把三套合成一套 ────────────────────────────────────────────

   `code_rule` 说清每一种编号长什么样，`app.next_code()` 负责发号。
   服务层不再自己拼字符串 —— 拼字符串的地方就是下一处会漂移的地方。

     形状 year ：前缀-年-序号     HJ-2026-005 · FS-2026-007
     形状 flat ：前缀-序号        SS-16 · G-03 · Q-1180
     形状 child：上级号-前缀序号  SS-16-P001（受试者跟着中心走）

   ── 三条设计取舍 ────────────────────────────────────────────────────

   **规则表不分租户，计数器分。** 编号长什么样是产品约定，不是租户数据；
   但序号必须一租户一套，所以 max() 永远带 tenant_id 条件。

   **按最大号取，不按行数。** 理由见上，也见 0042。

   **SECURITY DEFINER。** 取号问的是"这个号有没有被人用过"，
   不是"你看得见谁" —— 在 RLS 下数会漏掉别人的号然后撞上去。

   **同一个号段以 advisory lock 串行。** 并发两笔会算出同一个号，
   唯一约束把它变成 500。锁的粒度是"租户 + 号段"，
   不同项目、不同年份、不同中心的受试者互不排队。

   ── 顺带对齐的一处语义 ──────────────────────────────────────────────

   year 形状取的是**发号当天**的年份，不是记录上那个日期的年份。
   投标、可行性、合同变更原来按 b.submittedOn / b.surveyedOn / b.raisedOn
   取年，而立项受理和方案编号按当天取 —— 三处不一致。取当天：
   台账号答的是"什么时候登记的"，不是"事情什么时候发生的"；
   而按事件日期取年，序号就不再单调 —— 2026 年补录一条 2025 年的记录，
   会在早已封账的 2025 号段里插一个比现有号都大的号。

   ── 不归这里管的两个 ────────────────────────────────────────────────

   **随机号**留给人填。它是 IWRS / 中央随机系统发的，本系统只是抄录 ——
   一个能自己编随机号的临床系统，编出来的每一个号都是假的。

   **员工登录名**也留给人填。它是人自己要记住、要说给别人听的东西，
   由中文名机器转写出来的 login 只会得到 zhang3、li4 这种谁也认不出的串。
   ══════════════════════════════════════════════════════════════════════ */

CREATE TABLE code_rule (
  kind    text PRIMARY KEY,
  prefix  text NOT NULL CHECK (prefix ~ '^[A-Z]{1,6}$'),
  shape   text NOT NULL CHECK (shape IN ('year', 'flat', 'child')),
  width   int  NOT NULL CHECK (width BETWEEN 2 AND 6),
  src     text NOT NULL,
  col     text NOT NULL DEFAULT 'code',
  label   text NOT NULL
);
COMMENT ON TABLE code_rule IS
  '每一种编号长什么样 —— 唯一的一份。服务层不许自己拼编号字符串，
   由 tools/arch-check.mjs 断言。';

INSERT INTO code_rule (kind, prefix, shape, width, src, col, label) VALUES
  ('study',       'HJ',  'year',  3, 'study',              'code',         '项目'),
  ('site',        'SS',  'flat',  2, 'study_site',         'code',         '中心'),
  ('team',        'G',   'flat',  2, 'team',               'code',         '分组'),
  ('subject',     'P',   'child', 3, 'subject',            'screening_no', '受试者筛选号'),
  ('intake',      'NP',  'year',  3, 'intake_application', 'code',         '立项申请'),
  ('feasibility', 'FS',  'year',  3, 'feasibility',        'code',         '可行性调查'),
  ('bid',         'B',   'year',  2, 'bid',                'code',         '投标'),
  ('change',      'CR',  'year',  3, 'contract_change',    'code',         '合同变更'),
  ('acceptance',  'AC',  'year',  3, 'site_acceptance',    'code',         '立项受理'),
  ('monitor',     'MV',  'year',  3, 'monitor_visit',      'code',         '监查访视'),
  ('audit',       'AU',  'year',  3, 'internal_audit',     'code',         '内部稽查'),
  ('quality',     'QI',  'year',  4, 'quality_event',      'code',         '质量事件'),
  ('query',       'Q',   'flat',  4, 'quality_event',      'code',         '数据质疑'),
  ('deviation',   'DEV', 'year',  3, 'quality_event',      'code',         '方案偏离'),
  ('sae',         'SAE', 'year',  3, 'quality_event',      'code',         '严重不良事件'),
  ('saeLate',     'SAEL','year',  3, 'quality_event',      'code',         'SAE 超时上报');

GRANT SELECT ON code_rule TO sitedesk_app;

CREATE FUNCTION app.next_code(p_kind text, p_parent text DEFAULT NULL)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
DECLARE
  r        code_rule%ROWTYPE;
  v_tenant uuid := app.current_tenant_id();
  v_stem   text;   -- 序号之前的一切，含分隔符
  v_next   int;
BEGIN
  SELECT * INTO r FROM code_rule WHERE kind = p_kind;
  IF NOT FOUND THEN
    RAISE EXCEPTION '没有登记编号规则：% —— 规则在 code_rule 表里，不在代码里', p_kind;
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION '取编号时没有租户上下文 —— app.current_tenant_id() 为空';
  END IF;

  v_stem := CASE r.shape
    WHEN 'year' THEN r.prefix || '-' || extract(year FROM CURRENT_DATE)::int::text || '-'
    WHEN 'flat' THEN r.prefix || '-'
    WHEN 'child' THEN
      CASE WHEN coalesce(p_parent, '') = '' THEN NULL
           ELSE p_parent || '-' || r.prefix END
  END;
  IF v_stem IS NULL THEN
    RAISE EXCEPTION '「%」的编号要挂在一个上级编号下面（比如中心号），但没给', r.label;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_tenant::text || '|' || v_stem, 0));

  /* starts_with 而不是 LIKE：上级编号是数据，里面出现 % 或 _ 时
     LIKE 会安静地多匹配一批别人的号，然后发一个已经用掉的号出去。 */
  EXECUTE format(
    'SELECT coalesce(max(substring(%I FROM %s)::int), 0) + 1
       FROM %I
      WHERE tenant_id = $1
        AND starts_with(%I, $2)
        AND substring(%I FROM %s) ~ ''^[0-9]+$''',
    r.col, (length(v_stem) + 1)::text, r.src,
    r.col, r.col, (length(v_stem) + 1)::text)
    INTO v_next USING v_tenant, v_stem;

  RETURN v_stem || lpad(v_next::text, r.width, '0');
END $$;

COMMENT ON FUNCTION app.next_code(text, text) IS
  '按 code_rule 发下一个编号。按最大号 + 1 取（行数不是序号），
   SECURITY DEFINER 绕开 RLS（取号问的是"这个号有没有被人用过"），
   同租户同号段以 advisory lock 串行。';

GRANT EXECUTE ON FUNCTION app.next_code(text, text) TO sitedesk_app;

/* 0042 那个只管方案编号的函数并进来 —— 两个发号处就是两套规则的开始。 */
DROP FUNCTION IF EXISTS app.next_study_code(int);

-- Down Migration
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
GRANT EXECUTE ON FUNCTION app.next_study_code(int) TO sitedesk_app;

DROP FUNCTION IF EXISTS app.next_code(text, text);
DROP TABLE IF EXISTS code_rule;
