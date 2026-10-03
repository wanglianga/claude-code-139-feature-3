import { dt, EVIDENCE_LABEL, hm, money, RulingTag, Tag } from './ui';

// ---------- 分账明细 ----------
export function SettlementView({ s }: { s: any }) {
  if (!s) return <div className="empty">暂无结算记录</div>;
  const rows: [string, any, string?][] = [
    ['基础停车费', s.base_fee],
    ['充电服务费', s.charging_fee],
    ['访客超时费', s.overtime_fee],
    ['错停违约金', s.wrong_park_fine],
    ['优惠券抵扣', s.coupon_discount],
    ['异常补偿（现金+赔付券）', s.abnormal_compensation],
    ['其中赔付券（非现金）', s.coupon_compensation],
    ['业主补偿', s.owner_compensation],
    ['预约预付', s.prepaid],
  ];
  return (
    <div>
      <div className="fee-grid">
        {rows.map(([label, v]) => (
          <div className="row" key={label}>
            <span className="muted">{label}</span>
            <span className="money">{money(v)}</span>
          </div>
        ))}
        <div className="row"><span>离场补缴</span><span className="money pos">{money(s.exit_charge)}</span></div>
        <div className="row"><span>离场退款</span><span className="money neg">{money(s.refund)}</span></div>
        <div className="row total"><span>车主本次应付</span><span className="money">{money(s.payable)}</span></div>
        <div className="row total"><span>计费时长</span><span>{s.duration_minutes} 分钟</span></div>
      </div>

      <div style={{ height: 14 }} />
      <div className="grid grid-3">
        <MiniStat label="业主收益 70%" value={money(s.owner_income)} />
        <MiniStat label="物业服务费 10%" value={money(s.property_fee)} />
        <MiniStat label="平台抽成 20%" value={money(s.platform_fee)} />
      </div>
      <div style={{ height: 10 }} />
      <div className="btn-row">
        <RulingTag ruling={s.ruling} />
        {s.detail?.cross_day && <Tag cls="purple" label="跨日分账" />}
        {Number(s.credit_delta) !== 0 && (
          <Tag cls={Number(s.credit_delta) < 0 ? 'red' : 'green'}
            label={`信用 ${s.credit_target === 'driver' ? '车主' : s.credit_target === 'owner' ? '业主' : '物业'} ${s.credit_delta > 0 ? '+' : ''}${s.credit_delta}`} />
        )}
        <span className="small muted">{dt(s.created_at)} 结算 · {s.code}</span>
      </div>
      {s.detail?.notes?.length > 0 && (
        <div className="alert info" style={{ marginTop: 12 }}>
          <b>清算说明：</b>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {s.detail.notes.map((n: string, i: number) => <li key={i}>{n}</li>)}
          </ul>
        </div>
      )}
      <DaySegmentsTable segments={s.day_segments} />
      {s.reversals?.length > 0 && (
        <div className="alert info" style={{ marginTop: 12 }}>
          <b>关联冲正单：</b>
          {s.reversals.map((rv: any) => (
            <div key={rv.id} className="small" style={{ marginTop: 4 }}>
              <Tag cls="red" label="冲正" /> <span className="mono">{rv.code}</span>：申诉 {rv.appeal_code} 成立后红冲原分账
              <span className="mono"> {rv.settlement_code}</span>，当前有效分账为本单（{rv.new_settlement_code}） · {dt(rv.created_at)}
            </div>
          ))}
        </div>
      )}
      <LedgerTable entries={s.ledger} />
    </div>
  );
}

// ---------- 跨日分账：按结算日拆分的费用段与费用来源 ----------
const SOURCE_TAG: Record<string, { label: string; cls: string }> = {
  coupon: { label: '优惠券', cls: 'green' },
  manual_release: { label: '人工放行', cls: 'purple' },
  spot_swap: { label: '换位调度', cls: 'cyan' },
  owner_return: { label: '业主回家', cls: 'amber' },
  stranger_occupy: { label: '异常占用', cls: 'red' },
  weak_signal: { label: '信号差', cls: 'amber' },
  wrong_parking: { label: '错停核验', cls: 'red' },
  overstay: { label: '访客超时', cls: 'amber' },
  charging: { label: '充电服务', cls: 'green' },
};

export function DaySegmentsTable({ segments }: { segments: any[] }) {
  if (!segments?.length) return null;
  const crossDay = segments.length > 1;
  const pick = (g: any, snake: string, camel: string) => g[snake] ?? g[camel];
  return (
    <div style={{ marginTop: 14 }}>
      <h3 style={{ fontSize: 14, marginBottom: 8 }}>
        分日段拆分
        <Tag cls={crossDay ? 'purple' : 'gray'} label={crossDay ? `跨 ${segments.length} 个结算日` : '单结算日'} />
        <span className="hint">凌晨离场跨结算日时，按实际占用时段拆分业主收益与物业服务费</span>
      </h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>结算日</th><th>占用时段</th><th>分钟</th><th>基础费</th><th>充电费</th><th>超时费</th>
              <th>业主收益</th><th>物业费</th><th>平台</th><th>费用来源</th>
            </tr>
          </thead>
          <tbody>
            {segments.map((g, i) => {
              const sources = g.sources ?? [];
              return (
                <tr key={i}>
                  <td className="mono small">{String(pick(g, 'settlement_date', 'settlementDate')).slice(0, 10)}</td>
                  <td className="small mono">{hm(pick(g, 'from_at', 'from'))}–{hm(pick(g, 'to_at', 'to'))}</td>
                  <td>{g.minutes}</td>
                  <td className="money">{money(pick(g, 'base_fee', 'baseFee'))}</td>
                  <td className="money">{money(pick(g, 'charging_fee', 'chargingFee'))}</td>
                  <td className="money">{money(pick(g, 'overtime_fee', 'overtimeFee'))}</td>
                  <td className="money">{money(pick(g, 'owner_income', 'ownerIncome'))}</td>
                  <td className="money">{money(pick(g, 'property_fee', 'propertyFee'))}</td>
                  <td className="money">{money(pick(g, 'platform_fee', 'platformFee'))}</td>
                  <td className="small" style={{ minWidth: 180 }}>
                    {sources.length === 0 && <span className="muted">—</span>}
                    {sources.map((src: any, j: number) => (
                      <div key={j} style={{ marginBottom: 2 }}>
                        <Tag cls={SOURCE_TAG[src.type]?.cls ?? 'gray'} label={SOURCE_TAG[src.type]?.label ?? src.type} />
                        {' '}<span className="small">{src.label}</span>
                      </div>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat" style={{ padding: '12px 14px' }}>
      <div className="label">{label}</div>
      <div className="value" style={{ fontSize: 20 }}>{value}</div>
    </div>
  );
}

const ACCOUNT_LABEL: Record<string, string> = {
  driver: '车主',
  escrow: '平台托管账户',
  property: '物业',
  platform: '平台',
  coupon_pool: '优惠券资金池',
};

export function accountLabel(a: string) {
  if (a.startsWith('owner:')) return `业主账户（${a.slice(6)}）`;
  return ACCOUNT_LABEL[a] ?? a;
}

export function LedgerTable({ entries }: { entries: any[] }) {
  if (!entries?.length) return null;
  const debit = entries.filter((e) => e.direction === 'debit').reduce((a, b) => a + Number(b.amount), 0);
  const credit = entries.filter((e) => e.direction === 'credit').reduce((a, b) => a + Number(b.amount), 0);
  return (
    <div style={{ marginTop: 14 }}>
      <h3 style={{ fontSize: 14, marginBottom: 8 }}>资金流水（借 {money(debit)} / 贷 {money(credit)}）</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>账户</th><th>方向</th><th>金额</th><th>摘要</th></tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={i}>
                <td>{accountLabel(e.account)}</td>
                <td>
                  <Tag cls={e.direction === 'debit' ? 'amber' : 'green'} label={e.direction === 'debit' ? '借方' : '贷方'} />
                  {e.reversal_id != null && <Tag cls="red" label="冲正" />}
                  {e.refund_request_id != null && <Tag cls="cyan" label="退款单" />}
                </td>
                <td className="money">{money(e.amount)}</td>
                <td className="small">{e.memo}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- 车位一晚时间轴 ----------
const KIND_LABEL: Record<string, string> = {
  driver: '车主使用',
  owner: '业主自用',
  stranger: '陌生车占用',
  idle: '空档',
  gap: '等待/受阻',
};

export function TimelineView({ data }: { data: any }) {
  if (!data) return null;
  return (
    <div>
      <div className="small muted" style={{ marginBottom: 10 }}>
        审计窗口：{dt(data.night_start)} ~ {dt(data.night_end)} · 共 {data.segments.length} 个时间段 · {data.orders.length} 笔预约
      </div>
      <div className="tl">
        {data.segments.map((seg: any, i: number) => (
          <div key={i} className={`tl-seg ${seg.occupantKind}`}>
            <div className="tl-time">
              {hm(seg.from)}<br />– {hm(seg.to)}
              <div className="muted">{seg.minutes} 分钟</div>
            </div>
            <div className="tl-body">
              <div className="tl-title">
                <span>{seg.occupant}</span>
                <Tag cls="gray" label={KIND_LABEL[seg.occupantKind] ?? seg.occupantKind} />
                <Tag status={undefined} label={seg.status} cls={
                  seg.occupantKind === 'stranger' ? 'red' :
                  seg.occupantKind === 'owner' ? 'purple' :
                  seg.occupantKind === 'gap' ? 'amber' :
                  seg.occupantKind === 'driver' ? 'blue' : 'gray'
                } />
                {seg.plate && <span className="mono small muted">{seg.plate}</span>}
                {seg.reservationId && <span className="small muted">订单 #{seg.reservationId}</span>}
              </div>
              <dl className="tl-meta">
                <dt>谁付款</dt><dd>{seg.payer}</dd>
                <dt>谁担责</dt><dd>{seg.liability}</dd>
                {seg.note && <><dt>备注</dt><dd>{seg.note}</dd></>}
              </dl>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- 证据链 ----------
const SOURCE_META: Record<string, { icon: string; cls: string }> = {
  plate_recognition: { icon: '📷', cls: 'blue' },
  reservation: { icon: '📋', cls: 'gray' },
  photo: { icon: '🖼️', cls: 'purple' },
  gate_log: { icon: '🚧', cls: 'cyan' },
  owner_home: { icon: '🏠', cls: 'amber' },
  patrol: { icon: '🔦', cls: 'green' },
  appeal_statement: { icon: '🗣️', cls: 'gray' },
  signal: { icon: '📶', cls: 'red' },
};

export function EvidenceList({ items }: { items: any[] }) {
  if (!items?.length) return <div className="empty">暂无证据</div>;
  return (
    <div>
      {items.map((e, i) => {
        const meta = SOURCE_META[e.source] ?? { icon: '📄', cls: 'gray' };
        return (
          <div className="evidence-item" key={i}>
            <div className={`evidence-icon tag ${meta.cls}`} style={{ borderRadius: 8 }}>{meta.icon}</div>
            <div style={{ flex: 1 }}>
              <div className="btn-row" style={{ justifyContent: 'space-between' }}>
                <b>{e.title}</b>
                <span className="tag gray">{EVIDENCE_LABEL[e.source] ?? e.source}</span>
              </div>
              <div className="small" style={{ marginTop: 4 }}>{e.content}</div>
              <div className="small muted" style={{ marginTop: 4 }}>
                {e.captured_at ? dt(e.captured_at) : ''} {e.media_url ? `· 附件 ${e.media_url}` : ''}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const RULING_COLOR: Record<string, string> = {
  driver_fault: '#cf3333',
  owner_fault: '#b76b00',
  platform_fault: '#6d3bd1',
  property_fault: '#0a7ea4',
  stranger: '#cf3333',
  mixed: '#b76b00',
  no_fault: '#8a94a6',
};
const RULING_NAME: Record<string, string> = {
  driver_fault: '车主',
  owner_fault: '业主',
  platform_fault: '平台',
  property_fault: '物业',
  stranger: '陌生车主',
  mixed: '混合',
  no_fault: '存疑/无责',
};

export function AdjudicationPanel({ a }: { a: any }) {
  if (!a) return null;
  const max = Math.max(0.1, ...Object.values(a.scorecard ?? {}).map(Number));
  return (
    <div>
      <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <div className="btn-row">
          <RulingTag ruling={a.ruling} />
          <span className="tag gray">置信度 {Math.round(Number(a.confidence) * 100)}%</span>
        </div>
        <span className="small muted">系统综合车牌识别 / 预约 / 照片 / 道闸 / 业主回家 / 巡查证据自动给出，物业可人工改判</span>
      </div>
      <div style={{ marginBottom: 12 }}>
        {Object.entries(a.scorecard ?? {}).map(([k, v]) => (
          <div className="score-bar" key={k}>
            <span className="name">{RULING_NAME[k] ?? k}</span>
            <span className="track"><span className="fill" style={{ width: `${(Number(v) / max) * 100}%`, background: RULING_COLOR[k] }} /></span>
            <span className="val">{Number(v).toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="alert info">
        <b>裁决理由：</b>
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {(a.reasons ?? []).map((r: string, i: number) => <li key={i}>{r}</li>)}
        </ul>
      </div>
      <details>
        <summary className="small muted" style={{ cursor: 'pointer' }}>证据时间线（{a.evidenceTimeline?.length ?? 0}）</summary>
        <div style={{ marginTop: 8 }}>
          {(a.evidenceTimeline ?? []).map((e: any, i: number) => (
            <div key={i} className="small" style={{ padding: '3px 0' }}>
              <span className="muted">{e.at ? dt(e.at) : '—'}</span>
              {' '}<span className="tag gray" style={{ marginRight: 6 }}>{EVIDENCE_LABEL[e.source] ?? e.source}</span>
              {e.content}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

// ---------- 订单全链路事件 ----------
const EVENT_LABEL: Record<string, string> = {
  spot_published: '车位发布',
  spot_review_approved: '物业审核通过',
  spot_review_rejected: '物业审核驳回',
  reservation_created: '预约创建',
  reservation_cancelled: '预约取消',
  gate_entry: '道闸识别入场',
  manual_release: '物业人工放行',
  recognition_fail: '车牌识别失败',
  move_notice_sent: '挪车通知送达',
  weak_signal_report: '信号差上报',
  parking_confirmed: '停放确认',
  wrong_parking_detected: '错停核验',
  owner_return_report: '业主回家上报',
  overstay_warning: '超时预警',
  patrol_log: '物业巡查',
  incident_resolved: '异常工单处置',
  appeal_submitted: '发起错停申诉',
  appeal_ruled: '申诉终裁',
  settlement_completed: '离场结算完成',
  settlement_recomputed: '分账重算',
  credit_adjusted: '信用调整',
  monthly_priority_conflict: '月租优先冲突',
  spot_swap: '换位调度',
  charging_session: '充电会话',
  refund_requested: '退款申请',
  refund_approved: '退款到账',
  refund_rejected: '退款驳回',
};

const EVENT_COLOR: Record<string, string> = {
  recognition_fail: 'red', wrong_parking_detected: 'red', overstay_warning: 'amber',
  owner_return_report: 'amber', weak_signal_report: 'amber', move_notice_sent: 'amber',
  gate_entry: 'cyan', parking_confirmed: 'green', settlement_completed: 'blue',
  appeal_ruled: 'purple', manual_release: 'purple', incident_resolved: 'green',
  spot_swap: 'cyan', charging_session: 'green', refund_requested: 'amber',
  refund_approved: 'green', refund_rejected: 'red',
};

export function ServiceEvents({ events }: { events: any[] }) {
  if (!events?.length) return <div className="empty">暂无事件</div>;
  return (
    <div className="tl">
      {events.map((e, i) => (
        <div key={i} className="tl-seg driver">
          <div className="tl-time">{dt(e.occurred_at)}</div>
          <div className="tl-body" style={{ borderLeftColor: 'var(--ink-3)' }}>
            <div className="tl-title">
              <Tag cls={EVENT_COLOR[e.type] ?? 'gray'} label={EVENT_LABEL[e.type] ?? e.type} />
              {e.plate && <span className="mono small muted">{e.plate}</span>}
              {e.gate && <span className="small muted">@{e.gate}</span>}
            </div>
            {e.detail && Object.keys(e.detail).length > 0 && (
              <div className="small muted mono" style={{ marginTop: 4 }}>{JSON.stringify(e.detail)}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
