-- ════════════════════════════════════════════════════════════════════
-- 演示账号的登录链接收件地址。
--
-- 从 001 里分出来，不是为了整齐：001 是 tools/gen-seed.mjs 从原型生成的
-- **产物**，重跑一次就会被覆盖。手写的东西放进去，迟早会在某一次
-- 重新生成时安静地消失。
--
-- ── 为什么是「每一个在职账号」，不是挑几个 ──────────────────────────
-- 没有登记地址的账号申请链接时，服务端**不签发**（见迁移 0015）——
-- 对外仍然是同一个 202，但那个人永远收不到链接。
-- 演示环境里只给几个人登记的话，其余账号看起来就是"登录坏了"，
-- 而唯一的线索在服务端日志里。演示数据不该留这种坑。
--
-- 域名一律用 .example —— RFC 2606 保留给文档用，永远不会被注册。
-- 用一个看起来像真的域名，第一次把演示环境的 SMTP 接上时，
-- 这些信就真的发出去了，发给谁不知道。
-- ════════════════════════════════════════════════════════════════════
INSERT INTO auth_identity (account_id, provider, subject)
SELECT a.id, 'magic-link',
       a.login || '@' ||
       -- 外部方（机构办、PI）用医院的域，和内部账号分开 ——
       -- 一次性链接对两者是同一条路径，域名不同只是为了看着像真的
       CASE WHEN a.is_external THEN 'pumch.example' ELSE 'hengji.example' END
  FROM account a
 WHERE a.status = 'active'
   AND NOT EXISTS (
     SELECT 1 FROM auth_identity i
      WHERE i.account_id = a.id AND i.provider = 'magic-link');
