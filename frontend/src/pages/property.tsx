import { useEffect, useState } from 'react';
import { api } from '../api';
import { useLoader } from '../hooks';
import { WorkspaceShell } from '../App';
import { dt, INCIDENT_LABEL, money, Tag } from '../ui';
import { OrderTable } from './owner';
import { AppealDetailModal, ReservationDetailModal } from './shared';

type Session = any;
const NAV = [
  { key: 'review', label: '车位审核', icon: '✅' },
  { key: 'gate', label: '道闸操作台', icon: '🚧' },
  { key: 'dispatch', label: '夜间调度看板', icon: '🌙' },
  { key: 'patrol', label: '巡查登记', icon: '🔦' },
  { key: 'appeals', label: '申诉裁决', icon: '⚖️' },
  { key: 'refunds', label: '退款审核', icon: '💸' },
  { key: 'orders', label: '订单追溯', icon: '🧾' },
];

export function PropertyWorkspace({ session }: { session: Session }) {
  const [tab, setTab] = useState('dispatch');
  return (
    <WorkspaceShell session={session} nav={NAV} active={tab} onNav={setTab}>
      {tab === 'review' && <ReviewTab />}
      {tab === 'gate' && <GateTab />}
      {tab === 'dispatch' && <DispatchTab />}
      {tab === 'patrol' && <PatrolTab />}
      {tab === 'appeals' && <AppealsTab />}
      {tab === 'refunds' && <RefundReviewTab />}
      {tab === 'orders' && <OrdersTab />}
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

// ---------- 车位审核 ----------
function ReviewTab() {
  const { data: pending, reload } = useLoader<any[]>('/spots/review/pending');
  const [remark, setRemark] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');

  const review = async (s: any, pass: boolean) => {
    await api('POST', `/spots/${s.id}/review`, { pass, remark: remark[s.id] ?? (pass ? '产权材料齐全' : '产权证明待补充') });
    setMsg(`车位 ${s.code} 已${pass ? '审核通过' : '驳回'}`);
    reload();
  };

  return (
    <div>
      <PageHead title="车位发布审核" desc="核验业主车位产权证明、充电桩位置与共享时段，通过后车主方可预约" />
      {msg && <div className="alert ok">{msg}</div>}
      <div className="card">
        <h3>待审核队列 <span className="hint">{pending?.length ?? 0} 个</span></h3>
        {(pending ?? []).length === 0 && <div className="empty">没有待审核车位</div>}
        {(pending ?? []).map((s) => (
          <div className="ticket-card open" key={s.id}>
            <div className="ticket-head">
              <span className="ticket-title">{s.community_name} · {s.code}</span>
              <span className="small muted">{s.owner_name} {s.owner_phone}</span>
            </div>
            <div className="ticket-desc">
              {s.location_desc} · {s.hourly_rate} 元/时{s.overnight_cap ? ` · 封顶 ${s.overnight_cap}` : ''} · {dt(s.created_at)} 提交
            </div>
            <div className="spot-tags">
              {s.near_charger && <Tag cls="green" label={`⚡ 充电桩 ${s.charger_power_kw ?? ''}kW`} />}
              {s.allow_visitor ? <Tag cls="blue" label="允许访客" /> : <Tag cls="gray" label="禁访客" />}
              {s.monthly_priority && <Tag cls="purple" label="月租优先" />}
            </div>
            <div className="btn-row" style={{ marginTop: 8 }}>
              <input style={{ maxWidth: 360 }} placeholder="审核备注（产权材料 / 现场核验）"
                value={remark[s.id] ?? ''} onChange={(e) => setRemark((m) => ({ ...m, [s.id]: e.target.value }))} />
              <button className="btn success sm" onClick={() => review(s, true)}>通过</button>
              <button className="btn danger sm" onClick={() => review(s, false)}>驳回</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 道闸操作台 ----------
function GateTab() {
  const [plate, setPlate] = useState('沪AD88899');
  const [gate, setGate] = useState('南门入口');
  const [rec, setRec] = useState<any>(null);
  const [err, setErr] = useState('');
  const [confidence, setConfidence] = useState(0.96);

  const recognize = async () => {
    setErr('');
    try {
      const r = await api('POST', '/operations/gate/recognize', { plate, gate, confidence });
      setRec(r);
    } catch (e: any) { setErr(e.message); }
  };
  const admit = async (mode: 'auto' | 'manual') => {
    setErr('');
    try {
      if (!rec?.reservation?.id) { setErr('请先识别到匹配预约'); return; }
      await api('POST', '/operations/gate/admit', {
        reservation_id: rec.reservation.id, plate, gate, mode, confidence,
        note: mode === 'manual' ? '物业核对预约码后人工放行' : undefined,
      });
      setRec({ ...rec, admitted: true, justAdmitted: true });
    } catch (e: any) { setErr(e.message); }
  };

  return (
    <div>
      <PageHead title="道闸操作台" desc="摄像头车牌识别 → 匹配当晚预约 → 自动放行并下发导航；识别失败时转人工核验放行，全过程写入同一笔停车服务" />
      <div className="grid grid-2">
        <div className="card">
          <h3>入场识别</h3>
          {err && <div className="alert error">{err}</div>}
          <div className="form-row">
            <div className="field"><label>识别车牌</label><input className="mono" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} /></div>
            <div className="field"><label>道闸</label>
              <select value={gate} onChange={(e) => setGate(e.target.value)}>
                <option>南门入口</option><option>北门入口</option><option>地库 B2 入口</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label>识别置信度：{Math.round(confidence * 100)}%（低于 75% 判识别失败）</label>
            <input type="range" min={0.3} max={0.99} step={0.01} value={confidence} onChange={(e) => setConfidence(Number(e.target.value))} />
          </div>
          <div className="btn-row">
            <button className="btn" onClick={recognize}>📷 识别</button>
            <button className="btn ghost" disabled={!rec?.reservation} onClick={() => admit('auto')}>自动放行</button>
            <button className="btn gray" disabled={!rec?.reservation} onClick={() => admit('manual')}>人工核验放行</button>
          </div>
        </div>
        <div className="card">
          <h3>识别结果</h3>
          {!rec && <div className="empty">等待识别…</div>}
          {rec && (
            <div>
              {rec.justAdmitted && <div className="alert ok">已{rec.manual ? '人工' : '自动'}开闸放行，入场事件已绑定服务单</div>}
              <div className="btn-row" style={{ marginBottom: 10 }}>
                {rec.admitted ? <Tag cls="green" label="准予放行" /> : <Tag cls="red" label="拒绝入场" />}
                <span className="small muted">置信度 {Math.round((rec.confidence ?? 0) * 100)}%</span>
                {rec.ticket_id && <Tag cls="amber" label={`识别失败工单 #${rec.ticket_id}`} />}
              </div>
              {rec.reason && <div className="small muted">原因：{rec.reason === 'no_reservation' ? '无匹配预约' : rec.reason === 'recognition_low_confidence' ? '识别置信度过低' : rec.reason}</div>}
              {rec.reservation && (
                <div style={{ marginTop: 8 }}>
                  <div>预约单 <b>#{rec.reservation.id}</b> · 车位 <b className="mono">{rec.reservation.spot_code}</b></div>
                  <div className="small muted">{rec.reservation.community_name} · {rec.reservation.location_desc}</div>
                  <div className="spot-tags" style={{ marginTop: 8 }}>
                    {rec.reservation.is_new_energy && <Tag cls="green" label="新能源" />}
                    {rec.reservation.is_visitor && <Tag cls="cyan" label="访客车" />}
                  </div>
                </div>
              )}
              {rec.guidance && (
                <div className="nav-steps" style={{ marginTop: 12 }}>
                  <b>{rec.guidance.voice}</b>
                  <ol>{rec.guidance.steps.map((s: string, i: number) => <li key={i}>{s}</li>)}</ol>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- 夜间调度看板 ----------
function DispatchTab() {
  const [status, setStatus] = useState('');
  const { data: tickets, reload } = useLoader<any[]>(`/dispatch/incidents${status ? `?status=${status}` : ''}`);
  const { data: overview } = useLoader<any>('/dispatch/overview');
  const [openNotices, setOpenNotices] = useState<any | null>(null);
  const [swapOpen, setSwapOpen] = useState(false);
  const [msg, setMsg] = useState('');

  const notify = async (t: any) => {
    await api('POST', `/dispatch/incidents/${t.id}/notify`, {});
    setMsg(`挪车通知已发送至 ${t.plate}（App 推送 + 车位 LED 屏）`);
    reload();
  };
  const resolve = async (t: any) => {
    const resolution = prompt('处置结果说明', t.type === 'stranger_occupy' ? '陌生车辆已劝离' : '已处置完成');
    if (resolution === null) return;
    const waive = t.type === 'visitor_overstay' ? confirm('是否豁免该单超时费？') : false;
    await api('POST', `/dispatch/incidents/${t.id}/resolve`, { resolution, waive_overtime: waive });
    setMsg(`工单 ${t.code} 已关闭`);
    reload();
  };
  const overstay = async () => {
    const id = prompt('输入访客超时的预约单 ID');
    if (!id) return;
    await api('POST', '/dispatch/overstay', { reservation_id: Number(id) });
    setMsg('超时预警与挪车通知已发送');
    reload();
  };

  const counts: Record<string, number> = {};
  for (const x of overview?.incidents_24h ?? []) counts[`${x.type}:${x.status}`] = x.n;

  return (
    <div>
      <PageHead title="夜间调度看板" desc="集中处理业主临时回家、访客超时、陌生车占用、识别失败、信号差、燃油车占充电位、人工放行、换位调度等夜间事件" right={
        <div className="btn-row">
          <button className="btn ghost" onClick={() => setSwapOpen(true)}>🔀 换位调度</button>
          <button className="btn ghost" onClick={overstay}>访客超时预警</button>
        </div>
      } />
      {msg && <div className="alert ok">{msg}</div>}
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {Object.entries(INCIDENT_LABEL).map(([k, label]) => {
          const open = (overview?.incidents_24h ?? []).filter((x: any) => x.type === k && ['open', 'notified'].includes(x.status)).reduce((a: number, b: any) => a + b.n, 0);
          return (
            <div className="stat" key={k}>
              <div className="label">{label}</div>
              <div className="value" style={{ color: open > 0 ? 'var(--red)' : undefined }}>{open}</div>
              <div className="sub">待处理（24h）</div>
            </div>
          );
        })}
      </div>
      <div className="card">
        <div className="filter-bar">
          <h3 style={{ margin: 0 }}>异常工单</h3>
          <span style={{ flex: 1 }} />
          {[['', '全部'], ['open', '待处理'], ['notified', '已通知'], ['resolved', '已解决']].map(([v, l]) => (
            <button key={v} className={`btn sm ${status === v ? '' : 'gray'}`} onClick={() => setStatus(v)}>{l}</button>
          ))}
        </div>
        {(tickets ?? []).length === 0 && <div className="empty">当前没有工单</div>}
        {(tickets ?? []).map((t) => (
          <div key={t.id} className={`ticket-card ${t.status}`}>
            <div className="ticket-head">
              <span className="ticket-title">{t.label} <span className="mono small muted">{t.code}</span></span>
              <span className="btn-row"><span className="mono">{t.plate ?? '车牌待核'}</span><Tag status={t.status} /></span>
            </div>
            <div className="ticket-desc">{t.description}</div>
            <div className="small muted">
              {dt(t.created_at)} · {t.community_name} {t.spot_code ?? ''} {t.reservation_code ? `· 订单 ${t.reservation_code}` : ''}
            </div>
            {t.resolution && <div className="small" style={{ marginTop: 4 }}>处置结果：{t.resolution}</div>}
            <div className="btn-row" style={{ marginTop: 8 }}>
              {['open', 'notified'].includes(t.status) && (
                <>
                  <button className="btn sm ghost" onClick={() => notify(t)}>📨 派发挪车通知</button>
                  <button className="btn sm success" onClick={() => resolve(t)}>处置完成</button>
                  <button className="btn sm gray" onClick={() => setOpenNotices(t)}>通知记录</button>
                </>
              )}
              {t.status === 'resolved' && <button className="btn sm gray" onClick={() => setOpenNotices(t)}>通知记录</button>}
            </div>
          </div>
        ))}
      </div>
      {openNotices && <NoticesModal ticket={openNotices} onClose={() => setOpenNotices(null)} />}
      {swapOpen && (
        <SpotSwapModal
          onClose={() => setSwapOpen(false)}
          onDone={(m: string) => { setSwapOpen(false); setMsg(m); reload(); }}
        />
      )}
    </div>
  );
}

// 换位调度：把进行中订单协调到相邻车位，费用按实际占用连续计算并进入财务页费用来源
function SpotSwapModal({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const { data: orders } = useLoader<any[]>('/reservations');
  const { data: spots } = useLoader<any[]>('/spots');
  const active = (orders ?? []).filter((o) => ['admitted', 'in_garage'].includes(o.status));
  const [reservationId, setReservationId] = useState<number | ''>('');
  const [toSpotId, setToSpotId] = useState<number | ''>('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const order = active.find((o) => o.id === reservationId);
  const targets = (spots ?? []).filter((s: any) => s.review_status === 'approved' && s.id !== order?.spot_id);

  const submit = async () => {
    setErr(''); setBusy(true);
    try {
      const r = await api('POST', '/dispatch/spot-swap', {
        reservation_id: reservationId,
        to_spot_id: toSpotId,
        reason: reason || undefined,
      });
      onDone(`换位调度完成：${r.from_spot} → ${r.to_spot}，挪车通知已推送车主，费用按实际占用连续计算`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head"><h3>换位调度（进行中订单换车位）</h3><button className="close-x" onClick={onClose}>×</button></div>
        <div className="modal-body">
          {err && <div className="alert error">{err}</div>}
          {active.length === 0 && <div className="empty">当前没有进行中的订单</div>}
          <div className="field">
            <label>进行中订单</label>
            <select value={reservationId} onChange={(e) => setReservationId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">请选择订单</option>
              {active.map((o: any) => (
                <option key={o.id} value={o.id}>{o.code} · {o.spot_code} · {o.plate}（{o.driver_name}）</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>换位至目标车位</label>
            <select value={toSpotId} onChange={(e) => setToSpotId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">请选择车位</option>
              {targets.map((s: any) => (
                <option key={s.id} value={s.id}>{s.community_name} · {s.code}（{s.location_desc}）</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>换位原因</label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：原车位地锁故障 / 业主临时回家协调至相邻车位" />
          </div>
          <div className="alert info">换位后订单延续不换单：费用按实际占用时段连续计算，换位事件将标注在财务页该时段的费用来源中。</div>
        </div>
        <div className="modal-foot">
          <button className="btn gray" onClick={onClose}>取消</button>
          <button className="btn" disabled={busy || !reservationId || !toSpotId} onClick={submit}>{busy ? '提交中…' : '确认换位'}</button>
        </div>
      </div>
    </div>
  );
}

function NoticesModal({ ticket, onClose }: { ticket: any; onClose: () => void }) {
  const [items, setItems] = useState<any[] | null>(null);
  useEffect(() => {
    api('GET', `/dispatch/incidents/${ticket.id}/notices`).then(setItems);
  }, [ticket.id]);
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head"><h3>挪车通知记录 · {ticket.code}</h3><button className="close-x" onClick={onClose}>×</button></div>
        <div className="modal-body">
          {!items ? <div className="empty">加载中…</div> : items.length === 0 ? <div className="empty">尚未发送通知</div> : (
            items.map((n) => (
              <div key={n.id} className="ticket-card resolved">
                <div className="ticket-head"><span className="mono">{n.target_plate}</span><Tag cls="blue" label={n.channel} /></div>
                <div className="ticket-desc">{n.message}</div>
                <div className="small muted">送达 {dt(n.delivered_at)}{n.acknowledged_at ? ` · 确认 ${dt(n.acknowledged_at)}` : ' · 未确认'}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- 巡查登记 ----------
function PatrolTab() {
  const { data: spots } = useLoader<any[]>('/spots');
  const { data: logs, reload } = useLoader<any[]>('/operations/patrol');
  const [spotId, setSpotId] = useState<number | ''>('');
  const [plate, setPlate] = useState('');
  const [finding, setFinding] = useState<'normal' | 'stranger' | 'wrong_park' | 'ice_on_charger'>('stranger');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const submit = async () => {
    setErr('');
    if (!spotId) { setErr('请选择巡查车位'); return; }
    try {
      const r = await api('POST', '/operations/patrol', {
        spot_id: spotId, plate: plate || undefined, finding, note: note || undefined,
        media_url: `evidence/patrol-${Date.now()}.jpg`,
      });
      setMsg(`巡查已登记${r.ticket_id ? '，并自动生成异常工单' : ''}`);
      setPlate(''); setNote('');
      reload();
    } catch (e: any) { setErr(e.message); }
  };

  const FINDINGS = [
    { v: 'normal', l: '正常', c: 'green' },
    { v: 'stranger', l: '陌生车辆占用', c: 'red' },
    { v: 'wrong_park', l: '车主停错车位', c: 'amber' },
    { v: 'ice_on_charger', l: '燃油车占充电位', c: 'purple' },
  ] as const;

  return (
    <div>
      <PageHead title="物业巡查登记" desc="夜巡发现陌生车、错停或燃油车占用充电位时登记，照片自动进入相关申诉的证据链" />
      {msg && <div className="alert ok">{msg}</div>}
      {err && <div className="alert error">{err}</div>}
      <div className="grid grid-2">
        <div className="card">
          <h3>现场登记</h3>
          <div className="field">
            <label>巡查车位</label>
            <select value={spotId} onChange={(e) => setSpotId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">请选择车位</option>
              {(spots ?? []).map((s: any) => (
                <option key={s.id} value={s.id}>{s.community_name} · {s.code}（{s.location_desc}）</option>
              ))}
            </select>
          </div>
          <div className="field"><label>现场车牌（如有）</label><input className="mono" value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} /></div>
          <div className="field">
            <label>巡查发现</label>
            <div className="btn-row">
              {FINDINGS.map((f) => (
                <button key={f.v} className={`btn sm ${finding === f.v ? '' : 'gray'}`} style={finding === f.v ? undefined : undefined} onClick={() => setFinding(f.v as any)}>{f.l}</button>
              ))}
            </div>
          </div>
          <div className="field"><label>情况说明 / 现场照片附件名</label><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：夜间巡查发现非预约燃油车停放在 B2-108 充电位，已拍照" /></div>
          <button className="btn" onClick={submit}>提交巡查记录</button>
        </div>
        <div className="card">
          <h3>近期巡查档案</h3>
          {(logs ?? []).length === 0 && <div className="empty">暂无巡查记录</div>}
          {(logs ?? []).map((p) => (
            <div key={p.id} className="ticket-card resolved">
              <div className="ticket-head">
                <span className="ticket-title">车位 #{p.spot_id} {p.plate ? `· ${p.plate}` : ''}</span>
                <span className="small muted">{p.guard_name} · {dt(p.patrolled_at)}</span>
              </div>
              <div className="ticket-desc">{p.note}</div>
              {p.media_url && <div className="small muted">📎 {p.media_url}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- 申诉裁决 ----------
function AppealsTab() {
  const { data: appeals, reload } = useLoader<any[]>('/appeals');
  const [open, setOpen] = useState<number | null>(null);
  const [filter, setFilter] = useState<'open' | 'closed' | ''>('');
  const list = (appeals ?? []).filter((a) => (filter ? a.status === filter || (filter === 'closed' && a.status === 'closed') : true));

  return (
    <div>
      <PageHead title="错停申诉裁决" desc="系统已基于六类证据给出责任建议；物业可直接采纳或人工改判，终裁后可一键重算分账与信用" />
      <div className="card">
        <div className="filter-bar">
          <h3 style={{ margin: 0 }}>申诉列表</h3>
          <span style={{ flex: 1 }} />
          {[['', '全部'], ['open', '待裁决'], ['closed', '已终裁']].map(([v, l]) => (
            <button key={v} className={`btn sm ${filter === v ? '' : 'gray'}`} onClick={() => setFilter(v as any)}>{l}</button>
          ))}
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>申诉单</th><th>车主</th><th>车位/车牌</th><th>事由</th><th>状态</th><th></th></tr></thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td className="mono small">{a.code}<div className="small muted">{dt(a.created_at)}</div></td>
                  <td>{a.appellant_name}</td>
                  <td>{a.spot_code}<div className="small muted mono">{a.reservation_code} · {a.plate}</div></td>
                  <td className="small" style={{ maxWidth: 280 }}>{a.reason}</td>
                  <td><Tag status={a.status === 'closed' ? 'closed' : 'investigating'} /></td>
                  <td><button className="btn sm" onClick={() => setOpen(a.id)}>{a.status === 'closed' ? '查看/重算' : '裁决'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {open && <AppealDetailModal id={open} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

// ---------- 退款审核（按道闸/巡查/离场时间校验结果审批）----------
function RefundReviewTab() {
  const { data: refunds, reload } = useLoader<any[]>('/refund-requests');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const review = async (f: any, approve: boolean) => {
    setErr(''); setMsg('');
    const note = approve ? '校验属实，同意退款' : (prompt('驳回原因', '证据不足，退款申请驳回') ?? undefined);
    if (!approve && note === undefined) return;
    try {
      const r = await api('POST', `/refund-requests/${f.id}/review`, { approve, note });
      setMsg(
        r.status === 'approved'
          ? `退款单 ${f.code} 已核准 ${r.validated_amount} 元（托管账户 → 车主）`
          : `退款单 ${f.code} 已驳回${r.validation?.maxRefundable <= 0 ? '（重复冲销校验：可退余额为 0）' : ''}`,
      );
      reload();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const pending = (refunds ?? []).filter((f) => f.status === 'pending');
  const done = (refunds ?? []).filter((f) => f.status !== 'pending');

  return (
    <div>
      <PageHead title="退款审核" desc="系统已按道闸记录、物业巡查与离场时间校验可退金额；超额申请自动截断，可退余额为 0 自动拒绝（避免重复冲销）" />
      {msg && <div className="alert ok">{msg}</div>}
      {err && <div className="alert error">{err}</div>}
      <div className="card">
        <h3>待审核 <span className="hint">{pending.length} 笔</span></h3>
        {pending.length === 0 && <div className="empty">没有待审核的退款申请</div>}
        {pending.map((f) => (
          <div key={f.id} className="ticket-card notified">
            <div className="ticket-head">
              <span className="ticket-title">{f.code} · {f.driver_name} 申请 {money(f.requested_amount)}</span>
              <Tag cls="amber" label={`系统校验可退上限 ${money(f.validated_amount)}`} />
            </div>
            <div className="ticket-desc">{f.reason || '（未填写理由）'} · 订单 {f.reservation_code} · {f.spot_code} · {f.plate}</div>
            <div style={{ margin: '8px 0' }}>
              {(f.checks ?? []).map((c: any, i: number) => (
                <div key={i} className="small" style={{ padding: '3px 0', display: 'flex', gap: 8 }}>
                  <Tag cls={c.passed ? 'green' : 'red'} label={c.passed ? '通过' : '未通过'} />
                  <span><b>{c.label}</b>：<span className="muted">{c.detail}</span></span>
                </div>
              ))}
            </div>
            <div className="btn-row">
              <button className="btn sm success" onClick={() => review(f, true)}>按校验上限核准退款</button>
              <button className="btn sm danger" onClick={() => review(f, false)}>驳回</button>
            </div>
          </div>
        ))}
      </div>
      <div className="card">
        <h3>已处理</h3>
        {done.length === 0 && <div className="empty">暂无</div>}
        <div className="table-wrap">
          <table>
            <thead><tr><th>退款单</th><th>车主/订单</th><th>申请</th><th>核准</th><th>状态</th><th>审批说明</th><th>时间</th></tr></thead>
            <tbody>
              {done.map((f) => (
                <tr key={f.id}>
                  <td className="mono small">{f.code}</td>
                  <td className="small">{f.driver_name}<div className="small muted mono">{f.reservation_code}</div></td>
                  <td className="money">{money(f.requested_amount)}</td>
                  <td className="money">{f.status === 'approved' ? money(f.validated_amount) : '—'}</td>
                  <td><Tag status={f.status} /></td>
                  <td className="small" style={{ maxWidth: 260 }}>{f.review_note ?? '—'}</td>
                  <td className="small muted">{dt(f.reviewed_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------- 订单追溯 ----------
function OrdersTab() {
  const { data: orders } = useLoader<any[]>('/reservations');
  const [detail, setDetail] = useState<number | null>(null);
  return (
    <div>
      <PageHead title="全部停车服务单" desc="覆盖车位发布、预约、入场、异常、离场、分账的完整事件链，供业主/车主/物业共同追溯" />
      <div className="card">
        <OrderTable orders={orders ?? []} onOpen={setDetail} />
      </div>
      {detail && <ReservationDetailModal id={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
