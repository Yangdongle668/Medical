# @sitedesk/contracts —— 契约的唯一定义源

前端类型、后端 DTO、OpenAPI 文档、MSW mock **全部由 `src/` 下的 zod schema 派生**。
`openapi.yaml` 与 `mocks/examples.json` 是**产物**，进 git 只为可评审与可比对，
任何时候都以 zod 定义为准 —— CI 会重新生成并比对，手改产物会被拦下。

```sh
npm run build           # 生成 openapi.yaml + mocks/examples.json
npm run check:breaking  # 与 git HEAD 比对破坏性变更
npm run typecheck
npm test
```

## 分层

| 层 | 形态 | 职责 |
|---|---|---|
| **L1 资源层** | `GET/POST/PATCH /v1/…` | CRUD 与列表查询，无业务判断 |
| **L2 命令层** | `POST /v1/…/{id}:action` | 领域动作，返回 `sideEffects` |
| **L3 投影层** | `GET /v1/analytics/…` | 只读聚合，**永不返回明细** |

### 为什么必须有 L2

「完成一次访视」不是对 `subject_visit` 的 PATCH。它一次性触发七件事：
记工时 → 归集成本 → 生成受试者补偿 → 超窗则生成方案偏离 → 转 PI 确认 →
推进 seq → 按 SOA 生成下一次窗口。

拆成七个 REST 调用，**任何一个失败都会留下不一致的状态**。

`sideEffects` **是契约的一部分，不是调试信息**：一线提交后必须立刻知道
「这次操作还顺带生成了一条方案偏离」—— 否则他以为自己只是打了个卡，
而系统已经替他记下了一次质量事件。

本包冻结的样板是 `POST /v1/study-sites/{id}:advance`（推进中心阶段）——
选它是因为它有真实的闸门与真实的表，能被实现和验证；
`:complete` 属于 ClinicalOps，在那一纵切里按同一信封填充。

## 五条不可协商的约定

| # | 约定 | 理由 |
|---|---|---|
| 1 | **行范围之外一律 404，绝不是 403** | 403 等于确认「它存在，只是你不能碰」。对竞争对手的项目编号来说，这个确认本身就是泄漏 |
| 2 | **无权限的字段从响应里消失，不是返回 `null`** | `null` 泄漏了「这个字段存在」。因此所有 `x-gated-by` 字段在契约里一律 optional，客户端必须能处理「它不在」 |
| 3 | **所有 L2 命令必须接受 `Idempotency-Key`** | CRC 离线重放的生命线。24 小时内同键返回首次结果 |
| 4 | **金额一律整数分** | 计算引擎前后端共用，整数运算不需要十进制库；JSON 里 numeric 会变字符串，前端一 `Number()` 就回到浮点 |
| 5 | **错误一律 RFC 9457 `application/problem+json`** | `type` 是稳定 URI 永不改，`title` 面向人可改，`code` 供程序分支 |

## 破坏性变更门禁

**请求与响应的兼容性规则是相反的**，门禁按用途分类后再判：

| 变更 | 请求端 | 响应端 |
|---|---|---|
| 新增必填字段 | **破坏** —— 旧客户端不会发送它 | 兼容 —— 客户端只是多收到一点 |
| 字段由可选变必填 | **破坏** | 兼容 |
| 字段由必填变可选 | 兼容 —— 服务端更宽松 | **破坏** —— 客户端原本可假定它存在 |
| 删除字段 | **破坏** | **破坏** |
| 枚举移除取值 | **破坏** —— 服务端不再接受 | 告警 —— 仅收窄 |
| 枚举新增取值 | 兼容 | 告警 —— 穷举分支的客户端会漏掉 |

一视同仁会产生假阳性，而假阳性会让人养成随手 `--allow-breaking` 的习惯 ——
**那等于废掉门禁本身**。

声明了 `x-extensible: true` 的枚举（如 `SideEffectType`）新增取值一律放行：
客户端有义务忽略不认识的取值。

## 目录

```
src/
├─ kernel/          共享内核，所有上下文依赖它
│  ├─ primitives.ts   Uuid / DateOnly / Timestamp / Cents / Cursor
│  ├─ fields.ts       列维度权限：gated()
│  ├─ errors.ts       RFC 9457 + 错误码目录
│  ├─ pagination.ts   游标分页（不用 offset —— 数据一直在变）
│  ├─ command.ts      L2 信封 + SideEffect（**本阶段冻结**）
│  └─ registry.ts     端点注册表，OpenAPI 由它生成
├─ identity/        身份与权限：行 × 列 × 动作
└─ site/            项目与中心：StudySite 是最小作业单元
```

## 范围说明

本包**只覆盖已有数据库表的两个上下文**（Identity & Access、Site & Staffing）。
其余八个上下文的契约，在各自那一纵切的开头写 —— API-First 仍然成立，
只是以模块为单位，而不是以整个系统为单位。

为几个月后才实现的模块先写八十个端点，是典型的 big design up front：
写出来必然是错的，因为还没从实现里学到东西。
