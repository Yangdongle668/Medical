#!/usr/bin/env bash
# 给某个账号签发一条一次性登录链接，打在终端上。
#
#   ./deploy/login-link.sh lingyuan
#
# 生产环境登录只有这一条路。链接本该由邮件/短信发给本人 ——
# 那个通道还没做，所以暂时由**能进服务器的人**代发：
# 签发权限因此等同于运维权限，这个前提是清楚的，
# 而不是在某个公开接口上开一个谁都能敲的口子。
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
[ $# -ge 1 ] || 死 "用法：./deploy/login-link.sh <登录名>"
检查docker
ORIGIN="$(读取 SITEDESK_PUBLIC_ORIGIN)"
dc run --rm -e SITEDESK_PUBLIC_ORIGIN="${ORIGIN:-http://localhost:8080}" \
  --entrypoint node api apps/api/scripts/issue-login-link.mjs "$@"
