// 跨日分账：车辆凌晨离场、订单跨越两个结算日时，
// 按实际占用时段把基础停车费/充电费/超时费拆分到每个结算日，
// 并按 业主 70% / 物业 10% / 平台 20% 逐段清算，同时标注每段费用来源
// （换位调度、优惠券抵扣、物业人工放行、业主回家、陌生车占用等）。

export interface FeeSource {
  type:
    | 'coupon' // 优惠券抵扣
    | 'manual_release' // 物业人工放行
    | 'spot_swap' // 换位调度
    | 'owner_return' // 业主临时回家
    | 'stranger_occupy' // 陌生车/燃油车占用
    | 'weak_signal' // 地下车库信号差
    | 'wrong_parking' // 错停核验
    | 'overstay' // 访客超时
    | 'charging'; // 充电服务
  label: string;
  amount?: number;
  at?: Date | null;
}

export interface DaySplitInput {
  usableFrom: Date; // 实际可使用时点
  billableEnd: Date; // 计费截止（业主回家提前终止 / 道闸离场时间）
  baseFee: number; // 结算单基础停车费（已应用夜间封顶）
  chargingFee: number; // 充电服务费
  chargingAt?: Date | null; // 充电会话时间（决定费用归属日），缺省按分钟占比分摊
  overtimeFee: number; // 访客超时费
  overtimeFrom?: Date | null; // 超时起算点（预约结束 + 宽限）
  overtimeTo?: Date | null; // 实际离场时间
  ownerShare: number; // 0.7
  propertyShare: number; // 0.1
  sources?: FeeSource[]; // 费用来源事件，按发生时间归属到对应结算日段
}

export interface DaySegment {
  settlementDate: string; // 结算日 YYYY-MM-DD（服务器本地自然日）
  from: Date;
  to: Date;
  minutes: number;
  baseFee: number;
  chargingFee: number;
  overtimeFee: number;
  serviceRevenue: number; // 该段服务费收入合计
  ownerIncome: number; // 业主收益 70%
  propertyFee: number; // 物业服务费 10%
  platformFee: number; // 平台抽成（差额，吸收舍入）
  sources: FeeSource[]; // 该段费用来源
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** 本地自然日键：YYYY-MM-DD */
export function dayKeyOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 把 [from, to] 按本地自然日 00:00 切成互不重叠的区间 */
export function splitByDay(from: Date, to: Date): Array<{ from: Date; to: Date }> {
  const out: Array<{ from: Date; to: Date }> = [];
  if (!(to.getTime() > from.getTime())) return out;
  let cursor = new Date(from);
  while (cursor.getTime() < to.getTime()) {
    const nextMidnight = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1, 0, 0, 0, 0);
    const segEnd = nextMidnight.getTime() < to.getTime() ? nextMidnight : to;
    out.push({ from: new Date(cursor), to: new Date(segEnd) });
    cursor = segEnd;
  }
  return out;
}

/** 把金额按各段分钟占比分摊（末段吸收舍入误差，保证合计守恒） */
function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || total === 0) return weights.map(() => 0);
  const parts = weights.map((w) => round2((total * w) / sum));
  const drift = round2(total - parts.reduce((a, b) => a + b, 0));
  // 把舍入差补到最后一个非零权重段
  for (let i = weights.length - 1; i >= 0; i--) {
    if (weights[i] > 0) {
      parts[i] = round2(parts[i] + drift);
      break;
    }
  }
  return parts;
}

export function splitSettlementDays(input: DaySplitInput): DaySegment[] {
  const spans = splitByDay(input.usableFrom, input.billableEnd);
  // 无有效计费区间（全额免单等）时，仍生成一条 0 分钟段承载费用来源
  const effective =
    spans.length > 0
      ? spans
      : [{ from: new Date(input.usableFrom), to: new Date(input.usableFrom) }];

  const minutesOf = effective.map((s) => Math.max(0, Math.round((s.to.getTime() - s.from.getTime()) / 60000)));
  const baseParts = allocate(round2(input.baseFee), minutesOf);

  // 充电费：有会话时间则归该日段，否则按分钟占比分摊
  let chargingParts: number[];
  const chargingFee = round2(input.chargingFee);
  if (chargingFee > 0 && input.chargingAt) {
    const key = dayKeyOf(input.chargingAt);
    chargingParts = effective.map((s) => (dayKeyOf(s.from) === key ? chargingFee : 0));
    if (!chargingParts.some((p) => p > 0)) chargingParts = allocate(chargingFee, minutesOf);
  } else {
    chargingParts = allocate(chargingFee, minutesOf);
  }

  // 超时费：按超时区间自身跨日情况拆分后归入对应日段
  const overtimeFee = round2(input.overtimeFee);
  const overtimeParts = effective.map(() => 0);
  if (overtimeFee > 0) {
    const oFrom = input.overtimeFrom ?? input.billableEnd;
    const oTo = input.overtimeTo ?? input.billableEnd;
    const oSpans = splitByDay(oFrom, oTo);
    if (oSpans.length === 0) {
      // 无明确超时区间：归入计费截止所在日
      const key = dayKeyOf(input.billableEnd);
      const idx = effective.findIndex((s) => dayKeyOf(s.from) === key);
      overtimeParts[idx >= 0 ? idx : effective.length - 1] = overtimeFee;
    } else {
      const oMinutes = oSpans.map((s) => Math.max(0, Math.round((s.to.getTime() - s.from.getTime()) / 60000)));
      const oAlloc = allocate(overtimeFee, oMinutes);
      oSpans.forEach((s, i) => {
        const key = dayKeyOf(s.from);
        const idx = effective.findIndex((e) => dayKeyOf(e.from) === key);
        overtimeParts[idx >= 0 ? idx : effective.length - 1] = round2(
          overtimeParts[idx >= 0 ? idx : effective.length - 1] + oAlloc[i],
        );
      });
    }
  }

  // 费用来源按发生时间归属到对应结算日段（无时间的归首段）
  const sourceBuckets: FeeSource[][] = effective.map(() => []);
  for (const src of input.sources ?? []) {
    let idx = 0;
    if (src.at) {
      const key = dayKeyOf(src.at);
      const found = effective.findIndex((s) => dayKeyOf(s.from) === key);
      idx = found >= 0 ? found : 0;
    }
    sourceBuckets[idx].push(src);
  }

  return effective.map((s, i) => {
    const serviceRevenue = round2(baseParts[i] + chargingParts[i] + overtimeParts[i]);
    const ownerIncome = round2(serviceRevenue * input.ownerShare);
    const propertyFee = round2(serviceRevenue * input.propertyShare);
    const platformFee = round2(serviceRevenue - ownerIncome - propertyFee);
    return {
      settlementDate: dayKeyOf(s.from),
      from: s.from,
      to: s.to,
      minutes: minutesOf[i],
      baseFee: baseParts[i],
      chargingFee: chargingParts[i],
      overtimeFee: overtimeParts[i],
      serviceRevenue,
      ownerIncome,
      propertyFee,
      platformFee,
      sources: sourceBuckets[i],
    };
  });
}

/** 校验拆分结果与结算单总额守恒（单元测试与落库前自检用） */
export function splitTotalsMatch(
  segments: DaySegment[],
  totals: { baseFee: number; chargingFee: number; overtimeFee: number },
): boolean {
  const sum = (k: 'baseFee' | 'chargingFee' | 'overtimeFee') => round2(segments.reduce((a, s) => a + s[k], 0));
  return (
    sum('baseFee') === round2(totals.baseFee) &&
    sum('chargingFee') === round2(totals.chargingFee) &&
    sum('overtimeFee') === round2(totals.overtimeFee)
  );
}
