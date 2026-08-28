-- Up Migration
/* ══════════════════════════════════════════════════════════════════════
   口令登录，与一个开箱就有的管理员。

   ── 先说清楚这里补的是什么洞 ──────────────────────────────────────
   `deploy/deploy.sh` 不带 --demo 跑完，库里有：一个租户、八个角色、
   一整套业务配置 —— 和**零个账号**。

   而建账号的那个接口（createAccount）要求调用方已经登录、且拿着
   `manage` 动作权限。登录只有一条路：一次性链接。链接要发给"本人"，
   收件地址从 auth_identity 里解析，而 auth_identity 挂在 account 上。

   于是：要登录得先有账号，要有账号得先登录。**一次干净的部署，
   没有任何人能进得去。** 这不是"少了个便捷功能"，是装完了打不开门。

   ── 为什么补的是口令，不是"再放宽一点魔法链接" ────────────────────
   链接那条路的每一环都有它存在的理由（不回显、不枚举、单次、短时效），
   为了开机去松其中任何一环，松掉的是所有人的登录安全，
   换来的只是第一天那一次。口令是**另开一扇门**，门自己带锁。

   ── 出厂口令是 admin ──────────────────────────────────────────────
   这是一个有意识的取舍，写在这里免得以后被当成疏忽：
   出厂口令弱到不能再弱，所以配套的三件事一件都不能少 ——
     ① 库里记着"这还是出厂口令"（is_initial），改过就永远翻不回来；
     ② API 启动时按这个标记打 WARN，界面上挂一条红条；
     ③ 改密就在界面里，不必登服务器。
   把 is_initial 做成一个**只能从 true 变 false** 的标记（见触发器），
   是因为它唯一的用处就是报警 —— 一个能被重新点亮又能被熄灭的报警灯
   等于没有报警灯。
   ══════════════════════════════════════════════════════════════════════ */

/* ── 口令 ─────────────────────────────────────────────────────────── */
CREATE TABLE auth_password (
  account_id   uuid PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL DEFAULT app.default_tenant_id() REFERENCES tenant(id),
  hash         text NOT NULL,
  is_initial   boolean NOT NULL DEFAULT false,
  changed_at   timestamptz NOT NULL DEFAULT now(),
  /* 连续失败与锁定。放在库里而不是内存里：多副本各锁各的等于没锁，
     而"换一个副本再试"恰恰是撞库最省事的一步。 */
  failed_count int NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until timestamptz,
  last_ok_at   timestamptz,
  CONSTRAINT auth_password_shape CHECK (hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$')
);
COMMENT ON TABLE auth_password IS
  '口令只存 scrypt 派生值。明文只在验证的那一瞬间存在于内存里。
   一个账号可以没有这一行 —— 那就是"这个人只能用一次性链接登录"，是正常状态。';
COMMENT ON COLUMN auth_password.is_initial IS
  '还是出厂口令。只能从 true 变 false（见 auth_password_initial_one_way）——
   它唯一的用处是报警，而能被重新点亮的报警灯等于没有报警灯。';

CREATE FUNCTION app.auth_password_initial_one_way() RETURNS trigger
  LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.is_initial AND NOT OLD.is_initial THEN
    RAISE EXCEPTION '不能把账号标回「出厂口令」—— 这个标记只用来报警，翻回去等于把报警灯关掉'
      USING ERRCODE = '23514';
  END IF;
  /* 改了哈希就不再是出厂口令了，不依赖调用方记得传 false */
  IF NEW.hash IS DISTINCT FROM OLD.hash THEN
    NEW.is_initial := false;
    NEW.changed_at := now();
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER auth_password_initial_one_way
  BEFORE UPDATE ON auth_password
  FOR EACH ROW EXECUTE FUNCTION app.auth_password_initial_one_way();

ALTER TABLE auth_password ENABLE ROW LEVEL SECURITY;
/* 本人只看得到自己那一行。**连自己的哈希也不该经过应用层的读路径** ——
   验证走下面的 SECURITY DEFINER 函数，那是唯一取得哈希的地方。 */
CREATE POLICY auth_password_self ON auth_password FOR ALL
  USING (tenant_id = app.current_tenant_id() AND account_id = app.current_account_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND account_id = app.current_account_id());

/* ── 验证：又一次「先有鸡先有蛋」 ───────────────────────────────────
   登录发生在认证之前，此刻 app.account_id 还没设，RLS 一行都不给。
   和 app.resolve_session / app.issue_login_link 同一手法：
   收进 SECURITY DEFINER，只暴露验证这一件事需要的那几个字段。 */
CREATE FUNCTION app.password_challenge(p_login text)
  RETURNS TABLE (account_id uuid, hash text, is_initial boolean,
                 locked_until timestamptz, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  SELECT a.id, p.hash, coalesce(p.is_initial, false), p.locked_until, a.tenant_id
    FROM account a LEFT JOIN auth_password p ON p.account_id = a.id
   WHERE a.login = p_login AND a.status = 'active'
$$;
COMMENT ON FUNCTION app.password_challenge(text) IS
  '登录名 → 口令哈希。**账号不存在与账号没设口令返回的行数不同**（0 与 1），
   所以调用方必须对两者返回完全相同的响应 —— 否则它就是账号枚举器。';

/* 记一次失败。锁定是**递增**的：前 4 次不锁，之后每次锁得更久，
   到 15 分钟封顶。固定阈值（"5 次锁 30 分钟"）对撞库没用而对本人很痛 ——
   打错三次的人会在第四次被关半小时，而脚本换个账号继续跑。 */
CREATE FUNCTION app.password_login_failed(p_account uuid) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  UPDATE auth_password SET
    failed_count = failed_count + 1,
    locked_until = CASE WHEN failed_count + 1 >= 4
      THEN now() + (least(power(2, failed_count + 1 - 4)::int, 15) || ' minutes')::interval
      END
  WHERE account_id = p_account
$$;

CREATE FUNCTION app.password_login_ok(p_account uuid) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  UPDATE auth_password
     SET failed_count = 0, locked_until = NULL, last_ok_at = now()
   WHERE account_id = p_account
$$;

/* 设置口令。管理员给别人设（is_initial 由调用方决定）与本人改密
   都走这一个入口 —— 两个入口意味着两套规则，而其中一套迟早会漏。 */
CREATE FUNCTION app.set_password(p_account uuid, p_hash text, p_initial boolean DEFAULT false)
  RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
BEGIN
  INSERT INTO auth_password (account_id, tenant_id, hash, is_initial)
  SELECT p_account, a.tenant_id, p_hash, p_initial FROM account a WHERE a.id = p_account
  ON CONFLICT (account_id) DO UPDATE
    SET hash = EXCLUDED.hash, failed_count = 0, locked_until = NULL;
  IF NOT FOUND THEN RAISE EXCEPTION '账号不存在：%', p_account; END IF;
END $$;

REVOKE ALL ON FUNCTION app.password_challenge(text)      FROM public;
REVOKE ALL ON FUNCTION app.password_login_failed(uuid)   FROM public;
REVOKE ALL ON FUNCTION app.password_login_ok(uuid)       FROM public;
REVOKE ALL ON FUNCTION app.set_password(uuid,text,boolean) FROM public;
GRANT EXECUTE ON FUNCTION app.password_challenge(text)      TO sitedesk_app;
GRANT EXECUTE ON FUNCTION app.password_login_failed(uuid)   TO sitedesk_app;
GRANT EXECUTE ON FUNCTION app.password_login_ok(uuid)       TO sitedesk_app;
GRANT EXECUTE ON FUNCTION app.set_password(uuid,text,boolean) TO sitedesk_app;

/* 「还有谁在用出厂口令」——启动自检要问的那一句，
   问的时候还没有身份，所以也得是 SECURITY DEFINER。 */
CREATE FUNCTION app.accounts_on_factory_password()
  RETURNS TABLE (login text, display_name text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, app, pg_temp AS
$$
  SELECT a.login, a.display_name FROM auth_password p JOIN account a ON a.id = p.account_id
   WHERE p.is_initial AND a.status = 'active' ORDER BY a.login
$$;
REVOKE ALL ON FUNCTION app.accounts_on_factory_password() FROM public;
GRANT EXECUTE ON FUNCTION app.accounts_on_factory_password() TO sitedesk_app;

-- Down Migration
DROP FUNCTION IF EXISTS app.accounts_on_factory_password();
DROP FUNCTION IF EXISTS app.set_password(uuid,text,boolean);
DROP FUNCTION IF EXISTS app.password_login_ok(uuid);
DROP FUNCTION IF EXISTS app.password_login_failed(uuid);
DROP FUNCTION IF EXISTS app.password_challenge(text);
DROP TRIGGER IF EXISTS auth_password_initial_one_way ON auth_password;
DROP FUNCTION IF EXISTS app.auth_password_initial_one_way();
DROP TABLE IF EXISTS auth_password;
