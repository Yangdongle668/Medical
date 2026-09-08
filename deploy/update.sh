#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# 一键更新。拉新代码 → 重建镜像 → 先迁移 → 再换服务。
#
#   ./deploy/update.sh              # 拉最新代码再更新
#   ./deploy/update.sh --no-pull    # 用工作区当前的代码
#   ./deploy/update.sh --rollback   # 回到上一个镜像标签
#
# ── 顺序为什么是「先迁移，后换镜像」 ────────────────────────────────
# 反过来的话，新代码会打在旧 schema 上，第一个请求就炸。
# 这个顺序的前提是：**迁移必须向后兼容一个版本** —— 在迁移完成到镜像
# 换完之间，旧代码正打在新 schema 上。所以加列要可空、改名要分两步走。
#
# ── 数据 ────────────────────────────────────────────────────────────
# 更新不碰数据卷，也不灌种子。库是有状态的那一半，回滚回不去它。
# ══════════════════════════════════════════════════════════════════════
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

PULL=1; ROLLBACK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-pull) PULL=0; shift ;;
    --rollback) ROLLBACK=1; shift ;;
    -h|--help) 用法 "$0"; exit 0 ;;
    *) 死 "不认识的参数：$1（用 --help 看用法）" ;;
  esac
done

检查docker
[ -f "$ENV_FILE" ] || 死 "没有 deploy/.env —— 这台机器还没部署过，先跑 ./deploy/deploy.sh"

# ── 变量名一律用 ASCII ────────────────────────────────────────────────
# 函数名可以是中文（bash 允许），**变量名不行**：
# `现标签=local` 不是一条赋值，bash 会把整个词当成命令名去找，于是
#
#     ./deploy/update.sh: line 33: 现标签=local: command not found
#
# 而这是脚本的第 33 行 —— 也就是说这个脚本在任何一台机器上、
# 任何一次调用里都走不过第三步，`--rollback` 也一样。
# 它从来没被跑起来过，因为没有任何测试会去执行一个 .sh。
CUR_TAG="$(读取 SITEDESK_TAG local)"
PORT="$(读取 SITEDESK_PORT 8080)"

if [ "$ROLLBACK" = "1" ]; then
  PREV_TAG="$(读取 SITEDESK_PREV_TAG)"
  [ -n "$PREV_TAG" ] || 死 "没有记录上一个标签 —— 这台机器还没更新过。"
  # 两个镜像都要在。只查一个的话，另一个被 prune 掉时会卡在 up 那一步，
  # 报的是拉取失败 —— 看不出是回滚目标已经不存在了。
  for IMG in "sitedesk-api:$PREV_TAG" "sitedesk-web:$PREV_TAG"; do
    docker image inspect "$IMG" >/dev/null 2>&1 \
      || 死 "镜像 $IMG 已经不在本机了（被 docker image prune 清掉了？）。"
  done
  步 "回滚：$CUR_TAG → $PREV_TAG"
  红 "  注意：**数据库不会回滚**。上一版跑不了新 schema 的话，回滚救不了。"
  设置 SITEDESK_TAG "$PREV_TAG"
  dc up -d api web
  等就绪 "$PORT"; 验一遍 "$PORT"
  绿 "✓ 已回到 $PREV_TAG"
  exit 0
fi

if [ "$PULL" = "1" ]; then
  步 "① 拉代码"
  git -C "$REPO" pull --ff-only
else
  灰 "跳过 git pull（--no-pull）"
fi

NEW_TAG="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo local)"
if [ "$NEW_TAG" = "$CUR_TAG" ]; then
  灰 "代码没变（仍是 $NEW_TAG）—— 仍然重建一次，依赖或 Dockerfile 可能动过。"
fi

步 "② 构建 $NEW_TAG"
SITEDESK_TAG="$NEW_TAG" dc build

# 同 deploy.sh：先确认口令对得上，再迁移。
# 升级路径上更容易撞到 —— 换机器、换目录、从备份恢复 .env，
# 都会让"卷"和".env"来自两个不同的时刻。
#
# **先把库拉起来再验**：机器重启过、或者有人 `down` 过的话，库这时是停的，
# 而 `dc exec` 对"停着"和"口令不对"给的是同一个失败。分不出来的后果不对称 ——
# 口令对不上那条提示里的第②条是 `down -v`，会把数据全删掉。
起数据库
验口令 || 口令对不上

步 "③ 迁移（在换镜像之前）"
SITEDESK_TAG="$NEW_TAG" dc --profile tools run --rm migrate

步 "④ 换服务"
设置 SITEDESK_PREV_TAG "$CUR_TAG"
设置 SITEDESK_TAG "$NEW_TAG"
# 有 restart 策略在，compose 会逐个换掉容器。API 收到 SIGTERM 之后
# 先让就绪转 503、等 SITEDESK_DRAIN_MS，再把在途请求做完才关。
dc up -d api web
等就绪 "$PORT"

步 "⑤ 验一遍"
验一遍 "$PORT"
绿 "  首页 ✓  同源反代 ✓  数据库就绪 ✓  未认证 401 ✓"

步 "完成"
绿 "  $CUR_TAG → $NEW_TAG"
灰 "  出问题就回滚：./deploy/update.sh --rollback"
灰 "  （只换回镜像；数据库不回滚。）"
