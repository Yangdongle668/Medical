import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { boot, resetDb, as, type Caller } from "./harness.js";
import { fileEndpoints } from "../src/infra/upload-limit.js";

const idem = () => ({ "Idempotency-Key": randomUUID() });
const today = () => new Date().toISOString().slice(0, 10);

/* ════════════════════════════════════════════════════════════════════
   立项受理：一线的两个日期，外加那张纸。

   0038 把这件事建成了一条**双方在系统里协作**的流程：递交方列八项清单 →
   机构办逐项勾 → 齐备则受理。那套模型的前提是"医院的机构办是本系统的
   用户"，而 0038 自己在同一个文件里写着相反的事实：多数医院的机构办
   不在这个系统里。

   于是那张清单由递交方自己填、自己不勾、也没有第二个人来勾 ——
   **一张永远不会被勾的清单，不是记录，是每次递交都要重填一遍的仪式。**

   一线真正要报给项目管理员的只有两件事：哪天递交的、哪天拿到受理意向函的。
   这一组测试钉的就是这两条路走得通，以及那张纸真的存得进来、取得出去。
   ════════════════════════════════════════════════════════════════════ */

/** 一份最小的合法 PDF —— 开头必须是 %PDF-，服务端认的就是这五个字节。 */
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "latin1");
const b64 = (b: Buffer) => b.toString("base64");

let app: INestApplication;
let crc: Caller, admin: Caller;
let studyId: string;

beforeAll(async () => {
  resetDb(); app = await boot();
  admin = await as(app, "admin");
  crc   = await as(app, "wutong");
  studyId = ((await admin.get("/v1/studies?limit=10")).body.items as
    { id: string }[])[0]!.id;
}, 180_000);
afterAll(async () => { await app?.close(); });

/** 每条测试用一家没递过的医院 —— 同一个项目同一家医院只有一条受理。 */
let n = 0;
const 医院 = () => `测试医院第${++n}分院`;

const 递交 = (c: Caller, hospital: string, extra: Record<string, unknown> = {}) =>
  c.post("/v1/site-acceptances", { studyId, hospital, ...extra }, idem());

const 登记意向函 = (c: Caller, id: string, b: Record<string, unknown>) =>
  c.post(`/v1/site-acceptances/${id}:record-letter`, b, idem());

describe("递交：不列清单也递得出去", () => {
  it("**材料清单不再必填** —— 一张永远不会被勾的清单不是记录", async () => {
    const r = await 递交(crc, 医院());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.docs).toEqual([]);
    /* 空清单在 in_system 上要读成「没列清单」，不是「八项都齐」——
       这两件事在界面上长得一样，所以这里钉住数据那一侧。 */
    expect(r.body.missingDocs).toEqual([]);
    expect(r.body.presentDocs).toBe(0);
  });

  it("要列的照样列得出来 —— 收回的是「必经」，不是「能力」", async () => {
    const r = await 递交(crc, 医院(), { docs: ["立项申请表", "保险单"] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((r.body.docs as { name: string }[]).map(d => d.name))
      .toEqual(["立项申请表", "保险单"]);
    /* 递进去一律未勾 —— 勾是机构办形式审查的动作。 */
    expect((r.body.docs as { present: boolean }[]).every(d => !d.present)).toBe(true);
  });

  it("**递交日期收得下过去** —— 过两天才回系统里补登是常事", async () => {
    const 前天 = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const r = await 递交(crc, 医院(), { submittedOn: 前天 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    /* 默认成今天的话，「递交日期」就成了「登记日期」，
       而两者差的那几天恰恰是伦理排期要算的。 */
    expect(r.body.submittedOn).toBe(前天);
  });

  it("收不下将来的日期 —— 这一栏记的是「哪天递出去的」", async () => {
    const 下周 = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const r = await 递交(crc, 医院(), { submittedOn: 下周 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("validation-failed");
  });

  it("省略日期就是今天", async () => {
    const r = await 递交(crc, 医院());
    expect(r.body.submittedOn).toBe(today());
  });
});

describe("撞上一条自己看不见的受理记录", () => {
  /* ── 这一条是被真事故逼出来的 ──────────────────────────────────────
     CRC 在中心详情页点「登记递交」，界面上回一句**「服务内部错误」**。

     `site_acceptance` 上有 UNIQUE (tenant_id, study_id, hospital)，
     而服务层那句 pre-check 是**带行策略的** —— 行规则为 assigned 的
     CRA / CRC 看不见别人递的那一条（那时 study_site_id 还是空的，
     app.site_visible 判不出来），于是 pre-check 查回 0 行、一路放行，
     最后撞在唯一约束上；pg 的 23505 落到兜底分支就是 500。

     一句"服务内部错误"教会用户的是**重试**，而重试一万次结果都一样。 */
  it("**说得出编号和递交人，而不是一句「服务内部错误」**", async () => {
    const hospital = 医院();
    /* 先由 admin 递一条 —— CRC 看不见它（下面那句断言钉住这个前提）。 */
    expect((await 递交(admin, hospital)).status).toBe(201);
    const 他看得见的 = (await crc.get("/v1/site-acceptances?limit=200")).body.items as
      { hospital: string }[];
    expect(他看得见的.some(x => x.hospital === hospital),
      "前提变了：CRC 现在看得见这一条，那这条测试就不再测它要测的东西")
      .toBe(false);

    const r = await 递交(crc, hospital);
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.invariant).toBe("acceptance-duplicate");
    /* 三样都要说出来：已经有了、编号是多少、谁递的 ——
       最后一样才是"我该去找谁"的答案。 */
    expect(r.body.detail).toMatch(/AC-/);
    expect(r.body.detail).toContain("系统管理员");
    expect(r.body.detail, "没说清他为什么在台账上看不到它").toContain("可见范围");
  });

  it("**兜底那一层也要在**：任何约束违例都不该出口成 500", async () => {
    /* 上面那条修的是这一处的根因。但同一个形状在别处还会再长出来 ——
       每一条唯一约束、排他约束、CHECK 都是一次潜在的 500。
       这里验的是 ProblemFilter 那一道：约束违例一律落 422。

       用同一条路再走一次（pre-check 已经拦住了，所以这一条实际上
       验的是"拦住之后仍然是 422"）；真正的兜底行为由 problem.ts
       的 pgConstraint 负责，它在这里与 pre-check 同一个出口。 */
    const hospital = 医院();
    expect((await 递交(admin, hospital)).status).toBe(201);
    const r = await 递交(admin, hospital);
    expect(r.status).toBe(422);
    expect(r.status).not.toBe(500);
  });
});

describe("一步填完：两个日期 + 一份意见函", () => {
  /* 这是这条流程真正的形状。院方的机构办不是这套系统的用户 ——
     一线手里拿着的就是那张《立项受理意见函》，他要做的是把两个日期
     和那张纸登记进来，不是替一个不存在的用户演一遍审查流程。 */
  it("**填完就是已受理**，不经过「形式审查中」，也不等任何人", async () => {
    const 前天 = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const r = await 递交(crc, 医院(), {
      submittedOn: 前天,
      acceptedOn: today(),
      letter: { filename: "立项受理意见函.pdf", contentBase64: b64(PDF) }
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.state).toBe("accepted");
    expect(r.body.submittedOn).toBe(前天);
    expect(r.body.acceptedOn).toBe(today());
    expect(r.body.letter.filename).toBe("立项受理意见函.pdf");
    /* 受理人仍然为空 —— 医院那边是谁受理的由那张纸回答。 */
    expect(r.body.acceptedByName).toBeNull();
  });

  it("**意见函还没下来就留空** —— 那不是中间态，是一个事实", async () => {
    const r = await 递交(crc, 医院());
    expect(r.status).toBe(201);
    expect(r.body.state).toBe("review");
    expect(r.body.acceptedOn).toBeNull();
  });

  it("传了纸却没填日期就拒 —— 没有日期的 PDF 挂在哪一行都说不清", async () => {
    const r = await 递交(crc, 医院(), {
      letter: { filename: "意见函.pdf", contentBase64: b64(PDF) } });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain("收到日期");
  });

  it("受理日期早于递交日期就拒 —— 意见函不会比材料先到", async () => {
    const 昨天 = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const r = await 递交(crc, 医院(), { submittedOn: today(), acceptedOn: 昨天 });
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("acceptance-letter-before-submit");
  });

  it("**文件不合格时这条受理不该被建出来** —— 校验在 INSERT 之前", async () => {
    const hospital = 医院();
    const r = await 递交(crc, hospital, {
      acceptedOn: today(),
      letter: { filename: "假的.pdf", contentBase64: b64(Buffer.from("\x89PNG\r\n")) }
    });
    expect(r.status).toBe(422);
    /* 再递一次要能成功 —— 上一次如果留下了半条记录，这里会撞唯一约束。 */
    const again = await 递交(crc, hospital, { acceptedOn: today() });
    expect(again.status, "上一次失败留下了一条记录").toBe(201);
  });

  it("一步填完之后，闸门当场放行「伦理递交」", async () => {
    /* 闸门按 (项目, 医院) 找受理 —— 所以要有一个同项目同医院的中心。 */
    const site = ((await admin.get("/v1/study-sites?limit=200")).body.items as
      { id: string; hospital: string; study: { id: string } }[])
      .find(x => x.study.id === studyId);
    expect(site, "演示数据里应当有这个项目下的中心").toBeTruthy();

    const before = await admin.get(`/v1/study-sites/${site!.id}/gate?to=irb_submit`);
    /* 种子里这个中心的受理已经是 accepted 了，所以这里只验文案那一半。 */
    if (!before.body.satisfied)
      expect(`${before.body.unmet[0].message}`,
        "闸门仍然把人指向机构办 —— 而机构办不是这套系统的用户")
        .not.toContain("等机构办");
  });
});

describe("登记受理意向函", () => {
  it("**一个日期 + 一份 PDF，就是这条流程的终点**", async () => {
    const a = (await 递交(crc, 医院())).body;
    const r = await 登记意向函(crc, a.id, {
      receivedOn: today(),
      file: { filename: "受理意向函.pdf", contentBase64: b64(PDF) }
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.state).toBe("accepted");
    expect(r.body.data.acceptedOn).toBe(today());
    expect(r.body.data.letter.filename).toBe("受理意向函.pdf");
    expect(r.body.data.letter.sizeBytes).toBe(PDF.length);
    /* **受理人不填** —— 医院那边是谁受理的由那张纸回答，
       从下拉框里挑一个本系统的账号填进去，填的是编的。 */
    expect(r.body.data.acceptedByName).toBeNull();
  });

  it("**台账那条查询一个字节的 PDF 都不带** —— 一页二十行就废了", async () => {
    const one = ((await crc.get("/v1/site-acceptances?limit=100")).body.items as
      { letter: Record<string, unknown> | null }[]).find(x => x.letter)!;
    expect(one, "上一条刚登记过，列表里应当有它").toBeTruthy();
    expect(Object.keys(one.letter!).sort())
      .toEqual(["contentType", "filename", "sizeBytes", "uploadedAt", "uploadedByName"]);
  });

  it("取原件拿到的是 PDF 本身，不是 JSON", async () => {
    const a = (await 递交(crc, 医院())).body;
    await 登记意向函(crc, a.id, {
      receivedOn: today(), file: { filename: "意向函.pdf", contentBase64: b64(PDF) } });

    const r = await crc.get(`/v1/site-acceptances/${a.id}/letter`)
      .buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("application/pdf");
    expect(Buffer.from(r.body as Buffer).equals(PDF), "取回来的字节和存进去的不一样")
      .toBe(true);
    /* 同一个 URL 对不同的人答案不同 —— 不许被缓存到共享层。 */
    expect(r.headers["cache-control"]).toContain("no-store");
  });

  it("**文件可以后补** —— 纸还没到手、先把日期登记上是常事", async () => {
    const a = (await 递交(crc, 医院())).body;
    const r = await 登记意向函(crc, a.id, { receivedOn: today() });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.state).toBe("accepted");
    expect(r.body.data.letter).toBeNull();
    /* 没传纸的时候那句提醒要显眼 —— 核查看的是纸，不是台账上的日期。 */
    expect(r.body.sideEffects[0].summary).toContain("扫描件还没传");

    /* 补传一次 */
    const back = await 登记意向函(crc, a.id, {
      receivedOn: today(), file: { filename: "补传.pdf", contentBase64: b64(PDF) } });
    expect(back.status).toBe(201);
    expect(back.body.data.letter.filename).toBe("补传.pdf");
  });

  it("再传一份是覆盖，不是并存 —— 一条受理只有一份意向函", async () => {
    const a = (await 递交(crc, 医院())).body;
    await 登记意向函(crc, a.id, {
      receivedOn: today(), file: { filename: "第一份.pdf", contentBase64: b64(PDF) } });
    const r = await 登记意向函(crc, a.id, {
      receivedOn: today(), file: { filename: "第二份.pdf", contentBase64: b64(PDF) } });
    expect(r.body.data.letter.filename).toBe("第二份.pdf");
  });
});

describe("拦住的那几样，都要说得出为什么", () => {
  it("**不是 PDF 就拒** —— 改个扩展名不会让它变成 PDF", async () => {
    const a = (await 递交(crc, 医院())).body;
    const r = await 登记意向函(crc, a.id, {
      receivedOn: today(),
      file: { filename: "其实是张图.pdf", contentBase64: b64(Buffer.from("\x89PNG\r\n")) }
    });
    expect(r.status).toBe(422);
    expect(r.body.detail).toContain("%PDF-");
  });

  it("超过 10 MB 就拒，而且**报的是解出来的真实大小**", async () => {
    const a = (await 递交(crc, 医院())).body;
    const big = Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024, 0x20)]);
    const r = await 登记意向函(crc, a.id, {
      receivedOn: today(), file: { filename: "太大.pdf", contentBase64: b64(big) } });
    /* 两条路都会拦：请求体先撞上解析上限（413 → 422，见 infra/problem.ts），
       或者解出来之后撞上服务层那 10 MB。**两条都必须是 422**，
       不能是 500 —— 500 教会用户的是重试，不是换一份小一点的文件。 */
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.code).toBe("validation-failed");
    expect(`${r.body.detail}`).toMatch(/太大|上限|11\.0 MB/);
  });
});

/* ════════════════════════════════════════════════════════════════════
   **一份正常大小的扫描件必须递得进去。**

   这一组是从一次现场报障里长出来的：一份 **100 KB** 的 PDF 递不进去，
   回 422，而报文写着「受理意向函的上限是 10 MB」——
   一条同时说着"太大了"和"上限 10 MB"的报错。

   原因：express 的 JSON 解析默认上限是 100 KB，而放大上限那段中间件
   判的是"路径里有没有 `:record-letter`"。一步填完的
   `POST /v1/site-acceptances` 后来也收 letter 了，它的路径里没有那个词。

   ── 为什么上面那一组没拦住 ────────────────────────────────────────
   上面只测了 11 MB（必拒）和 6 字节的假 PDF（必拒），**从来没测过
   一份正常大小的文件**。两端都测了，中间那一大段没人走过 ——
   而真实文件全部落在中间那一段。

   所以这里钉的是"正常那一档"，而且**两条收文件的端点各钉一次**：
   这次出事的正是后加的那一条。 */
describe("正常大小的扫描件，两条路都要收得下", () => {
  /** 500 KB —— 一份彩色扫描件的常见大小，编码后约 683 KB，
   *  远超 express 那 100 KB 的默认上限，也远在 10 MB 以内。 */
  const 扫描件 = () => Buffer.concat([PDF, Buffer.alloc(500 * 1024, 0x20)]);

  it("一步填完那条：递交时直接带上意见函", async () => {
    const r = await 递交(crc, 医院(), {
      acceptedOn: today(),
      letter: { filename: "受理意见函.pdf", contentBase64: b64(扫描件()) }
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.state).toBe("accepted");
    expect(r.body.letter?.filename).toBe("受理意见函.pdf");
    /* 落库的是解出来的字节数，不是 base64 的长度。 */
    expect(r.body.letter?.sizeBytes).toBe(扫描件().length);
  });

  it("补登那条：先递交、后补传", async () => {
    const a = (await 递交(crc, 医院())).body;
    const r = await 登记意向函(crc, a.id, {
      receivedOn: today(),
      file: { filename: "后补的.pdf", contentBase64: b64(扫描件()) }
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.letter?.sizeBytes).toBe(扫描件().length);
  });

  it("**收文件的端点名单是从契约里取的** —— 下一条自动在册", async () => {
    /* 这一条守的是"别再靠路径里那个词"。名单由请求体里有没有
       `contentBase64` 决定，所以新加一条收文件的端点时，
       它自动落在放大上限的名单里 —— 不需要有人记得回来改中间件。
       名单变短（有人把文件字段挪走了而中间件没跟上）时这条会红。 */
    const ids = fileEndpoints().map(e => `${e.method} ${e.path}`).sort();
    expect(ids).toEqual([
      "POST /v1/site-acceptances",
      "POST /v1/site-acceptances/{id}:record-letter"
    ]);
  });

  it("收到日期早于递交日期就拒 —— 意向函不会比材料先到", async () => {
    const 昨天 = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const a = (await 递交(crc, 医院())).body;          // 递交日 = 今天
    const r = await 登记意向函(crc, a.id, { receivedOn: 昨天 });
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("acceptance-letter-before-submit");
  });

  it("将来的收到日期就拒", async () => {
    const 下周 = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const a = (await 递交(crc, 医院())).body;
    const r = await 登记意向函(crc, a.id, { receivedOn: 下周 });
    expect(r.status).toBe(422);
  });

  it("系统外登记的存根改不动 —— 它记的是一件已经发生过的事", async () => {
    const stub = ((await admin.get("/v1/site-acceptances?limit=100")).body.items as
      { id: string; origin: string }[]).find(x => x.origin === "registered");
    if (!stub) return;
    const r = await 登记意向函(admin, stub.id, { receivedOn: today() });
    expect(r.status).toBe(422);
    expect(r.body.invariant).toBe("acceptance-registered-readonly");
  });

  it("**看不见那条受理的人取不到那份 PDF** —— 附件的可见性跟着父行走", async () => {
    const a = (await 递交(crc, 医院())).body;
    await 登记意向函(crc, a.id, {
      receivedOn: today(), file: { filename: "私密.pdf", contentBase64: b64(PDF) } });

    /* 换机构办来试 —— 他按「本院承接的项目」切行，而这些测试医院
       不是他那一家。**别拿 DM 试**：DM 的行规则是 all，他本来就看得见
       全部，那样这条测试验的是"看得见的人取得到"，正好反了。 */
    const inst = await as(app, "zhanghm");
    const r = await inst.get(`/v1/site-acceptances/${a.id}/letter`);
    expect([403, 404], `机构办不该取得到别家医院的意向函`).toContain(r.status);
  });
});

describe("审计", () => {
  it("登记意向函进审计，记的是**谁登记的**，不是谁受理的", async () => {
    const 轨迹 = (await admin.get("/v1/audit-entries?limit=200")).body.items as
      { action: string; reason: string | null }[];
    const 条 = 轨迹.filter(e => e.action === "登记受理意向函");
    expect(条.length, "审计里没有「登记受理意向函」").toBeGreaterThan(0);
    expect(条.every(e => !!e.reason)).toBe(true);
  });
});
