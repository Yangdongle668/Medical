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

# 读一个键，第二个参数是取不到时的默认值。
#
# ── 为什么不能只写那一条管道 ──────────────────────────────────────────
# 原来是 `grep … | head -1 | cut -d= -f2-`。键不在 .env 里时 grep 返回 1，
# 而 lib.sh 开头是 `set -euo pipefail` —— pipefail 把 grep 的 1 传给整条管道，
# set -e 再把它变成**整个脚本当场退出，一个字都不打**。
#
# 于是 `./deploy/update.sh --rollback` 在一台还没更新过的机器上
# （那种机器的 .env 里没有 SITEDESK_PREV_TAG）就是"按下去什么也没发生"，
# 而下一行那句"没有记录上一个标签 —— 这台机器还没更新过"永远没机会打出来。
# 一条写好了的错误提示，被它上面那一行给吃掉了。
读取() {
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  printf '%s' "${v:-${2-}}"
}

# --help：打脚本开头那一段注释，到第一行非注释为止。
#
# 原来每个脚本各写一句 `sed -n '2,20p' "$0"` —— 行号是照着当时的文件头数的，
# 而文件头是会被改的。update.sh 的头后来短了四行，于是 `--help` 把
# `source …`、`PULL=1; ROLLBACK=0`、`while [ $# -gt 0 ]; do` 也一起打了出来。
# 没有任何东西会为此报警：它照样退出 0。
用法() { sed -n '2,${/^#/!q; s/^# \{0,1\}//p;}' "$1"; }

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
    psql -U sitedesk -d "$(读取 POSTGRES_DB sitedesk)" -c 'SELECT 1' \
    >/dev/null 2>&1
}

# 起数据库并等它真的能应答。**验口令之前必须先走这一步。**
#
# 不走的话：库没在跑时 `dc exec` 同样失败，而 `验口令 || 口令对不上`
# 分不出"口令不对"和"库根本没起来"—— 于是屏幕上出现的是
# "数据卷比 .env 老，两条路选一条"，其中②那条是 `down -v`。
# 一个因为重启而没起来的库，被诊断成要连卷一起删掉。
起数据库() {
  dc up -d db
  local n=0
  printf '  等数据库'
  until dc exec -T db pg_isready -U postgres >/dev/null 2>&1; do
    n=$((n + 1)); printf '.'
    [ "$n" -lt 60 ] || { echo; 死 "数据库 60 秒内没起来：docker compose logs db"; }
    sleep 1
  done
  echo
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
