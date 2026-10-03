// 计费与分账核心规则（纯函数，便于单元测试）
// 合并：基础停车费、充电费、访客超时费、错停罚款、优惠券、退款、异常补偿、业主补偿
// 再按 业主/物业/平台 比例清算，并生成可解释的资金流水。
// 跨日（凌晨离场跨越两个结算日）时，由 buildDaySplits 按实际占用时段拆分各方收益。

import { buildDaySplits, ChargeEvent as SplitChargeEvent, DaySplit } from './daysplit';

export const SHARES = {
  owner: 0.7, // 业主收益占净收入池比例
  property: 0.1, // 物业服务费
  platform: 0.2, // 平台抽成
};

export const PRICING = {
  freeExitGraceMinutes: 10, // 离场宽限
  overtimeMultiplier: 1.5, // 访客超时倍率
  wrongParkFine: 50, // 错停违约金
  ownerCompensationWrongPark: 30, // 错停时车主向业主支付的补偿
  ownerReturnCompensation: 20, // 业主临时回家违约，向车主支付的补偿
  chargerPricePerKwh: 1.2, // 充电服务费 元/kWh
  platformFaultCoupon: 15, // 平台/物业责任的补偿券（计入异常补偿）
  minBillableMinutes: 30, // 最低计费时长（被异常打断不足此时长按此时长或全额免单，由裁决决定）
};

export type Ruling =
  | 'driver_fault'
  | 'owner_fault'
  | 'platform_fault'
  | 'property_fault'
  | 'stranger'
  | 'mixed'
  | 'no_fault';

export interface IncidentInput {
  type:
    | 'owner_return'
    | 'visitor_overstay'
    | 'stranger_occupy'
    | 'recognition_fail'
    | 'weak_signal'
    | 'ice_occupy_charger'
    | 'wrong_parking'
    | 'manual_release';
  started_at?: Date | null;
  resolved_at?: Date | null;
  detail?: Record<string, any>;
}

export interface ChargeEvent {
  at: Date;
  detail?: { kwh?: number };
}

export interface PriceInput {
  reservedStart: Date;
  reservedEnd: Date;
  actualEntry?: Date | null;
  actualExit?: Date | null;
  // 车主实际可使用车位的起点（陌生车占用/识别失败等待会推迟）
  usableFrom?: Date | null;
  hourlyRate: number;
  overnightCap?: number | null;
  isNewEnergy: boolean;
  chargeKwh: number;
  // 充电发生时点（用于跨日充电费归属）；缺省时按占用时长占比分摊
  chargeEvents?: SplitChargeEvent[];
  incidents: IncidentInput[];
  ruling?: Ruling | null;
  couponAmount?: number;
  prepaid: number;
  reservedSpotCode?: string;
}

export interface LedgerDraft {
  account: string; // driver | owner | property | platform | coupon_pool
  direction: 'debit' | 'credit';
  amount: number;
  memo: string;
}

export interface SettlementBreakdown {
  actualEntryAt: Date | null;
  actualExitAt: Date | null;
  usableFrom: Date | null;
  durationMinutes: number;
  baseFee: number;
  chargingFee: number;
  overtimeFee: number;
  wrongParkFine: number;
  couponDiscount: number;
  abnormalCompensation: number; // 车主收到的补偿总额（现金 + 赔付券）
  couponCompensation: number; // 赔付券（非现金，下次抵扣）
  ownerCompensation: number; // 业主收到的补偿（车主错停等）
  prepaid: number;
  refund: number;
  exitCharge: number;
  payable: number; // 车主本次总承担
  ownerIncome: number;
  propertyFee: number;
  platformFee: number;
  ownerShare: number;
  propertyShare: number;
  platformShare: number;
  creditTarget: 'driver' | 'owner' | 'property' | 'none';
  creditDelta: number;
  ruling: Ruling | null;
  // 跨日分账（UTC+8 结算日）：各段费用与三方收益拆分，合计与本单总账严格相等
  rawBaseFee: number;
  capApplied: boolean;
  overtimeFrom: Date | null;
  wrongParkAt: Date | null;
  splits: DaySplit[];
  ledger: LedgerDraft[];
  notes: string[];
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const minutes = (a: Date, b: Date) => Math.max(0, round2((b.getTime() - a.getTime()) / 60000));

export function settlePrice(input: PriceInput): SettlementBreakdown {
  const notes: string[] = [];
  const ledger: LedgerDraft[] = [];
  const ruling = input.ruling ?? null;

  const entry = input.actualEntry ?? input.reservedStart;
  const exit = input.actualExit ?? input.reservedEnd;
  const usableFrom = input.usableFrom ?? entry;

  // 业主临时回家：共享服务提前终止，按实际可用时长计费
  const ownerReturn = input.incidents.find((i) => i.type === 'owner_return');
  const effectiveEnd = ownerReturn?.started_at && ownerReturn.started_at < exit ? ownerReturn.started_at : exit;

  const billableEnd = effectiveEnd > usableFrom ? effectiveEnd : usableFrom;
  let durationMinutes = minutes(usableFrom, billableEnd);

  // ---- 基础停车费（跨夜封顶）----
  // 服务未实际交付（平台/物业/陌生车责任）时免收停车费；业主违约时按实际可用时长照实计费
  const feeWaived = ['platform_fault', 'property_fault', 'stranger'].includes(ruling ?? '');
  const hours = durationMinutes / 60;
  const rawBaseFee = round2(hours * input.hourlyRate);
  let baseFee = 0;
  let capApplied = false;
  if (ruling === 'no_fault' || !feeWaived) {
    baseFee = rawBaseFee;
    if (input.overnightCap && baseFee > input.overnightCap) {
      baseFee = input.overnightCap;
      capApplied = true;
      notes.push(`夜间封顶价 ¥${input.overnightCap} 生效`);
    }
  }

  // 业主回家导致订单被打断：不足最低计费时长则免单
  if (ownerReturn && durationMinutes < PRICING.minBillableMinutes) {
    baseFee = 0;
    notes.push('业主回家导致使用时长不足最低计费时长，基础停车费全免');
  }

  // ---- 充电费 ----
  const chargingFee =
    input.isNewEnergy && input.chargeKwh > 0
      ? round2(input.chargeKwh * PRICING.chargerPricePerKwh)
      : 0;

  // ---- 访客超时费（离场宽限外，按超时倍率）----
  let overtimeFee = 0;
  let overtimeFrom: Date | null = null;
  const overstay = input.incidents.find((i) => i.type === 'visitor_overstay');
  if (input.actualExit && input.actualExit > input.reservedEnd) {
    const overStart = new Date(input.reservedEnd.getTime() + PRICING.freeExitGraceMinutes * 60000);
    const overMin = minutes(overStart, input.actualExit);
    if (overMin > 0) {
      overtimeFrom = overStart;
      overtimeFee = round2(((overMin / 60) * input.hourlyRate * PRICING.overtimeMultiplier));
      notes.push(`超时 ${Math.round(overMin)} 分钟，按 ${PRICING.overtimeMultiplier}× 计费`);
    }
  }
  if (overstay?.detail?.waived) {
    overtimeFee = 0;
    notes.push('物业批准超时费豁免');
  }

  // ---- 错停罚款与业主补偿 ----
  let wrongParkFine = 0;
  let ownerCompensation = 0;
  const wrongParkIncident = input.incidents.find((i) => i.type === 'wrong_parking');
  const wrongPark = !!wrongParkIncident;
  if (wrongPark || ruling === 'driver_fault' || ruling === 'mixed') {
    wrongParkFine = PRICING.wrongParkFine;
    ownerCompensation = PRICING.ownerCompensationWrongPark;
    notes.push(`认定车主错停：违约金 ¥${wrongParkFine}，其中 ¥${ownerCompensation} 补偿业主`);
  }
  const wrongParkAt = wrongParkIncident?.started_at ?? (wrongParkFine > 0 ? usableFrom : null);

  // ---- 异常补偿 ----
  // 现金补偿（业主/陌生车责任，进入退款-托管资金流）与赔付券（平台/物业/信号问题，非现金，下次抵扣）分开
  let cashCompensation = 0;
  let couponCompensation = 0;
  if (ruling === 'owner_fault' || ownerReturn) {
    cashCompensation += PRICING.ownerReturnCompensation;
    notes.push(`业主临时回家违约，现金补偿车主 ¥${PRICING.ownerReturnCompensation}`);
  }
  if (ruling === 'platform_fault' || input.incidents.some((i) => i.type === 'weak_signal')) {
    couponCompensation += PRICING.platformFaultCoupon;
    notes.push(`地下车库信号差/平台服务瑕疵，发放赔付券 ¥${PRICING.platformFaultCoupon}（非现金，下次抵扣）`);
  }
  if (ruling === 'property_fault') {
    couponCompensation += PRICING.platformFaultCoupon;
    notes.push(`物业放行车牌核对失误，发放赔付券 ¥${PRICING.platformFaultCoupon}（非现金，下次抵扣）`);
  }
  if (ruling === 'stranger') {
    cashCompensation += PRICING.ownerReturnCompensation;
    notes.push(`车位被陌生车辆占用，平台先行现金补偿车主 ¥${PRICING.ownerReturnCompensation}，后续向肇事车主追缴`);
    // 陌生车同时让业主空等，平台兜底补偿业主
    ownerCompensation += PRICING.ownerCompensationWrongPark;
    notes.push(`平台先行赔付业主 ¥${PRICING.ownerCompensationWrongPark}，向陌生车主追缴`);
  }
  const abnormalCompensation = round2(cashCompensation + couponCompensation);

  // ---- 优惠券 ----
  const couponDiscount = Math.min(input.couponAmount ?? 0, round2(baseFee + chargingFee + overtimeFee));
  if (couponDiscount > 0) notes.push(`优惠券抵扣 ¥${couponDiscount}`);

  // 车主账单总额（含错停违约金）
  const gross = round2(baseFee + chargingFee + overtimeFee + wrongParkFine);

  // ---- 净收入池（服务费）与三方分成 ----
  // 服务费收入 = 基础停车费 + 充电费 + 超时费；错停罚款中补偿业主之外的余额归平台（违约金处理费）
  const serviceRevenue = round2(baseFee + chargingFee + overtimeFee);
  const ownerShareEarn = round2(serviceRevenue * SHARES.owner);
  let propertyFee = round2(serviceRevenue * SHARES.property);
  const platformServiceEarn = round2(serviceRevenue - ownerShareEarn - propertyFee);
  const fineResidual = round2(Math.max(0, wrongParkFine - ownerCompensation));

  // 业主在"业主回家"场景需要向车主支付的补偿，先从其分成中扣减，不足部分平台垫付
  const ownerPaysComp = ruling === 'owner_fault' || ownerReturn ? PRICING.ownerReturnCompensation : 0;
  if (ownerPaysComp > 0) {
    notes.push(
      `业主承担车主补偿 ¥${ownerPaysComp}：优先从业主分成 ¥${ownerShareEarn} 中扣除，不足部分平台垫付并保留追缴权`,
    );
  }
  // 业主净收 = max(0, 分成 - 业主应承担补偿) + 错停/陌生车补偿业主的部分
  let ownerIncome = round2(Math.max(0, ownerShareEarn - ownerPaysComp) + ownerCompensation);

  // ---- 退款与离场补缴 ----
  // 车主净头寸 D = 账单 - 已用券 - 现金补偿（赔付券不冲抵本单，下次使用）；为正净支付，为负净收款
  const prepaid = round2(input.prepaid);
  const driverNet = round2(gross - couponDiscount - cashCompensation); // 可负
  let refund = driverNet < prepaid ? round2(prepaid - driverNet) : 0;
  let exitCharge = driverNet > prepaid ? round2(driverNet - prepaid) : 0;
  const payable = round2(Math.max(0, driverNet));

  // 平台/物业全责且费用全免时，显式标注（退款金额已含预付退还）
  if (['platform_fault', 'property_fault'].includes(ruling ?? '') && gross === 0 && prepaid > 0) {
    notes.push('责任方全责，预约预付款随补偿一并退还车主');
  }

  // ---- 信用影响 ----
  let creditTarget: SettlementBreakdown['creditTarget'] = 'none';
  let creditDelta = 0;
  switch (ruling) {
    case 'driver_fault':
      creditTarget = 'driver';
      creditDelta = -10;
      break;
    case 'mixed':
      creditTarget = 'driver';
      creditDelta = -5;
      break;
    case 'owner_fault':
      creditTarget = 'owner';
      creditDelta = -5;
      break;
    case 'property_fault':
      creditTarget = 'property';
      creditDelta = -5;
      break;
    case 'stranger':
      // 陌生车主不是本单预约人：扣减记到陌生车主追缴账（系统识别到其账号时生效），
      // 不影响本单预约车主的信用分
      creditTarget = 'none';
      creditDelta = 0;
      notes.push('陌生车主记 -10 信用（待追缴入账，若系统无其账号则挂账）');
      break;
    case 'no_fault':
    case 'platform_fault':
    default:
      creditTarget = ruling === 'no_fault' ? 'none' : 'none';
      creditDelta = 0;
  }
  if (overtimeFee > 0 && creditDelta === 0) {
    creditTarget = 'driver';
    creditDelta = -3;
  }

  // ---- 资金流水（以平台托管账户 escrow 为枢纽的成对转账，全局借贷必须相等）----
  // 业主补偿的资金来源：错停场景出自车主罚款（经托管账户）；陌生车场景由平台先行赔付
  const ownerCompFromPool = ruling === 'stranger' ? 0 : ownerCompensation;
  const strangerAdvance = ruling === 'stranger' ? ownerCompensation : 0;
  const ownerTotal = round2(Math.max(0, ownerShareEarn - ownerPaysComp) + ownerCompFromPool);

  // 托管池：入金 = 预付 + 离场补缴 + 券池出资；出金 = 退款 + 业主收 + 物业收。
  // 出金多于入金的缺口由平台现金兜底，盈余归平台抽成。
  const escrowIn = round2(prepaid + exitCharge + couponDiscount);
  const escrowOutBeforePlatform = round2(refund + ownerTotal + propertyFee);
  const gap = round2(escrowOutBeforePlatform - escrowIn);
  const platformTopup = Math.max(0, gap);
  const platformRetained = Math.max(0, -gap);
  const platformFee = round2(platformRetained - platformTopup - strangerAdvance);

  // 1) 预约预付（车主 → 托管）
  if (prepaid > 0) ledger.push({ account: 'driver', direction: 'debit', amount: prepaid, memo: '预约预付（托管）' });
  if (prepaid > 0) ledger.push({ account: 'escrow', direction: 'credit', amount: prepaid, memo: '预约预付入托管' });
  // 2) 离场补缴（车主 → 托管）
  if (exitCharge > 0)
    ledger.push({
      account: 'driver',
      direction: 'debit',
      amount: exitCharge,
      memo: `离场补缴（基础¥${baseFee} 充电¥${chargingFee} 超时¥${overtimeFee} 违约¥${wrongParkFine} -券¥${couponDiscount} -补偿¥${abnormalCompensation}）`,
    });
  if (exitCharge > 0) ledger.push({ account: 'escrow', direction: 'credit', amount: exitCharge, memo: '离场补缴入托管' });
  // 3) 优惠券出资（券池 → 托管）
  if (couponDiscount > 0)
    ledger.push({ account: 'coupon_pool', direction: 'debit', amount: couponDiscount, memo: '优惠券抵扣出资' });
  if (couponDiscount > 0)
    ledger.push({ account: 'escrow', direction: 'credit', amount: couponDiscount, memo: '优惠券抵扣入托管' });
  // 4) 托管资金不足时平台现金兜底（平台 → 托管）
  if (platformTopup > 0)
    ledger.push({ account: 'platform', direction: 'debit', amount: platformTopup, memo: '平台现金兜底入托管（异常补偿/退款缺口）' });
  if (platformTopup > 0)
    ledger.push({ account: 'escrow', direction: 'credit', amount: platformTopup, memo: '平台兜底入托管' });
  // 5) 退款（托管 → 车主，含预付退还与异常补偿）
  if (refund > 0) ledger.push({ account: 'escrow', direction: 'debit', amount: refund, memo: '托管退款给车主' });
  if (refund > 0)
    ledger.push({
      account: 'driver',
      direction: 'credit',
      amount: refund,
      memo: `离场退款（预付退还与现金补偿 ¥${cashCompensation}）`,
    });
  // 6) 托管出金：三方分成 + 业主补偿
  if (ownerTotal > 0) {
    ledger.push({ account: 'escrow', direction: 'debit', amount: ownerTotal, memo: '托管出金：业主' });
    ledger.push({
      account: 'owner',
      direction: 'credit',
      amount: ownerTotal,
      memo: `业主收款（服务分成 ¥${round2(Math.max(0, ownerShareEarn - ownerPaysComp))}${ownerCompFromPool > 0 ? ` + 错停补偿 ¥${ownerCompFromPool}` : ''}）`,
    });
  }
  if (propertyFee > 0) {
    ledger.push({ account: 'escrow', direction: 'debit', amount: propertyFee, memo: '托管出金：物业' });
    ledger.push({ account: 'property', direction: 'credit', amount: propertyFee, memo: '物业服务费 10%' });
  }
  if (platformRetained > 0) {
    ledger.push({ account: 'escrow', direction: 'debit', amount: platformRetained, memo: '托管出金：平台' });
    ledger.push({
      account: 'platform',
      direction: 'credit',
      amount: platformRetained,
      memo: `平台抽成（服务 20% ¥${platformServiceEarn}${fineResidual > 0 ? ` + 违约金余额 ¥${fineResidual}` : ''}）`,
    });
  }
  // 7) 陌生车场景：平台绕过托管先行赔付业主，后续向陌生车主追缴
  if (strangerAdvance > 0) {
    ledger.push({ account: 'platform', direction: 'debit', amount: strangerAdvance, memo: '平台先行赔付业主（向陌生车主追缴）' });
    ledger.push({ account: 'owner', direction: 'credit', amount: strangerAdvance, memo: '业主补偿（陌生车占用，平台垫付）' });
  }

  ownerIncome = ownerTotal;

  durationMinutes = Math.round(durationMinutes);

  // ---- 跨日分账拆分（UTC+8 结算日；凌晨离场跨两个自然日时各方收益按实际占用时段归属）----
  const splits = buildDaySplits({
    usableFrom,
    billableTo: billableEnd,
    exitAt: exit,
    hourlyRate: input.hourlyRate,
    baseFee,
    rawBaseFee,
    capApplied,
    chargingFee,
    chargeUnitPrice: PRICING.chargerPricePerKwh,
    chargeEvents: input.chargeEvents,
    overtimeFee,
    overtimeFrom,
    wrongParkFine,
    fineAt: wrongParkAt,
    couponDiscount,
    ownerShareEarn,
    propertyFee,
    platformServiceEarn,
    fineResidual,
    ownerPaysComp,
    ownerCompFromPool,
    strangerAdvance,
    platformDriverCash: ruling === 'stranger' ? PRICING.ownerReturnCompensation : 0,
    incidents: input.incidents,
    reservedSpotCode: input.reservedSpotCode ?? '',
    ruling,
  });

  return {
    actualEntryAt: input.actualEntry ?? null,
    actualExitAt: input.actualExit ?? null,
    usableFrom,
    durationMinutes,
    baseFee,
    chargingFee,
    overtimeFee,
    wrongParkFine,
    couponDiscount,
    abnormalCompensation,
    couponCompensation,
    ownerCompensation,
    prepaid,
    refund,
    exitCharge,
    payable,
    ownerIncome: round2(ownerIncome),
    propertyFee,
    platformFee,
    ownerShare: SHARES.owner,
    propertyShare: SHARES.property,
    platformShare: SHARES.platform,
    creditTarget,
    creditDelta,
    ruling,
    rawBaseFee,
    capApplied,
    overtimeFrom,
    wrongParkAt,
    splits,
    ledger,
    notes,
  };
}
