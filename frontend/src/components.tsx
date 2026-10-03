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
      <DaySplitView splits={s.splits} />
      <div className="btn-row">
        <RulingTag ruling={s.ruling} />
        {s.kind === 'recomputed' && <Tag cls="purple" label="冲正重做版" />}
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
      <ReversalsView versions={s.versions} reversals={s.reversals} />
      <LedgerTable entries={s.ledger} />
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

// ---------- 跨日分账分段（按 UTC+8 结算日展示每段费用来源）----------
const SOURCE_KIND_LABEL: Record<string, string> = {
  parking: '停车',
  charging: '充电',
  overtime: '超时',
  fine: '违约金',
  coupon: '优惠券',
  manual_release: '人工放行',
  spot_change: '换位',
  stranger: '异常占用',
  owner_return: '业主回家',
  weak_signal: '信号差',
  share: '三方分成',
  compensation: '补偿',
};
const SOURCE_KIND_CLS: Record<string, string> = {
  parking: 'blue', charging: 'green', overtime: 'amber', fine: 'red', coupon: 'purple',
  manual_release: 'cyan', spot_change: 'red', stranger: 'red', owner_return: 'amber',
  weak_signal: 'amber', share: 'gray', compensation: 'green',
};

export function DaySplitView({ splits }: { splits: any[] }) {
  if (!splits?.length) return null;
  const sum = (k: string) => splits.reduce((a, s) => a + Number(s[k] ?? 0), 0);
  const crossDay = splits.length > 1;
  return (
    <div style={{ marginTop: 14 }}>
      <h3 style={{ fontSize: 14, marginBottom: 8 }}>
        {crossDay ? `跨日分账（${splits.length} 个结算日 · UTC+8 日界 00:00）` : '结算日分段'}
      </h3>
      <div className="alert info" style={{ marginBottom: 10 }}>
        {crossDay
          ? '车辆凌晨离场跨越两个结算日：业主收益、物业服务费、平台抽成按实际占用时段拆分；换位/优惠券/人工放行按发生日落入对应分段。'
          : '本单未跨结算日，全部费用归属同一结算日。'}
      </div>
      <div className="grid" style={{ gap: 10 }}>
        {splits.map((sp, i) => (
          <div className="card" key={i} style={{ marginTop: 0 }}>
            <div className="btn-row" style={{ justifyContent: 'space-between' }}>
              <div className="btn-row">
                <Tag cls="blue" label={sp.settlement_date} />
                <span className="small muted">{hm(sp.period_from)} ~ {hm(sp.period_to)}（{sp.duration_minutes} 分钟）</span>
                {sp.spot_code && <span className="mono small muted">车位 {sp.spot_code}</span>}
              </div>
              <div className="btn-row">
                <Tag cls="gray" label={`业主 ${money(sp.owner_income)}`} />
                <Tag cls="gray" label={`物业 ${money(sp.property_fee)}`} />
                <Tag cls="gray" label={`平台 ${money(sp.platform_fee)}`} />
              </div>
            </div>
            <div className="fee-grid" style={{ marginTop: 8 }}>
              <span className="row"><span className="muted">基础停车费</span><span className="money">{money(sp.base_fee)}</span></span>
              <span className="row"><span className="muted">充电服务费</span><span className="money">{money(sp.charging_fee)}</span></span>
              <span className="row"><span className="muted">访客超时费</span><span className="money">{money(sp.overtime_fee)}</span></span>
              <span className="row"><span className="muted">错停违约金</span><span className="money">{money(sp.wrong_park_fine)}</span></span>
              <span className="row"><span className="muted">优惠券抵扣</span><span className="money">{money(sp.coupon_discount)}</span></span>
              <span className="row"><span className="muted">净服务费收入</span><span className="money">{money(sp.service_revenue)}</span></span>
            </div>
            {sp.sources?.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div className="small muted" style={{ marginBottom: 4 }}>本段费用来源：</div>
                <div className="btn-row" style={{ flexWrap: 'wrap' }}>
                  {sp.sources.map((x: any, j: number) => (
                    <span key={j} className={`tag ${SOURCE_KIND_CLS[x.kind] ?? 'gray'}`} title={x.label}>
                      {SOURCE_KIND_LABEL[x.kind] ?? x.kind}{x.amount != null ? ` ${money(x.amount)}` : ''}
                    </span>
                  ))}
                </div>
                <ul className="small muted" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {sp.sources.map((x: any, j: number) => <li key={j}>{x.label}{x.at ? `（${dt(x.at)}）` : ''}</li>)}
                </ul>
              </div>
            )}
          </div>
        ))}
      </div>
      {crossDay && (
        <div className="small muted" style={{ marginTop: 8 }}>
          分段合计：业主 {money(sum('owner_income'))} · 物业 {money(sum('property_fee'))} · 平台 {money(sum('platform_fee'))}
          {' '}· 基础费 {money(sum('base_fee'))} · 券 {money(sum('coupon_discount'))}（与结算单合计严格相等）
        </div>
      )}
    </div>
  );
}

// ---------- 结算版本与冲正单 ----------
export function ReversalsView({ versions, reversals }: { versions?: any[]; reversals?: any[] }) {
  if ((!versions || versions.length <= 1) && (!reversals || reversals.length <= 0)) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <h3 style={{ fontSize: 14, marginBottom: 8 }}>结算版本与冲正单（红字冲销不删原账）</h3>
      {versions && versions.length > 1 && (
        <div className="table-wrap" style={{ marginBottom: 10 }}>
          <table>
            <thead><tr><th>版本</th><th>类型</th><th>裁决</th><th>车主应付</th><th>退款</th><th>业主</th><th>物业</th><th>平台</th><th>冲正次数</th><th>时间</th></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.id}>
                  <td className="mono small">{v.code}</td>
                  <td>{v.kind === 'recomputed' ? <Tag cls="purple" label="冲正重做" /> : <Tag cls="gray" label="原始分账" />}</td>
                  <td><RulingTag ruling={v.ruling} /></td>
                  <td className="money">{money(v.payable)}</td>
                  <td className="money neg">{money(v.refund)}</td>
                  <td className="money">{money(v.owner_income)}</td>
                  <td className="money">{money(v.property_fee)}</td>
                  <td className="money">{money(v.platform_fee)}</td>
                  <td>{Number(v.reversal_count ?? 0)}</td>
                  <td className="small muted">{dt(v.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {reversals?.map((rv) => (
        <div className="alert info" key={rv.id} style={{ marginBottom: 8 }}>
          <div className="btn-row" style={{ justifyContent: 'space-between' }}>
            <div className="btn-row">
              <Tag cls={rv.kind === 'refund_approved' ? 'green' : 'purple'}
                label={rv.kind === 'refund_approved' ? '退款冲正' : '申诉成立冲正'} />
              <span className="mono small">{rv.code}</span>
              <RulingTag ruling={rv.new_ruling} />
            </div>
            <span className="small muted">{dt(rv.created_at)}</span>
          </div>
          <div className="small" style={{ marginTop: 6 }}>{rv.reason}</div>
          <div className="btn-row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
            {Number(rv.refund_to_driver) > 0 && <Tag cls="green" label={`补退车主 ${money(rv.refund_to_driver)}`} />}
            {Number(rv.coupon_reissue) > 0 && <Tag cls="purple" label={`补发赔付券 ${money(rv.coupon_reissue)}`} />}
            {Number(rv.owner_clawback) > 0 && <Tag cls="amber" label={`追回业主 ${money(rv.owner_clawback)}`} />}
            {Number(rv.property_clawback) > 0 && <Tag cls="amber" label={`追回物业 ${money(rv.property_clawback)}`} />}
            {Number(rv.platform_clawback) > 0 && <Tag cls="red" label={`平台垫付 ${money(rv.platform_clawback)}`} />}
            {Number(rv.credit_delta) !== 0 && <Tag cls={Number(rv.credit_delta) < 0 ? 'red' : 'green'} label={`信用净调整 ${rv.credit_delta}`} />}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- 退款校验项（车主/物业共用）----------
export function RefundChecks({ checks }: { checks: any[] }) {
  if (!checks?.length) return null;
  return (
    <div className="grid" style={{ gap: 8 }}>
      {checks.map((c, i) => (
        <div key={i} className={`ticket-card ${c.passed === false ? 'open' : c.passed === true ? 'resolved' : 'notified'}`}>
          <div className="ticket-head">
            <span className="ticket-title">{c.label}</span>
            {c.passed === true ? <Tag cls="green" label="支持" /> : c.passed === false ? <Tag cls="red" label="不支持/拦截" /> : <Tag cls="gray" label="事实记录" />}
          </div>
          <div className="ticket-desc">{c.detail}</div>
        </div>
      ))}
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
              <tr key={i} style={e.reversal_id ? { background: 'rgba(207,51,51,0.06)' } : undefined}>
                <td>{accountLabel(e.account)}{e.reversal_id && <div className="small" style={{ color: 'var(--red)' }}>红字冲正</div>}</td>
                <td>
                  <Tag cls={e.direction === 'debit' ? 'amber' : 'green'} label={e.direction === 'debit' ? '借方' : '贷方'} />
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
  settlement_reversed: '结算冲正',
  refund_requested: '申请退款',
  refund_reviewed: '退款审核',
  credit_adjusted: '信用调整',
  monthly_priority_conflict: '月租优先冲突',
};

const EVENT_COLOR: Record<string, string> = {
  recognition_fail: 'red', wrong_parking_detected: 'red', overstay_warning: 'amber',
  owner_return_report: 'amber', weak_signal_report: 'amber', move_notice_sent: 'amber',
  gate_entry: 'cyan', parking_confirmed: 'green', settlement_completed: 'blue',
  appeal_ruled: 'purple', manual_release: 'purple', incident_resolved: 'green',
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
