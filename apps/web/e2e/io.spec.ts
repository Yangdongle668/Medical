import { test, expect } from "@playwright/test";
import fs from "node:fs";

/* ════════════════════════════════════════════════════════════════════
   导出与批量导入（W16 / W17）。

   导出：按钮点下去真的下载一个 CSV，Excel 打开不乱码（BOM），行数对得上。
   导入：选文件 → 逐行试运行 → 确认 → 逐行结果 → 关掉后列表里有新的那几行。
   ════════════════════════════════════════════════════════════════════ */

test("受试者列表导出成 CSV：带 BOM，一行一人", async ({ page }) => {
  await page.goto("/subjects");
  const rows = page.getByTestId("subject-row");
  await expect(rows.first()).toBeVisible();
  const n = await rows.count();

  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export").click()]);
  expect(dl.suggestedFilename()).toMatch(/^subjects-\d{8}\.csv$/);
  const text = fs.readFileSync((await dl.path())!, "utf8");
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const lines = text.slice(1).trim().split("\r\n");
  expect(lines[0]).toMatch(/^筛选号,中心,状态/);
  expect(lines.length - 1).toBe(n);
});

test("预筛批量导入：试运行逐行说明，确认后导入", async ({ page }) => {
  await page.goto("/prescreen");
  await expect(page.getByTestId("pre-row").first()).toBeVisible();
  await page.getByTestId("pre-site").selectOption({ index: 1 });
  await page.getByTestId("pre-import").click();

  await page.getByTestId("pre-imp-file").setInputFiles({
    name: "预筛.csv", mimeType: "text/csv",
    buffer: Buffer.from("﻿序号,筛选号,知情签署日\r\n1,SS-01-P0700,\r\n2,SS-01-P0700,\r\n3,,2999-01-01\r\n4,,\r\n")
  });
  const rows = page.getByTestId("pre-imp-row");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText("重复");
  await expect(rows.nth(2)).toContainText("不能晚于今天");
  await expect(page.getByTestId("pre-imp-summary")).toContainText("2 行可以导入");

  await page.getByTestId("pre-imp-commit").click();
  await expect(page.getByTestId("pre-imp-summary")).toContainText("导入了 2 行");
  await page.getByTestId("pre-imp-finish").click();
  await expect(page.getByTestId("pre-row").filter({ hasText: "SS-01-P0700" })).toBeVisible();
});

test("批量建号：外部方角色、错级别逐行拦下，其余建出来", async ({ page }) => {
  await page.goto("/org?as=boss");
  await expect(page.getByTestId("account-row").first()).toBeVisible();
  await page.getByTestId("acc-import").click();
  await page.getByTestId("acc-imp-file").setInputFiles({
    name: "人员.csv", mimeType: "text/csv",
    buffer: Buffer.from("登录名,姓名,角色,级别,城市,GCP证书到期日,分组\n" +
      "impone,导入一,crc,中级,北京,,\nimptwo,导入二,inst,中级,北京,,\nimpthree,导入三,crc,特级,北京,,\n")
  });
  const rows = page.getByTestId("acc-imp-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(1)).toContainText("外部方");
  await expect(rows.nth(2)).toContainText("级别");

  await page.getByTestId("acc-imp-commit").click();
  await expect(page.getByTestId("acc-imp-summary")).toContainText("导入了 1 行");
  await page.getByTestId("acc-imp-finish").click();
  await expect(page.getByTestId("account-row").filter({ hasText: "impone" })).toBeVisible();
});

test("选了 xlsx：说清楚怎么另存为 CSV，而不是报一句解析失败", async ({ page }) => {
  await page.goto("/org?as=boss");
  await expect(page.getByTestId("account-row").first()).toBeVisible();
  await page.getByTestId("acc-import").click();
  await page.getByTestId("acc-imp-file").setInputFiles({
    name: "人员.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("PK")
  });
  await expect(page.getByTestId("acc-imp-problem")).toContainText("另存为");
});
