// 退款校验：车主申请退款时，平台按 道闸记录 / 物业巡查 / 离场时间 三方校验可退金额，
// 并扣除结算单已退款与历史已批准退款，避免重复冲销。

export interface PatrolRecord {
  at: Date;
  finding: 'normal' | 'stranger' | 'wrong_park' | 'ice_on_charger' | string;
  note?: string | null;
}

export interface RefundCheckInput {
  prepaid: number; // 预约预付（现金实收）
  exitCharge: number; // 离场补缴（现金实收）
  settledPayable: number; // 结算单车主应付
  settledRefund: number; // 结算时已退（托管退回）
  approvedRefunds: number; // 历史已批准退款单总额（不含本次）
  requestedAmount: number; // 本次申请金额
  gateEntryAt: Date | null; // 道闸入场时间
  gateExitAt: Date | null; // 道闸离场时间
  reservedEnd: Date; // 预约结束时间
  patrols: PatrolRecord[]; // 订单时段内该车位巡查记录
  feeWaived: boolean; // 裁决免单（平台/物业/陌生车责任）
}

export interface RefundCheck {
  key: 'gate' | 'patrol' | 'exit_time' | 'duplicate';
  label: string;
  passed: boolean;
  detail: string;
}

export interface RefundValidation {
  totalPaid: number; // 车主现金实付 = 预付 + 离场补缴
  alreadyRefunded: number; // 已退 = 结算退款 + 已批准退款单
  validatedCharges: number; // 校验后车主仍应付的费用
  maxRefundable: number; // 可退上限
  approvedAmount: number; // 本次可批金额 = min(申请, 上限)
  autoReject: boolean; // 可退上限为 0（或重复冲销）时系统建议直接拒绝
  checks: RefundCheck[];
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function validateRefund(input: RefundCheckInput): RefundValidation {
  const checks: RefundCheck[] = [];
  const totalPaid = round2(input.prepaid + input.exitCharge);
  const alreadyRefunded = round2(input.settledRefund + input.approvedRefunds);

  // ---- 1) 道闸校验：入场/离场记录决定服务是否实际交付 ----
  let validatedCharges = round2(Math.max(0, input.settledPayable));
  if (!input.gateEntryAt) {
    validatedCharges = 0;
    checks.push({
      key: 'gate',
      label: '道闸记录校验',
      passed: true,
      detail: '道闸无入场识别/放行记录，车辆未实际入场，服务未交付，已收费用应全额退还',
    });
  } else {
    checks.push({
      key: 'gate',
      label: '道闸记录校验',
      passed: true,
      detail: `道闸记录完整：入场 ${fmt(input.gateEntryAt)}${input.gateExitAt ? `，离场 ${fmt(input.gateExitAt)}` : '，暂无离场记录'}，按结算单应付 ¥${validatedCharges.toFixed(2)} 为基数`,
    });
  }

  // ---- 2) 巡查校验：巡查发现未交付（车位空闲/被陌生车占用）时应付清零 ----
  const occupyPatrol = input.patrols.find((p) => ['stranger', 'ice_on_charger'].includes(p.finding));
  if (occupyPatrol && validatedCharges > 0) {
    validatedCharges = 0;
    checks.push({
      key: 'patrol',
      label: '物业巡查校验',
      passed: true,
      detail: `巡查记录（${fmt(occupyPatrol.at)}）发现车位被${occupyPatrol.finding === 'ice_on_charger' ? '燃油车' : '陌生车辆'}占用，预约服务未交付，应付费用核减为 0`,
    });
  } else {
    checks.push({
      key: 'patrol',
      label: '物业巡查校验',
      passed: true,
      detail: input.patrols.length
        ? `订单时段内 ${input.patrols.length} 条巡查记录，未发现服务未交付情形`
        : '订单时段内无巡查异常记录，维持结算单应付金额',
    });
  }

  // ---- 3) 离场时间校验：提前离场不多计；裁决免单则应付清零 ----
  if (input.feeWaived && validatedCharges > 0) {
    validatedCharges = 0;
    checks.push({
      key: 'exit_time',
      label: '离场时间校验',
      passed: true,
      detail: '申诉裁决为责任方全责（平台/物业/陌生车），费用全免，应付核减为 0',
    });
  } else if (input.gateExitAt && input.gateExitAt < input.reservedEnd) {
    checks.push({
      key: 'exit_time',
      label: '离场时间校验',
      passed: true,
      detail: `车辆 ${fmt(input.gateExitAt)} 提前于预约结束 ${fmt(input.reservedEnd)} 离场，结算已按实际离场时间计费，不再重复核减`,
    });
  } else {
    checks.push({
      key: 'exit_time',
      label: '离场时间校验',
      passed: true,
      detail: input.gateExitAt
        ? `离场时间 ${fmt(input.gateExitAt)} 与结算计费截止一致，无多计`
        : '无道闸离场记录，按预约结束时间口径核对',
    });
  }

  // ---- 4) 重复冲销校验：已退金额不得覆盖"实付 - 校验后应付" ----
  const maxRefundable = round2(Math.max(0, totalPaid - alreadyRefunded - validatedCharges));
  const duplicateBlocked = alreadyRefunded >= round2(totalPaid - validatedCharges) && totalPaid > 0;
  checks.push({
    key: 'duplicate',
    label: '重复冲销校验',
    passed: maxRefundable > 0,
    detail:
      maxRefundable > 0
        ? `实收 ¥${totalPaid.toFixed(2)} - 已退 ¥${alreadyRefunded.toFixed(2)} - 校验后应付 ¥${validatedCharges.toFixed(2)} = 可退上限 ¥${maxRefundable.toFixed(2)}`
        : `实收 ¥${totalPaid.toFixed(2)} 已退 ¥${alreadyRefunded.toFixed(2)}，可退余额为 0，拒绝重复冲销`,
  });

  const approvedAmount = round2(Math.min(Math.max(0, input.requestedAmount), maxRefundable));
  return {
    totalPaid,
    alreadyRefunded,
    validatedCharges,
    maxRefundable,
    approvedAmount,
    autoReject: maxRefundable <= 0 || duplicateBlocked,
    checks,
  };
}

function fmt(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
