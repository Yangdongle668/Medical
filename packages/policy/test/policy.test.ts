import { describe, it, expect } from "vitest";
import { canField, maskFields, canAct, canModule, needsReason, SENSITIVE_ACTIONS,
         type Principal, type FieldGates } from "../src/index.js";

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

describe("敏感动作必须留原因", () => {
  it("权限与账号变更、阶段推进、关键日期修改都在清单里", () => {
    for (const id of ["disableAccount", "updateRolePermissions", "advanceStudySite",
                      "updateVisitTargetDate"])
      expect(needsReason(id), id).toBe(true);
  });
  it("普通读写不在清单里", () => {
    for (const id of ["listAccounts", "getMe", "listStudySites"])
      expect(needsReason(id), id).toBe(false);
  });
  it("清单不为空 —— 空清单等于这条约束没生效", () => {
    expect(SENSITIVE_ACTIONS.size).toBeGreaterThan(4);
  });
});
