import { useState } from "react";
import { ChangePassword } from "../features/login/ChangePassword.js";

/* ════════════════════════════════════════════════════════════════════
   「这台系统的管理员口令还是 admin」。

   ── 为什么是一条挡在内容上面的红条，而不是一个角标 ────────────────
   出厂口令是**公开的**。这台机器只要从外面打得到，任何人都能以
   系统管理员身份登进来 —— 不是"权限配置不当"那种慢性问题，
   是门开着。角标的意思是"有空看一下"，而这件事没有"有空"。

   ── 为什么它关不掉 ────────────────────────────────────────────────
   能关掉的警报等于没有警报：第一天关掉，第二天就没人记得。
   它唯一的消失方式是**口令真的改了** —— 那时 /v1/me 里的
   passwordIsInitial 变成 false，这条自己就不见了。
   而 is_initial 在库里只能从 true 变 false（迁移 0025 的触发器），
   所以它也不会被谁重新点亮又熄掉。

   展开/收起的是**表单**，不是警报本身。
   ════════════════════════════════════════════════════════════════════ */

export function FactoryPasswordBanner(
  { login, onDone }: { login: string; onDone: () => void }
) {
  const [open, setOpen] = useState(false);

  return (
    <div className="problem stack" data-testid="factory-password"
         role="alert" style={{ marginBottom: 14 }}>
      <strong>账号 <span className="mono">{login}</span> 还在用出厂口令</strong>
      <p className="muted" style={{ margin: 0 }}>
        出厂口令是公开的（<span className="mono">admin</span>）。
        这台系统只要从外面连得上，任何人都能以系统管理员的身份登进来 ——
        看得到全部中心、改得动所有人的权限。<b>现在就改掉它。</b>
      </p>
      {open
        ? <ChangePassword hasPassword onDone={onDone} />
        : <button className="btn primary" data-testid="open-change-password"
            style={{ alignSelf: "flex-start" }} onClick={() => setOpen(true)}>
            改口令
          </button>}
    </div>
  );
}
