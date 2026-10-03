import React from 'react';

export const money = (v: any) =>
  `¥${Number(v ?? 0).toFixed(2)}`;

export const dt = (v?: string | Date | null) => {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const hm = (v?: string | Date | null) => {
  if (!v) return '—';
  const d = new Date(v);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const STATUS_TAG: Record<string, { label: string; cls: string }> = {
  pending: { label: '待审核', cls: 'amber' },
  approved: { label: '已通过', cls: 'green' },
  rejected: { label: '已驳回', cls: 'red' },
  revoked: { label: '已撤销', cls: 'gray' },

  reserved: { label: '已预约', cls: 'blue' },
  admitted: { label: '已入场', cls: 'cyan' },
  in_garage: { label: '停放中', cls: 'green' },
  completed: { label: '已完成', cls: 'gray' },
  cancelled: { label: '已取消', cls: 'gray' },
  noshow: { label: '爽约', cls: 'red' },

  open: { label: '待处理', cls: 'red' },
  notified: { label: '已通知', cls: 'amber' },
  resolved: { label: '已解决', cls: 'green' },
  closed: { label: '已关闭', cls: 'gray' },

  investigating: { label: '核查中', cls: 'cyan' },
  upheld: { label: '申诉成立', cls: 'green' },
  rejected_appeal: { label: '申诉驳回', cls: 'red' },

  // 退款申请
  paid: { label: '已出账', cls: 'green' },

  normal: { label: '月租优先', cls: 'gray' },
  monthly: { label: '月租优先', cls: 'purple' },
};

export const RULING: Record<string, { label: string; cls: string }> = {
  driver_fault: { label: '车主责任', cls: 'red' },
  owner_fault: { label: '业主责任', cls: 'amber' },
  platform_fault: { label: '平台责任', cls: 'purple' },
  property_fault: { label: '物业责任', cls: 'cyan' },
  stranger: { label: '陌生车主责任', cls: 'red' },
  mixed: { label: '混合责任', cls: 'amber' },
  no_fault: { label: '无责/存疑', cls: 'gray' },
};

export const INCIDENT_LABEL: Record<string, string> = {
  owner_return: '业主临时回家',
  visitor_overstay: '访客车辆超时',
  stranger_occupy: '陌生车辆占用',
  recognition_fail: '道闸识别失败',
  weak_signal: '地下车库信号差',
  ice_occupy_charger: '燃油车占充电位',
  wrong_parking: '车主停错车位',
  manual_release: '物业人工放行',
};

export const EVIDENCE_LABEL: Record<string, string> = {
  plate_recognition: '车牌识别',
  reservation: '预约记录',
  photo: '现场照片',
  gate_log: '道闸日志',
  owner_home: '业主回家时间',
  patrol: '物业巡查',
  appeal_statement: '车主陈述',
  signal: '信号记录',
};

export function Tag({ status, label, cls }: { status?: string; label?: string; cls?: string }) {
  const meta = status ? STATUS_TAG[status] : undefined;
  const text = label ?? meta?.label ?? status ?? '';
  const c = cls ?? meta?.cls ?? 'gray';
  return <span className={`tag ${c}`}>{text}</span>;
}

export function RulingTag({ ruling }: { ruling?: string | null }) {
  if (!ruling) return <span className="tag gray">未裁决</span>;
  const m = RULING[ruling] ?? { label: ruling, cls: 'gray' };
  return <span className={`tag ${m.cls}`}>{m.label}</span>;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="close-x" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

export function CreditChip({ score }: { score: number }) {
  const cls = score >= 90 ? '' : score >= 70 ? 'warn' : 'bad';
  return <span className={`credit-chip ${cls}`}>信用 {score}</span>;
}
