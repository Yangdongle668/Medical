/* 本地重置：down 到底再 up，然后灌种子。生产不用（生产只进不退）。 */
import { execSync } from "node:child_process";
import path from "node:path";
import { loadEnv, ROOT } from "./env.mjs";
loadEnv();
const run = c => execSync(c, { stdio: "inherit", cwd: ROOT });
const M = "npx node-pg-migrate --migrations-dir db/migrations --migrations-table schema_migration";
run(`${M} down 99 || true`);
run(`${M} up`);
run(`node ${path.join(ROOT, "db/scripts/seed.mjs")}`);
