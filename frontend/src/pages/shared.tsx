import { useEffect, useState } from 'react';
import { api } from '../api';
import { AdjudicationPanel, EvidenceList, LedgerTable, ServiceEvents, SettlementView, TimelineView } from '../components';
import { dt, INCIDENT_LABEL, money, Modal, RulingTag, Tag } from '../ui';

// 订单全链路追溯弹层：预约信息 + 事件流 + 异常工单 + 申诉 + 分账 + 同车位时间轴入口
export function ReservationDetailModal({ id, onClose }: { id: number; onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<'trace' | 'settlement' | 'timeline'>('trace');
  const [timeline, setTimeline] = useState<any>(null);

  useEffect(() => {
    api('GET', `/reservations/${id}`).then(setD).catch((e) => setErr(e.message));
  }, []);

  if (err) return <Modal title="订单详情" onClose={onClose}><div className="alert error">{err}</div></Modal>;
  if (!d) return <Modal title="加载中…" onClose={onClose}><div className="empty">加载中…</div></Modal>;

  const loadTimeline = async () => {
    if (timeline) { setTab('timeline'); return; }
    const t = await api('GET', `/spots/${d.spot_id}/timeline`);
    setTimeline(t);
    setTab('timeline');
  };

  return (
    <Modal
      wide
      title={
        <div className="btn-row" style={{ justifyContent: 'space-between', width: '100%', paddingRight: 12 }}>
          <span>停车服务单 {d.code}</span>
          <span className="btn-row">
            <Tag status={d.status} />
            {d.priority === 'monthly' && <Tag status="monthly" />}
            <RulingTag ruling={d.settlement?.ruling} />
          </span>
        </div>
      }
      onClose={onClose}
    >
      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Info label="车位" value={`${d.community_name} · ${d.spot_code}`} />
        <Info label="车牌" value={d.plate} mono />
        <Info label="车主" value={d.driver_name} />
        <Info label="业主" value={d.owner_name} />
        <Info label="预约时段" value={`${dt(d.start_at)}\n~ ${dt(d.end_at)}`} pre />
        <Info label="入场道闸" value={d.gate_entry_at ? dt(d.gate_entry_at) : '—'} />
        <Info label="停放确认" value={d.parking_confirmed_at ? dt(d.parking_confirmed_at) : '—'} />
        <Info label="离场结算" value={d.settled_at ? dt(d.settled_at) : '—'} />
      </div>

      <div className="btn-row" style={{ marginBottom: 14 }}>
        <button className={`btn sm ${tab === 'trace' ? '' : 'gray'}`} onClick={() => setTab('trace')}>全链路事件 ({d.events.length})</button>
        <button className={`btn sm ${tab === 'settlement' ? '' : 'gray'}`} onClick={() => setTab('settlement')}>
          分账清算 {d.settlement ? money(d.settlement.payable) : '（未结算）'}
        </button>
        <button className={`btn sm ${tab === 'timeline' ? '' : 'gray'}`} onClick={loadTimeline}>同车位当晚时间轴</button>
        <span style={{ flex: 1 }} />
        <span className="small muted">异常工单 {d.incidents.length} · 申诉 {d.appeals.length}</span>
      </div>

      {tab === 'trace' && (
        <div className="grid grid-2">
          <div>
            <h3 style={{ fontSize: 14, marginBottom: 8 }}>同一笔停车服务事件流</h3>
            <ServiceEvents events={d.events} />
          </div>
          <div>
            <h3 style={{ fontSize: 14, marginBottom: 8 }}>夜间异常与挪车通知</h3>
            {d.incidents.length === 0 && <div className="empty">本单无异常工单</div>}
            {d.incidents.map((t: any) => (
              <div key={t.id} className={`ticket-card ${t.status}`}>
                <div className="ticket-head">
                  <span className="ticket-title">{INCIDENT_LABEL[t.type] ?? t.type}</span>
                  <Tag status={t.status} />
                </div>
                <div className="ticket-desc">{t.description}</div>
                {t.resolution && <div className="small">处置：{t.resolution}</div>}
              </div>
            ))}
            <h3 style={{ fontSize: 14, margin: '14px 0 8px' }}>错停申诉</h3>
            {d.appeals.length === 0 && <div className="empty">本单无申诉</div>}
            {d.appeals.map((a: any) => (
              <div key={a.id} className="ticket-card investigating">
                <div className="ticket-head">
                  <span className="ticket-title">{a.code}</span>
                  <RulingTag ruling={a.ruling} />
                </div>
                <div className="ticket-desc">{a.reason}</div>
                <div className="small muted">{a.ruling_note ?? '调查中，等待物业终裁'}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'settlement' && (
        d.settlement ? <SettlementWithLedger id={d.id} /> : <div className="empty">订单尚未离场结算</div>
      )}

      {tab === 'timeline' && (timeline ? <TimelineView data={timeline} /> : <div className="empty">加载中…</div>)}
    </Modal>
  );
}

function SettlementWithLedger({ id }: { id: number }) {
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    api('GET', `/reservations/${id}/settlement`).then((r) => setS(r ? { ...r, ledger: r.ledger ?? [] } : null));
  }, []);
  if (!s) return <div className="empty">加载中…</div>;
  return (
    <div>
      <SettlementView s={s} />
      {!s.ledger?.length && <LedgerTable entries={s.ledger} />}
    </div>
  );
}

function Info({ label, value, mono, pre }: { label: string; value: any; mono?: boolean; pre?: boolean }) {
  return (
    <div>
      <div className="small muted">{label}</div>
      <div style={{ whiteSpace: pre ? 'pre-line' : undefined }} className={mono ? 'mono' : ''}>{value}</div>
    </div>
  );
}

// 申诉详情（裁决工作台共用）
export function AppealDetailModal({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged?: () => void }) {
  const [d, setD] = useState<any>(null);
  const [ruling, setRuling] = useState('');
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    api('GET', `/appeals/${id}`).then((x) => {
      setD(x);
      setRuling(x.adjudication?.ruling ?? '');
    }).catch((e) => setErr(e.message));
  }, []);

  if (err) return <Modal title="申诉详情" onClose={onClose}><div className="alert error">{err}</div></Modal>;
  if (!d) return <Modal title="加载中…" onClose={onClose}><div className="empty">加载中…</div></Modal>;

  const submitRule = async () => {
    setErr(''); setMsg('');
    try {
      await api('POST', `/appeals/${id}/rule`, { ruling, note });
      setMsg('终裁已提交，可在结算页重算分账');
      onChanged?.();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const resettle = async () => {
    setErr('');
    try {
      const r = await api('POST', `/appeals/${id}/resettle`, {});
      if (r.idempotent) {
        setMsg('当前分账已按该终裁口径落账，无需再次冲正（幂等返回，无重复冲销）');
      } else {
        setMsg(`已生成冲正单 ${r.reversal?.code ?? ''}：原分账红字冲销保留、按终裁重做一版，信用分已净调整`);
      }
      onChanged?.();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  return (
    <Modal wide title={<span>错停申诉裁决 · {d.code} <RulingTag ruling={d.ruling} /></span>} onClose={onClose}>
      <div className="grid grid-2">
        <div>
          <div className="card" style={{ marginTop: 0 }}>
            <h3>申诉内容</h3>
            <div className="small muted">{d.appellant_name} · {d.plate} · 车位 {d.spot_code} · {dt(d.created_at)}</div>
            <p>{d.reason}</p>
            {d.ruling_note && <div className="alert info">终裁说明：{d.ruling_note}</div>}
          </div>
          <div className="card">
            <h3>证据链 <span className="hint">车牌识别 / 预约 / 照片 / 道闸日志 / 业主回家 / 巡查</span></h3>
            <EvidenceList items={d.evidence} />
          </div>
        </div>
        <div>
          <div className="card" style={{ marginTop: 0 }}>
            <h3>自动责任分析</h3>
            <AdjudicationPanel a={d.adjudication} />
          </div>
          <div className="card">
            <h3>人工终裁</h3>
            {msg && <div className="alert ok">{msg}</div>}
            {err && <div className="alert error">{err}</div>}
            {d.status === 'closed' ? (
              <div>
                <div className="alert info">该申诉已终裁：<RulingTag ruling={d.ruling} /></div>
                <button className="btn" onClick={resettle}>按终裁结果重算离场分账与信用分</button>
              </div>
            ) : (
              <div>
                <div className="field">
                  <label>裁决结论（默认采纳系统建议）</label>
                  <select value={ruling} onChange={(e) => setRuling(e.target.value)}>
                    <option value="driver_fault">车主责任（违约金 + 信用 -10）</option>
                    <option value="owner_fault">业主责任（补偿车主 + 业主信用 -5）</option>
                    <option value="property_fault">物业责任（赔付券 + 物业信用 -5）</option>
                    <option value="platform_fault">平台责任（免单/赔付券）</option>
                    <option value="stranger">陌生车主责任（平台兜底，向其追缴）</option>
                    <option value="mixed">混合责任（车主信用 -5）</option>
                    <option value="no_fault">无责/证据不足</option>
                  </select>
                </div>
                <div className="field">
                  <label>裁决说明</label>
                  <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="说明证据采信与责任划分依据" />
                </div>
                <button className="btn danger" onClick={submitRule}>提交终裁</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
