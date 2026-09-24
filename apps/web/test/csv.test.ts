import { describe, it, expect } from "vitest";
import { toCsv } from "../src/shell/csv.js";

/* 导出的 CSV：Excel 直接打开不乱码（BOM）、不被当公式算、逗号换行不串列。 */
describe("toCsv", () => {
  const cols = [
    { label: "名称", value: (r: { a: unknown }) => r.a as string },
  ];
  const one = (v: unknown) => toCsv(cols, [{ a: v }]).split("\r\n")[1];

  it("带 BOM，CRLF 换行", () => {
    expect(toCsv(cols, [])).toBe("﻿名称\r\n");
  });

  it("逗号、引号、换行要包起来", () => {
    expect(one('a,"b"\nc')).toBe('"a,""b""\nc"');
  });

  it("以 = + - @ 开头的文字垫一个 '，数字不垫", () => {
    expect(one("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(one("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(one(-3)).toBe("-3");
    expect(one(true)).toBe("是");
    expect(one(null)).toBe("");
  });
});
