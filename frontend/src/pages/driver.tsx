import { useState } from 'react';
import { api, qs } from '../api';
import { useLoader } from '../hooks';
import { WorkspaceShell } from '../App';
import { dt, money, Tag } from '../ui';
import { OrderTable } from './owner';
import { AppealDetailModal, ReservationDetailModal } from './shared';
import { SettlementView } from '../components';

type Session = any;
const NAV = [
  { key: 'browse', label: '找车位预约', icon: '🔍' },
  { key: 'active', label: '我的停车服务', icon: '🚗' },
  { key: 'vehicles', label: '车辆与优惠券', icon: '🎫' },
  { key: 'refunds', label: '退款申请', icon: '💸' },
  { key: 'appeals', label: '错停申诉', icon: '⚖️' },
];

export function DriverWorkspace({ session }: { session: Session }) {
  const [tab, setTab] = useState('browse');
  return (
    <WorkspaceShell session={session} nav={NAV} active={tab} onNav={setTab}>
      {tab === 'browse' && <BrowseTab />}
      {tab === 'active' && <OrdersTab />}
      {tab === 'vehicles' && <VehiclesTab />}
      {tab === 'refunds' && <RefundsTab />}
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

// ---------- 找车位 ----------
function BrowseTab() {
  const [community, setCommunity] = useState('1');
  const [needCharger, setNeedCharger] = useState(false);
  const [visitor, setVisitor] = useState(false);
  const { data: communities } = useLoader<any[]>('/spots/communities');
  const query = qs({ community_id: community, need_charger: needCharger || undefined, visitor: visitor || undefined });
  const { data: spots, reload } = useLoader<any[]>(`/spots${query}`);
  const { data: vehicles } = useLoader<any[]>('/vehicles');
  const { data: coupons } = useLoader<any[]>('/coupons');
  const [booking, setBooking] = useState<any>(null);
  const [msg, setMsg] = useState('');

  return (
    <div>
      <PageHead title="找车位预约" desc="仅展示物业审核通过、当前在共享时段内的业主闲置车位；月租车在优先规则下排期" />
      {msg && <div className="alert ok">{msg}</div>}
      <div className="filter-bar card" style={{ marginBottom: 16 }}>
        <label className="small muted">小区</label>
        <select value={community} onChange={(e) => setCommunity(e.target.value)}>
          {(communities ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="checkbox"><input type="checkbox" checked={needCharger} onChange={(e) => setNeedCharger(e.target.checked)} />仅看充电桩车位</label>
        <label className="checkbox"><input type="checkbox" checked={visitor} onChange={(e) => setVisitor(e.target.checked)} />允许访客车</label>
        <span className="small muted" style={{ marginLeft: 'auto' }}>{spots?.length ?? 0} 个可约车位</span>
      </div>
      <div className="grid grid-3">
        {(spots ?? []).map((s) => (
          <div className="spot-card" key={s.id}>
            <div className="btn-row" style={{ justifyContent: 'space-between' }}>
              <span className="code">{s.code}</span>
              {s.monthly_priority && <Tag cls="purple" label="月租优先" />}
            </div>
            <div className="loc">{s.community_name} · {s.location_desc}</div>
            <div className="spot-tags">
              {s.near_charger && <Tag cls="green" label={`⚡ ${s.charger_power_kw ?? 7}kW`} />}
              {s.allow_visitor ? <Tag cls="blue" label="访客可约" /> : <Tag cls="gray" label="禁访客" />}
              <Tag cls="gray" label={`业主 ${s.owner_name}`} />
            </div>
            <div className="small muted" style={{ minHeight: 34 }}>
              今日共享：{(s.windows ?? []).filter((w: any) => [new Date().getDay(), (new Date().getDay() + 6) % 7].includes(w.weekday))
                .map((w: any) => `${String(w.start_time).slice(0, 5)}-${String(w.end_time).slice(0, 5)}`).join(' / ') || '—'}
            </div>
            <div className="btn-row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <div className="price">{s.hourly_rate}<small> 元/时</small><div className="small muted" style={{ fontSize: 11 }}>夜间封顶 {s.overnight_cap ? money(s.overnight_cap) : '无'}</div></div>
              <button className="btn" onClick={() => setBooking(s)}>预约</button>
            </div>
          </div>
        ))}
      </div>
      {booking && (
        <BookingModal
          spot={booking}
          vehicles={vehicles ?? []}
          coupons={coupons ?? []}
          onClose={() => setBooking(null)}
          onDone={() => { setBooking(null); setMsg('预约成功：请在入场时使用车牌识别，道闸将自动放行并下发导航'); reload(); }}
        />
      )}
    </div>
  );
}

const toLocalInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

function BookingModal({ spot, vehicles, coupons, onClose, onDone }: any) {
  const startDefault = new Date(Date.now() + 15 * 60000);
  const endDefault = new Date(startDefault.getTime() + 3 * 3600000);
  const [vehicleId, setVehicleId] = useState<number | ''>(vehicles[0]?.id ?? '');
  const [start, setStart] = useState(toLocalInput(startDefault));
  const [end, setEnd] = useState(toLocalInput(endDefault));
  const [couponId, setCouponId] = useState<number | ''>('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const availableCoupons = coupons.filter((c: any) => !c.used_at);
  const hours = (new Date(end).getTime() - new Date(start).getTime()) / 3600000;
  const estimate = Math.min(Number(spot.overnight_cap ?? 1e9), Math.max(0, hours) * Number(spot.hourly_rate));
  const coupon = availableCoupons.find((c: any) => c.id === couponId);
  const prepaid = Math.max(0, estimate - Number(coupon?.amount ?? 0));

  const submit = async () => {
    setErr(''); setBusy(true);
    try {
      await api('POST', '/reservations', {
        spot_id: spot.id,
        vehicle_id: vehicleId,
        start_at: new Date(start).toISOString(),
        end_at: new Date(end).toISOString(),
        coupon_id: couponId || undefined,
      });
      onDone();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head"><h3>预约车位 {spot.code}</h3><button className="close-x" onClick={onClose}>×</button></div>
        <div className="modal-body">
          {err && <div className="alert error">{err}</div>}
          <div className="field">
            <label>预约车辆</label>
            <select value={vehicleId} onChange={(e) => setVehicleId(Number(e.target.value))}>
              {vehicles.map((v: any) => (
                <option key={v.id} value={v.id}>
                  {v.plate}（{v.is_new_energy ? '新能源' : '燃油'}{v.is_monthly ? '·月租' : ''}{v.is_visitor ? '·访客' : ''}）
                </option>
              ))}
            </select>
            {vehicles.length === 0 && <div className="small" style={{ color: 'var(--red)' }}>请先在"车辆与优惠券"中登记车辆</div>}
          </div>
          <div className="form-row">
            <div className="field"><label>开始时间</label><input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="field"><label>结束时间</label><input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
          </div>
          <div className="field">
            <label>优惠券</label>
            <select value={couponId} onChange={(e) => setCouponId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">不使用</option>
              {availableCoupons.map((c: any) => <option key={c.id} value={c.id}>{c.code}（{money(c.amount)}）</option>)}
            </select>
          </div>
          <div className="alert info">
            <div className="fee-grid">
              <div className="row"><span>预估费用（{hours.toFixed(1)} 小时）</span><span className="money">{money(estimate)}</span></div>
              <div className="row"><span>优惠券</span><span className="money">-{money(coupon?.amount ?? 0)}</span></div>
              <div className="row total"><span>预约预付</span><span className="money">{money(prepaid)}</span></div>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn" disabled={busy || !vehicleId} onClick={submit}>{busy ? '提交中…' : '确认预约并预付'}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- 我的停车服务（入场/停放/申诉/结算操作）----------
function OrdersTab() {
  const { data: orders, reload } = useLoader<any[]>('/reservations?scope=mine');
  const [detail, setDetail] = useState<number | null>(null);
  const [activeOrder, setActiveOrder] = useState<any>(null);
  const [settlement, setSettlement] = useState<{ id: number; data: any } | null>(null);

  return (
    <div>
      <PageHead title="我的停车服务" desc="从预约、道闸识别入场、导航引导、停放确认到离场结算，全部绑定同一笔服务单" right={
        <button className="btn ghost" onClick={reload}>刷新</button>
      } />
      <div className="card">
        <OrderTable orders={orders ?? []} onOpen={(id) => {
          const o = (orders ?? []).find((x) => x.id === id);
          if (['reserved', 'admitted', 'in_garage'].includes(o.status)) setActiveOrder(o);
          else setDetail(id);
        }} />
      </div>
      {detail && <ReservationDetailModal id={detail} onClose={() => setDetail(null)} />}
      {activeOrder && (
        <ServiceActionModal
          order={activeOrder}
          onClose={() => setActiveOrder(null)}
          onChanged={() => { setActiveOrder(null); reload(); }}
          onSettlement={(id: number, data: any) => setSettlement({ id, data })}
        />
      )}
      {settlement && (
        <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && setSettlement(null)}>
          <div className="modal wide">
            <div className="modal-head"><h3>离场结算单</h3><button className="close-x" onClick={() => setSettlement(null)}>×</button></div>
            <div className="modal-body"><SettlementView s={settlement.data} /></div>
          </div>
        </div>
      )}
    </div>
  );
}

function ServiceActionModal({ order, onClose, onChanged, onSettlement }: any) {
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [rec, setRec] = useState<any>(null);
  const [actualSpot, setActualSpot] = useState(order.spot_code);
  const [signalArea, setSignalArea] = useState('B2 层');

  const act = async (fn: () => Promise<any>) => {
    setErr(''); setBusy(true);
    try { return await fn(); } catch (e: any) { setErr(e.message); return null; } finally { setBusy(false); }
  };

  const recognize = () => act(async () => {
    const r = await api('POST', '/operations/gate/recognize', { plate: order.plate, gate: '南门入口', confidence: 0.96 });
    setRec(r);
    return r;
  });
  const admit = (mode: 'auto' | 'manual') => act(async () => {
    await api('POST', '/operations/gate/admit', {
      reservation_id: order.id, plate: order.plate,
      gate: mode === 'auto' ? '南门入口' : '北门入口', mode,
      note: mode === 'manual' ? '识别不顺利，请物业核对预约码后人工放行' : undefined,
    });
    onChanged();
  });
  const guidance = () => act(async () => {
    const r = await api('POST', '/operations/navigation/guidance', { reservation_id: order.id, signal: 'good' });
    setRec((x: any) => ({ ...(x ?? {}), guidance: r }));
    return r;
  });
  const offlineGuidance = () => act(async () => {
    const r = await api('POST', '/operations/navigation/guidance', { reservation_id: order.id, signal: 'weak' });
    setRec((x: any) => ({ ...(x ?? {}), guidance: r }));
    return r;
  });
  const reportSignal = () => act(async () => api('POST', `/operations/reservations/${order.id}/report-signal`, { area: signalArea }));
  const parked = () => act(async () => {
    const r = await api('POST', `/operations/reservations/${order.id}/parked`, { actual_spot_code: actualSpot });
    if (r?.wrong_parking) {
      setRec((x: any) => ({ ...(x ?? {}), wrong: true }));
    } else {
      onChanged();
    }
    return r;
  });
  const exit = async () => {
    const r = await act(async () => api('POST', `/reservations/${order.id}/exit`, { charge_kwh: order.near_charger ? 20 : 0 }));
    if (r) { onSettlement(order.id, r); onChanged(); }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head">
          <h3>停车服务操作 · {order.code} <Tag status={order.status} /></h3>
          <button className="close-x" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {err && <div className="alert error">{err}</div>}
          <div className="small muted" style={{ marginBottom: 12 }}>
            车位 {order.community_name} {order.spot_code} · {order.plate} · 预约 {dt(order.start_at)} ~ {dt(order.end_at)}
          </div>

          <div className="grid grid-2">
            <div className="card" style={{ marginTop: 0 }}>
              <h3>① 入场道闸</h3>
              <div className="btn-row">
                <button className="btn" disabled={busy || order.status !== 'reserved'} onClick={recognize}>📷 车牌识别</button>
                <button className="btn ghost" disabled={busy || order.status !== 'reserved'} onClick={() => admit('auto')}>识别成功 · 开闸</button>
                <button className="btn gray" disabled={busy || order.status !== 'reserved'} onClick={() => admit('manual')}>🙋 请物业人工放行</button>
              </div>
              {rec?.admitted === false && (
                <div className="alert error" style={{ marginTop: 10 }}>
                  识别未通过（{rec.reason === 'no_reservation' ? '无匹配预约' : '置信度过低'}），已自动生成识别失败工单，请联系物业人工核验
                </div>
              )}
              {rec?.admitted === true && (
                <div className="alert ok" style={{ marginTop: 10 }}>识别成功！置信度 {Math.round(rec.confidence * 100)}%，道闸已放行</div>
              )}
              {order.status !== 'reserved' && <div className="small muted" style={{ marginTop: 8 }}>车辆已入场（{dt(order.gate_entry_at)}）</div>}
            </div>

            <div className="card" style={{ marginTop: 0 }}>
              <h3>② 导航引导</h3>
              <div className="btn-row">
                <button className="btn ghost" disabled={busy || order.status === 'reserved'} onClick={guidance}>🧭 在线导航</button>
                <button className="btn gray" disabled={busy || order.status === 'reserved'} onClick={offlineGuidance}>📶 信号差 · 离线导航码</button>
              </div>
              {rec?.guidance && (
                <div className="nav-steps" style={{ marginTop: 10 }}>
                  <b>{rec.guidance.voice}{rec.guidance.offline_cached ? '（离线缓存）' : ''}</b>
                  <ol>{rec.guidance.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ol>
                </div>
              )}
              <div className="btn-row" style={{ marginTop: 10 }}>
                <input style={{ width: 120 }} placeholder="信号弱区域" value={signalArea} onChange={(e) => setSignalArea(e.target.value)} />
                <button className="btn sm gray" disabled={busy || order.status === 'reserved'} onClick={reportSignal}>上报地下车库信号差</button>
              </div>
            </div>

            <div className="card">
              <h3>③ 停放确认（车位地磁/App 打卡）</h3>
              <div className="btn-row">
                <input style={{ width: 150 }} value={actualSpot} onChange={(e) => setActualSpot(e.target.value)} placeholder="实际停放车位号" />
                <button className="btn" disabled={busy || order.status !== 'admitted'} onClick={parked}>我已停好</button>
              </div>
              {rec?.wrong && (
                <div className="alert error" style={{ marginTop: 10 }}>
                  ⚠️ 检测到您停在 {actualSpot}，预约车位为 {order.spot_code}：已自动生成错停工单并发送挪车通知。
                  若确有客观原因（指示不清/被陌生车占用等），请立即在"错停申诉"中提交现场照片。
                </div>
              )}
              {order.status === 'in_garage' && <div className="alert ok" style={{ marginTop: 10 }}>已确认停放在预约车位，计费进行中</div>}
            </div>

            <div className="card">
              <h3>④ 离场结算</h3>
              <div className="small muted" style={{ marginBottom: 8 }}>
                系统将合并基础停车费{order.near_charger ? '、充电费' : ''}、超时/违约金、优惠券、异常补偿，
                按 业主 70% / 物业 10% / 平台 20% 清算；预付多退少补。
              </div>
              {order.near_charger && <div className="small muted" style={{ marginBottom: 8 }}>演示按充电 20kWh 结算（1.2 元/kWh）</div>}
              <button className="btn success" disabled={busy || !['admitted', 'in_garage'].includes(order.status)} onClick={exit}>
                道闸离场并查看清算单
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- 车辆与优惠券 ----------
function VehiclesTab() {
  const { data: vehicles, reload } = useLoader<any[]>('/vehicles');
  const { data: coupons } = useLoader<any[]>('/coupons');
  const [form, setForm] = useState({ plate: '', plate_color: '蓝牌', is_new_energy: false, is_monthly: false, is_visitor: false });
  const [err, setErr] = useState('');

  const submit = async () => {
    setErr('');
    try {
      await api('POST', '/vehicles', form);
      setForm({ plate: '', plate_color: '蓝牌', is_new_energy: false, is_monthly: false, is_visitor: false });
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div>
      <PageHead title="车辆与优惠券" desc="登记车牌（入场道闸识别依据）；月租车与访客车标识影响预约规则" />
      <div className="grid grid-2">
        <div className="card">
          <h3>我的车辆</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>车牌</th><th>类型</th><th>标识</th></tr></thead>
              <tbody>
                {(vehicles ?? []).map((v) => (
                  <tr key={v.id}>
                    <td className="mono">{v.plate} <span className="small muted">{v.plate_color}</span></td>
                    <td>{v.is_new_energy ? '新能源' : '燃油'}</td>
                    <td className="btn-row">
                      {v.is_monthly && <Tag cls="purple" label="月租" />}
                      {v.is_visitor && <Tag cls="cyan" label="访客" />}
                      {!v.is_monthly && !v.is_visitor && <span className="small muted">普通</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ height: 14 }} />
          {err && <div className="alert error">{err}</div>}
          <div className="form-row">
            <div className="field"><label>车牌号</label><input value={form.plate} onChange={(e) => setForm({ ...form, plate: e.target.value.toUpperCase() })} placeholder="如 沪AD88899" /></div>
            <div className="field"><label>车牌颜色</label>
              <select value={form.plate_color} onChange={(e) => setForm({ ...form, plate_color: e.target.value })}>
                <option>蓝牌</option><option>绿牌</option><option>黄牌</option>
              </select>
            </div>
          </div>
          <div className="btn-row">
            <label className="checkbox"><input type="checkbox" checked={form.is_new_energy} onChange={(e) => setForm({ ...form, is_new_energy: e.target.checked })} />新能源</label>
            <label className="checkbox"><input type="checkbox" checked={form.is_monthly} onChange={(e) => setForm({ ...form, is_monthly: e.target.checked })} />月租车</label>
            <label className="checkbox"><input type="checkbox" checked={form.is_visitor} onChange={(e) => setForm({ ...form, is_visitor: e.target.checked })} />访客车</label>
            <button className="btn" onClick={submit} disabled={!form.plate}>登记车辆</button>
          </div>
        </div>
        <div className="card">
          <h3>我的优惠券 <span className="hint">含异常赔付券</span></h3>
          {(coupons ?? []).length === 0 && <div className="empty">暂无优惠券</div>}
          <div className="grid" style={{ gap: 10 }}>
            {(coupons ?? []).map((c) => (
              <div key={c.id} className="spot-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div className="mono">{c.code}</div>
                  <div className="small muted">{c.used_at ? `已于 ${dt(c.used_at)} 使用（订单 #${c.used_reservation_id}）` : '未使用'}</div>
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--brand)' }}>{money(c.amount)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- 退款申请（平台按道闸/巡查/离场时间校验可退金额）----------
function RefundsTab() {
  const { data: orders } = useLoader<any[]>('/reservations?scope=mine');
  const { data: refunds, reload } = useLoader<any[]>('/refund-requests');
  const completed = (orders ?? []).filter((o) => o.status === 'completed');
  const [reservationId, setReservationId] = useState<number | ''>('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setErr(''); setResult(null); setBusy(true);
    try {
      const r = await api('POST', `/reservations/${reservationId}/refund-requests`, {
        amount: Number(amount),
        reason,
      });
      setResult(r);
      setAmount(''); setReason('');
      reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHead title="退款申请" desc="平台按道闸记录、物业巡查与离场时间校验可退金额，已退部分自动扣减，避免重复冲销" />
      <div className="grid grid-2">
        <div className="card">
          <h3>发起退款申请</h3>
          {err && <div className="alert error">{err}</div>}
          {result && (
            <div className="alert ok">
              退款申请已提交（{result.code}），系统校验可退上限 {money(result.validation?.maxRefundable)}，等待物业审核
            </div>
          )}
          <div className="field">
            <label>选择已结算订单</label>
            <select value={reservationId} onChange={(e) => setReservationId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">请选择订单</option>
              {completed.map((o: any) => (
                <option key={o.id} value={o.id}>{o.code} · {o.spot_code} · {dt(o.start_at)}</option>
              ))}
            </select>
          </div>
          <div className="field"><label>申请退款金额（元）</label><input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="field"><label>退款理由</label><textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：申诉裁定平台责任免单 / 道闸离场时间记录有误多扣费…" /></div>
          <button className="btn" disabled={busy || !reservationId || !(Number(amount) > 0)} onClick={submit}>
            {busy ? '提交中…' : '提交申请并校验'}
          </button>
          {result && (
            <div style={{ marginTop: 12 }}>
              <h3 style={{ fontSize: 14, marginBottom: 8 }}>系统校验明细</h3>
              <RefundChecks checks={result.validation?.checks} />
            </div>
          )}
        </div>
        <div className="card">
          <h3>我的退款记录 <span className="hint">{refunds?.length ?? 0} 笔</span></h3>
          {(refunds ?? []).length === 0 && <div className="empty">暂无退款申请</div>}
          {(refunds ?? []).map((f) => (
            <div key={f.id} className={`ticket-card ${f.status === 'approved' ? 'resolved' : f.status === 'rejected' ? 'open' : 'notified'}`}>
              <div className="ticket-head">
                <span className="ticket-title">{f.code} · {money(f.requested_amount)}</span>
                <Tag status={f.status} />
              </div>
              <div className="ticket-desc">{f.reason || '（未填写理由）'} · 订单 {f.reservation_code} · {f.spot_code}</div>
              <div className="small muted">
                {dt(f.created_at)}
                {f.status === 'approved' && ` · 核准 ${money(f.validated_amount)} 已到账`}
                {f.review_note ? ` · ${f.review_note}` : ''}
              </div>
              <details style={{ marginTop: 6 }}>
                <summary className="small muted" style={{ cursor: 'pointer' }}>校验明细（道闸 / 巡查 / 离场时间 / 重复冲销）</summary>
                <RefundChecks checks={f.checks} />
              </details>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function RefundChecks({ checks }: { checks?: any[] }) {
  if (!checks?.length) return <div className="empty small">暂无校验明细</div>;
  return (
    <div style={{ marginTop: 8 }}>
      {checks.map((c, i) => (
        <div key={i} className="small" style={{ padding: '4px 0', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <Tag cls={c.passed ? 'green' : 'red'} label={c.passed ? '通过' : '未通过'} />
          <div>
            <b>{c.label}</b>
            <div className="muted">{c.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- 我的申诉 ----------
function AppealsTab() {
  const { data: appeals, reload } = useLoader<any[]>('/appeals');
  const { data: orders } = useLoader<any[]>('/reservations?scope=mine');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const appealable = (orders ?? []).filter((o) => ['admitted', 'in_garage', 'completed'].includes(o.status));

  return (
    <div>
      <PageHead title="错停申诉" desc="系统将自动汇聚车牌识别、预约、道闸日志、业主回家时间、物业巡查记录，结合你上传的现场照片给出责任建议" right={
        <button className="btn" disabled={appealable.length === 0} onClick={() => setCreating(true)}>发起申诉</button>
      } />
      <div className="card">
        {(appeals ?? []).length === 0 && <div className="empty">暂无申诉记录</div>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>申诉单</th><th>车位/车牌</th><th>事由</th><th>状态/裁决</th><th></th></tr></thead>
            <tbody>
              {(appeals ?? []).map((a) => (
                <tr key={a.id}>
                  <td className="mono small">{a.code}<div className="small muted">{dt(a.created_at)}</div></td>
                  <td>{a.spot_code}<div className="small muted mono">{a.plate}</div></td>
                  <td className="small">{a.reason}</td>
                  <td><Tag status={a.status} /></td>
                  <td><button className="btn sm gray" onClick={() => setOpenId(a.id)}>证据链/裁决</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {creating && <CreateAppealModal orders={appealable} onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload(); }} />}
      {openId && <AppealView id={openId} onClose={() => { setOpenId(null); reload(); }} />}
    </div>
  );
}

function AppealView({ id, onClose }: { id: number; onClose: () => void }) {
  return <AppealDetailModal id={id} onClose={onClose} />;
}

function CreateAppealModal({ orders, onClose, onDone }: any) {
  const [reservationId, setReservationId] = useState(orders[0]?.id ?? '');
  const [reason, setReason] = useState('');
  const [photoNote, setPhotoNote] = useState('');
  const [err, setErr] = useState('');
  const [result, setResult] = useState<any>(null);

  const submit = async () => {
    setErr('');
    try {
      const r = await api('POST', '/appeals', {
        reservation_id: reservationId,
        reason,
        evidence: photoNote
          ? [{ source: 'photo', title: '现场照片说明', content: photoNote, captured_at: new Date().toISOString(), stance: 'support' }]
          : [],
      });
      setResult(r);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide">
        <div className="modal-head"><h3>发起错停申诉</h3><button className="close-x" onClick={onClose}>×</button></div>
        <div className="modal-body">
          {!result ? (
            <div>
              {err && <div className="alert error">{err}</div>}
              <div className="field">
                <label>关联停车服务单</label>
                <select value={reservationId} onChange={(e) => setReservationId(Number(e.target.value))}>
                  {orders.map((o: any) => <option key={o.id} value={o.id}>{o.code} · {o.spot_code} · {o.plate} · {dt(o.start_at)}</option>)}
                </select>
              </div>
              <div className="field">
                <label>申诉事由</label>
                <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：到场发现车位被陌生车占用 / 导航信号中断被引导至错误区域 / 业主临时回家要求挪车…" />
              </div>
              <div className="field">
                <label>现场照片说明（上传 OSS 后在此描述照片内容与链接）</label>
                <textarea value={photoNote} onChange={(e) => setPhotoNote(e.target.value)} placeholder="如：照片显示车位标牌 B2-109，地面箭头磨损；附件 evidence/xxx.jpg" />
              </div>
              <div className="alert info">提交后系统立即自动分析：车牌识别记录、预约记录、道闸日志、业主回家上报时间、物业巡查档案与你的陈述/照片。</div>
              <button className="btn" disabled={!reason} onClick={submit}>提交申诉并查看自动责任分析</button>
            </div>
          ) : (
            <div>
              <div className="alert ok">申诉已受理（{result.appeal.code}），自动责任分析已生成，物业将据此终裁</div>
              <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>
                建议结论：{result.adjudication.ruling}（置信度 {Math.round(result.adjudication.confidence * 100)}%）{'\n'}
                {result.adjudication.reasons.join('\n')}
              </pre>
              <button className="btn" onClick={onDone}>完成</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
