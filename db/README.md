# @sitedesk/db — Schema 与迁移

**Schema 是这个系统的核心资产，不是 ORM 的副产物。** 因此：手写 SQL 迁移，
不用 ORM 的自动迁移 —— `EXCLUDE` 约束、GiST 索引、生成列、RLS 策略，
ORM 要么表达不了，要么表达得很别扭。

## 快速开始

```sh
# 一次性：创建角色与扩展（需要超级用户）
sudo -u postgres psql -d sitedesk_dev -f db/scripts/bootstrap.sql

cp .env.example .env
npm install
npm run db:up          # 执行迁移
npm run db:seed        # 灌演示数据
npm test               # RLS / 审计不可变 / 迁移幂等
```

## SQL 规约

违反规约的迁移不予合并。这些不是风格偏好，每一条都对应一次真实事故。

| # | 规约 | 理由 |
|---|---|---|
| 1 | 表名与**列名**均为 `snake_case`，表名单数，**不使用保留字** | `user` / `group` / `window` 是保留字，被迫加引号后每处引用都要记得加 |
| 2 | 主键一律 `uuid`，`DEFAULT gen_random_uuid()` | **离线优先的前提**：CRC 断网时客户端能自己生成 ID，联网重放不需要换 ID |
| 3 | 人类可读编号放 `code` 列并加唯一约束，**不做主键** | 编号格式会变（`SS-01` → `BJ-XH-001`），做主键就得更新所有外键 |
| 4 | 每张表的**租户归属必须可推导**：自带 `tenant_id`，或是全局枚举表，或主键里含指向父表的外键 | 见 Phase 0 §9.1。事后加列要动全部外键与全部策略。外键必须落在**主键**里 —— 落在普通列上可以 `UPDATE` 到别的租户 |
| 5 | 金额一律 `bigint`，单位**分**，列名以 `_cents` 结尾，**禁止浮点** | 万元 + float 是对账对不平的经典成因。整数分与契约层口径一致，展示层再转元/万元 |
| 6 | 日历日期用 `date`，时间戳用 `timestamptz`，**禁止 `timestamp`** | 访视目标日是日历概念，带时区会在跨时区时错一天 |
| 7 | 枚举优先用**查找表**；仅当取值稳定且无需排序时用 `text` + `CHECK` | 原生 `ENUM` 增删值要 `ALTER TYPE`，在生产上是锁表操作 |
| 8 | 事实表**只追加**：无 `UPDATE`/`DELETE` 权限，修正靠冲销记录 | 见 `audit_entry` 的语句级触发器 |
| 9 | 所有表有 `created_at`；可变表有 `updated_at` + `touch_updated_at` 触发器 | 手动维护 `updated_at` 必然有人忘 |
| 10 | 迁移**生产只进不退**；`down` 仅供本地迭代 | 生产回滚靠补偿迁移。`down` 存在是为了本地 `reset` 能重复跑 |
| 11 | RLS 策略的辅助函数**接收行的列值**，不按 id 回查本表 | `FOR ALL` 策略的 `USING` 会作用于 `INSERT ... RETURNING` 的返回行，而 `STABLE` 函数用的是命令开始时的快照 —— 看不到刚插入的那一行。症状是每个条件单独求值都为真，插入却被自己的策略拒绝 |
| 12 | 策略之间互相引用时，把查询收进 `SECURITY DEFINER` 函数 | 否则 A 的策略查 B、B 的策略回查 A，直接无限递归 |
| 13 | 「谁能做什么」属于**租户数据**，写在种子里，不写在迁移里 | 迁移跑在种子之前，`INSERT ... SELECT FROM role` 会安静地插入 0 行；症状是所有角色一律 403，最难查 |

## 目录

```
db/
├─ scripts/bootstrap.sql   集群级：角色与扩展（DBA 执行一次，不是迁移）
├─ migrations/*.sql        版本化 schema
├─ seeds/                  演示数据（来源于 prototype/，受试者编号已重新生成）
└─ test/                   RLS、审计不可变、迁移幂等
```

## 为什么应用不能用 owner 连接

PostgreSQL 的表 owner **默认绕过 RLS**。因此有两个角色：

| 角色 | 用途 | RLS |
|---|---|---|
| `sitedesk` | 跑迁移，拥有全部对象 | 绕过 |
| `sitedesk_app` | 应用运行时 | **真实生效** |

`db/test/rls.test.ts` 用 `sitedesk_app` 连接验证 —— 用 owner 测 RLS 会全绿，
但什么也没证明。
