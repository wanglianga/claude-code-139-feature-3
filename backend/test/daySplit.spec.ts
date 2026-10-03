import { dayKeyOf, splitByDay, splitSettlementDays, splitTotalsMatch, DaySplitInput } from '../src/domain/daySplit';

// 本地时间构造，避免时区差异
const T = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0);

const baseInput: DaySplitInput = {
  usableFrom: T(2026, 10, 1, 22, 0), // 22:00 入场
  billableEnd: T(2026, 10, 2, 2, 0), // 次日 02:00 离场（跨两个结算日）
  baseFee: 20, // 4 小时 × 5 元
  chargingFee: 0,
  overtimeFee: 0,
  ownerShare: 0.7,
  propertyShare: 0.1,
  sources: [],
};

describe('splitByDay / dayKeyOf', () => {
  test('跨日区间按 00:00 切成两段，段边界连续', () => {
    const spans = splitByDay(T(2026, 10, 1, 22, 0), T(2026, 10, 2, 2, 0));
    expect(spans.length).toBe(2);
    expect(dayKeyOf(spans[0].from)).toBe('2026-10-01');
    expect(dayKeyOf(spans[1].from)).toBe('2026-10-02');
    expect(spans[0].to.getTime()).toBe(spans[1].from.getTime());
    expect(spans[0].to.getHours()).toBe(0);
  });

  test('单日区间只有一段', () => {
    const spans = splitByDay(T(2026, 10, 1, 20, 0), T(2026, 10, 1, 23, 30));
    expect(spans.length).toBe(1);
  });
});

describe('splitSettlementDays 跨日分账', () => {
  test('凌晨离场跨两个结算日：按实际占用分钟拆分业主收益与物业服务费', () => {
    const segs = splitSettlementDays(baseInput);
    expect(segs.length).toBe(2);
    // 第一段 22:00-24:00 = 120 分钟，第二段 00:00-02:00 = 120 分钟
    expect(segs[0].minutes).toBe(120);
    expect(segs[1].minutes).toBe(120);
    // 基础费 20 元按 1:1 拆分
    expect(segs[0].baseFee).toBe(10);
    expect(segs[1].baseFee).toBe(10);
    // 每段独立计提 业主 70% / 物业 10% / 平台 20%
    expect(segs[0].ownerIncome).toBe(7);
    expect(segs[0].propertyFee).toBe(1);
    expect(segs[0].platformFee).toBe(2);
    expect(splitTotalsMatch(segs, { baseFee: 20, chargingFee: 0, overtimeFee: 0 })).toBe(true);
  });

  test('不等长占用按分钟占比分摊，合计守恒（末段吸收舍入）', () => {
    const segs = splitSettlementDays({
      ...baseInput,
      usableFrom: T(2026, 10, 1, 23, 0), // 23:00-02:00 = 60 + 120 分钟
      baseFee: 15.01, // 故意制造舍入
    });
    expect(segs[0].minutes).toBe(60);
    expect(segs[1].minutes).toBe(120);
    expect(segs[0].baseFee + segs[1].baseFee).toBeCloseTo(15.01, 2);
    expect(splitTotalsMatch(segs, { baseFee: 15.01, chargingFee: 0, overtimeFee: 0 })).toBe(true);
    // 三段分成逐段自洽：业主+物业+平台 = 段服务费
    for (const s of segs) {
      expect(s.ownerIncome + s.propertyFee + s.platformFee).toBeCloseTo(s.serviceRevenue, 2);
    }
  });

  test('充电费按充电会话时间归属到对应结算日', () => {
    const segs = splitSettlementDays({
      ...baseInput,
      chargingFee: 24,
      chargingAt: T(2026, 10, 1, 23, 30), // 充电发生在首日
    });
    expect(segs[0].chargingFee).toBe(24);
    expect(segs[1].chargingFee).toBe(0);
    expect(splitTotalsMatch(segs, { baseFee: 20, chargingFee: 24, overtimeFee: 0 })).toBe(true);
  });

  test('超时费归入超时区间所在结算日', () => {
    const segs = splitSettlementDays({
      ...baseInput,
      overtimeFee: 7.5,
      overtimeFrom: T(2026, 10, 2, 1, 50), // 超时发生在次日
      overtimeTo: T(2026, 10, 2, 2, 0),
    });
    expect(segs[0].overtimeFee).toBe(0);
    expect(segs[1].overtimeFee).toBe(7.5);
    expect(splitTotalsMatch(segs, { baseFee: 20, chargingFee: 0, overtimeFee: 7.5 })).toBe(true);
  });

  test('费用来源按发生时间归属：优惠券/人工放行在首日，换位在次日', () => {
    const segs = splitSettlementDays({
      ...baseInput,
      sources: [
        { type: 'coupon', label: '优惠券抵扣 ¥10', amount: 10, at: T(2026, 10, 1, 21, 55) },
        { type: 'manual_release', label: '物业人工放行', at: T(2026, 10, 1, 22, 0) },
        { type: 'spot_swap', label: '换位调度：B2-108 → B2-109', at: T(2026, 10, 2, 0, 30) },
      ],
    });
    expect(segs[0].sources.map((s) => s.type)).toEqual(['coupon', 'manual_release']);
    expect(segs[1].sources.map((s) => s.type)).toEqual(['spot_swap']);
  });

  test('全额免单（0 分钟）仍产出一段承载费用来源，金额全 0', () => {
    const segs = splitSettlementDays({
      ...baseInput,
      billableEnd: T(2026, 10, 1, 22, 0), // 与 usableFrom 相同 → 无计费区间
      baseFee: 0,
      sources: [{ type: 'stranger_occupy', label: '陌生车占用', at: T(2026, 10, 1, 22, 0) }],
    });
    expect(segs.length).toBe(1);
    expect(segs[0].minutes).toBe(0);
    expect(segs[0].serviceRevenue).toBe(0);
    expect(segs[0].sources.length).toBe(1);
  });
});
