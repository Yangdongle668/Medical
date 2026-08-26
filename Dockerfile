# ══════════════════════════════════════════════════════════════════════
# API 的部署镜像。
#
# 两阶段：构建阶段有全部 devDependencies（tsc / esbuild 都要），
# 运行阶段只带运行时依赖和一个打好的文件。
#
# 为什么 COPY 的是 build/server.mjs 而不是整个 dist/：
# workspace 依赖以 TS 源码导出，`node dist/main.js` 会
# ERR_MODULE_NOT_FOUND（见 Phase 9a）。打包之后 @sitedesk/* 已经内联，
# 剩下的外部依赖（@nestjs、pg、rxjs、zod）由 npm 装。
# ══════════════════════════════════════════════════════════════════════
FROM node:22-slim AS build
WORKDIR /repo

# 先只拷清单，让依赖层能被缓存 —— 改一行业务代码不该重装一遍 node_modules
COPY package.json package-lock.json ./
COPY apps/api/package.json        apps/api/
COPY apps/web/package.json        apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/calc/package.json      packages/calc/
COPY packages/policy/package.json    packages/policy/
COPY packages/ui/package.json        packages/ui/
COPY db/package.json                 db/
RUN npm ci

COPY . .
RUN npm run bundle -w @sitedesk/api

# ── 运行阶段 ──────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# 只装运行时依赖。--omit=dev 之后 tsc/esbuild/vitest 都不会进镜像。
#
# 为什么把 @sitedesk/db 也装进来：镜像里带着 migrations，却没有能执行它们的
# 东西 —— node-pg-migrate 是 db 这个 workspace 的依赖，只装 api 的话它不在。
# "迁移随镜像走"于是只走了一半：文件在，跑不动。
# db 的运行时依赖只有 node-pg-migrate 与 pg（pg 本来就在），代价很小。
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY db/package.json       db/
RUN npm ci --omit=dev --workspace @sitedesk/api --workspace @sitedesk/db \
      --include-workspace-root \
 && npm cache clean --force

COPY --from=build /repo/apps/api/build ./apps/api/build
# 迁移随镜像走：部署时先迁移再起服务，两者必须是同一个版本
COPY --from=build /repo/db/migrations ./db/migrations
# 种子与灌数脚本：演示部署要用。路径必须是 /app/db/scripts —— seed.mjs
# 是按 `../..` 反推仓库根的，挪个地方它就找不到 db/seeds 了。
COPY --from=build /repo/db/scripts   ./db/scripts
COPY --from=build /repo/db/seeds     ./db/seeds
# 运维工具：签发一次性登录链接（邮件通道补上之前的唯一入口）
COPY --from=build /repo/apps/api/scripts/issue-login-link.mjs ./apps/api/scripts/

# 不用 root 跑。node 镜像自带 uid 1000 的 node 用户。
USER node

EXPOSE 3000
# 存活探针不碰数据库，所以它能如实回答"这个进程要不要重启"
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/build/server.mjs"]
