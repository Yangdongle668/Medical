import type { Server } from "node:http";

/** 生产托管服务器。见 server.mjs 顶部的说明。 */
export interface WebServer extends Server {
  /** 让 /healthz 开始返回 503（停机第一步：先摘流量） */
  startDraining(): void;
  /** 解析之后的静态目录绝对路径 */
  root: string;
}

export function createServer(opts: {
  root: string;
  api: string | URL;
  /** HSTS 的 max-age（秒）。0 / 省略 = 不发。默认读 SITEDESK_HSTS_MAX_AGE。 */
  hstsMaxAge?: number;
  /** 明文请求 308 到 https（按 X-Forwarded-Proto 判定）。默认读 SITEDESK_FORCE_HTTPS=1。 */
  forceHttps?: boolean;
}): WebServer;
