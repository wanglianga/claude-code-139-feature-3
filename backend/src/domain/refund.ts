// 退款校验（纯函数）：车主申请退款时，平台按
//   ① 道闸记录（入场/人工放行/离场时间）② 物业巡查记录 ③ 离场时间与预约结束时间
// 三类客观证据核定可退现金与应补发券额，并对重复申请 / 重复冲销做硬拦截。
// 财务最终应收/应退由控制器用 settlePrice 以终裁裁决重算后传入（justifiedDriverCash）。

import { Ruling } from './pricing';

export interface RefundPatrolFinding {
  finding: 'normal' | 'stranger' | 'wrong_park' | 'ice_on_charger' | string;
  at: Date;
  plate?: string | null;
  note?: string | null;
}

export interface RefundCheckInput {
  reservation: { code: string; status: string; startAt: Date; endAt: Date };
  gateEntryAt: Date | null;
  gateExitAt: Date | null;
  gateEntryMode?: 'auto' | 'manual' | null;
  // 已落账结算单（未离场时为 null）
  settlement: {
    prepaid: number;
    exitCharge: number;
    refund: number;
    couponDiscount: number;
    ruling: Ruling | null;
  } | null;
  // 未结算（未入场）时的预约预付现金额
  prepaidEstimate?: number;
  patrolFindings: RefundPatrolFinding[];
  hasWeakSignal?: boolean;
  // 目标裁决：已关闭申诉的终裁，或退款审批时物业确认的责任方；无裁决时只按道闸/离场事实核验
  targetRuling?: Ruling | null;
  // 终裁重算后车主"本应净付现金"（控制器调 settlePrice 得出）；无重算时等于已结算净付
  justifiedDriverCash?: number | null;
  // 该服务周期内巡查证据所指向的建议裁决
  suggestedRuling?: Ruling | null;
  requestedAmount: number;
  alreadyRefundedCash: number; // 此前冲正单已退现金合计
  couponAlreadyReissued: number; // 此前已补发券额
  hasOpenRequest: boolean;
  now?: Date;
}

export interface RefundCheck {
  key: string;
  label: string;
  // true=通过(支持退款) false=不通过/拦截 null=中性事实记录
  passed: boolean | null;
  detail: string;
}

export interface RefundDecision {
  decision: 'eligible' | 'ineligible' | 'awaiting_exit' | 'duplicate';
  refundable: boolean;
  validatedAmount: number; // 核定本次可退现金
  couponReissue: number; // 应补发赔付券（券抵扣不退现金）
  cap: number; // 现金可退上限
  suggestedRuling: Ruling | null;
  checks: RefundCheck[];
  reasons: string[];
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const fmt = (d?: Date | null) => (d ? d.toISOString() : '—');

const WAIVER_RULINGS: Ruling[] = ['platform_fault', 'property_fault', 'stranger'];

export function validateRefund(input: RefundCheckInput): RefundDecision {
  const checks: RefundCheck[] = [];
  const reasons: string[] = [];
  const now = input.now ?? new Date();
  const s = input.settlement;

  // ---- 0. 防重复申请 / 重复冲销 ----
  if (input.hasOpenRequest) {
    checks.push({
      key: 'duplicate',
      label: '重复申请拦截',
      passed: false,
      detail: '该订单已存在处理中（待审核/已核准待出账）的退款申请，同一笔分账不得重复冲销',
    });
    return {
      decision: 'duplicate',
      refundable: false,
      validatedAmount: 0,
      couponReissue: 0,
      cap: 0,
      suggestedRuling: null,
      checks,
      reasons: ['该订单已有处理中的退款申请，请勿重复提交'],
    };
  }

  // ---- 1. 道闸入场核验 ----
  const entered = !!input.gateEntryAt;
  if (entered) {
    checks.push({
      key: 'gate_entry',
      label: '道闸入场记录',
      passed: true,
      detail: `${fmt(input.gateEntryAt)} ${input.gateEntryMode === 'manual' ? '物业人工放行入场' : '车牌识别自动放行'}，服务已实际交付`,
    });
  } else if (['reserved'].includes(input.reservation.status) && now.getTime() < input.reservation.endAt.getTime()) {
    checks.push({ key: 'gate_entry', label: '道闸入场记录', passed: null, detail: '预约尚未开始入场，暂不核定' });
  } else {
    checks.push({
      key: 'gate_entry',
      label: '道闸入场记录',
      passed: true,
      detail: '道闸无入场记录：服务未交付，预约预付应予退还（券自动释放）',
    });
  }

  // ---- 2. 道闸离场核验 ----
  const exited = !!input.gateExitAt;
  if (!exited && entered) {
    checks.push({
      key: 'gate_exit',
      label: '道闸离场记录',
      passed: null,
      detail: `车辆尚未离场（入场 ${fmt(input.gateEntryAt)}），可退金额需在离场结算后按实际占用核定`,
    });
  } else if (exited) {
    const consistent = !entered || input.gateExitAt!.getTime() >= input.gateEntryAt!.getTime();
    checks.push({
      key: 'gate_exit',
      label: '道闸离场记录',
      passed: consistent,
      detail: `${fmt(input.gateExitAt)} 道闸离场${consistent ? '' : '；离场时间早于入场时间，记录异常，暂挂起退款转人工核查'}`,
    });
    if (!consistent) reasons.push('道闸离场时间早于入场时间，记录异常');
  } else {
    checks.push({ key: 'gate_exit', label: '道闸离场记录', passed: null, detail: '无入场亦无离场记录' });
  }

  // ---- 3. 离场时间 vs 预约结束时间 ----
  if (exited) {
    const diffMin = Math.round((input.gateExitAt!.getTime() - input.reservation.endAt.getTime()) / 60000);
    if (diffMin > 10) {
      checks.push({
        key: 'exit_time',
        label: '离场时间校验',
        passed: null,
        detail: `超出预约结束时间 ${diffMin} 分钟（10 分钟宽限外按 1.5× 计超时费），超时费不退`,
      });
    } else if (diffMin < 0) {
      checks.push({
        key: 'exit_time',
        label: '离场时间校验',
        passed: true,
        detail: `提前 ${-diffMin} 分钟离场，离场结算已按实际占用时长计费，差额在结算单中退还`,
      });
    } else {
      checks.push({
        key: 'exit_time',
        label: '离场时间校验',
        passed: null,
        detail: '在预约结束时间（含 10 分钟宽限）内正常离场',
      });
    }
  } else {
    checks.push({ key: 'exit_time', label: '离场时间校验', passed: null, detail: '车辆未离场，离场时间待补录' });
  }

  // ---- 4. 巡查证据 ----
  const hostile = input.patrolFindings.filter((p) => p.finding === 'stranger' || p.finding === 'ice_on_charger');
  const wrongParkPatrols = input.patrolFindings.filter((p) => p.finding === 'wrong_park');
  for (const p of hostile) {
    checks.push({
      key: 'patrol',
      label: '物业巡查记录',
      passed: true,
      detail: `${fmt(p.at)} 夜巡登记「${p.finding === 'ice_on_charger' ? '燃油车占用充电位' : '陌生车辆占用'}」${p.plate ? `（车牌 ${p.plate}）` : ''}：等待/受阻时段不计费，支持退款${p.note ? `；${p.note}` : ''}`,
    });
  }
  for (const p of wrongParkPatrols) {
    checks.push({
      key: 'patrol',
      label: '物业巡查记录',
      passed: false,
      detail: `${fmt(p.at)} 巡查登记「车主停错车位」：错停违约金原则上不退${p.note ? `；${p.note}` : ''}`,
    });
  }
  if (input.patrolFindings.some((p) => p.finding === 'normal')) {
    checks.push({ key: 'patrol', label: '物业巡查记录', passed: null, detail: '存在「现场正常」巡查记录' });
  }
  if (input.hasWeakSignal) {
    checks.push({ key: 'patrol', label: '信号记录', passed: true, detail: '地下车库信号差上报记录在案：支持平台服务瑕疵免责与赔付券' });
  }

  // ---- 建议裁决（无正式终裁时供审批人参考）----
  let suggestedRuling: Ruling | null = input.suggestedRuling ?? null;
  if (!suggestedRuling) {
    if (hostile.length > 0) suggestedRuling = 'stranger';
    else if (input.hasWeakSignal) suggestedRuling = 'platform_fault';
  }

  // ---- 金额核定 ----
  // 车主当前净付现金 = 预付 + 离场补缴 - 结算退款 - 历次冲正已退
  const settledCash = s
    ? round2(s.prepaid + s.exitCharge - s.refund - input.alreadyRefundedCash)
    : round2((input.prepaidEstimate ?? 0) - input.alreadyRefundedCash);
  const cap = Math.max(0, settledCash);

  const target = input.targetRuling ?? null;
  const waiver = target ? WAIVER_RULINGS.includes(target) : false;

  let validated = 0;
  if (s && target && input.justifiedDriverCash != null) {
    validated = round2(Math.max(0, cap - Math.max(0, round2(input.justifiedDriverCash))));
  } else if (!entered && !s) {
    validated = cap; // 未入场：预付全退
  } else if (s && waiver) {
    validated = cap;
  } else if (s && target === 'owner_fault' && s.ruling !== 'owner_fault') {
    validated = cap; // 控制器重算会给出更精确金额，兜底上限
  }

  // 申请额作为上限（车主不能申请多于核定）
  if (input.requestedAmount > 0) validated = Math.min(validated, round2(input.requestedAmount));
  validated = round2(Math.min(validated, cap));

  // 券抵扣部分不退现金：责任免除时补发等额赔付券
  let couponReissue = 0;
  if (s && waiver) {
    couponReissue = round2(Math.max(0, s.couponDiscount - input.couponAlreadyReissued));
  }
  if (couponReissue > 0) {
    checks.push({
      key: 'coupon',
      label: '优惠券处理',
      passed: true,
      detail: `原券抵扣 ¥${s!.couponDiscount} 不退现金，核准后补发等额赔付券 ¥${couponReissue}（下次预约抵扣）`,
    });
  }

  // ---- 终态 ----
  if (!exited && entered) {
    return {
      decision: 'awaiting_exit',
      refundable: false,
      validatedAmount: 0,
      couponReissue: 0,
      cap,
      suggestedRuling,
      checks,
      reasons: ['车辆尚未离场，退款申请已登记，离场结算后核定'],
    };
  }
  if (reasons.some((r) => r.includes('异常'))) {
    return { decision: 'ineligible', refundable: false, validatedAmount: 0, couponReissue: 0, cap, suggestedRuling, checks, reasons };
  }
  if (validated <= 0 && couponReissue <= 0) {
    if (s && !target) {
      reasons.push('离场结算已按道闸与离场时间据实多退少补；无责任免除证据，无额外可退金额。如对责任有异议请先发起申诉');
    } else if (s && target && !waiver && target !== 'owner_fault') {
      reasons.push('终裁裁决不支持额外退款（如车主责任：违约金不退）');
    } else {
      reasons.push('按现有道闸、巡查与离场时间证据核定，可退金额为 0 元');
    }
    return { decision: 'ineligible', refundable: false, validatedAmount: 0, couponReissue: 0, cap, suggestedRuling, checks, reasons };
  }

  if (input.alreadyRefundedCash > 0) {
    checks.push({
      key: 'reversal_guard',
      label: '重复冲销防护',
      passed: true,
      detail: `历史冲正已退 ¥${input.alreadyRefundedCash}，本次仅退剩余可退额度 ¥${validated}，累计不超过现金可退上限 ¥${cap + input.alreadyRefundedCash}`,
    });
  }
  checks.push({
    key: 'amount',
    label: '可退金额核定',
    passed: true,
    detail: `车主当前净付现金 ¥${cap}${target ? `，按${target} 终裁重算应净付 ¥${round2(input.justifiedDriverCash ?? 0)}` : ''}，本次核定退款 ¥${validated}${couponReissue > 0 ? `，补发赔付券 ¥${couponReissue}` : ''}`,
  });

  return {
    decision: 'eligible',
    refundable: true,
    validatedAmount: validated,
    couponReissue,
    cap,
    suggestedRuling,
    checks,
    reasons,
  };
}
