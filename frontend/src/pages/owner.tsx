import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLoader } from '../hooks';
import { WorkspaceShell } from '../App';
import { dt, money, Tag } from '../ui';
import { AppealDetailModal, ReservationDetailModal } from './shared';
import { TimelineView } from '../components';

type Session = any;
const NAV = [
  { key: 'spots', label: '我的车位', icon: '🅿️' },
  { key: 'orders', label: '预约与收益', icon: '🧾' },
  { key: 'dispatch', label: '夜间调度', icon: '🌙' },
  { key: 'appeals', label: '车位申诉', icon: '⚖️' },
];

export function OwnerWorkspace({ session }: { session: Session }) {
  const [tab, setTab] = useState('spots');
  return (
    <WorkspaceShell session={session} nav={NAV} active={tab} onNav={setTab}>
      {tab === 'spots' && <SpotsTab session={session} />}
      {tab === 'orders' && <OrdersTab />}
      {tab === 'dispatch' && <DispatchTab session={session} />}
      {tab === 'appeals' && <AppealsTab />}
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

// ---------- 车位发布与管理 ----------
function SpotsTab({ session }: { session: Session }) {
  const { data: spots, reload } = useLoader<any[]>('/spots/mine');
  const { data: communities } = useLoader<any[]>('/spots/communities');
  const [publishing, setPublishing] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [timelineSpot, setTimelineSpot] = useState<any>(null);

  const [form, setForm] = useState<any>({
    community_id: 1,
    code: '',
    location_desc: '',
    near_charger: true,
    charger_power_kw: 7,
    allow_visitor: true,
    monthly_priority: false,
    hourly_rate: 5,
    overnight_cap: 45,
    windows: [
      { weekday: 1, start_time: '19:00', end_time: '08:00' },
      { weekday: 2, start_time: '19:00', end_time: '08:00' },
      { weekday: 3, start_time: '19:00', end_time: '08:00' },
      { weekday: 4, start_time: '19:00', end_time: '08:00' },
      { weekday: 5, start_time: '20:00', end_time: '09:00' },
      { weekday: 6, start_time: '00:00', end_time: '23:59' },
      { weekday: 0, start_time: '00:00', end_time: '23:59' },
    ],
  });
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  const setWin = (weekday: number, patch: any) =>
    setForm((f: any) => ({
      ...f,
      windows: f.windows.map((w: any) => (w.weekday === weekday ? { ...w, ...patch } : w)),
    }));
  const winEnabled = (weekday: number) => form.windows.some((w: any) => w.weekday === weekday);
  const toggleWin = (weekday: number) =>
    setForm((f: any) =>
      winEnabled(weekday)
        ? { ...f, windows: f.windows.filter((w: any) => w.weekday !== weekday) }
        : { ...f, windows: [...f.windows, { weekday, start_time: '19:00', end_time: '08:00' }] },
    );

  const submit = async () => {
    setErr(''); setMsg(''); setPublishing(true);
    try {
      await api('POST', '/spots', form);
      setMsg('车位已提交，等待物业审核产权材料');
      set('code', '');
      reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setPublishing(false);
    }
  };

  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  return (
    <div>
      <PageHead title="我的车位" desc="登记产权车位的共享时段、充电桩、访客与月租车优先规则，提交物业审核后上架" />
      {msg && <div className="alert ok">{msg}</div>}
      {err && <div className="alert error">{err}</div>}
      <div className="grid grid-2">
        <div className="card">
          <h3>发布闲置车位</h3>
          <div className="form-row">
            <div className="field">
              <label>所属小区</label>
              <select value={form.community_id} onChange={(e) => set('community_id', Number(e.target.value))}>
                {(communities ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>车位编号</label>
              <input placeholder="如 B2-108" value={form.code} onChange={(e) => set('code', e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label>位置描述（导航引导用）</label>
            <input placeholder="如 地下二层 B 区，靠 3 号充电桩" value={form.location_desc} onChange={(e) => set('location_desc', e.target.value)} />
          </div>
          <div className="form-row">
            <div className="field">
              <label>每小时单价（元）</label>
              <input type="number" step="0.5" value={form.hourly_rate} onChange={(e) => set('hourly_rate', Number(e.target.value))} />
            </div>
            <div className="field">
              <label>夜间封顶价（元）</label>
              <input type="number" step="1" value={form.overnight_cap ?? ''} onChange={(e) => set('overnight_cap', e.target.value ? Number(e.target.value) : null)} />
            </div>
          </div>
          <div className="form-row">
            <div className="field checkbox">
              <input id="c1" type="checkbox" checked={form.near_charger} onChange={(e) => set('near_charger', e.target.checked)} />
              <label htmlFor="c1" style={{ margin: 0 }}>靠近充电桩（仅新能源车可约）</label>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>充电桩功率（kW）</label>
              <input type="number" step="0.5" disabled={!form.near_charger} value={form.charger_power_kw ?? ''} onChange={(e) => set('charger_power_kw', e.target.value ? Number(e.target.value) : null)} />
            </div>
          </div>
          <div className="form-row">
            <div className="field checkbox">
              <input id="c2" type="checkbox" checked={form.allow_visitor} onChange={(e) => set('allow_visitor', e.target.checked)} />
              <label htmlFor="c2" style={{ margin: 0 }}>允许访客车辆预约</label>
            </div>
            <div className="field checkbox">
              <input id="c3" type="checkbox" checked={form.monthly_priority} onChange={(e) => set('monthly_priority', e.target.checked)} />
              <label htmlFor="c3" style={{ margin: 0 }}>月租车优先排期</label>
            </div>
          </div>

          <div className="field" style={{ marginTop: 6 }}>
            <label>可共享时段（跨天如 19:00→次日 08:00）</label>
            <div className="grid" style={{ gap: 6 }}>
              {WEEK.map((w, i) => {
                const win = form.windows.find((x: any) => x.weekday === i);
                return (
                  <div key={i} className="btn-row" style={{ alignItems: 'center' }}>
                    <label className="checkbox" style={{ width: 70 }}>
                      <input type="checkbox" checked={winEnabled(i)} onChange={() => toggleWin(i)} />
                      周{w}
                    </label>
                    <input type="time" style={{ width: 110 }} disabled={!win} value={win?.start_time ?? ''} onChange={(e) => setWin(i, { start_time: e.target.value })} />
                    <span className="muted">至</span>
                    <input type="time" style={{ width: 110 }} disabled={!win} value={win?.end_time ?? ''} onChange={(e) => setWin(i, { end_time: e.target.value })} />
                  </div>
                );
              })}
            </div>
          </div>
          <button className="btn" disabled={publishing || !form.code} onClick={submit}>{publishing ? '提交中…' : '提交物业审核'}</button>
        </div>

        <div>
          <div className="card">
            <h3>已登记车位 <span className="hint">{spots?.length ?? 0} 个</span></h3>
            {(spots ?? []).map((s) => (
              <div className="spot-card" key={s.id} style={{ marginBottom: 10 }}>
                <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                  <span className="code">{s.code}</span>
                  <Tag status={s.review_status} />
                </div>
                <div className="loc">{s.location_desc}</div>
                <div className="spot-tags">
                  {s.near_charger && <Tag cls="green" label={`⚡ 充电桩 ${s.charger_power_kw ?? ''}kW`} />}
                  {s.allow_visitor ? <Tag cls="blue" label="允许访客" /> : <Tag cls="gray" label="禁访客" />}
                  {s.monthly_priority && <Tag cls="purple" label="月租优先" />}
                  <Tag cls="gray" label={`${s.hourly_rate} 元/时`} />
                  {s.overnight_cap && <Tag cls="amber" label={`封顶 ${s.overnight_cap}`} />}
                </div>
                <div className="small muted" style={{ marginBottom: 8 }}>
                  共享：{(s.windows ?? []).map((w: any) => `周${'日一二三四五六'[w.weekday]} ${String(w.start_time).slice(0, 5)}-${String(w.end_time).slice(0, 5)}`).join('，')}
                </div>
                {s.review_remark && <div className="small" style={{ marginBottom: 8 }}>审核备注：{s.review_remark}</div>}
                <button className="btn sm ghost" onClick={() => setTimelineSpot(s)}>查看一晚时间轴与占用解释</button>
              </div>
            ))}
          </div>
        </div>
      </div>
      {timelineSpot && <SpotTimelineModal spot={timelineSpot} onClose={() => setTimelineSpot(null)} />}
    </div>
  );
}

function SpotTimelineModal({ spot, onClose }: { spot: any; onClose: () => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const load = async (d: string) => {
    setLoading(true);
    const r = await api('GET', `/spots/${spot.id}/timeline?date=${d}`);
    setData(r);
    setLoading(false);
  };
  useEffect(() => {
    load(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head">
          <h3>车位 {spot.code} 整晚占用时间轴</h3>
          <button className="close-x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="filter-bar">
            <label className="small muted">审计日期（18:00 ~ 次日 09:00）</label>
            <input type="date" value={date} onChange={(e) => { setDate(e.target.value); load(e.target.value); }} />
            {loading && <span className="small muted">加载中…</span>}
          </div>
          {data && <TimelineView data={data} />}
        </div>
      </div>
    </div>
  );
}

// ---------- 预约与收益 ----------
function OrdersTab() {
  const { data: orders } = useLoader<any[]>('/reservations');
  const { data: ledger } = useLoader<any[]>('/ledger');
  const [detail, setDetail] = useState<number | null>(null);
  const income = (ledger ?? []).filter((l) => l.account.startsWith('owner:') && l.direction === 'credit').reduce((a, b) => a + Number(b.amount), 0);
  return (
    <div>
      <PageHead title="预约与收益" desc="查看自家车位的全部预约服务单、分账明细与资金流水" />
      <div className="grid grid-3" style={{ marginBottom: 18 }}>
        <div className="stat"><div className="label">累计预约单</div><div className="value">{orders?.length ?? 0}</div></div>
        <div className="stat"><div className="label">业主账户累计入账</div><div className="value text-green">{money(income)}</div><div className="sub">服务分成 70% + 错停/占用补偿</div></div>
        <div className="stat"><div className="label">流水笔数</div><div className="value">{ledger?.length ?? 0}</div></div>
      </div>
      <div className="card">
        <h3>预约服务单</h3>
        <OrderTable orders={orders ?? []} onOpen={(id) => setDetail(id)} />
      </div>
      <div className="card">
        <h3>业主收益流水</h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>时间</th><th>结算单</th><th>方向</th><th>金额</th><th>摘要</th></tr></thead>
            <tbody>
              {(ledger ?? []).map((l) => (
                <tr key={l.id}>
                  <td className="small">{dt(l.created_at)}</td>
                  <td className="small mono">{l.settlement_code}</td>
                  <td>
                    <Tag cls={l.direction === 'credit' ? 'green' : 'amber'} label={l.direction === 'credit' ? '入账' : '出账'} />
                    {l.reversal_id != null && <Tag cls="red" label="冲正" />}
                  </td>
                  <td className="money">{money(l.amount)}</td>
                  <td className="small">{l.memo}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {detail && <ReservationDetailModal id={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

export function OrderTable({ orders, onOpen }: { orders: any[]; onOpen: (id: number) => void }) {
  if (!orders.length) return <div className="empty">暂无预约单</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr><th>单号</th><th>车位</th><th>车主/车牌</th><th>预约时段</th><th>状态</th><th>预付</th><th>实付</th><th></th></tr>
        </thead>
        <tbody>
          {orders.map((r) => (
            <tr key={r.id} className="row-clickable" onClick={() => onOpen(r.id)}>
              <td className="mono small">{r.code}</td>
              <td>{r.spot_code}</td>
              <td>{r.driver_name}<div className="small muted mono">{r.plate}</div></td>
              <td className="small">{dt(r.start_at)}<br />~ {dt(r.end_at)}</td>
              <td><Tag status={r.status} />{r.priority === 'monthly' && <div style={{ marginTop: 4 }}><Tag cls="purple" label="月租" /></div>}</td>
              <td className="money small">{money(r.estimated_fee)}</td>
              <td className="money">{r.status === 'completed' ? money(r.estimated_fee) : '—'}</td>
              <td><button className="btn sm gray" onClick={(e) => { e.stopPropagation(); onOpen(r.id); }}>追溯</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- 夜间调度（业主视角）----------
function DispatchTab({ session }: { session: Session }) {
  const { data: spots } = useLoader<any[]>('/spots/mine');
  const { data: tickets, reload } = useLoader<any[]>('/dispatch/incidents');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const reportReturn = async (spotId: number) => {
    setErr(''); setMsg('');
    const eta = prompt('预计多少分钟后到家？', '30');
    if (eta === null) return;
    try {
      const r = await api('POST', '/dispatch/owner-return', { spot_id: spotId, eta_minutes: Number(eta), note: '业主临时回家' });
      setMsg(`已为该车位在场车主发送挪车通知（工单 ${r.ticket.code}），平台将按其实际使用时长结算并补偿`);
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div>
      <PageHead title="夜间调度" desc="临时回家时一键触发挪车协调；查看自家车位相关异常工单与处置进度" />
      {msg && <div className="alert ok">{msg}</div>}
      {err && <div className="alert error">{err}</div>}
      <div className="card">
        <h3>我要临时回家（收回共享车位）</h3>
        <div className="btn-row">
          {(spots ?? []).filter((s) => s.review_status === 'approved').map((s) => (
            <button key={s.id} className="btn ghost" onClick={() => reportReturn(s.id)}>
              🏠 {s.code} 业主回家
            </button>
          ))}
        </div>
        <div className="small muted" style={{ marginTop: 8 }}>
          触发后：通知在场车主挪车 → 订单按实际可用时长结算 → 业主向车主支付现金补偿（从分成中扣减，不足平台垫付）→ 业主信用 -5（恶意频繁触发时）
        </div>
      </div>
      <div className="card">
        <h3>我车位上的异常工单</h3>
        {(tickets ?? []).length === 0 && <div className="empty">暂无异常</div>}
        {(tickets ?? []).map((t) => (
          <div key={t.id} className={`ticket-card ${t.status}`}>
            <div className="ticket-head">
              <span className="ticket-title">{t.label}</span>
              <span className="btn-row"><span className="mono small muted">{t.spot_code}</span><Tag status={t.status} /></span>
            </div>
            <div className="ticket-desc">{t.description}</div>
            {t.resolution && <div className="small">处置：{t.resolution}</div>}
            <div className="small muted">{dt(t.created_at)}{t.reservation_code ? ` · 关联订单 ${t.reservation_code}` : ''}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 申诉（业主查看）----------
function AppealsTab() {
  const { data: appeals } = useLoader<any[]>('/appeals');
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div>
      <PageHead title="车位申诉" desc="车主对自家车位订单发起的错停申诉，可查看证据链与物业终裁结果" />
      <div className="card">
        {(appeals ?? []).length === 0 && <div className="empty">暂无申诉</div>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>申诉单</th><th>订单/车位</th><th>事由</th><th>裁决</th><th></th></tr></thead>
            <tbody>
              {(appeals ?? []).map((a) => (
                <tr key={a.id}>
                  <td className="mono small">{a.code}<div className="small muted">{dt(a.created_at)}</div></td>
                  <td>{a.spot_code}<div className="small muted mono">{a.reservation_code} · {a.plate}</div></td>
                  <td className="small">{a.reason}</td>
                  <td><Tag status={a.status} /></td>
                  <td><button className="btn sm gray" onClick={() => setOpen(a.id)}>查看证据与裁决</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {open && <AppealDetailModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
