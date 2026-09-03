# deploy.sh 与 update.sh 共用的部分。两边各写一份的话，
# 迟早只改了其中一处 —— 而那种分叉在出事之前一点征兆都没有。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ENV_FILE="$HERE/.env"

红() { printf '\033[31m%s\033[0m\n' "$*" >&2; }
绿() { printf '\033[32m%s\033[0m\n' "$*"; }
灰() { printf '\033[2m%s\033[0m\n' "$*"; }
步() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
死() { 红 "✗ $*"; exit 1; }

# docker compose v2 是 `docker compose`；v1 是 `docker-compose`。
# 只认其中一个的话，在另一种机器上报的是 "command not found"，
# 看不出是版本问题。
检查docker() {
  command -v docker >/dev/null 2>&1 || 死 "没有 docker。先装 Docker Engine 24+。"
  if docker compose version >/dev/null 2>&1; then
    DC=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    DC=(docker-compose)
  else
    死 "没有 docker compose 插件。装 docker-compose-plugin，或升级到 Docker Desktop。"
  fi
  docker info >/dev/null 2>&1 || 死 "docker 守护进程没在跑（或当前用户没有权限）。"
}

dc() { "${DC[@]}" --project-directory "$HERE" -f "$HERE/docker-compose.yml" "$@"; }

# 32 字节的随机口令。用 openssl，没有就退回 /dev/urandom ——
# 绝不用 $RANDOM 之类：那不是随机数，是可预测的序列。
生成口令() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 24 | tr -d '/+=' | cut -c1-24
  else
    LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24
  fi
}

# 就地改 .env 里的一个键。没有就追加。
设置() {
  local k="$1" v="$2"
  if grep -q "^${k}=" "$ENV_FILE" 2>/dev/null; then
    # 用 | 作分隔符，口令里不会有它（生成时去掉了 /+=）
    sed -i.bak "s|^${k}=.*|${k}=${v}|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
  fi
}

读取() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-; }

# 等前端真的能应答。只等容器"起来了"是不够的 ——
# 进程在、端口通、页面 500，这三件事完全可以同时成立。
等就绪() {
  local port="$1" n=0
  printf '  等前端起来'
  until curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; do
    n=$((n + 1)); printf '.'
    [ "$n" -lt 60 ] || { echo; 死 "60 秒内没起来。看日志：$(basename "$0") 同目录下 \`docker compose logs\`"; }
    sleep 1
  done
  echo
}

# 部署完了要能真的打通一次，而不是只看容器状态。
# "起来了但一个接口都打不通"是前后端分离部署最常见的失败，
# 而它在 `docker ps` 里长得和成功一模一样。
验一遍() {
  local port="$1"
  curl -fsS "http://127.0.0.1:${port}/" | grep -q '<div id="root">' \
    || 死 "首页不是构建产物 —— 静态目录可能是空的。"
  curl -fsS "http://127.0.0.1:${port}/v1/health" >/dev/null \
    || 死 "经前端反代打不通 API。"
  curl -fsS "http://127.0.0.1:${port}/v1/health/ready" >/dev/null \
    || 死 "API 起来了，但连不上数据库（就绪探针 503）。"
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/v1/study-sites")
  [ "$code" = "401" ] || 死 "未认证请求返回 $code，应为 401 —— 守卫没生效。"
}

# ── 口令对不对得上 ────────────────────────────────────────────────────
# `deploy/initdb/20-roles.sh` 只在**数据卷第一次初始化**时跑。
# 卷已经存在、而 .env 里的口令是后来才生成的（.env 丢过、被删过、
# 或者在另一台机器上生成过），角色里存的还是旧口令 ——
# 于是迁移那一步直接撞上：
#
#     password authentication failed for user "sitedesk"   (28P01)
#
# 那条报错说的是"口令不对"，而真正的原因是"卷比 .env 老"。
# 这两件事的解法完全相反，所以要在迁移之前分清楚。
验口令() {
  dc exec -T -e PGPASSWORD="$(读取 SITEDESK_DB_OWNER_PASSWORD)" db \
    psql -U sitedesk -d "$(读取 POSTGRES_DB || echo sitedesk)" -c 'SELECT 1' \
    >/dev/null 2>&1
}

口令对不上() {
  红 "✗ 数据库拒绝了 deploy/.env 里的口令（sitedesk / 28P01）。"
  echo
  灰 "  这几乎总是同一件事：**数据卷比 deploy/.env 老。**"
  灰 "  角色口令只在卷第一次初始化时写入（deploy/initdb/20-roles.sh），"
  灰 "  之后再改 .env 不会同步过去。"
  echo
  echo "  两条路，选一条："
  echo
  echo "  ① 库里的数据还要 —— 把角色口令改成 .env 里现在这一份："
  echo
  echo "     ./deploy/reset-db-password.sh"
  echo
  echo "  ② 库里的数据不要了（演示环境通常是这种）—— 连卷一起重来："
  echo
  echo "     docker compose --project-directory deploy -f deploy/docker-compose.yml down -v"
  echo "     ./deploy/deploy.sh${1:+ $1}"
  echo
  灰 "  ② 会**删掉全部数据**，包括已经录进去的中心、受试者与工时。"
  exit 1
}
