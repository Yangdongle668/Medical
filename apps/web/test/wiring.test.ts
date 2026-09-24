import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allEndpoints } from "@sitedesk/contracts";

/* ════════════════════════════════════════════════════════════════════
   写端点必须有人调，没人调的要**写明为什么**。

   ── 这条测试是为哪次盘点写的 ────────────────────────────────────
   那次盘点时契约里 132 个端点，其中 75 个是写端点
   （post / patch / put / delete）。
   清点了一遍前端到底调了哪些：**60 个已接，15 个在服务端跑着
   但界面上没有任何入口** —— 完整的 controller、service、审计、幂等键，
   `db/test` 里还有针对性的测试，就是没有一个按钮打得到它。

   漏掉的那些有一条清楚的规律：**每条流程"处理/判定"那一端都接了，
   "发起"那一端没接。** 可以判定一份立项申请，但提不了；
   可以受理一份机构材料，但交不了；可以确认、执行、交报告一次监查访视，
   但排不了。于是系统只能处理已经在库里的记录 ——
   任何一件事都没法从界面上开一个头。

   ── 这件事此前同样没有任何东西会报警 ────────────────────────────
   `tools/arch-check.mjs` 断言"端点与契约一一对应"，
   但它比的是**契约与后端实现**，不管前端有没有调。
   于是一个端点可以写完、测完、上线，然后在那里放一年。

   ── 所以：豁免要写理由 ──────────────────────────────────────────
   一个端点暂时没接不是错。**没人说得出为什么没接**才是。
   ════════════════════════════════════════════════════════════════════ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "../src");

/** 递归读 apps/web/src 下的全部 ts / tsx，**排除 mocks/** ——
 *  mock 里出现一个端点名只说明它有假响应，不说明界面上打得到它。 */
function sources(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name !== "mocks") sources(path.join(dir, e.name), acc);
    } else if (/\.tsx?$/.test(e.name)) acc.push(path.join(dir, e.name));
  }
  return acc;
}

const CODE = sources(SRC).map(f => fs.readFileSync(f, "utf8")).join("\n");

/* 按**词**匹配，不是子串。`call("createBid")`、
   `op: "createBid" | "decideBid"`（当成变量传下去的那种）、
   feature 里的 api.ts 包装 —— 三种写法都要认得出。
   只用 `call("…")` 那一种正则的话会漏掉后两种，
   而第一次盘点正是这么把 60 个数成了 38 个的。 */
const referenced = (op: string) =>
  new RegExp(`\\b${op}\\b`).test(CODE);

const WRITE = new Set(["post", "patch", "put", "delete"]);
const writes = allEndpoints()
  .filter(e => WRITE.has(e.method))
  .map(e => e.id)
  .sort();

/** 服务端有、界面上暂时没有入口的写端点。**每一条都要写清楚为什么。**
 *  接上一个就从这里删一行 —— 这张表只许变短。
 *
 *  **现在它空了：75 个写端点全都有界面入口。**
 *  空着不等于这条测试没用了 —— 契约新增一个写端点时，
 *  上面那条断言会立刻响，而那正是要有人来决定"它归哪一页"的时刻。
 *  往这里加一行是允许的，但得写清楚为什么。 */
const NOT_YET: Record<string, string> = {};

describe("写端点接线", () => {
  it("每个写端点要么被前端引用，要么在 NOT_YET 里写明理由", () => {
    const orphan = writes.filter(id => !referenced(id) && !(id in NOT_YET));
    expect(orphan, "服务端写了、前端没接，也没写理由").toEqual([]);
  });

  it("NOT_YET 只许变短：接上了就把那一行删掉", () => {
    /* 留在表里的"已经接了"比漏掉一个更坏 ——
       它会让人以为那件事还没做，然后再做一遍。 */
    const stale = Object.keys(NOT_YET).filter(referenced);
    expect(stale, "这些已经接上了，从 NOT_YET 里删掉").toEqual([]);
  });

  it("NOT_YET 里的都还是真端点 —— 契约改名时这条先响", () => {
    const gone = Object.keys(NOT_YET).filter(id => !writes.includes(id));
    expect(gone, "契约里已经没有这些写端点了").toEqual([]);
  });

  it("盘点的分母对得上：91 个写端点", () => {
    /* 分母写死。契约新增一个写端点时这条会响 ——
       那正是要有人来决定"它归哪一页"的时刻。

       75 → 76：`setLoginAddress`（登记登录收件地址）。
       它归"组织与权限"那一页，账号台账每行一个按钮 —— 因为
       "这个人自助进不进得来"本来就是那张台账要回答的问题之一。

       76 → 77：`setStudyTeam`（把项目划给另一个组）。
       同样归"组织与权限"，在「分组」那一页每个组卡片里 ——
       因为**它就是这个组的行范围本身**：划走那一刻，这个组的 PM
       看不见这个项目和它下面的一切。在此之前这件事只能直接改库。

       77 → 79：`setMailTransport` / `testMailTransport`（投递通道）。
       归"组织与权限"新开的那一页。登录链接靠它送出去，而在此之前
       **只能改环境变量、重启进程** —— 也就是说签发登录链接的权限
       等同于运维权限（login-delivery.ts 自己把这条列为
       「上线前该补掉的一项」）。

       79 → 82：`assignSiteStaff` / `endSiteAssignment`（派工）与
       `setStudySitePi`（给中心指定研究者）。前两个归"派工与产能"，
       第三个归中心详情页的「这个中心上有谁」。

       这三条补的是同一个格子：`site_assignment` 是行规则 `assigned`
       的唯一来源，`study_site.pi_account_id` 是 `pi` 的唯一来源，
       而**两者都没有入口** —— 种子灌了 30 行派工，交接在两个人之间
       挪行，第一行从哪来没有答案；PI 那一栏只有建档那一次能写，
       而建档表单从来没有那一栏。

       这正是本文件开头那条规律的又一例，只是更隐蔽：
       缺的不是某条流程的"发起"那一端，是**一整张表没有写端点**——
       而这张表决定的是谁看得见什么。开发库的审计轨迹里留着绕过去的
       痕迹：09-06 有人把整个 CRC 角色的行规则从 assigned 改成了 team。

       82 → 83：`setAccountStaff`（登记 / 修改员工名册）。归"组织与权限"的
       账号台账，每行一个按钮。

       它补的是**同一个坑的下一层**：上面那三条让派工有了入口，而派工的
       下拉是从 `staff` 出的 —— 「组织与权限」建号只写 `account`，
       于是建出来的 CRC 是半个人：能登录，但派工的下拉里没有他、
       填工时被拒 422（费率按 `staff.level` 挑）、备案名册上没有他、
       发起不了交接。**四处都不报「这个账号没有名册」。**
       开发库里 8 个内部账号有 3 个是这样建出来的。

       83 → 84：`recordAcceptanceLetter`（登记拿到立项受理意向函）。
       归"立项受理"那一页，每条受理一个按钮。

       它和 `acceptSite` 是**两条路，不是一条的两半**：`acceptSite` 是
       机构办在本系统里点的（要先逐项勾清单），而多数医院的机构办
       不在这个系统里（迁移 0038 自己写着这句话）—— 一线手里拿着的
       是一张纸，这一条就是那张纸落库的地方。
       同一批还把 `docs` 从必填改成了可省略：一张永远不会被勾的清单，
       不是记录，是每次递交都要重填一遍的仪式。

       84 → 85：`scheduleSubjectVisit`（补排一次访视）。归"受试者访视窗口"，
       没有下一次访视的那几行一个按钮。

       它补的**不是某条流程的发起那一端，是一条流程的唯一出路**：
       在此之前访视只有两个出生口 —— 签知情排第 0 次、完成一次排下一次。
       两个都堵上时，界面上没有任何办法给这一例排出访视来；而入组要求
       第 0 次已登记 PI 确认，于是这一例除了筛败 / 脱落没有出路。
       现场报来的两句原话就是这条缝的两半：
         「页面没有可以操作的按钮，只有一个脱落」
         「显示访视没有排出来，但是我没有看到排访视的功能」

       两个口都堵上不是假想。最普通的那种是**方案修订把 SOA 加长了**：
       下一次是在「完成上一次」那一刻排的，那时新的 seq 还不存在，
       而 `replaceSoa` 写明了"只影响此后才排出来的访视"、不回头补 ——
       于是做到原最后一次的那一批人整批卡住，且此前只能改库。

       85 → 86：`setNotifyPrefs`（改自己的邮件提醒偏好）。归「提醒设置」一页，
       首页右上角进去；每封提醒邮件底下也指到那里 —— 退订要比忍着方便，
       否则人会去把发件人拉黑，连 SAE 的紧急提醒也一起收不到了。

       86 → 91：`recordExport`（导出留痕）与两类批量导入的试运行 / 执行
       （`previewPrescreenImport` / `commitPrescreenImport` 归「预筛登记」，
       `previewAccountImport` / `commitAccountImport` 归「组织与权限」的账号台账）。
       导出按钮在受试者、访视日程、质疑、工时、监查访视、质量台账六页（shell/ExportButton）。
       试运行也是 POST：它要带整份文件上来，而且服务端是真跑一遍再回滚。 */
    expect(writes.length).toBe(91);
  });
});
