#!/bin/sh
# 由 parts/ 拼接生成自包含的 index.html。
# parts/ 是源，index.html 是产物 —— 不要直接改 index.html。
set -e
cd "$(dirname "$0")"
cat parts/01-head.html \
    parts/02-shell.html \
    parts/02b-roles.html \
    parts/02c-intake.html \
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
    parts/99-boot.html > index.html
echo "index.html 已重新生成（$(wc -l < index.html) 行）"
