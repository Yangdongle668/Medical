import { useEffect, useState } from "react";
import { call } from "../../api/client.js";

interface Site {
  id: string; code: string; hospital: string; dept: string; city: string;
  state: string; contracted: number; piName: string;
  /* 受列权限管辖：无权限时**字段不在**，不是 null。所以类型是 optional。 */
  unitPriceCents?: number; startupFeeCents?: number;
}

const yuan = (cents: number) => (cents / 100).toLocaleString("zh-CN",
  { style: "currency", currency: "CNY", maximumFractionDigits: 0 });

export function SitesPage() {
  const [sites, setSites] = useState<Site[] | null>(null);
  useEffect(() => {
    call<{ items: Site[] }>("listStudySites", { query: { limit: 50 } })
      .then(r => setSites(r.items));
  }, []);

  /* 「有没有这一列」由数据决定，不由角色判断 —— 前端不重算权限。
     后端把无权限的字段删掉了，这里就少一列，仅此而已。 */
  const showPrice = sites?.some(s => s.unitPriceCents !== undefined) ?? false;

  return (
    <>
      <div className="page-head">
        <h2>我的中心</h2>
        <p>行范围由登录身份推导；**列**同理 —— 看得到中心，不等于看得到它的价钱。</p>
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
              <tr key={s.id}>
                <td className="mono">{s.code}</td>
                <td>{s.hospital}<div className="muted">{s.dept} · {s.city}</div></td>
                <td>{s.piName}</td>
                <td><span className="chip flat">{s.state}</span></td>
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
    </>
  );
}
