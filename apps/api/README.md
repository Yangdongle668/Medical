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

## 一条连接，一次只发一条语句

一个请求 = 一个事务 = 一条连接。在这条连接上用 `Promise.all` 并发发查询，
pg 只会把它们排队（换不来速度），却让语句在同一个事务里交错。
这里一律顺序 `await`，不用 `Promise.all`。
