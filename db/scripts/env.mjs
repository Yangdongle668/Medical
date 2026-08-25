/* 从仓库根的 .env 补齐环境变量。
 *
 * 「补齐」而不是「覆盖」：CI 与生产通过真实环境变量注入，
 * 本地 .env 只是缺省值。反过来做的话，CI 上会静默连到开发库 ——
 * 而这种错误跑起来一切正常，只有数据不对。
 *
 * .env 不存在不是错误：CI 上本来就没有这个文件。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function loadEnv() {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
