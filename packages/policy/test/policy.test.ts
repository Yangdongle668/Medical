import { describe, it, expect } from "vitest";
import { canField, maskFields, canAct, canModule, needsReason, SENSITIVE_ACTIONS,
         type Principal, type FieldGates } from "../src/index.js";
import { allEndpoints } from "@sitedesk/contracts";

const base: Principal = {
  accountId: "a1", tenantId: "t1", login: "x", roleCode: "cra", rowRule: "assigned",
  isExternal: false, active: true, teamId: null, orgRef: null,
  fields: ["subject"], actions: ["raiseQ"], modules: ["cra", "mysites"]
};
const inst: Principal = { ...base, roleCode: "inst", rowRule: "hospital",
  isExternal: true, orgRef: "北京协和医院", fields: [], actions: ["closeQA"], modules: ["inst"] };
const boss: Principal = { ...base, roleCode: "boss", rowRule: "all",
  fields: ["cost", "margin", "price", "staff"], actions: ["manage", "advance"], modules: ["dash"] };

const GATES: FieldGates = {
  unitPriceCents: "price", startupFeeCents: "price", contractAmountCents: "price",
  costCents: "cost", grossMarginRatio: "margin", screeningNo: "subject"
};

describe("列维度：无权限的字段消失，不是置 null", () => {
  it("有权限时字段原样保留", () => {
    const out = maskFields(boss, GATES, { code: "SS-01", unitPriceCents: 5800000 });
    expect(out).toEqual({ code: "SS-01", unitPriceCents: 5800000 });
  });

  it("无权限时字段**不存在**，而不是 null", () => {
    const out = maskFields(base, GATES, { code: "SS-01", unitPriceCents: 5800000 }) as any;
    expect("unitPriceCents" in out).toBe(false);
    expect(out.unitPriceCents).toBeUndefined();
    expect(JSON.stringify(out)).toBe('{"code":"SS-01"}');
  });

  it("嵌套与数组里同样生效 —— 换个位置绕不过去", () => {
    const out = maskFields(base, GATES, {
      items: [{ code: "SS-01", unitPriceCents: 1, study: { contractAmountCents: 2 } }],
      summary: { costCents: 3 }
    }) as any;
    expect(out.items[0].unitPriceCents).toBeUndefined();
    expect(out.items[0].study.contractAmountCents).toBeUndefined();
    expect(out.summary.costCents).toBeUndefined();
    expect(out.items[0].code).toBe("SS-01");
  });

  it("外部角色默认什么敏感字段都看不到", () => {
    expect(inst.fields).toEqual([]);
    const out = maskFields(inst, GATES, {
      code: "SS-01", unitPriceCents: 1, costCents: 2, screeningNo: "S-0203"
    }) as any;
    expect(Object.keys(out)).toEqual(["code"]);
  });

  it("停用账号失去全部字段权限", () => {
    const off = { ...boss, active: false };
    expect(canField(off, "price")).toBe(false);
    expect(Object.keys(maskFields(off, GATES, { code: "x", unitPriceCents: 1 })))
      .toEqual(["code"]);
  });

  it("无需脱敏时原样返回同一个对象引用 —— 不做无谓拷贝", () => {
    const v = { code: "SS-01" };
    /* 经营层有 price，故该 gate 无需脱敏 */
    expect(maskFields(boss, { unitPriceCents: "price" } as FieldGates, v)).toBe(v);
  });

  it("经营层刻意没有 subject 权限 —— 算账不需要受试者标识", () => {
    expect(canField(boss, "subject")).toBe(false);
    expect(canField(boss, "margin")).toBe(true);
    const out = maskFields(boss, GATES, { code: "SS-01", screeningNo: "S-0203", costCents: 1 }) as any;
    expect("screeningNo" in out).toBe(false);
    expect(out.costCents).toBe(1);
  });
});

describe("动作维度：看得到不等于能操作", () => {
  it("QA 能关闭质量事件，CRA 不能", () => {
    expect(canAct({ ...base, actions: ["closeQA"] }, "closeQA")).toBe(true);
    expect(canAct(base, "closeQA")).toBe(false);
  });
  it("停用账号失去全部动作", () => {
    expect(canAct({ ...boss, active: false }, "manage")).toBe(false);
  });
  it("模块可见性只收敛导航，不是安全边界", () => {
    expect(canModule(base, "cra")).toBe(true);
    expect(canModule(base, "pnl")).toBe(false);
  });
});

/* ── 这一组曾经是绿的，而且正因为它是绿的才没人发现问题 ──────────────
   原来这里断言 `needsReason("updateVisitTargetDate")` 为真，它确实为真 ——
   因为 SENSITIVE_ACTIONS 里就写着这个名字。**但契约里从来没有过这个端点。**
   断言"名字在这张手写清单里"是在拿清单证明清单：清单写错什么，
   测试就跟着确认什么。真正要成立的性质是**它对得上一个真实端点**。

   三条死名字里最贵的是 `changeAccountRole`（真名是 `updateAccount`）：
   `needsReason()` 查不到只返回 false，于是"谁把谁调成了什么角色"
   进了审计轨迹却没被标成敏感，而审计页默认只看敏感那一档 ——
   核查员打开的第一屏里没有它。 */
describe("敏感动作必须留原因", () => {
  it("接管账号、改权限、推进阶段都在清单里", () => {
    for (const id of ["disableAccount", "enableAccount", "updateAccount",
                      "updateRolePermissions", "setAccountPassword", "setLoginAddress",
                      "advanceStudySite", "voidTimesheet"])
      expect(needsReason(id), id).toBe(true);
  });
  it("普通读写不在清单里", () => {
    for (const id of ["listAccounts", "getMe", "listStudySites"])
      expect(needsReason(id), id).toBe(false);
  });
  it("清单不为空 —— 空清单等于这条约束没生效", () => {
    expect(SENSITIVE_ACTIONS.size).toBeGreaterThan(4);
  });

  /* 拿契约本身当唯一权威，而不是再抄一份名单。
     `tools/arch-check.mjs` 里有同样一条 —— 那份是文本解析，跑在不需要
     数据库的第一个 CI job 里，比这里早失败几分钟；这份是语义的，
     不会因为 SENSITIVE_ACTIONS 换个写法就解析不出来。两份都留着。 */
  it("清单里的每一条都得是真的 operationId —— 写错名字不报错，只是静默地不算敏感", () => {
    const declared = new Set(allEndpoints().map(e => e.id));
    const 死名字 = [...SENSITIVE_ACTIONS].filter(id => !declared.has(id));
    expect(死名字, "这些名字不对应任何端点，needsReason() 对它们永远返回 false").toEqual([]);
  });
});
