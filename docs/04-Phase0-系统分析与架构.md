# Phase 0：系统分析与架构

> **本阶段不产出任何业务代码。** 交付物是决策：架构、技术栈、模块边界、数据模型轮廓、
> API 分层、权限模型、目录结构、阶段计划，以及**必须由你拍板、否则 Phase 1 无法开始的六件事**。

---

## 0. 先说清楚这份文档的定位

仓库里已经有一份[开发需求与技术架构](03-开发需求与技术架构.md)（1084 行）。
它定下的五条原则、技术选型、计算引擎、事件模型、接口约定**继续有效，本文档不重复**。

Phase 0 要做的是另外三件事：

1. **确认基线** —— 哪些决策已定、可以直接进 Phase 1；
2. **纠正已经过时的部分** —— 原型这一轮补完 CRC 生命周期与经营预测之后，规格里有三处已经不对；
3. **把真正没定的决策拿出来** —— 见 §9。这些决策**改变 Phase 1 的每一张表**，不能边做边定。

### 0.1 三处必须先纠正的地方

**① 不变量 I8 是错的。** 规格 §2.3 写的是：

```
I8  收入 = 启动费 + 入组 × 单价 + 筛败 × 单价 × 筛败费率     ← 缺一项
```

原型这一轮补上了第二处口径修正 —— **受试者脱落**。正确的是：

```
I8'  收入 = 启动费
          + 入组例数 × 单例单价
          − Σ(1 − 该受试者已完成访视数 ÷ 计划访视数) × 单例单价     ← 脱落扣减
          + 筛败例数 × 单例单价 × 筛败费率
```

两处修正**方向相反**：筛败费把收入调高（漏算会砍掉本来赚钱的高筛败中心），
脱落扣减把收入调低（漏算会保住实际在亏钱的高脱落中心）。
**只做一个比两个都不做更危险 —— 因为它看起来是对的。**

这条如果带进 Phase 1 的 schema，`subject` 表就会缺 `dropout` 状态与 `visits_completed_at_exit`，
后面 `calc`、结算、看板每一层都要返工。

**② 限界上下文从 8 个变成 10 个。** 新增两个，原有几个长大了 —— 见 §3。

**③ 审计轨迹不是 §4.4 的一小节，是 M0 的一等公民。**
规格把它放在权限章节里当作"要留痕"。在 GCP 语境下这是系统成立与否的前提，
必须和权限一起进第一个可交付版本。原型已经验证了它的形态（谁 / 何时 / 改前→改后 / **为什么**）。

---

## 1. 系统架构

### 1.1 形态：模块化单体 + 独立 worker

```
                    ┌───────────────────────────────┐
   企业微信/飞书 ──▶ │  OIDC  ──▶  apps/api          │
   外部方账号  ──▶  │            NestJS 单体进程     │
                    │  ┌─────────────────────────┐  │
                    │  │ 10 个限界上下文模块      │  │
                    │  │ 边界=代码边界，跨界只走  │  │
                    │  │ 领域事件或只读查询接口   │  │
                    │  └───────────┬─────────────┘  │
                    │              │ 事务内写 outbox │
                    └──────────────┼────────────────┘
                                   ▼
                    ┌──────────────────────────────┐
                    │  PostgreSQL 16               │
                    │  事实表(只追加) + 派生投影    │
                    │  RLS 作为权限兜底             │
                    └──────────────┬───────────────┘
                                   │ 轮询 outbox
                    ┌──────────────▼───────────────┐
                    │  apps/worker                 │
                    │  领域事件消费者：成本归集、    │
                    │  偏离生成、里程碑判定、投影刷新 │
                    └──────────────────────────────┘

   apps/web (React)  ──── 离线队列 ────▶ 幂等重放
```

**为什么不是微服务**：这个系统的复杂度在领域模型，不在并发。
15 个中心、几十人、每天几百条写操作 —— 上来拆服务只会把「跨上下文一致性」
这个本来靠数据库事务就能解决的问题，变成分布式事务问题。

**为什么必须是模块化的**：外部协作方（机构办、PI）与内部员工的数据边界，
如果只靠"记得在查询里加条件"来维持，迟早会漏。模块边界要能被 CI 断言。

### 1.2 三条不可协商的架构约束

| 约束 | 强制方式 |
|---|---|
| `packages/calc` 与 `packages/policy` 不得 import 任何 IO | ESLint `no-restricted-imports` + CI 阻断 |
| 上下文之间不得直接 import 对方的实体 | 依赖图断言（`arch:check`） |
| 任何返回受试者明细的接口必须经 policy 且写审计 | 序列化层 + 审计中间件，架构测试断言 |

### 1.3 数据流的两条主线

**写路径（事实）**：命令 → 领域校验（不变量）→ 事务内写事实表 + outbox → 提交 → worker 派生。

**读路径（派生）**：所有看板数字来自 `packages/calc` 的纯函数，或来自 worker 刷新的物化投影。
**没有第三条路** —— 不允许某个页面自己写 SQL 算一遍毛利。

---

## 2. 技术栈建议

延续规格 §1.3，只标注**变化**与**新增**：

| 层 | 选型 | 状态 |
|---|---|---|
| 语言 | TypeScript 全栈 | 不变。唯一决定性理由：**计算引擎前后端共用同一份编译产物** |
| 后端 | NestJS + Node 22 LTS | 不变 |
| 数据库 | PostgreSQL 16 | 不变。`daterange`+GiST（访视窗口）、`exclusion constraint`（费率卡不重叠）、RLS（权限兜底） |
| 前端 | React 18 + Vite + TanStack Query | 不变 |
| 契约 | **zod** 单一定义 → TS 类型 + 运行时校验 + OpenAPI | 不变。这是第 9 条原则（避免重复定义）的落地方式 |
| 异步 | Postgres Outbox + worker | 不变。不引入 Kafka |
| 认证 | OIDC | **待定** —— 外部方（机构办 / PI）不在我们的企业 IM 里，见 §9.3 |
| 离线 | **IndexedDB + 幂等重放队列** | **深度待定**，见 §9.2 |
| 迁移 | **node-pg-migrate**（纯 SQL，只进不退） | 新增。不用 ORM 的自动迁移 —— schema 是资产，不是副产物 |
| 测试 | Vitest（单元/黄金）+ Supertest（契约）+ Playwright（E2E） | 新增明确 |
| 移动端形态 | **待定**，见 §9.4 | 影响离线能力与前端栈 |

**不用 ORM 做 schema 权威**：Prisma/TypeORM 的 migration 生成在这个系统里是负债 ——
`exclusion constraint`、GiST 索引、生成列、RLS 策略它们表达不了或表达得很别扭。
用查询构建器（Kysely，类型安全）读写，schema 用手写 SQL 迁移。

---

## 3. 模块划分

### 3.1 十个限界上下文

规格里是 8 个。原型这一轮之后必须变成 10 个：

| # | 上下文 | 聚合根 | 变化 |
|---|---|---|---|
| 1 | **Identity & Access** 身份与权限 | `User`, `Role`, `Group`, `AuditEntry` | **新增**。原本散在"权限章节"里，没有归属 |
| 2 | **Intake & Contract** 商务与合同 | `Bid`, `Feasibility`, `Client`, `Study`, `IntakeRequest`, `ChangeOrder` | **长大**。吸收投标闭环、客户、合同变更、可行性 |
| 3 | **Site & Staffing** 中心与人员 | `StudySite`, `StartupChecklist`, `Staff`, `Assignment`, `Handover` | **长大**。吸收启动清单、交接、人才梯队 |
| 4 | **Regulatory** 法规事务 | `EthicsSubmission`, `ProtocolAmendment`, `ISFItem` | **新增**。伦理是贯穿全周期的周期性义务，不是状态机上的两格 |
| 5 | **ClinicalOps** 临床作业 | `Prescreen`, `Subject`, `SubjectVisit`, `IPBatch`, `Specimen`, `SAEReport`, `Query`, `SubjectCompensation` | **长大**。吸收预筛登记、脱落、受试者补偿、数据质疑 |
| 6 | **Timesheet & Cost** 工时与成本 | `TimesheetEntry`, `RateCard`, `ContractTerms` | **长大**。合同条款（筛败费率、脱落计费规则）参数化 |
| 7 | **Revenue & Billing** 收入与结算 | `Milestone`, `Invoice`, `Payment` | 不变 |
| 8 | **Quality** 质量 | `QualityEvent`, `CAPA`, `Audit`, `MonitoringVisit` | 不变 |
| 9 | **External** 外部协作 | `QCRound`, `StaffRegistration`, `AcceptanceRequest`, `PIConfirmation` | 不变 |
| 10 | **Analytics** 分析 | 无（只读投影） | **长大**。吸收现金流预测、筛选漏斗、人才风险 |

**为什么 Identity & Access 必须独立**：权限是三维的（行 × 列 × 动作），
它的规则会被**所有**其他上下文引用。如果它没有自己的边界，规则就会被复制到十个地方，
然后其中一个忘了更新 —— 这正是数据泄漏的标准剧本。

**为什么 Regulatory 必须从 Site 里分出来**：伦理批件断档意味着**该中心必须停止入组与给药**，
这是比访视超窗严重得多的事件。它需要自己的状态机与倒计时，
且方案修订审查是 Study 级的、年度跟踪审查是 Site 级的 —— 两个粒度混在 StudySite 里会很难看。

### 3.2 依赖方向（只允许单向）

```
Identity&Access ◀── 所有上下文（只读引用 principal）

Intake&Contract ──StudyApproved──▶ Site&Staffing ──SiteActivated──▶ ClinicalOps
       │                                  │                              │
       │                                  ├──▶ Regulatory                │
       │                                  │                              │
       └──ContractTermsChanged──▶ Timesheet&Cost ◀──VisitCompleted───────┤
                                          │                              │
                                          └──CostPosted──▶ Revenue&Billing
                                                                         │
                              Quality ◀──DeviationDetected / SAEOverdue──┤
                                 │                                       │
                                 ▼                                       ▼
                              External ◀──QCIssued──┐        Analytics（只读投影）
```

**Analytics 只订阅事件、只写投影、不被任何人依赖。** 这样"加一个看板"永远不会改动业务代码。

### 3.3 模块的垂直切分顺序（对应你的 Phase 4/6）

按"能独立产生价值 + 依赖最少"排：

```
① Identity&Access + 审计        ← 所有模块的前提
② Site&Staffing（中心台账+状态机）← 第一个能看见东西的模块
③ ClinicalOps（受试者+访视+窗口）← 一线真正天天用的模块
④ Timesheet&Cost               ← 有了访视才能验证"工时与访视同次录入"
⑤ Revenue&Billing              ← 有了成本才能算毛利
⑥ Regulatory                   ← 可与 ③④ 并行
⑦ Quality + External           ← 依赖 ③ 的偏离事件
⑧ Intake&Contract              ← 可最早也可最晚，与其他模块耦合最少
⑨ Analytics                    ← 必须最后，它消费所有事件
```

---

## 4. 数据模型

### 4.1 分三类，混在一起就完了

| 类别 | 特征 | 例子 | 规则 |
|---|---|---|---|
| **事实** | 只追加，不可改 | `timesheet_entry`, `subject_visit`, `payment`, `audit_entry` | 修正靠冲销记录，不靠 UPDATE |
| **状态** | 可变，但每次变更必须留痕 | `study_site.state`, `subject.status`, `user.role` | 触发器写 `audit_entry` |
| **派生** | 可随时重算 | 毛利、利用率、漏斗、现金流预测 | **不落库**，或落物化投影且可重建 |

**任何被当成"状态"存下来的派生值，都是未来某次口径变更的定时炸弹。**

### 4.2 核心实体轮廓（Phase 1 展开为 DDL）

只列会影响架构的字段，完整 DDL 是 Phase 1 的事。

```
── Identity & Access ──────────────────────────────────────
user            (id, login, name, role_id, group_id, is_external,
                 org_ref, status, joined_at, disabled_at, disabled_reason)
role            (id, code, name, is_external, row_rule, created_at)
role_field      (role_id, field_key, visible)          ← 列维度
role_action     (role_id, action_key, allowed)         ← 动作维度
role_module     (role_id, module_key)                  ← 可访问模块
group           (id, name, lead_user_id)
group_study     (group_id, study_id)                   ← PM 行范围的来源
audit_entry     (id, at, actor_id, actor_role, action, target_type, target_id,
                 before, after, study_site_id, reason)  ← 只追加，见 §6.4

── Intake & Contract ──────────────────────────────────────
client          (id, name, since, payment_terms, contact)
bid             (id, client_id, name, submitted_at, sites, subjects,
                 our_price, our_md, result, won_price, reviewed_note)
feasibility     (id, hospital, study_id, answers_jsonb, score, predicted_rate,
                 actual_rate, decision, override_reason)   ← override 强制留痕
study           (id, client_id, code, short_name, phase, indication,
                 planned_subjects, contract_amount, start_at, end_at)
contract_terms  (id, study_id, effective_from, effective_to,
                 sf_fee_ratio, dropout_billing_rule, unit_price, startup_fee)
                 ↑ EXCLUDE 约束保证同一 study 的生效区间不重叠
change_order    (id, study_id, study_site_id, kind, raised_at, raised_by,
                 description, md_impact, per_subject, amount, status)

── Site & Staffing ────────────────────────────────────────
study_site      (id, study_id, hospital, dept, pi_name, city, state,
                 contracted, unit_price, startup_fee,
                 ethics_at, siv_at, fpi_at, siv_planned_at)
site_state_log  (id, study_site_id, from_state, to_state, at, by, gate_snapshot)
startup_item    (id, study_site_id, category, item, owner_id, due_at,
                 done_at, is_blocking)                  ← is_blocking 驱动 SIV 闸门
staff           (user_id, role_kind, level, city, gcp_expires_at)
assignment      (id, staff_user_id, study_site_id, fte, from_at, to_at)
handover        (id, from_user_id, to_user_id, reason, planned_at, status)
handover_item   (handover_id, seq, item, done_at)

── Regulatory ─────────────────────────────────────────────
ethics_submission (id, study_site_id, kind, due_at, submitted_at,
                   approved_at, status, note)
protocol_amendment(id, study_id, version_from, version_to, effective_at,
                   requires_reconsent, requires_retraining)
isf_item          (id, study_site_id, category, item, status, expires_at, note)

── ClinicalOps ────────────────────────────────────────────
prescreen       (id, study_site_id, at, by_user_id, source, result, reason)
subject         (id, study_site_id, screening_no, randomization_no,
                 status, icf_signed_at, crc_user_id,
                 exit_reason, exit_at, visits_completed_at_exit)   ← I8' 依赖
                 ↑ status ∈ 预筛|筛选中|已入组|筛败|已脱落|已出组
subject_visit   (id, subject_id, seq, visit_name, target_at, window_days,
                 window daterange GENERATED,             ← GiST 索引
                 completed_at, pi_confirmed_at, edc_entered_at, contact_state)
soa_template    (study_id, seq, label_rule, task_rule, cycle_days, window_days)
ip_batch        (id, study_site_id, batch_no, received, dispensed, returned,
                 destroyed, counted, expires_at, temp_excursions)
specimen        (id, subject_id, kind, collected_at, spun_at, stored_at,
                 shipped_at, acknowledged_at)
sae_report      (id, subject_id, term, aware_at, reported_at, hours_elapsed)
query           (id, subject_id, form, field, text, raised_by, owner_user_id,
                 status, opened_at, replied_at, closed_at)
subject_comp    (id, subject_visit_id, traffic, meal, paid_at, method, receipt)

── Timesheet & Cost ───────────────────────────────────────
rate_card       (id, role_kind, day_rate, effective_from, effective_to)
                 ↑ EXCLUDE USING gist (role_kind WITH =, period WITH &&)
timesheet_entry (id, at, user_id, study_site_id, subject_visit_id,
                 work_type, hours, travel_amount,
                 billable, rate_card_id, cost_amount)  ← 落库固化，不回溯

── Revenue & Billing ──────────────────────────────────────
milestone       (id, study_site_id, name, ratio, amount,
                 reached_at, evidence_ref, invoice_id)
invoice         (id, milestone_id, issued_at, due_at, amount)
payment         (id, invoice_id, received_at, amount)

── Quality / External ─────────────────────────────────────
quality_event   (id, study_site_id, source, severity, kind, found_at,
                 description, owner_user_id, due_at, status, sla_hours)
capa            (id, quality_event_id, measures, submitted_at,
                 verified_at, recurrence_count)
monitoring_visit(id, study_site_id, kind, planned_at, monitor_user_id, status)
mvr_item        (monitoring_visit_id, seq, item, done_at)
qc_round        (id, study_site_id, by_org_user_id, at, status)
staff_registration(id, hospital, user_id, gcp_doc, training_doc, doa_listed, status)
```

### 4.3 三个必须在 Phase 1 就用上的 Postgres 能力

| 能力 | 用在哪 | 不用的代价 |
|---|---|---|
| `daterange` + GiST | `subject_visit.window` 生成列 | 「本周哪些访视超窗」变成全表扫 + 应用层比日期 |
| `EXCLUDE` 约束 | `rate_card`、`contract_terms` 生效区间 | 两张生效期重叠的费率卡，历史成本永远对不平 |
| 行级安全 RLS | 所有带 `study_site_id` 的表 | 应用层漏一个 `WHERE` 就是跨项目数据泄漏 |

**RLS 是兜底，不是主要手段。** 主要手段仍然是 `packages/policy` 在查询层注入范围；
RLS 用来保证"即使有人写了裸 SQL，也拿不到不该拿的行"。

---

## 5. API 分层设计

### 5.1 四层，职责不重叠

```
L0  契约层    packages/contracts     zod schema → TS 类型 + 运行时校验 + OpenAPI
              ↑ 单一定义源。前端类型、后端 DTO、文档全部由它生成
L1  资源层    GET/POST/PATCH /v1/…   CRUD 与列表查询，无业务判断
L2  命令层    POST /v1/…/{id}:action 领域动作，返回 sideEffects
L3  投影层    GET  /v1/analytics/…   只读聚合，永不返回明细
```

### 5.2 为什么必须有 L2（命令层）

「完成一次访视」不是对 `subject_visit` 的 PATCH。它一次性触发七件事：
记工时 → 归集成本 → 生成受试者补偿 → 超窗则生成方案偏离 → 转 PI 确认 →
推进 seq → 按 SOA 生成下一次窗口。

如果做成 REST 的 PATCH，客户端就得自己调七个接口，
而**其中任何一个失败都会留下不一致的状态**。所以：

```http
POST /v1/subject-visits/{id}:complete
Idempotency-Key: <uuid>

{ "hours": 4.0, "payCompensation": true, "completedAt": "2026-08-22" }

200 OK
{
  "visit":  { … },
  "sideEffects": [
    { "type": "TimesheetPosted",   "id": "ts_…",  "amount": 0.059 },
    { "type": "CostPosted",        "siteId": "SS-01" },
    { "type": "CompensationDue",   "id": "sc_…" },
    { "type": "DeviationDetected", "qualityEventId": "qe_…", "days": 5 },
    { "type": "NextVisitScheduled","id": "sv_…", "window": "[2026-09-09,2026-09-15]" }
  ]
}
```

**`sideEffects` 不是调试信息，是契约的一部分。** 一线提交后必须立刻知道
"这次操作还顺带生成了一条方案偏离" —— 否则他会以为自己只是打了个卡。

### 5.3 通用约定（Phase 2 展开为 OpenAPI）

| 项 | 约定 |
|---|---|
| 版本 | URL 前缀 `/v1`。破坏性变更开 `/v2`，旧版至少并行 6 个月 |
| 错误 | RFC 9457 Problem Details，`type` 为稳定 URI，业务错误码在 `code` |
| 分页 | 游标分页 `?cursor=&limit=`，不用 offset（数据在变） |
| 幂等 | 所有 L2 命令必须接受 `Idempotency-Key`，24h 内重放返回首次结果 |
| 字段脱敏 | **无权限的字段从响应里"消失"，不是返回 `null`** —— `null` 本身泄漏了字段存在 |
| 聚合 | L3 永不返回受试者明细；返回明细的接口一律走 L1/L2 并写审计 |
| 时间 | 全部 ISO 8601 带时区；日期型字段（访视目标日）用 `date`，不用 `timestamp` |

### 5.4 API-First 的执行方式（对应你的原则 2、3）

```
Phase 2 产出 packages/contracts + openapi.yaml
   ├─▶ 后端：从 contracts 生成 DTO 与校验，实现 handler
   └─▶ 前端：从 openapi.yaml 生成 client + MSW mock handlers
              ↑ 前端不等后端，用 Mock Data 并行开发
```

**契约冻结机制**：`openapi.yaml` 进 git，CI 对比上一版，
破坏性变更（删字段、改类型、加必填）必须显式 `--allow-breaking` 才能合并。

---

## 6. 权限模型

### 6.1 三维，缺一不可（原型已验证）

| 维度 | 存储 | 判定函数 | 强制点 |
|---|---|---|---|
| **行** 看得到哪些中心 | `role.row_rule` + `group_study` | `rowScope(principal)` | 查询层注入 + RLS 兜底 |
| **列** 哪些字段可见 | `role_field` | `canField(principal, key)` | 序列化层剔除 |
| **动作** 能做什么 | `role_action` | `canAct(principal, key)` | 路由守卫 + 领域层二次校验 |

行范围规则（`row_rule` 枚举）：

```
all       全部中心                 经营层 / QA / DM
team      本组承接项目下的中心      PM        ← 由 group_study 推导
assigned  被指派的中心             CRA / CRC ← 由 assignment 推导
hospital  本院承接的项目           机构办     ← 由 user.org_ref 推导
pi        本人担任研究者的中心      PI
none      无
```

**行范围由身份推导，绝不由用户选择。** 前端那个"项目范围"下拉只能在
`rowScope()` 的结果内**再收窄**，永远不能扩大。

### 6.2 外部角色默认拒绝

`role.is_external = true` 的角色，`role_field` 初始为空 —— 所有敏感字段不可见，
靠白名单一项项加回来。

这和"先给全部、再关掉敏感的"在**正常情况下结果一样**，
在**新增一个字段**时结果完全相反：前者新字段默认不可见，后者新字段默认泄漏。
一年内会加几十个字段，这条差异迟早兑现。

### 6.3 权限不是 UI 关注点

前端用 policy 收敛导航与按钮（不给用户看见做不了的事），
但**后端必须独立再判一次**。原型里 `render()` 入口的模块校验对应的是前端那一半；
Phase 3 要做的是另一半，且要有测试断言"绕过前端直接打接口会被拒"。

### 6.4 审计：四个 W，缺一不可

```
audit_entry(at, actor, action, target, before, after, reason)
             谁  何时          改了什么       为什么
```

**`reason` 最容易被省掉，也最要命。** 核查员看到"访视目标日从 08-18 改成 08-25"，
要问的从来不是"改了吗"，而是**"为什么改"** —— 是受试者确实改期，
还是为了让超窗看起来没发生。

规则：**关键字段（访视日期、入组数、里程碑达成日、工时、权限）的变更，`reason` 为必填。**
只追加，无 UPDATE / DELETE 权限（数据库层用 `REVOKE` 保证，不靠自觉）。

---

## 7. 项目目录结构

```
sitedesk/
├─ packages/
│  ├─ contracts/          ★ zod 契约（单一定义源）
│  │  ├─ src/{identity,intake,site,regulatory,clinical,cost,revenue,quality,external,analytics}/
│  │  └─ openapi.yaml     由 zod 生成，进 git，CI 比对破坏性变更
│  ├─ domain/             领域模型、状态机、不变量（纯 TS，零运行时依赖）
│  │  └─ src/invariants/  I1…I15 每条一个文件 + 单测
│  ├─ calc/               ★ 计算引擎：费率卡 + 合同条款 + 纯函数 + 口径注册表
│  │  ├─ src/cost-model.ts        前后端共用
│  │  ├─ src/revenue.ts           I8' 在这里，且只在这里
│  │  └─ src/registry.ts          口径版本注册表
│  ├─ policy/             权限策略（纯函数）rowScope / canField / canAct
│  └─ ui/                 设计系统「Instrument」：令牌 + 组件
├─ apps/
│  ├─ api/                NestJS
│  │  └─ src/modules/     ← 一个限界上下文一个模块，目录即边界
│  ├─ worker/             领域事件消费者
│  └─ web/                React + Vite
│     ├─ src/features/    ← 与后端模块同名，一一对应
│     ├─ src/api/         由 openapi.yaml 生成的 client
│     └─ src/mocks/       MSW handlers（Phase 5/6 并行开发用）
├─ db/
│  ├─ migrations/         版本化 SQL，只进不退
│  └─ seeds/              演示数据（从原型迁移）
├─ tools/
│  ├─ golden/             黄金测试数据集与基线
│  └─ arch-check/         依赖图断言
├─ prototype/             ← 现有可交互原型，作为需求基线保留
└─ docs/
```

**`apps/web/src/features/*` 与 `apps/api/src/modules/*` 同名一一对应。**
找代码不需要猜，且"这个上下文的前端在哪"永远只有一个答案。

---

## 8. 开发阶段计划

### 8.1 你的 Phase 0–9 与规格 M0–M5 的关系

两者是**同一批工作的两种切法**：你的按技术层横切，规格的按业务模块纵切。
它们不冲突 —— 你的 Phase 1–3 是地基（必须横切），Phase 4–6 是模块（必须纵切）。

**但有一处我建议改**：

> **Phase 1 不要一次做完所有表。**
> 原则 4 说"按业务模块垂直开发"，而"Phase 1 数据库 Schema"如果理解成
> "把 40 张表一次建完"，就和原则 4 直接矛盾，也和原则 5（不要一次修改大量无关代码）矛盾。
>
> **建议**：Phase 1 只做 ① 迁移框架与规约 ② Identity&Access 的表 ③ 一张示范业务表
> （`study_site`，因为它是最小作业单元）。其余各表在各自模块的 Phase 6 里随模块建。

### 8.2 修订后的阶段计划

| Phase | 内容 | 退出标准（可验收） | 估时 |
|---|---|---|---|
| **0** | 本文档 + §9 六个决策拍板 | 六个决策全部有结论并写回文档 | — |
| **1** | 迁移框架 + Identity&Access 表 + `study_site` 示范表 + seed | ① `migrate up/down` 可重复执行 ② RLS 策略在 `study_site` 上生效并有测试 ③ 审计表 `REVOKE UPDATE/DELETE` 已验证 | 1.5 周 |
| **2** | `packages/contracts`：全部 10 个上下文的 zod 契约 + OpenAPI + 错误码表 | ① `openapi.yaml` 生成且 lint 通过 ② 前端可据此生成 client 与 MSW mock ③ 破坏性变更 CI 门禁生效 | 2 周 |
| **3** | NestJS 骨架 + OIDC + RBAC 三维强制 + 审计中间件 + `packages/policy` | ① 8 角色 × 行/列/动作 权限矩阵测试全绿 ② 绕过前端直调接口被拒的测试 ③ 字段脱敏快照覆盖 100% DTO 字段 | 3 周 |
| **4** | 核心业务模块 API（按 §3.3 顺序前 3 个：Site&Staffing / ClinicalOps / Timesheet&Cost） | ① `calc` 黄金测试基线建立 ② I8' 有穷举测试 ③ `:complete` 命令的 sideEffects 契约冻结 | 5 周 |
| **5** | 前端骨架 + `packages/ui` 设计系统 + MSW mock 全链路 | ① 设计令牌与原型一致（明暗双模式对比度实测）② 390/834/1500px 零横向溢出 ③ 用 mock 可走通一条完整业务流 | 2.5 周 |
| **6** | 按模块 Frontend + Integration（每模块一个完整纵切） | 每模块：DB→API→Backend→Frontend→集成测试 全绿才算完成 | 8 周 |
| **7** | 离线队列 + 幂等重放 + 异常处理 + 数据校验收口 | ① 离线 8 小时录入 20 条后恢复，重放零丢失零重复 ② 所有 L2 命令幂等测试通过 | 3 周 |
| **8** | 完整测试 + 性能 + 安全 | ① 8 条 E2E 闭环通过 ② 聚合接口 P95 < 800ms ③ 外部角色字段零泄露（渗透测试） | 3 周 |
| **9** | 生产构建 + 部署 + 可观测性 | ① 蓝绿部署可回滚 ② 迁移在生产数据量级上演练通过 ③ 关键指标看板上线 | 2 周 |

**合计约 30 周**（规格里是 34 周，差异来自 Phase 1 收窄与前后端并行）。

### 8.3 并行关系

```
Phase 1 ─┬─ Phase 2 ─┬─ Phase 3 ─┬─ Phase 4 ──┬─ Phase 6 ─┬─ Phase 7 ─ 8 ─ 9
         │           │           └─ Phase 5 ──┘           │
         └───────────┴─ packages/ui 可从 Phase 2 起并行 ───┘
```

**Phase 4 与 Phase 5 必须并行** —— 这正是原则 3 的意思。
前端在 Phase 5 用 MSW mock 开发，Phase 6 才切真实接口。

---

## 9. 六个决策（已定）

> **状态：2026-08-24 全部按建议采纳。** 下表是决议，不是待办。
> 每条后面标注了它在 Phase 1 里实际变成了什么 —— 决策不落到 schema 上就只是意见。

| # | 决策 | 结论 | Phase 1 的落地 |
|---|---|---|---|
| 1 | 租户模型 | **单租户，但列与表先立住** | `tenant` 表 + 每张业务表 `tenant_id`；RLS 策略已含租户条件；有跨租户不可见的测试 |
| 2 | 离线深度 | **B：写队列 + 幂等重放** | 主键改为 `uuid`（客户端可自行生成 ID，联网重放不换 ID）—— 这是离线优先的前提 |
| 3 | 外部方认证 | **一次性魔法链接**，15 分钟有效、单次使用 | `account` 表**不设密码列**；`auth_identity` / `login_token` 属 Phase 3 |
| 4 | 移动端 | **响应式 Web + 企业微信工作台入口** | 不影响 schema |
| 5 | 合同条款粒度 | **按 study + 生效区间参数化** | `contract_terms` 在 Timesheet&Cost 模块建（Phase 6）；`btree_gist` 扩展已就位 |
| 6 | EDC 对接 | **预留只读接口，不真对接** | 不影响 Phase 1 |

以下为决策时的原始分析，保留以备回溯。

### 9.1 单租户还是多租户？（最重要）

这个系统是**恒济自己用**，还是要做成 SaaS **卖给别的 CRO/SMO**？

| | 单租户 | 多租户 |
|---|---|---|
| Schema | 干净 | 每张表加 `tenant_id`，每条 RLS 加租户条件 |
| 成本 | 基准 | Phase 1 +1 周，Phase 3 +1 周，长期心智负担持续 |
| 后悔成本 | 以后改成多租户 ≈ 重写数据层 | 一直单租户则白付这份复杂度 |

**建议：先单租户，但把 `tenant_id` 作为列加上、值恒为 1，RLS 策略预留。**
这样成本只有几天，而未来要改造时不用动 40 张表的主键。
**除非**你已经明确要卖给同行 —— 那就从第一天做真多租户，中途改造是最贵的路径。

### 9.2 CRC 离线要做到什么深度？

| 方案 | 能力 | 成本 |
|---|---|---|
| A 只读缓存 | 断网能查看今日访视与受试者清单，不能提交 | 0.5 周 |
| B 写队列 + 幂等重放 | 断网能完成访视、记工时、登记筛败，联网后重放 | 3 周 |
| C B + 冲突解决 UI | 上面基础上处理"服务端已被别人改过"的情况 | +2 周 |

**建议 B。** 理由：医院地下室、CT 室、病房都可能没信号，而"完成访视并记工时"
是 CRC 一天里最高频的动作 —— 这个动作离线做不了，一线就会退回纸笔，
系统就拿不到数据，管理层的看板就是假的。

C 暂不做：同一次访视被两个人同时改的概率极低，用**最后写入方带版本号、冲突则整单退回人工**即可。

### 9.3 外部方（机构办 / PI）怎么登录？

内部员工走企业微信 / 飞书 OIDC 没问题。但机构办老师和 PI **不在我们的 IM 里**。

| 方案 | 优点 | 缺点 |
|---|---|---|
| A 独立账号 + 密码 + 短信二次验证 | 可控，不依赖对方 IT | 我们要承担密码找回、锁定策略、口令强度 |
| B 邀请制魔法链接（邮箱 / 短信一次性登录） | 无密码，外部方几乎零学习成本 | 依赖邮箱/短信送达；链接泄漏风险需短有效期 |
| C 对接医院统一身份 | 最正规 | 每家医院一套，15 个中心就是 15 次对接，不现实 |

**建议 B（魔法链接，15 分钟有效，单次使用）+ 会话 8 小时。**
外部方是低频用户（机构办一周登录几次），密码只会被忘记然后走找回流程 —— 那还不如直接发链接。

### 9.4 移动端形态？

CRC 主要在手机上用。

| 方案 | 离线能力 | 分发 | 成本 |
|---|---|---|---|
| A 响应式 Web（PWA） | IndexedDB 可用，iOS 上受限 | 浏览器直接开 | 基准 |
| B 企业微信 / 飞书内嵌 H5 | 同 A，但有 IM 免登录 | 工作台入口 | +0.5 周 |
| C 小程序 | 好 | 需审核，且要维护第二套 UI | +6 周 |
| D 原生 App | 最好 | 需发版 | +12 周 |

**建议 A + B 组合：一套响应式 Web，同时在企业微信工作台开一个入口。**
原型已经在 390px 下验证过可用。C/D 的成本换来的能力，在这个场景里不值。

### 9.5 合同条款的参数化到什么粒度？

原型里 `SF_FEE = 0.35` 是全局常量，脱落计费规则也是写死的按访视比例。
真实合同里这两项**每个申办方都不一样**，甚至同一申办方不同项目也不一样。

**建议：`contract_terms` 按 `study_id` + 生效区间（EXCLUDE 约束防重叠）。**
包含：单例单价、启动费、筛败费率、脱落计费规则（枚举：按访视比例 / 按阶段档位 / 不计费）、
里程碑比例表。`calc` 的所有函数都从这张表取参数，**不接受硬编码常量**。

代价：Phase 1 多一张表 + Phase 4 的 `calc` 多一层参数传递。值得 —— 否则第二个客户就得改代码。

### 9.6 要不要预留 EDC 对接？

规格 §14 明确"不做 EDC"。但原型里有 `edc_entered_at`（录入滞后监控），
这意味着我们**已经在依赖 EDC 的一个状态**。

| 方案 | 说明 |
|---|---|
| A 纯人工标记 | CRC 自己点"已录入"。零对接成本，但数据可信度靠自觉 |
| B 预留只读同步接口 | 定义 `edc_sync` 表与一个 webhook 端点，暂不实现具体厂商适配 |
| C 真对接 | 每家 EDC 厂商一套，且涉及 CSV 验证边界 |

**建议 B。** 现在按 A 运行（CRC 手动标记），但 schema 与接口按 B 预留 ——
这样将来某个申办方愿意开放 EDC 只读 API 时，不用改表。**绝不做 C**，那会把我们拖进 GCP 监管范围。

---

## 10. Phase 0 交付物与下一步

### 本阶段完成内容

- 确认规格 §1–§14 的架构基线继续有效
- 纠正三处：不变量 I8 → I8'（补脱落扣减）、限界上下文 8 → 10、审计轨迹提升为 M0 一等公民
- 产出：系统架构、技术栈、10 个模块划分与依赖方向、数据模型轮廓（约 40 张表）、
  API 四层设计、三维权限模型、目录结构、修订后的 10 阶段计划（约 30 周）
- 列出六个阻塞 Phase 1 的决策，每个附建议

### 修改 / 新增的文件

| 文件 | 状态 |
|---|---|
| `docs/04-Phase0-系统分析与架构.md` | 新增（本文档） |
| `docs/03-开发需求与技术架构.md` | **待改**：I8 → I8'、上下文表、M0 范围 —— 等你确认 §9 后一并更新 |

### API 列表 / 数据库变更 / 测试结果

本阶段无。API 是 Phase 2 的交付物，DDL 是 Phase 1 的交付物。

### 当前已知问题

1. **规格 §2.3 的 I8 仍是错的**，等 §9 确认后一并修订（不单独改，避免文档反复）
2. **规格 §12 的 M0–M5 与本文档 Phase 1–9 并存**，两套计划需要合并成一套 —— 建议以本文档为准，M0–M5 作为业务视角的对照表保留
3. `prototype/` 里的演示数据将作为 `db/seeds/` 的来源，但**受试者编号需要重新生成**以确保与任何真实数据无关联

### 下一阶段计划（Phase 1）

**前置条件：§9 六个决策全部拍板。**

Phase 1 范围（收窄后）：
1. 迁移框架（node-pg-migrate）与 SQL 规约（命名、类型、约束、索引）
2. Identity & Access 全部表 + RLS 策略 + `audit_entry` 的 `REVOKE`
3. `study_site` 一张示范业务表（含 RLS）
4. seed 脚本（从原型迁移，受试者编号重新生成）

退出标准：`migrate up` / `migrate down` 可重复执行；RLS 在 `study_site` 上有通过的测试；
`audit_entry` 的 UPDATE/DELETE 被数据库拒绝有测试证明。

**Phase 1 不建其余业务表** —— 它们随各自模块在 Phase 6 建，这是原则 4 的要求。
