import { useState } from 'react';
import { api, qs } from '../api';
import { useLoader } from '../hooks';
import { WorkspaceShell } from '../App';
import { accountLabel } from '../components';
import { dt, money, Tag } from '../ui';
import { OrderTable } from './owner';
import { RefundsReviewTab } from './property';
import { ReservationDetailModal } from './shared';

type Session = any;
const NAV = [
  { key: 'overview', label: '平台总览', icon: '📊' },
  { key: 'ledger', label: '分账监管', icon: '💰' },
  { key: 'refunds', label: '退款与冲正', icon: '💸' },
  { key: 'orders', label: '订单追溯', icon: '🧾' },
  { key: 'dispatch', label: '调度总览', icon: '🌙' },
  { key: 'coupons', label: '补偿券发放', icon: '🎫' },
];

export function AdminWorkspace({ session }: { session: Session }) {
  const [tab, setTab] = useState('overview');
  return (
    <WorkspaceShell session={session} nav={NAV} active={tab} onNav={setTab}>
      {tab === 'overview' && <OverviewTab go={setTab} />}
      {tab === 'ledger' && <LedgerTab />}
      {tab === 'refunds' && <RefundsReviewTab />}
      {tab === 'orders' && <OrdersTab />}
      {tab === 'dispatch' && <DispatchTab />}
      {tab === 'coupons' && <CouponTab />}
    </WorkspaceShell>
  );
}

function PageHead({ title, desc, right }: any) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1><div className="desc">{desc}</div></div>
      {right}
    </div>
  );
}

function OverviewTab({ go }: { go: (k: string) => void }) {
  const { data: ledger } = useLoader<any[]>('/ledger');
  const { data: orders } = useLoader<any[]>('/reservations');
  const { data: overview } = useLoader<any>('/dispatch/overview');
  const { data: incidents } = useLoader<any[]>('/dispatch/incidents');

  const sum = (pred: (l: any) => boolean) =>
    (ledger ?? []).filter(pred).reduce((a, b) => a + Number(b.amount), 0);
  const ownerIn = sum((l) => l.account.startsWith('owner:') && l.direction === 'credit');
  const propertyIn = sum((l) => l.account === 'property' && l.direction === 'credit');
  const platformIn = sum((l) => l.account === 'platform' && l.direction === 'credit');
  const platformOut = sum((l) => l.account === 'platform' && l.direction === 'debit');
  const couponIn = sum((l) => l.account === 'coupon_pool' && l.direction === 'debit');
  const escrowIn = sum((l) => l.account === 'escrow' && l.direction === 'credit');
  const escrowOut = sum((l) => l.account === 'escrow' && l.direction === 'debit');
  const balanced = Math.abs(escrowIn - escrowOut) < 0.05;

  const openTickets = (incidents ?? []).filter((t) => ['open', 'notified'].includes(t.status)).length;

  return (
    <div>
      <PageHead title="平台运营总览" desc="分账资金守恒、异常处置与订单全链路的一屏监管" />
      <div className="grid grid-4">
        <div className="stat"><div className="label">累计停车服务单</div><div className="value">{orders?.length ?? 0}</div>
          <div className="sub">进行中 {overview?.active_reservations ?? 0}</div></div>
        <div className="stat"><div className="label">待处理异常工单</div><div className="value" style={{ color: openTickets ? 'var(--red)' : undefined }}>{openTickets}</div>
          <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => go('dispatch')}>去调度</button></div>
        <div className="stat"><div className="label">托管账户入/出</div><div className="value" style={{ fontSize: 18 }}>{money(escrowIn)}</div>
          <div className="sub">出金 {money(escrowOut)} {balanced ? '✓ 平衡' : '✗ 不平'}</div></div>
        <div className="stat"><div className="label">平台净留存</div><div className="value" style={{ fontSize: 18 }}>{money(platformIn - platformOut)}</div>
          <div className="sub">抽成 {money(platformIn)} · 兜底垫付 {money(platformOut)}</div></div>
      </div>
      <div className="grid grid-3" style={{ marginTop: 16 }}>
        <div className="stat"><div className="label">业主累计入账</div><div className="value text-green" style={{ color: 'var(--green)' }}>{money(ownerIn)}</div><div className="sub">服务分成 70% + 补偿</div></div>
        <div className="stat"><div className="label">物业服务费</div><div className="value">{money(propertyIn)}</div><div className="sub">10%</div></div>
        <div className="stat"><div className="label">优惠券池出资</div><div className="value">{money(couponIn)}</div><div className="sub">营销券 + 异常赔付券</div></div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <h3>近 24 小时异常分布</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>异常类型</th><th>状态</th><th>数量</th></tr></thead>
            <tbody>
              {(overview?.incidents_24h ?? []).map((x: any, i: number) => (
                <tr key={i}><td>{x.type}</td><td><Tag status={x.status} /></td><td>{x.n}</td></tr>
              ))}
              {(overview?.incidents_24h ?? []).length === 0 && <tr><td colSpan={3} className="empty">暂无</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function LedgerTab() {
  const [account, setAccount] = useState('');
  const query = qs({ account: account || undefined });
  const { data: ledger } = useLoader<any[]>(`/ledger${query}`);
  const debit = (ledger ?? []).filter((l) => l.direction === 'debit').reduce((a, b) => a + Number(b.amount), 0);
  const credit = (ledger ?? []).filter((l) => l.direction === 'credit').reduce((a, b) => a + Number(b.amount), 0);

  return (
    <div>
      <PageHead title="收益分账监管" desc="业主收益、物业服务费、平台抽成、优惠券抵扣、退款与异常补偿合并清算后的资金流水（以平台托管账户为枢纽）" />
      <div className="filter-bar card">
        <label className="small muted">账户</label>
        <select value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">全部账户</option>
          <option value="escrow">平台托管账户</option>
          <option value="driver">车主</option>
          <option value="property">物业</option>
          <option value="platform">平台</option>
          <option value="coupon_pool">优惠券池</option>
        </select>
        <span style={{ flex: 1 }} />
        <Tag cls="amber" label={`借方 ${money(debit)}`} />
        <Tag cls="green" label={`贷方 ${money(credit)}`} />
        <Tag cls={Math.abs(debit - credit) <= 0.05 ? 'green' : 'red'} label={Math.abs(debit - credit) <= 0.05 ? '借贷平衡 ✓' : '借贷不平 ✗'} />
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>时间</th><th>结算单</th><th>车位</th><th>账户</th><th>借/贷</th><th>金额</th><th>冲正单</th><th>摘要</th></tr></thead>
            <tbody>
              {(ledger ?? []).map((l) => (
                <tr key={l.id} style={l.reversal_code ? { background: 'rgba(207,51,51,0.06)' } : undefined}>
                  <td className="small">{dt(l.created_at)}</td>
                  <td className="small mono">{l.settlement_code}{l.settlement_kind === 'recomputed' && <Tag cls="purple" label="重做" />}<div className="small muted">{l.reservation_code}</div></td>
                  <td className="mono">{l.spot_code}</td>
                  <td>{accountLabel(l.account)}</td>
                  <td><Tag cls={l.direction === 'debit' ? 'amber' : 'green'} label={l.direction === 'debit' ? '借' : '贷'} /></td>
                  <td className="money">{money(l.amount)}</td>
                  <td className="mono small" style={{ color: l.reversal_code ? 'var(--red)' : undefined }}>{l.reversal_code ?? '—'}</td>
                  <td className="small">{l.memo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function OrdersTab() {
  const { data: orders } = useLoader<any[]>('/reservations');
  const [detail, setDetail] = useState<number | null>(null);
  return (
    <div>
      <PageHead title="全量停车服务单" desc="任意角色的订单追溯入口：发布 → 预约 → 入场 → 异常 → 离场 → 分账" />
      <div className="card"><OrderTable orders={orders ?? []} onOpen={setDetail} /></div>
      {detail && <ReservationDetailModal id={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function DispatchTab() {
  const { data: tickets } = useLoader<any[]>('/dispatch/incidents');
  return (
    <div>
      <PageHead title="调度事件总览（只读）" desc="全社区夜间异常工单及处置留痕" />
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr><th>工单</th><th>类型</th><th>车位</th><th>车牌</th><th>描述</th><th>状态</th><th>处置</th><th>时间</th></tr></thead>
            <tbody>
              {(tickets ?? []).map((t) => (
                <tr key={t.id}>
                  <td className="mono small">{t.code}</td>
                  <td>{t.label}</td>
                  <td className="mono">{t.spot_code}</td>
                  <td className="mono">{t.plate ?? '—'}</td>
                  <td className="small" style={{ maxWidth: 260 }}>{t.description}</td>
                  <td><Tag status={t.status} /></td>
                  <td className="small" style={{ maxWidth: 200 }}>{t.resolution ?? '—'}</td>
                  <td className="small muted">{dt(t.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function CouponTab() {
  const [users, setUsers] = useState('');
  const [amount, setAmount] = useState(15);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const issue = async () => {
    setErr(''); setMsg('');
    try {
      const r = await api('POST', '/coupons/issue', { user_id: Number(users), amount });
      setMsg(`已向用户 #${users} 发放 ${money(amount)} 赔付券（${r.code}）`);
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <div>
      <PageHead title="异常补偿券发放" desc="平台/物业责任结案后向车主发放赔付券（非现金，下次预约抵扣），流水计入优惠券资金池" />
      <div className="card" style={{ maxWidth: 520 }}>
        {msg && <div className="alert ok">{msg}</div>}
        {err && <div className="alert error">{err}</div>}
        <div className="field"><label>用户 ID</label><input type="number" value={users} onChange={(e) => setUsers(e.target.value)} placeholder="如 3（车主陈车主）" /></div>
        <div className="field"><label>券面额（元）</label><input type="number" value={amount} onChange={(e) => setAmount(Number(e.target.value))} /></div>
        <button className="btn" disabled={!users} onClick={issue}>发放补偿券</button>
        <div className="small muted" style={{ marginTop: 10 }}>
          常用账号 ID：3=陈车主（driver1），4=赵访客（driver2）。发放后车主可在"车辆与优惠券"中查看并于下次预约使用。
        </div>
      </div>
    </div>
  );
}
