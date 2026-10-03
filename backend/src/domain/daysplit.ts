// 跨日分账：车辆凌晨离场、订单跨越两个（或多个）结算日时，按实际占用时段把
// 业主收益 / 物业服务费 / 平台抽成拆分到 UTC+8 日历日，并给出每段费用来源。
// 纯函数：所有结果之和必须等于整张结算单的合计（由 settlePrice 调用后校验）。

import { IncidentInput, Ruling } from './pricing';

// 平台统一按东八区做财务结算日界（夜间订单 19:00 -> 次日 08:00 落在两个自然日）
export const SETTLEMENT_TZ_OFFSET_MS = 8 * 3600000;

export interface SplitSource {
  kind:
    | 'parking'
    | 'charging'
    | 'overtime'
    | 'fine'
    | 'coupon'
    | 'manual_release'
    | 'spot_change'
    | 'stranger'
    | 'owner_return'
    | 'weak_signal'
    | 'share'
    | 'compensation';
  label: string;
  amount?: number;
  at?: Date | null;
}

export interface DaySplit {
  settlementDate: string; // YYYY-MM-DD（UTC+8）
  from: Date;
  to: Date;
  durationMinutes: number;
  spotCode: string | null; // 该段实际停放车位（换位时与预约车位不同）
  baseFee: number;
  chargingFee: number;
  overtimeFee: number;
  wrongParkFine: number;
  couponDiscount: number;
  serviceRevenue: number; // 参与三方分成的收入（基础+充电+超时）
  ownerIncome: number;
  propertyFee: number;
  platformFee: number;
  sources: SplitSource[];
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const toLocal = (ms: number) => new Date(ms + SETTLEMENT_TZ_OFFSET_MS);

export function settlementDayLabel(ms: number): string {
  return toLocal(ms).toISOString().slice(0, 10);
}

// 下一个东八区自然日 00:00 的 UTC 毫秒
function nextMidnightMs(ms: number): number {
  const d = toLocal(ms);
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime() - SETTLEMENT_TZ_OFFSET_MS;
}

// 按东八区午夜把 [from,to] 切成不重叠时间段
export function slicesBySettlementDay(from: Date, to: Date): { date: string; from: Date; to: Date }[] {
  const out: { date: string; from: Date; to: Date }[] = [];
  let cursor = from.getTime();
  const end = to.getTime();
  if (end <= cursor) return out;
  while (cursor < end) {
    const cut = nextMidnightMs(cursor);
    const segTo = Math.min(cut, end);
    if (segTo > cursor) out.push({ date: settlementDayLabel(cursor), from: new Date(cursor), to: new Date(segTo) });
    cursor = segTo;
  }
  return out;
}

function overlapMin(aFrom: number, aTo: number, bFrom: number, bTo: number): number {
  return Math.max(0, Math.min(aTo, bTo) - Math.max(aFrom, bFrom)) / 60000;
}

/**
 * 最大余数法分摊：按 weights 把 total 拆成 n 个 round2 金额，之和严格等于 total。
 */
export function allocateByWeights(total: number, weights: number[]): number[] {
  const wsum = weights.reduce((a, b) => a + Math.max(0, b), 0);
  const n = weights.length;
  if (n === 0) return [];
  if (wsum <= 0) {
    const res = new Array(n).fill(0);
    res[0] = round2(total); // 无权重时全部挂第一段，保证不分摊丢钱
    return res;
  }
  const raw = weights.map((w) => (Math.max(0, w) / wsum) * total);
  const floors = raw.map((x) => Math.floor(x * 100) / 100);
  let cents = Math.round(total * 100) - floors.reduce((a, b) => a + Math.round(b * 100), 0);
  const order = raw
    .map((x, i) => ({ i, rem: Math.round(x * 100) - Math.floor(x * 100) }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of order) {
    if (cents <= 0) break;
    floors[i] = round2(floors[i] + 0.01);
    cents--;
  }
  return floors.map(round2);
}

export interface ChargeEvent {
  at: Date;
  kwh: number;
}

export interface SplitContext {
  usableFrom: Date;
  billableTo: Date; // 参与基础停车费的终点（业主回家时为回家时刻）
  exitAt: Date; // 实际离场（含超时段）
  hourlyRate: number;
  baseFee: number;
  rawBaseFee: number; // 封顶前的理论基础费
  capApplied: boolean;
  chargingFee: number;
  chargeUnitPrice: number;
  chargeEvents?: ChargeEvent[];
  overtimeFee: number;
  overtimeFrom: Date | null;
  wrongParkFine: number;
  fineAt: Date | null;
  couponDiscount: number;
  ownerShareEarn: number; // 三方分成池中的业主分成（未扣补偿）
  propertyFee: number;
  platformServiceEarn: number; // 平台 20% 服务抽成
  fineResidual: number; // 违约金补偿业主后的余额（归平台）
  ownerPaysComp: number; // 业主应承担的车主补偿（20）
  ownerCompFromPool: number; // 经托管池支付给业主的错停补偿（30）
  strangerAdvance: number; // 平台绕过托管先行赔付业主（30）
  platformDriverCash: number; // 平台直接承担的车主现金补偿（陌生车场景 20）
  incidents: IncidentInput[];
  reservedSpotCode: string;
  ruling: Ruling | null;
}

export function buildDaySplits(ctx: SplitContext): DaySplit[] {
  const occFrom = ctx.usableFrom.getTime();
  const occTo = Math.max(ctx.billableTo.getTime(), occFrom);
  const exitTo = Math.max(ctx.exitAt.getTime(), occFrom);

  // 统一分界：占用终点与离场终点（超时可能在午夜之后）范围内的所有午夜
  const slices = slicesBySettlementDay(new Date(occFrom), new Date(Math.max(occTo, exitTo)));
  if (slices.length === 0) return [];

  const durations = slices.map((s) =>
    Math.round(overlapMin(s.from.getTime(), s.to.getTime(), occFrom, Math.max(occTo, occFrom))),
  );
  const totalDuration = durations.reduce((a, b) => a + b, 0) || 1;

  // ---- 基础停车费：按时长占比（封顶额也按时长落到每日；责任免除则每日均为 0）----
  const feeWaived = ctx.baseFee === 0 && ctx.rawBaseFee > 0;
  const baseFees = feeWaived ? durations.map(() => 0) : allocateByWeights(ctx.baseFee, durations);

  // ---- 充电费：有充电事件按事件归属日；无事件按停车时长占比 ----
  let chargingFees: number[];
  if (ctx.chargingFee > 0) {
    if (ctx.chargeEvents && ctx.chargeEvents.length > 0) {
      const perKwh = new Array(slices.length).fill(0);
      for (const ev of ctx.chargeEvents) {
        const idx = slices.findIndex(
          (s) => ev.at.getTime() >= s.from.getTime() && ev.at.getTime() < s.to.getTime(),
        );
        if (idx >= 0) perKwh[idx] += ev.kwh;
      }
      const weights = perKwh.map((k) => k * ctx.chargeUnitPrice);
      chargingFees = allocateByWeights(ctx.chargingFee, weights);
    } else {
      chargingFees = allocateByWeights(ctx.chargingFee, durations);
    }
  } else {
    chargingFees = durations.map(() => 0);
  }

  // ---- 访客超时费：按超时区间与每日时间段的重叠分钟占比 ----
  let overtimeFees: number[];
  if (ctx.overtimeFee > 0 && ctx.overtimeFrom) {
    const weights = slices.map((s) =>
      overlapMin(s.from.getTime(), s.to.getTime(), ctx.overtimeFrom!.getTime(), exitTo),
    );
    overtimeFees = allocateByWeights(ctx.overtimeFee, weights);
  } else {
    overtimeFees = durations.map(() => 0);
  }

  // ---- 错停违约金及其业主补偿：归到错停发生当日 ----
  const fineFees = new Array(slices.length).fill(0);
  if (ctx.wrongParkFine > 0) {
    const idx = sliceIndexAt(slices, ctx.fineAt?.getTime() ?? exitTo);
    fineFees[idx] = ctx.wrongParkFine;
  }

  // ---- 优惠券抵扣：按各日服务费（基础+充电+超时）占比，最大余数法分摊 ----
  const grossPerDay = baseFees.map((b, i) => round2(b + chargingFees[i] + overtimeFees[i]));
  const couponSplit =
    ctx.couponDiscount > 0 ? allocateByWeights(ctx.couponDiscount, grossPerDay) : grossPerDay.map(() => 0);

  // ---- 三方分成：服务费按 70/10/20 落到每日 ----
  const serviceRevenue = grossPerDay;
  const ownerShare = allocateByWeights(ctx.ownerShareEarn, serviceRevenue);
  const propertyShare = allocateByWeights(ctx.propertyFee, serviceRevenue);
  const platformShare = allocateByWeights(ctx.platformServiceEarn, serviceRevenue);

  // 业主自担补偿（业主回家 20 元）：按业主分成从高到低扣，扣不动的缺口转该日平台垫付
  const ownerCompDeduct = allocateByWeights(ctx.ownerPaysComp, ownerShare);
  // 经托管池给业主的错停补偿（30 元）：随违约金当日
  const ownerCompFromPool = new Array(slices.length).fill(0);
  if (ctx.ownerCompFromPool > 0) {
    ownerCompFromPool[sliceIndexAt(slices, ctx.fineAt?.getTime() ?? occFrom)] = ctx.ownerCompFromPool;
  }
  // 陌生车场景平台先行赔付业主（30 元）：随陌生车占用事件当日
  const strangerAdvance = new Array(slices.length).fill(0);
  const stranger = ctx.incidents.find((i) => i.type === 'stranger_occupy' || i.type === 'ice_occupy_charger');
  if (ctx.strangerAdvance > 0) {
    strangerAdvance[sliceIndexAt(slices, new Date(stranger?.started_at ?? ctx.usableFrom).getTime())] =
      ctx.strangerAdvance;
  }
  // 违约金余额归平台（20 元处理费）：随违约金当日
  const fineResidual = new Array(slices.length).fill(0);
  if (ctx.fineResidual > 0) {
    fineResidual[sliceIndexAt(slices, ctx.fineAt?.getTime() ?? exitTo)] = ctx.fineResidual;
  }
  // 平台直接承担的车主现金补偿（陌生车场景 20 元）：随异常发生当日
  const driverCash = new Array(slices.length).fill(0);
  if (ctx.platformDriverCash > 0) {
    driverCash[sliceIndexAt(slices, new Date(stranger?.started_at ?? ctx.usableFrom).getTime())] =
      ctx.platformDriverCash;
  }

  // ---- 组装每段 ----
  return slices.map((s, i) => {
    // 业主收益口径与结算单 owner_income 列一致：分成（扣自担补偿）+ 经托管池的错停补偿；
    // 陌生车场景平台绕过托管的垫付不计入本列，只在来源说明与平台段体现。
    const ownerNet = round2(ownerShare[i] - Math.min(ownerShare[i], ownerCompDeduct[i]) + ownerCompFromPool[i]);
    const compShortfall = round2(Math.max(0, ownerCompDeduct[i] - ownerShare[i]));
    const platformNet = round2(platformShare[i] + fineResidual[i] - compShortfall - strangerAdvance[i] - driverCash[i]);

    const sources: SplitSource[] = [];
    if (baseFees[i] > 0) sources.push({ kind: 'parking', label: '基础停车费（按时长）', amount: baseFees[i] });
    if (chargingFees[i] > 0) sources.push({ kind: 'charging', label: '充电服务费', amount: chargingFees[i] });
    if (overtimeFees[i] > 0) sources.push({ kind: 'overtime', label: '访客超时费（1.5×）', amount: overtimeFees[i] });
    if (fineFees[i] > 0) sources.push({ kind: 'fine', label: '错停违约金', amount: fineFees[i] });
    if (couponSplit[i] > 0) sources.push({ kind: 'coupon', label: '优惠券抵扣（券池出资）', amount: couponSplit[i] });

    // 异常/调度事件在该段内的费用来源标注
    const inSlice = (t?: Date | null) =>
      !!t && t.getTime() >= s.from.getTime() && t.getTime() <= s.to.getTime();
    for (const inc of ctx.incidents) {
      if (inc.type === 'manual_release' && inSlice(inc.started_at)) {
        sources.push({ kind: 'manual_release', label: '物业人工放行入场（不产生额外费用）', at: inc.started_at ?? null });
      }
      if (inc.type === 'wrong_parking' && inSlice(inc.started_at)) {
        const actual = inc.detail?.actual;
        sources.push({
          kind: 'spot_change',
          label: actual
            ? `换位：实际停于 ${actual}，预约 ${ctx.reservedSpotCode}（违约金按发生日入账）`
            : `换位/错停：预约 ${ctx.reservedSpotCode}（违约金按发生日入账）`,
          at: inc.started_at ?? null,
        });
      }
      if ((inc.type === 'stranger_occupy' || inc.type === 'ice_occupy_charger') && inSlice(inc.started_at)) {
        sources.push({ kind: 'stranger', label: '异常占用：该段服务费免收，平台先行赔付并向肇事车主追缴', at: inc.started_at ?? null });
      }
      if (inc.type === 'owner_return' && inSlice(inc.started_at)) {
        sources.push({ kind: 'owner_return', label: '业主临时回家：服务提前终止，按实际占用计费并补偿车主', at: inc.started_at ?? null });
      }
      if (inc.type === 'weak_signal' && inSlice(inc.started_at)) {
        sources.push({ kind: 'weak_signal', label: '地下车库信号差：赔付券（非现金，下次抵扣）', at: inc.started_at ?? null });
      }
    }
    if (ownerCompFromPool[i] > 0) {
      sources.push({ kind: 'compensation', label: '车主违约金中补偿业主', amount: ownerCompFromPool[i] });
    }
    if (strangerAdvance[i] > 0) {
      sources.push({ kind: 'compensation', label: '平台先行赔付业主（向陌生车主追缴）', amount: strangerAdvance[i] });
    }
    if (driverCash[i] > 0) {
      sources.push({ kind: 'compensation', label: '平台先行现金补偿车主（向陌生车主追缴）', amount: driverCash[i] });
    }
    if (ownerShare[i] + propertyShare[i] + platformShare[i] > 0) {
      sources.push({ kind: 'share', label: `净服务费分成：业主 70% ¥${ownerShare[i]} / 物业 10% ¥${propertyShare[i]} / 平台 20% ¥${platformShare[i]}` });
    }

    return {
      settlementDate: s.date,
      from: s.from,
      to: s.to,
      durationMinutes: durations[i],
      spotCode: ctx.reservedSpotCode,
      baseFee: baseFees[i],
      chargingFee: chargingFees[i],
      overtimeFee: overtimeFees[i],
      wrongParkFine: fineFees[i],
      couponDiscount: couponSplit[i],
      serviceRevenue: serviceRevenue[i],
      ownerIncome: ownerNet,
      propertyFee: propertyShare[i],
      platformFee: platformNet,
      sources,
    };
  });
}

function sliceIndexAt(slices: { from: Date; to: Date }[], ms: number): number {
  const idx = slices.findIndex((s) => ms >= s.from.getTime() && ms < s.to.getTime());
  if (idx >= 0) return idx;
  // 落在边界外（如超时离场于最后一段之后）归最后一段
  return ms < slices[0].from.getTime() ? 0 : slices.length - 1;
}
