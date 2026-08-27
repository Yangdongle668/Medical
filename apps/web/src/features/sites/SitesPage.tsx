import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { call } from "../../api/client.js";
import { SITE_STATE_LABEL } from "../site/states.js";

interface Site {
  id: string; code: string; hospital: string; dept: string; city: string;
  state: string; contracted: number; piName: string;
  /** 已过 SIV，但启动清单仍有未完成的阻塞项 —— 见后端 INVALIDATED。 */
  startupInvalidated?: boolean;
  /* 受列权限管辖：无权限时**字段不在**，不是 null。所以类型是 optional。 */
  unitPriceCents?: number; startupFeeCents?: number;
}

const yuan = (cents: number) => (cents / 100).toLocaleString("zh-CN",
  { style: "currency", currency: "CNY", maximumFractionDigits: 0 });

export function SitesPage() {
  const [sites, setSites] = useState<Site[] | null>(null);
  /* 三态：不传 = 两种都要；true = 只看事后失效的。
     没有"只看正常的"那一档 —— 界面上没人会想要它。 */
  const [onlyBad, setOnlyBad] = useState(false);

  useEffect(() => {
    call<{ items: Site[] }>("listStudySites",
      { query: { limit: 50, ...(onlyBad ? { startupInvalidated: true } : {}) } })
      .then(r => setSites(r.items));
  }, [onlyBad]);

  /* 「有没有这一列」由数据决定，不由角色判断 —— 前端不重算权限。
     后端把无权限的字段删掉了，这里就少一列，仅此而已。 */
  const showPrice = sites?.some(s => s.unitPriceCents !== undefined) ?? false;
  const bad = sites?.filter(s => s.startupInvalidated).length ?? 0;

  return (
    <>
      <div className="page-head">
        <h2>我的中心</h2>
        <p>行范围由登录身份推导；**列**同理 —— 看得到中心，不等于看得到它的价钱。</p>
      </div>

      {/* 「事后失效」在台账上的落点。
          撤销一个已完成的启动阻塞项之后，系统**刻意不回退状态机**
          （一个已入组 12 例的中心被推回「合同签署」，那 12 例的访视
          就挂在了一个不存在的状态上）。但不回退不等于不记账 ——
          在此之前，撤销留下的唯一痕迹是一句转瞬即逝的 sideEffect 文案。 */}
      <div className="row spread" style={{ marginBottom: 12 }}>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={onlyBad} style={{ width: "auto" }}
            data-testid="only-invalidated"
            onChange={e => setOnlyBad(e.target.checked)} />
          <span className="muted">只看启动条件已失效的</span>
        </label>
        {!onlyBad && bad > 0 && (
          <span className="chip warn" data-testid="invalidated-count">
            {bad} 个中心的启动条件事后失效
          </span>
        )}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>编号</th><th>医院</th><th>研究者</th><th>阶段</th><th>合同例数</th>
              {showPrice && <th>单例单价</th>}
            </tr>
          </thead>
          <tbody>
            {sites?.map(s => (
              <tr key={s.id} data-testid="site-row">
                <td className="mono">
                  <Link to={`/sites/${s.id}`} data-testid="open-site">{s.code}</Link>
                </td>
                <td>{s.hospital}<div className="muted">{s.dept} · {s.city}</div></td>
                <td>{s.piName}</td>
                <td>
                  <span className="chip flat">{SITE_STATE_LABEL[s.state] ?? s.state}</span>
                  {s.startupInvalidated && (
                    <span className="chip warn" data-testid="invalidated-chip"
                      style={{ marginLeft: 6 }}
                      title="有人撤销了一个已完成的启动阻塞项 —— 当初推进到 SIV 的条件现在不成立">
                      启动条件已失效
                    </span>
                  )}
                </td>
                <td className="num">{s.contracted}</td>
                {showPrice && (
                  <td className="num">
                    {s.unitPriceCents !== undefined ? yuan(s.unitPriceCents) : "—"}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sites?.length === 0 && onlyBad && (
        <p className="muted" data-testid="no-invalidated">
          没有启动条件事后失效的中心 —— 这是应该的常态。
        </p>
      )}
    </>
  );
}
