import { describe, it, expect } from "vitest";
import { pickSite } from "../src/shell/currentSite.js";

/* 当前中心按 地址栏 → 上次选的 → 第一个 的顺序取；
   前两者都必须在这个人的中心列表里 —— 换了派工，上次选的可能已经不归他了。 */
describe("pickSite", () => {
  const ids = ["s1", "s2", "s3"];

  it("地址栏优先 —— 链接带过来的最具体", () => {
    expect(pickSite(ids, "s3", "s2")).toBe("s3");
  });
  it("没有地址栏就用上次选的", () => {
    expect(pickSite(ids, null, "s2")).toBe("s2");
  });
  it("不在列表里的一律不认，回退到第一个", () => {
    expect(pickSite(ids, "gone", "also-gone")).toBe("s1");
    expect(pickSite(ids, "gone", "s2")).toBe("s2");
  });
  it("没有中心就是空串，不是 undefined", () => {
    expect(pickSite([], "s1", "s1")).toBe("");
  });

  it("选错代价大的地方（预筛登记、填工时）不认得就留空；只有一个中心时照样选上", () => {
    expect(pickSite(ids, null, null, false)).toBe("");
    expect(pickSite(ids, null, "s2", false)).toBe("s2");
    expect(pickSite(["only"], null, null, false)).toBe("only");
  });
});
