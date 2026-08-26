/* 排空时长 —— 把那个「拍出来的 5 秒」换成算得出来的数。
 *
 *  ── 原来的样子 ──────────────────────────────────────────────────────
 *    const wait = Number(process.env["SITEDESK_DRAIN_MS"] ?? 5000);
 *
 *  两个毛病，第二个比第一个严重得多：
 *
 *  ① **5000 是拍的。** 它必须比负载均衡「把这个实例摘掉」所需的时间长，
 *     而那个时间等于 探测间隔 × 连续失败阈值。k8s 默认 10s × 3 = 30 秒，
 *     ALB 默认 30s × 2 = 60 秒 —— 两个都远大于 5 秒。也就是说默认值在
 *     最常见的两种编排器上**都是错的**，而错法是静默的：发布看起来成功，
 *     只是每次漏掉一小撮请求，在日志里表现为客户端侧的连接被拒。
 *
 *  ② **`Number("3o")` 是 NaN，而 `NaN > 0` 是 false。**
 *     于是一个手滑的环境变量把三步停机悄悄降级成「立刻关」——
 *     恰恰是这段代码存在的理由被删掉了，且没有任何一行日志提到它。
 *
 *  ── 现在的样子 ──────────────────────────────────────────────────────
 *  优先级：显式的 SITEDESK_DRAIN_MS  >  按 LB 参数推算  >  默认值 + 一条告警。
 *
 *  推算这条路是重点：运维知道自己的 LB 探测间隔配的是多少，
 *  但没人算得出「那我该排空几秒」。让他填自己知道的那个数，
 *  换算交给这里 —— 拍脑袋于是变成一次乘法。
 *
 *  畸形的值不再被静默吞掉：preflight 会据此**拒绝启动**。
 */

export interface DrainConfig {
  /** 收到 SIGTERM 之后、真正关闭之前等多久（毫秒） */
  ms: number;
  /** 这个数是怎么来的 —— 启动日志里要写出来，否则没人知道当前生效的是哪条路径 */
  source: "explicit" | "derived" | "default";
  /** 一句人话，进启动日志 */
  detail: string;
  /** 配置本身不合法。不在这里退出：拒绝启动是 preflight 的职责 */
  error?: string;
}

/** 排空超过这个数就不是排空了 —— 编排器的宽限期通常只有 30–60 秒，
 *  再长也等不到，只会被 SIGKILL 拦腰砍断，反而不如短一点先把连接关干净。 */
const MAX_MS = 600_000;
/** 既没显式给、也没给 LB 参数时的兜底。保留历史默认值，
 *  但生产环境下 preflight 会为它打一条告警 —— 沉默才是问题。 */
export const FALLBACK_MS = 5_000;
/** LB 摘掉实例之后再多等一会儿：探测与请求之间总有一点点抖动。 */
const MARGIN_MS = 1_000;

/** 严格的非负整数解析。`"3o"` / `"5.5"` / `" "` / `"-1"` 一律 null，不做四舍五入。 */
function intOf(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

const bad = (name: string, raw: string, want: string): DrainConfig => ({
  ms: FALLBACK_MS, source: "default", detail: "配置不合法",
  error: `${name}=${JSON.stringify(raw)} 不是合法的${want}。\n` +
         `    它会被 Number() 解析成 NaN，而 NaN 会让三步停机静默降级成「立刻关」——\n` +
         `    发布照常成功，只是每次都漏掉一小撮请求。所以这里拒绝启动。`
});

/** 纯函数，便于直接测。不读全局，只看传进来的 env。 */
export function drainConfig(env: NodeJS.ProcessEnv = process.env): DrainConfig {
  const rawDrain = env["SITEDESK_DRAIN_MS"]?.trim();
  if (rawDrain) {
    const ms = intOf(rawDrain);
    if (ms === null) return bad("SITEDESK_DRAIN_MS", rawDrain, "毫秒数（非负整数）");
    if (ms > MAX_MS)
      return { ms: FALLBACK_MS, source: "default", detail: "配置不合法",
        error: `SITEDESK_DRAIN_MS=${ms} 超过上限 ${MAX_MS}ms。\n` +
               `    编排器的宽限期通常只有 30–60 秒，排空比它长的话，等不到关闭就会被 SIGKILL，\n` +
               `    在途请求反而被拦腰砍断 —— 比排空得短更糟。` };
    return { ms, source: "explicit", detail: `SITEDESK_DRAIN_MS=${ms}` };
  }

  const rawProbe = env["SITEDESK_LB_PROBE_MS"]?.trim();
  if (rawProbe) {
    const probe = intOf(rawProbe);
    if (probe === null || probe < 100)
      return bad("SITEDESK_LB_PROBE_MS", rawProbe, "毫秒数（≥100 的整数）");
    const rawFails = env["SITEDESK_LB_PROBE_FAILURES"]?.trim();
    const fails = rawFails ? intOf(rawFails) : 2;
    if (fails === null || fails < 1 || fails > 10)
      return bad("SITEDESK_LB_PROBE_FAILURES", rawFails!, "次数（1–10 的整数）");
    const ms = Math.min(probe * fails + MARGIN_MS, MAX_MS);
    return { ms, source: "derived",
      detail: `按 LB 参数推算：探测间隔 ${probe}ms × 失败阈值 ${fails} + 余量 ${MARGIN_MS}ms` };
  }

  return { ms: FALLBACK_MS, source: "default", detail: `未配置，用默认值 ${FALLBACK_MS}ms` };
}

/** 给 preflight 用的一句话：为什么这个默认值该被替掉。 */
export const DRAIN_DEFAULT_WARNING =
  `SITEDESK_DRAIN_MS 未设置，正在用默认值 ${FALLBACK_MS}ms。\n` +
  "    这个数必须比「负载均衡把本实例摘掉」所需的时间长，也就是\n" +
  "      探测间隔 × 连续失败阈值 + 一点余量\n" +
  "    k8s 默认 10s × 3 = 30 秒，ALB 默认 30s × 2 = 60 秒 —— 都远大于 5 秒。\n" +
  "    短了不会报错，只会让每次发布漏掉一小撮请求（客户端侧看到连接被拒）。\n" +
  "    要么直接给 SITEDESK_DRAIN_MS，要么填 SITEDESK_LB_PROBE_MS\n" +
  "    （与 SITEDESK_LB_PROBE_FAILURES，默认 2），由本进程替你算。";
