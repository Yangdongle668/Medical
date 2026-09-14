import { describe, it, expect } from "vitest";
import { VISIT_STATUSES, VISIT_STATUS_LABEL, screeningGateWording }
  from "../src/clinical/model.js";

/* ════════════════════════════════════════════════════════════════════
   闸门上那几句话是给人看的，所以它们有约束。

   ── 这一组是从两次同类事故里长出来的 ──────────────────────────────
   ① 界面角标一度直接画 `subj` —— 键是给程序看的，现场看到的是英文；
   ② 入组闸门一度写 `筛选期访视当前是「planned」，还没做完`，同一个毛病。

   ②被补上之后又摔了一次：措辞在服务端与 mock 里各抄一份，改的时候
   服务端两句都改了，mock 只改了 `detail`，`message` 落下了 ——
   而界面照出去的偏偏是 `message`。所以措辞搬进了 `screeningGateWording`：
   一处定义，两处调用。这一组盯的是**那一处**说的话合不合规矩。

   ── 为什么不是"断言字符串等于字符串" ──────────────────────────────
   逐字比对等于把同一句话再抄一遍，红不了也证明不了什么。
   这里断言的是**性质**：不许漏出枚举键、不许漏出 Markdown 记号、
   三种情况必须说出三件不同的事、每一句都得给得出下一步。
   ════════════════════════════════════════════════════════════════════ */

/** 三种情况：连访视都没有 / 做完了没登记 / 其余（还没做、漏访……）。 */
const CASES = [null, ...VISIT_STATUSES.filter(s => s !== "locked")] as const;

describe("入组闸门的措辞", () => {
  it("**一个枚举键都不许漏出去** —— 键是给程序看的", () => {
    for (const s of CASES) {
      const w = screeningGateWording(s);
      for (const key of VISIT_STATUSES) {
        expect(w.detail, `detail 漏出了 ${key}`).not.toContain(key);
        expect(w.message, `message 漏出了 ${key}`).not.toContain(key);
      }
    }
  });

  it("也不许漏出 Markdown 记号 —— 那一栏是纯文本，`**` 会原样显示", () => {
    /* `UnmetList` 画的是 `<span>{u.message}</span>`，没有任何 Markdown 处理。
       服务端那句 `待**登记** PI 确认` 在界面上就是四个星号。 */
    for (const s of CASES) {
      const w = screeningGateWording(s);
      expect(w.detail).not.toContain("**");
      expect(w.message).not.toContain("**");
    }
  });

  it("三种情况说的是三件不同的事 —— 说一样的话等于没分支", () => {
    const msgs = CASES.map(s => screeningGateWording(s).message);
    expect(new Set(msgs).size).toBe(CASES.length);
    const details = CASES.map(s => screeningGateWording(s).detail);
    expect(new Set(details).size).toBe(CASES.length);
  });

  it("**每一句都要说得出下一步**，而且不许是「等 PI」或「再签一次知情」", () => {
    for (const s of CASES) {
      const w = screeningGateWording(s);
      /* 都是一线自己办得掉的事，所以每一句里都得有一个"去哪儿/做什么"。 */
      expect(w.message, `${s} 那一句没给下一步`).toMatch(/去|先|还差|打开/);
      /* 能走到入组的人已经签过知情了 —— 叫他再签一次是把办不到的事
         写成了下一步。 */
      expect(w.message).not.toContain("登记 ICF");
      expect(w.message).not.toContain("登记知情");
      /* PI 多数时候没有本系统的账号，"等 PI 确认"就是永远。
         正确的说法是"**登记** PI 确认"（迁移 0050）。 */
      expect(w.message).not.toMatch(/等 ?PI/);
      expect(w.message).not.toContain("需 PI 确认");
    }
  });

  it("状态中文名覆盖整个枚举 —— 少一个就会在那一支上漏出键", () => {
    /* 类型上已经是 `Record<VisitStatus, string>`，编译就拦得住；
       这一条钉的是**值**不为空：写成 `planned: ""` 一样编译得过，
       而那时闸门说的是「筛选期访视，不能入组」。 */
    for (const s of VISIT_STATUSES) {
      expect(VISIT_STATUS_LABEL[s], `${s} 没给中文名`).toBeTruthy();
      expect(VISIT_STATUS_LABEL[s]).not.toMatch(/^[\x20-\x7e]*$/);   // 得是中文
    }
  });
});
