#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# 一键部署。从一台只装了 Docker 的机器，到一个能登进去的中心台。
#
#   ./deploy/deploy.sh              # 空库
#   ./deploy/deploy.sh --demo       # 带演示数据，并直接给出一条登录链接
#   ./deploy/deploy.sh --port 9000  # 换个对外端口
#
# 做的事，按顺序：
#   ① 检查 docker，生成 deploy/.env（口令随机，只生成一次）
#   ② 构建两个镜像
#   ③ 起数据库，等它真的能应答
#   ④ **单独**跑一次迁移（不塞进服务启动 —— 多副本会打架，
#      而且迁移失败会伪装成"服务起不来"）
#   ⑤ --demo 时灌种子
#   ⑥ 起 API 与前端
#   ⑦ 真的打一遍：首页、反代、就绪、未认证 401
# ══════════════════════════════════════════════════════════════════════
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

DEMO=0; PORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --demo) DEMO=1; shift ;;
    --port) PORT="${2:?--port 后面要跟端口号}"; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) 死 "不认识的参数：$1（用 --help 看用法）" ;;
  esac
done

检查docker

步 "① 配置"
if [ ! -f "$ENV_FILE" ]; then
  cp "$HERE/.env.example" "$ENV_FILE"
  设置 POSTGRES_PASSWORD           "$(生成口令)"
  设置 SITEDESK_DB_OWNER_PASSWORD  "$(生成口令)"
  设置 SITEDESK_DB_APP_PASSWORD    "$(生成口令)"
  绿 "  已生成 deploy/.env，三个口令是随机的。"
  灰 "  这个文件不进版本库；**请把它备份好** —— 数据卷还在而口令丢了，"
  灰 "  库就打不开了（口令存的是哈希，找不回来）。"
else
  灰 "  deploy/.env 已存在，沿用它（口令不会被覆盖）。"
fi
[ -n "$PORT" ] && 设置 SITEDESK_PORT "$PORT"
PORT="$(读取 SITEDESK_PORT)"; PORT="${PORT:-8080}"
[ "$(读取 SITEDESK_PUBLIC_ORIGIN)" = "http://localhost:8080" ] && [ "$PORT" != "8080" ] \
  && 设置 SITEDESK_PUBLIC_ORIGIN "http://localhost:${PORT}"

步 "② 构建镜像（第一次要几分钟）"
dc build

步 "③ 起数据库"
dc up -d db
printf '  等数据库'
n=0
until dc exec -T db pg_isready -U postgres >/dev/null 2>&1; do
  n=$((n+1)); printf '.'
  [ "$n" -lt 60 ] || { echo; 死 "数据库 60 秒内没起来：dc logs db"; }
  sleep 1
done
echo

步 "④ 迁移"
# 一次性容器，跑完就退。失败就停在这里 —— 让一个 schema 不对的库
# 把服务拉起来，只会把问题推迟到第一个请求。
dc --profile tools run --rm migrate

if [ "$DEMO" = "1" ]; then
  步 "⑤ 灌演示数据"
  dc --profile tools run --rm seed
fi

步 "⑥ 起 API 与前端"
dc up -d api web
等就绪 "$PORT"

步 "⑦ 验一遍（不是看容器状态，是真的打一遍）"
验一遍 "$PORT"
绿 "  首页 ✓  同源反代 ✓  数据库就绪 ✓  未认证 401 ✓"

ORIGIN="$(读取 SITEDESK_PUBLIC_ORIGIN)"; ORIGIN="${ORIGIN:-http://localhost:$PORT}"
步 "完成"
绿 "  中心台：$ORIGIN"
echo
if [ "$DEMO" = "1" ]; then
  灰 "  演示数据已就位。下面这条链接 15 分钟内有效，点开即以「凌远 · 经营层」登录："
  echo
  dc run --rm -e SITEDESK_PUBLIC_ORIGIN="$ORIGIN" --entrypoint node api \
    apps/api/scripts/issue-login-link.mjs lingyuan || true
else
  灰 "  库是空的。建好账号之后，用下面这条命令给本人签发登录链接："
  echo
  echo "    ./deploy/login-link.sh <登录名>"
  echo
  灰 "  生产环境没有密码，也没有开发登录 —— 一次性链接是唯一入口。"
  灰 "  邮件/短信通道还没做，所以链接目前由运维在服务器上签发。"
fi
