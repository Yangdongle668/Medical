# @sitedesk/api —— 后端

NestJS 单体 + 独立 worker（worker 属后续阶段）。模块目录 = 限界上下文目录，
由 `npm run arch:check` 断言彼此不越界。

```sh
npm run db:reset            # 准备数据库
npm run typecheck
npm test                    # 权限矩阵 / 审计 / 幂等 / 闸门与认证
npm run api:dev             # 编译并启动
```

## 一个请求的生命周期

```
中间件  取连接 → BEGIN → 解析令牌 → SET LOCAL app.account_id → 装载 Principal
  ↓
AuthGuard      未认证一律 401（@Public 的端点除外）
  ↓
ActionGuard    @RequireAction 声明的动作权限，服务端强制
  ↓
ZodPipe        契约校验失败 → 422 + issues
  ↓
处理器          service 里用 siteScopeSql() 注入行范围
  ↓
MaskInterceptor 按列权限**删除**无权字段（不是置 null）
  ↓
TxInterceptor  成功 COMMIT / 失败 ROLLBACK
  ↓
ProblemFilter  任何异常 → RFC 9457 application/problem+json
```

### 为什么整个请求跑在一个事务里

RLS 靠 `SET LOCAL app.account_id` 生效，而 `SET LOCAL` 的作用域就是事务。
用连接级 `set_config` 在连接池下是灾难：一个请求设的身份会漏给下一个请求。

### 为什么认证在中间件而不是 Guard

Guard 在中间件之后运行，而装载主体本身就需要一个已经设好身份的连接。

### 为什么脱敏在序列化层

放在 service 里做，意味着每个新写接口的人都必须记得做。
忘一次就是一次泄漏，**而且不会有任何报错**。放在出口处统一做，忘不了。

## 权限的三处强制点

| 维度 | 强制点 | 兜底 |
|---|---|---|
| 行 | `siteScopeSql()` 注入 WHERE | PostgreSQL RLS |
| 列 | `MaskInterceptor` 删字段 | —— |
| 动作 | `ActionGuard` | service 内可再断言 |

**行维度有两处实现**（TypeScript 与数据库函数），
由 `packages/policy/test/parity.test.ts` 在全部「账号 × 中心」组合上穷举比对 ——
两处不一致就是数据泄漏。

## 认证

| 对象 | 方式 | 说明 |
|---|---|---|
| 内部员工 | OIDC（企业微信 / 飞书） | 待接入真实 IdP |
| 外部方 | 一次性魔法链接 | 15 分钟有效、单次使用、数据库内原子兑换 |
| 本地 / CI | `POST /v1/auth/dev-session` | **仅当 `SITEDESK_DEV_LOGIN=1`**，否则 404 |

令牌只存 SHA-256。明文只在生成的那一刻存在于内存里 ——
数据库被拖库时，明文令牌等于把所有人的会话一起交出去。

### 链接送到哪去

**收件地址由服务端解析，绝不来自请求。** 签发与解析是同一个调用
（`app.issue_login_link`），地址存在 `auth_identity(provider='magic-link')`，
由运维用 `deploy/login-address.sh` 登记。

请求体里那个 `sentTo` 只作审计留痕。拿它当收件地址的话，这个 `@Public()`
端点就是一键账号接管 —— `{"login":"lingyuan","sentTo":"我@攻击者"}`，
而且不会报错、不留异常痕迹：审计轨迹里记的是"凌远登录了"。

三种情况返回**完全一样的 202**：账号不存在、账号存在、账号存在但没登记地址。
最后一种是通道做出来之后新增的状态，同样不能被区分出来，
否则这个接口又变回账号枚举器。差别只写进服务端日志。

投递挂在 `RequestCtx.afterCommit` 上，**COMMIT 之后才发**：
在事务里发的话，用户可能在令牌落库之前就点开链接，
拿到一句"链接无效"而库里明明有 —— 那是最难复现的一类报障。

通道见 `infra/login-delivery.ts`（SMTP / 短信 webhook / 开发用的 console）。
console 通道在 `NODE_ENV=production` 下**拒绝启动**：它把可用的登录链接
打进日志，等于把登录权限授予所有能读日志的人。

### 限流是两级的

`infra/rate-limit.ts`：进程内计数器挡洪水，数据库计数器定阈值。

单靠进程内的话，多副本部署时实际配额 = 阈值 × 副本数，而**这件事是静默的**：
配置没变、日志没变、监控没变。单靠数据库的话，未认证流量就有了一条
直通数据库的写入路径。两级同时在，第一级把第二级的写入量限死：
每实例每窗口每 key 最多 `limit` 次。

key 先 `sha256(scope:key)` 再出门 —— 它是登录名和登录令牌前缀，
明文落库会推翻"库里只有哈希"这个前提。

共享计数走连接池，**不走请求那条连接**：兑换端点在令牌不对时会抛错回滚，
计数跟着回滚的话，猜错的每一次都不算数，暴力猜令牌完全不受限。

| 变量 | 默认 | 说明 |
|---|---|---|
| `SITEDESK_LINK_LIMIT` | `5` | 每 10 分钟每个登录名可申请几次链接 |
| `SITEDESK_REDEEM_LIMIT` | `10` | 每 10 分钟同一把令牌可兑换几次 |
| `SITEDESK_RATE_LIMIT_SHARED` | 开 | 设 `0` 退回单实例计数（会打一条告警） |

两个阈值填了非正整数就退回默认值并告警 —— `Number("五")` 是 `NaN`，
而 `次数 > NaN` 恒为 `false`：**限流会完全失效，且没有任何声音**。

会话可撤销：机构老师离职、PI 换人都要能立刻断开，无状态 JWT 做不到这一点。
账号一旦停用，`app.resolve_session()` 立即不再认它 —— 停用即断线。

## 闸门与「尚未交付」

`modules/site/gate.ts` 是中心状态机的闸门注册表。
SIV 闸门已接上启动清单（真实查询）；关闭闸门的七项条件仍多数依赖尚未交付的模块。

**这种情况下必须 fail-closed**：把「查不了」当成「通过」，
等于允许在质疑挂着、药品差三盒的时候关闭中心 ——
而这正是原型里那个只有一句 `ss.st = next` 的按钮所犯的错。

因此未就绪的检查项以 `unavailable` 出现在 `unmet` 里，闸门不放行。
每个模块交付时把自己的检查项接进那张表。

还有一种更隐蔽的失效：**闸门在查，但查的东西是空的**。
SIV 闸门查「启动清单的阻塞项是否清零」，而新建的中心若不铺开清单，
这个条件天然成立 —— 闸门看着在把关，实际对每一个新中心都放行。
所以 `SiteService.create()` 建档即铺开 `DEFAULT_STARTUP_ITEMS`，
并有两条测试锁死它。**一个默认放行的闸门比没有闸门更危险，
因为它会让人以为已经把住了。**

## 动作权限来自契约，不在控制器上另抄一遍

`ActionGuard` 按 `@Operation("x")` 声明的 operationId 去 `@sitedesk/contracts`
的端点注册表里查 `action`。控制器上**没有** `@RequireAction` 这类装饰器。

原因是两处各写一份的后果不是不一致告警，而是**静默失守**：
契约上写了 action、控制器忘了加装饰器，端点就是敞开的，
而所有测试都会照常通过 —— 因为没有任何一处会发现两边不一样。
（ClinicalOps 交付时就踩了这一下：契约写了 `subjRead`，QA 照样拉得出全院名册。）

`npm run arch:check` 断言两边一一对应：控制器上的每个 `@Operation`
必须在契约里有端点，契约里每个非 `planned` 的端点必须有人实现。
唯一的例外是 `devSession`，在 `tools/arch-check.mjs` 里逐条写明了理由。

## 一条连接，一次只发一条语句

一个请求 = 一个事务 = 一条连接。在这条连接上用 `Promise.all` 并发发查询，
pg 只会把它们排队（换不来速度），却让语句在同一个事务里交错。
这里一律顺序 `await`，不用 `Promise.all`。

## 日志：一行一条 JSON，靠 requestId 拼时间线

线上排查要做的事是**按请求把散落在各处的行拼回一条时间线** ——
这个 500 是哪个请求打的？它前面那条 N+1 告警是不是同一个请求？
Nest 默认格式里一个字段都没有，所以这件事根本做不了。

现在每条日志都是一行 JSON，固定 `ts / level / scope / msg`，
并**自动**带上请求上下文：`requestId / operationId / accountId / role`
（从 AsyncLocalStorage 取，调用方什么都不用传 —— 靠传参迟早有一条路径
漏传，而漏传的那条正是要查的那条）。

响应体里的 `traceId`、响应头里的 `X-Request-Id`、日志里的 `requestId`
是同一个值：用户报一个号，日志里就能捞出那一条堆栈。

前端那一跳（`apps/web/server.mjs`）会用 `X-Request-Id` 把号带过来。
API 认它，但**先校形状**（`^[A-Za-z0-9_-]{8,64}$`）：这个值会进日志、
也会回到响应体里，半信半疑地用它等于把日志的写入权交给调用方。

每个请求一行访问日志，挂 `close` 而不是 `finish` —— `finish` 只在响应
**发完**时触发，客户端中途断开就一条都没有，而那恰恰最需要留痕
（那些行带 `aborted: true`）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `SITEDESK_LOG_FORMAT` | 生产 `json` / 其余 `pretty` | 机器读 / 人读 |
| `SITEDESK_LOG_LEVEL` | `info` | `debug` 打开探针访问日志等细节 |

**日志绝不抛异常**：它经常在异常处理路径上被调用（`ProblemFilter`、
连接池的 `error` 事件），在那里抛等于把一个能看见的错误换成一个
看不见的崩溃。bigint、循环引用、`toJSON` 自己抛，都兜住了。
