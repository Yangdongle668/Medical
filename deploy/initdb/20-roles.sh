#!/bin/sh
# 把 bootstrap.sql 里那两个**开发用**口令换成本次部署的真口令。
#
# 为什么分两步：bootstrap.sql 是版本化文件，被 CI、本地开发和这里共用；
# 把口令写进去等于把生产口令提交进 git。所以角色由它建，口令由这里改。
# 这个脚本只在数据卷第一次初始化时跑一次。
set -e

: "${SITEDESK_DB_OWNER_PASSWORD:?缺少 SITEDESK_DB_OWNER_PASSWORD}"
: "${SITEDESK_DB_APP_PASSWORD:?缺少 SITEDESK_DB_APP_PASSWORD}"

# 用 psql 变量 :'x' 传口令 —— 它会替我们做转义。
# 直接拼进 SQL 字符串的话，口令里一个单引号就能把语句撑破（或更糟）。
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner="$SITEDESK_DB_OWNER_PASSWORD" -v app="$SITEDESK_DB_APP_PASSWORD" <<'SQL'
ALTER ROLE sitedesk     PASSWORD :'owner';
ALTER ROLE sitedesk_app PASSWORD :'app';
SQL

# 迁移要建表、建策略、授权，所以库得归 owner。
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -c "ALTER DATABASE \"$POSTGRES_DB\" OWNER TO sitedesk;"

echo "✓ 角色口令已设置，数据库归 sitedesk 所有"
