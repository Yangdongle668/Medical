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
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) 死 "不认识的参数：$1（用 --help 看用法）" ;;
  esac
done

检查docker
[ -f "$ENV_FILE" ] || 死 "没有 deploy/.env —— 这台机器还没部署过，先跑 ./deploy/deploy.sh"

PORT="$(读取 SITEDESK_PORT)"; PORT="${PORT:-8080}"
现标签="$(读取 SITEDESK_TAG)"; 现标签="${现标签:-local}"

if [ "$ROLLBACK" = "1" ]; then
  上一个="$(读取 SITEDESK_PREV_TAG)"
  [ -n "$上一个" ] || 死 "没有记录上一个标签 —— 这台机器还没更新过。"
  # 两个镜像都要在。只查一个的话，另一个被 prune 掉时会卡在 up 那一步，
  # 报的是拉取失败 —— 看不出是回滚目标已经不存在了。
  for 镜像 in "sitedesk-api:$上一个" "sitedesk-web:$上一个"; do
    docker image inspect "$镜像" >/dev/null 2>&1 \
      || 死 "镜像 $镜像 已经不在本机了（被 docker image prune 清掉了？）。"
  done
  步 "回滚：$现标签 → $上一个"
  红 "  注意：**数据库不会回滚**。上一版跑不了新 schema 的话，回滚救不了。"
  设置 SITEDESK_TAG "$上一个"
  dc up -d api web
  等就绪 "$PORT"; 验一遍 "$PORT"
  绿 "✓ 已回到 $上一个"
  exit 0
fi

if [ "$PULL" = "1" ]; then
  步 "① 拉代码"
  git -C "$REPO" pull --ff-only
else
  灰 "跳过 git pull（--no-pull）"
fi

新标签="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo local)"
if [ "$新标签" = "$现标签" ]; then
  灰 "代码没变（仍是 $新标签）—— 仍然重建一次，依赖或 Dockerfile 可能动过。"
fi

步 "② 构建 $新标签"
SITEDESK_TAG="$新标签" dc build

步 "③ 迁移（在换镜像之前）"
SITEDESK_TAG="$新标签" dc --profile tools run --rm migrate

步 "④ 换服务"
设置 SITEDESK_PREV_TAG "$现标签"
设置 SITEDESK_TAG "$新标签"
# 有 restart 策略在，compose 会逐个换掉容器。API 收到 SIGTERM 之后
# 先让就绪转 503、等 SITEDESK_DRAIN_MS，再把在途请求做完才关。
dc up -d api web
等就绪 "$PORT"

步 "⑤ 验一遍"
验一遍 "$PORT"
绿 "  首页 ✓  同源反代 ✓  数据库就绪 ✓  未认证 401 ✓"

步 "完成"
绿 "  $现标签 → $新标签"
灰 "  出问题就回滚：./deploy/update.sh --rollback"
灰 "  （只换回镜像；数据库不回滚。）"
