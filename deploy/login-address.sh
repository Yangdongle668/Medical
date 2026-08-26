#!/usr/bin/env bash
# 登记 / 更换某个账号的登录链接收件地址（邮箱或手机号）。
#
#   ./deploy/login-address.sh lingyuan lingyuan@hengji.com
#
# 登录链接只会送到**这里登记的**地址，不会送到请求里带的那个 ——
# 否则 /v1/auth/magic-link 就成了一键账号接管。
# 于是改地址这件事要求能进服务器：它等同于运维权限，和签发链接一样。
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
[ $# -ge 2 ] || 死 "用法：./deploy/login-address.sh <登录名> <邮箱或手机号>"
检查docker
dc run --rm --entrypoint node api apps/api/scripts/set-login-address.mjs "$@"
