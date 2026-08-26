-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   跨实例限流。

   ── 原来是什么样 ──────────────────────────────────────────────────
   `FixedWindow` 是一个进程内的 Map。它挡得住"随手刷"，代价写在
   apps/api/src/infra/rate-limit.ts 的注释里：

     多实例部署时每个实例各算各的，实际配额 = limit × 实例数。

   也就是说，**限流的阈值会随着扩容被静默放大**。扩到 3 个副本，
   "10 分钟 5 次"变成 15 次，而没有任何一处会说出来 —— 配置没变、
   日志没变、监控没变，只有被刷的那个邮箱知道。

   ── 原来为什么不放数据库 ──────────────────────────────────────────
   那条注释里的顾虑是真的，而且很重要：

     数据库版本天然跨实例，但它有个要命的副作用：
     **未认证的流量就此获得了一条写库的路径**。限流本身成了打库的手段。

   这一版没有反驳它，而是把它**挡在门外**：本地计数器仍然在，仍然是
   第一道；只有**通过了本地判定**的请求才轮得到这一张表。于是每个实例
   每个窗口每个 key 最多写 limit 次 —— 写库的量被限流器自己限住了。
   两级的分工是：本地那级挡洪水，这一级定阈值。

   ── 为什么 bucket 是哈希 ──────────────────────────────────────────
   key 是登录名和登录令牌的前缀。令牌前缀**绝不能明文落库** ——
   整套认证的前提就是"库里只有哈希"（见 0007）。所以应用侧先
   sha256(scope:key) 再送过来，这张表因此**不含任何可读信息**：
   它存不下人名，也存不下秘密。

   ── 规约 4 的例外 ────────────────────────────────────────────────
   没有 tenant_id。这是刻意的，而且是唯一能成立的做法：计数发生在
   **认证之前**，此刻既不知道是哪个租户，也不能去查 —— 查得出"这个
   登录名属于哪个租户"，这个接口就成了账号枚举器（见 0007 的说明）。
   代价是限流是全局的：不同租户的同名登录共用一个桶。在单租户部署下
   没有区别；将来真多租户了，桶名里加上租户前缀即可，前提是那时
   已经有一条**不泄漏**的租户判定路径。
   ══════════════════════════════════════════════════════════════════════ */

/* UNLOGGED：不写 WAL、不复制、崩溃后被清空。
   对计数器来说这些全是优点 —— 崩溃之后所有人重新开始计数，
   而"重启一次等于放行一个窗口"远比"每次限流都产生 WAL 流量"便宜。
   这也顺带把"未认证流量的写库路径"从主备复制里摘了出去。 */
CREATE UNLOGGED TABLE rate_limit_counter (
  bucket        text        PRIMARY KEY,
  window_start  timestamptz NOT NULL DEFAULT clock_timestamp(),
  hits          int         NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE rate_limit_counter IS
  '跨实例限流的固定窗口计数。bucket 是 sha256(scope:key)：这张表里不存人名，也不存令牌。'
  ' UNLOGGED —— 崩溃后清空是可以接受的（等于放行一个窗口），换掉的是 WAL 流量。';
COMMENT ON COLUMN rate_limit_counter.window_start IS
  '本窗口的起点。用 clock_timestamp() 而不是 now()：now() 是事务开始时间，'
  '在一个长事务里它是冻住的 —— 窗口于是永远过不去。';

/* 清理用。没有它，那次 DELETE 会全表扫一张只该被点查的表。 */
CREATE INDEX rate_limit_counter_gc_idx ON rate_limit_counter (window_start);

/* ── 应用角色够不着这张表 ──────────────────────────────────────────
   0001 的 ALTER DEFAULT PRIVILEGES 会自动把 CRUD 授给 sitedesk_app，
   这里收回去：唯一的入口是下面那个 SECURITY DEFINER 函数。
   理由和 login_token 一样 —— 未认证的请求能碰到的东西越少越好，
   而"能读这张表"等于能看出某个 key 最近有没有被用过。 */
REVOKE ALL ON TABLE rate_limit_counter FROM sitedesk_app;
/* 第二道：即使有人将来又把 GRANT 加回来，RLS 仍然把所有人挡在外面。
   owner 默认绕过 RLS，所以 SECURITY DEFINER 函数照常工作。

   策略写成显式的 `USING (false)`，而不是"开了 RLS 但一条策略都不建"——
   后者的效果一模一样，但看起来像**忘了建**。db/test/migration.test.js
   里有一条不变量正是在抓那种情况（启用而无策略），
   而这张表是唯一一处"就是要全拒"的地方 —— 那就把它写出来。 */
ALTER TABLE rate_limit_counter ENABLE ROW LEVEL SECURITY;
CREATE POLICY rate_limit_counter_no_direct_access ON rate_limit_counter
  FOR ALL USING (false) WITH CHECK (false);
COMMENT ON POLICY rate_limit_counter_no_direct_access ON rate_limit_counter IS
  '**故意全拒**：唯一入口是 app.rate_limit_hit（SECURITY DEFINER，以 owner 身份绕过本策略）。'
  ' 能直接读这张表，等于能看出某个 key 最近有没有被用过。';

/* ── 清理 ──────────────────────────────────────────────────────────
   单独一个函数，不是内联的 DELETE：内联的话它只在 1% 的调用里执行，
   于是**没有任何一条测试碰得到它** —— 一段永远不被验证的代码，
   等于一段迟早会错的代码。抽出来之后测试可以直接调它。

   不授给 sitedesk_app：未认证的请求不该有一条"触发全表清理"的开关。
   计数函数是 SECURITY DEFINER，内部以 owner 身份调它，够用了。 */
CREATE FUNCTION app.rate_limit_gc(p_older_than interval) RETURNS bigint
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
DECLARE v_gone bigint;
BEGIN
  DELETE FROM rate_limit_counter
   WHERE window_start < clock_timestamp() - p_older_than;
  GET DIAGNOSTICS v_gone = ROW_COUNT;
  RETURN v_gone;
END $$;

REVOKE ALL ON FUNCTION app.rate_limit_gc(interval) FROM public;

/* ── 计数 ──────────────────────────────────────────────────────────
   一条语句完成「窗口过期就重置，否则 +1」。分成"先查再写"的话，
   两个并发请求会双双读到 4、双双写回 5 —— 而限流器丢掉的那一次，
   正是它存在的理由。 */
CREATE FUNCTION app.rate_limit_hit(p_bucket text, p_limit int, p_window_ms int)
  RETURNS TABLE (allowed boolean, retry_after_sec int, remaining int)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
DECLARE
  v_window interval;
  v_start  timestamptz;
  v_hits   int;
BEGIN
  /* 参数校验放在这里，不放在调用方：这个函数是**未认证请求**能触达的
     少数几个之一，它得自己说得清什么是合法输入。 */
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION '限流阈值必须 ≥ 1（收到 %）', p_limit; END IF;
  IF p_window_ms IS NULL OR p_window_ms < 1000 OR p_window_ms > 86400000 THEN
    RAISE EXCEPTION '限流窗口必须在 1 秒到 1 天之间（收到 % 毫秒）', p_window_ms; END IF;
  IF p_bucket IS NULL OR length(p_bucket) > 128 THEN
    RAISE EXCEPTION 'bucket 不合法'; END IF;

  v_window := make_interval(secs => p_window_ms / 1000.0);

  INSERT INTO rate_limit_counter AS c (bucket, window_start, hits)
       VALUES (p_bucket, clock_timestamp(), 1)
  ON CONFLICT (bucket) DO UPDATE
     SET window_start = CASE WHEN c.window_start + v_window <= clock_timestamp()
                             THEN clock_timestamp() ELSE c.window_start END,
         /* 封顶：一个窗口内被刷到 int 溢出的话，计数会**回绕成负数**，
            于是限流器在被刷得最狠的时候放行。 */
         hits         = CASE WHEN c.window_start + v_window <= clock_timestamp()
                             THEN 1 ELSE least(c.hits + 1, 2000000000) END
  RETURNING c.window_start, c.hits INTO v_start, v_hits;

  /* 顺手清一次过期的行。没有清理的话，这张表会按"每个窗口出现过的不同
     key 数"一直长下去 —— 而 key 的多少由未认证流量决定。
     概率触发，不另开一个定时任务：定时任务是要部署、要监控、会忘记开的
     第三样东西，而这件事本身只值一行 DELETE。 */
  IF random() < 0.01 THEN
    PERFORM app.rate_limit_gc(greatest(v_window * 2, interval '10 minutes'));
  END IF;

  RETURN QUERY SELECT
    v_hits <= p_limit,
    CASE WHEN v_hits <= p_limit THEN 0
         ELSE greatest(1, ceil(extract(epoch FROM
                (v_start + v_window - clock_timestamp())))::int) END,
    greatest(0, p_limit - v_hits);
END $$;

COMMENT ON FUNCTION app.rate_limit_hit(text,int,int) IS
  '固定窗口计数，跨实例共享。调用方必须先在进程内计数器里过一道 ——'
  ' 否则未认证流量就有了一条直通数据库的路径，限流本身成了打库的手段。';

REVOKE ALL ON FUNCTION app.rate_limit_hit(text,int,int) FROM public;
GRANT EXECUTE ON FUNCTION app.rate_limit_hit(text,int,int) TO sitedesk_app;

-- Down Migration
DROP FUNCTION IF EXISTS app.rate_limit_hit(text,int,int);
DROP FUNCTION IF EXISTS app.rate_limit_gc(interval);
DROP TABLE IF EXISTS rate_limit_counter;
