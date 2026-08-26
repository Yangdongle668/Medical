import type { Server } from "node:http";

/** 生产托管服务器。见 server.mjs 顶部的说明。 */
export interface WebServer extends Server {
  /** 让 /healthz 开始返回 503（停机第一步：先摘流量） */
  startDraining(): void;
  /** 解析之后的静态目录绝对路径 */
  root: string;
}

export function createServer(opts: { root: string; api: string | URL }): WebServer;
