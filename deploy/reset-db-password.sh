#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# 把数据库里两个角色的口令，改成 deploy/.env 里现在这一份。
#
# 什么时候要它：数据卷是早先建的，而 .env 是后来生成的（丢过、删过、
# 或者在另一台机器上生成过）。角色口令只在卷**第一次初始化**时写入
# （deploy/initdb/20-roles.sh），之后再改 .env 不会同步过去，
# 于是迁移那一步撞上 `password authentication failed for user "sitedesk"`。
#
# 它**不动数据**，只改口令。库里已经录进去的东西一条不少。
#
# 前提：postgres 超级用户的口令（POSTGRES_PASSWORD）还对得上。
# 连它也对不上的话，这个卷就只能重建了 —— 那条路会删掉全部数据，
# 所以不放在这个脚本里，让人自己去敲。
# ══════════════════════════════════════════════════════════════════════
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

[ -f "$ENV_FILE" ] || 死 "找不到 deploy/.env —— 先跑一次 ./deploy/deploy.sh"

OWNER="$(读取 SITEDESK_DB_OWNER_PASSWORD)"
APP="$(读取 SITEDESK_DB_APP_PASSWORD)"
DB="$(读取 POSTGRES_DB)"; DB="${DB:-sitedesk}"
[ -n "$OWNER" ] && [ -n "$APP" ] || 死 "deploy/.env 里缺少角色口令"

检查docker
步 "① 起数据库（如果还没起）"
dc up -d db
printf '  等数据库'
n=0
until dc exec -T db pg_isready -U postgres >/dev/null 2>&1; do
  n=$((n+1)); printf '.'
  [ "$n" -lt 60 ] || { echo; 死 "数据库 60 秒内没起来：dc logs db"; }
  sleep 1
done
echo

步 "② 用超级用户改两个角色的口令"
# 口令走 psql 变量 :'x'，由 psql 做转义 —— 直接拼进 SQL 字符串的话，
# 口令里一个单引号就能把语句撑破。和 initdb/20-roles.sh 同一种写法。
if ! dc exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d "$DB" \
     -v owner="$OWNER" -v app="$APP" >/dev/null <<'SQL'
ALTER ROLE sitedesk     PASSWORD :'owner';
ALTER ROLE sitedesk_app PASSWORD :'app';
SQL
then
  echo
  死 "超级用户也连不上 —— POSTGRES_PASSWORD 同样对不上这个卷。
    这种情况这个脚本救不了：只能连卷一起重建（**会删掉全部数据**）：
      docker compose --project-directory deploy -f deploy/docker-compose.yml down -v"
fi

步 "③ 验一遍"
验口令 || 死 "改完仍然连不上 —— 请看 dc logs db"
绿 "  两个角色的口令已对齐 deploy/.env。"
echo
灰 "  接着往下跑就行："
echo
echo "    ./deploy/deploy.sh"
