#!/bin/sh
# 由 parts/ 拼接生成自包含的 index.html。
# parts/ 是源，index.html 是产物 —— 不要直接改 index.html。
set -e
cd "$(dirname "$0")"
cat parts/01-head.html \
    parts/02-shell.html \
    parts/02b-roles.html \
    parts/02c-intake.html \
    parts/02d-clinical.html \
    parts/02e-ops.html \
    parts/02f-org.html \
    parts/02g-life.html \
    parts/02h-biz.html \
    parts/03-core.html \
    parts/04-nav.html \
    parts/05-dash.html \
    parts/06-sites.html \
    parts/07-staff.html \
    parts/08-fin.html \
    parts/09-qa.html \
    parts/10-price.html \
    parts/11-crc.html \
    parts/12-cra.html \
    parts/13-pm.html \
    parts/14-intake.html \
    parts/15-inst.html \
    parts/16-screen.html \
    parts/17-feas.html \
    parts/18-pi.html \
    parts/19-qaudit.html \
    parts/20-crcops.html \
    parts/21-crclife.html \
    parts/22-lifeops.html \
    parts/23-cash.html \
    parts/24-bizdev.html \
    parts/25-talent.html \
    parts/26-org.html \
    parts/27-trail.html \
    parts/28-dm.html \
    parts/29-auth.html \
    parts/99-boot.html > index.html
echo "index.html 已重新生成（$(wc -l < index.html) 行）"
