import { settlePrice, SettlementBreakdown } from '../src/domain/pricing';
import { slicesBySettlementDay, allocateByWeights, settlementDayLabel } from '../src/domain/daysplit';

// 跨日锚点（UTC）：2026-10-01 15:00Z = 北京时间 23:00，离场 2026-10-02 02:00Z = 北京时间 10:00
const ENTRY = new Date('2026-10-01T15:00:00Z'); // 10-01 23:00 +08
const MID = new Date('2026-10-01T16:00:00Z'); // 10-02 00:00 +08（日界）
const EXIT = new Date('2026-10-02T02:00:00Z'); // 10-02 10:00 +08

const crossDayInput = {
  reservedStart: ENTRY,
  reservedEnd: EXIT,
  actualEntry: ENTRY,
  actualExit: EXIT,
  usableFrom: ENTRY,
  hourlyRate: 5,
  overnightCap: 45,
  isNewEnergy: false,
  chargeKwh: 0,
  incidents: [],
  ruling: null,
  couponAmount: 0,
  prepaid: 45,
  reservedSpotCode: 'B2-108',
};

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

describe('跨日分账拆分', () => {
  test('东八区午夜切出两个结算日（60 分钟 + 600 分钟）', () => {
    const slices = slicesBySettlementDay(ENTRY, EXIT);
    expect(slices.map((s) => s.date)).toEqual(['2026-10-01', '2026-10-02']);
    expect(slices[0].from.getTime()).toBe(ENTRY.getTime());
    expect(slices[0].to.getTime()).toBe(MID.getTime());
    expect(slices[1].to.getTime()).toBe(EXIT.getTime());
    expect(settlementDayLabel(MID.getTime() - 1)).toBe('2026-10-01');
    expect(settlementDayLabel(MID.getTime())).toBe('2026-10-02');
  });

  test('最大余数法分摊之和严格等于总额（含 1 分钱校正）', () => {
    const a = allocateByWeights(45, [60, 600]);
    expect(r2(sum(a))).toBe(45);
    const b = allocateByWeights(31.5, [60, 600]);
    expect(r2(sum(b))).toBe(31.5);
    const c = allocateByWeights(10, [1, 1, 1]);
    expect(c.map((x) => r2(x))).toEqual([3.34, 3.33, 3.33]);
    expect(r2(sum(c))).toBe(10);
    // 无权重时金额挂第一段，不丢钱
    expect(allocateByWeights(7, [0, 0])).toEqual([7, 0]);
  });

  test('夜间封顶总额按时长拆到两个结算日，分段合计等于账单', () => {
    const r = settlePrice(crossDayInput as any);
    expect(r.baseFee).toBe(45); // 13 小时 ×5=65 被封顶
    expect(r.splits).toHaveLength(2);
    expect(r.splits[0].durationMinutes).toBe(60);
    expect(r.splits[1].durationMinutes).toBe(600);
    expect(r2(sum(r.splits.map((s) => s.baseFee)))).toBe(45);
    expect(r2(sum(r.splits.map((s) => s.ownerIncome)))).toBe(r.ownerIncome);
    expect(r2(sum(r.splits.map((s) => s.propertyFee)))).toBe(r.propertyFee);
    expect(r2(sum(r.splits.map((s) => s.platformFee)))).toBe(r.platformFee);
    expect(r2(sum(r.splits.map((s) => s.serviceRevenue)))).toBe(45);
    // 两段业主/物业/平台收益比例仍为 70/10/20
    expect(r2(sum(r.splits.map((s) => s.ownerIncome)))).toBe(31.5);
    expect(r2(sum(r.splits.map((s) => s.propertyFee)))).toBe(4.5);
    expect(r2(sum(r.splits.map((s) => s.platformFee)))).toBe(9);
  });

  test('优惠券抵扣按各日服务费占比拆分，券池出资可追溯', () => {
    const r = settlePrice({ ...crossDayInput, couponAmount: 10, prepaid: 35 } as any);
    expect(r.couponDiscount).toBe(10);
    expect(r2(sum(r.splits.map((s) => s.couponDiscount)))).toBe(10);
    expect(r.splits.some((s) => s.sources.some((x) => x.kind === 'coupon'))).toBe(true);
    // 各段净服务费分成仍按 70/10/20 且合计与结算单一致
    expect(r2(sum(r.splits.map((s) => s.ownerIncome)))).toBe(r.ownerIncome);
    expect(r2(sum(r.splits.map((s) => s.propertyFee)))).toBe(r.propertyFee);
  });

  test('错停（换位）违约金与业主补偿归到错停发生当日，费用来源标注换位', () => {
    const r = settlePrice({
      ...crossDayInput,
      incidents: [{ type: 'wrong_parking', started_at: ENTRY, detail: { actual: 'B2-109' } }],
      ruling: 'driver_fault',
    } as any);
    expect(r.wrongParkFine).toBe(50);
    expect(r.splits[0].wrongParkFine).toBe(50); // 错停发生在 23:00（第一结算日）
    expect(r.splits[1].wrongParkFine).toBe(0);
    const changeSrc = r.splits[0].sources.find((s) => s.kind === 'spot_change');
    expect(changeSrc?.label).toContain('B2-109');
    expect(r2(sum(r.splits.map((s) => s.wrongParkFine)))).toBe(50);
    expect(r2(sum(r.splits.map((s) => s.ownerIncome)))).toBe(r.ownerIncome);
    expect(r2(sum(r.splits.map((s) => s.platformFee)))).toBe(r.platformFee);
  });

  test('物业人工放行入场在费用来源中标注但不产生额外费用', () => {
    const r = settlePrice({
      ...crossDayInput,
      incidents: [{ type: 'manual_release', started_at: ENTRY }],
    } as any);
    expect(r.splits[0].sources.some((s) => s.kind === 'manual_release')).toBe(true);
    expect(r.baseFee).toBe(45);
  });

  test('访客凌晨超时：超时费归到离场当日', () => {
    const later = new Date(EXIT.getTime() + 60 * 60000); // 再多停 60 分钟
    const r = settlePrice({
      ...crossDayInput,
      reservedEnd: EXIT,
      actualExit: later,
      incidents: [{ type: 'visitor_overstay' }],
    } as any);
    expect(r.overtimeFee).toBeGreaterThan(0);
    expect(r2(sum(r.splits.map((s) => s.overtimeFee)))).toBe(r.overtimeFee);
    expect(r.splits[1].overtimeFee).toBe(r.overtimeFee);
    expect(r2(sum(r.splits.map((s) => s.baseFee)))).toBe(r.baseFee);
  });

  test('陌生车占用：两段均无服务费，平台赔付与追缴体现在占用当日', () => {
    const r = settlePrice({
      ...crossDayInput,
      incidents: [{ type: 'stranger_occupy', started_at: ENTRY }],
      ruling: 'stranger',
    } as any);
    expect(r2(sum(r.splits.map((s) => s.baseFee)))).toBe(0);
    expect(r2(sum(r.splits.map((s) => s.ownerIncome)))).toBe(0);
    expect(r2(sum(r.splits.map((s) => s.platformFee)))).toBe(r.platformFee);
    expect(r.splits[0].sources.some((s) => s.kind === 'stranger')).toBe(true);
    // 平台当日段体现先行赔付车主与业主
    expect(r.splits[0].platformFee).toBeLessThan(0);
  });

  test('业主凌晨 00:30 回家：按实际占用两段拆分，业主收益扣减与补偿合计正确', () => {
    const homeAt = new Date(MID.getTime() + 30 * 60000); // 北京 00:30
    const r = settlePrice({
      ...crossDayInput,
      overnightCap: null,
      incidents: [{ type: 'owner_return', started_at: homeAt }],
      ruling: 'owner_fault',
      actualExit: homeAt,
    } as any);
    // 90 分钟 ×5 = 7.5
    expect(r.baseFee).toBe(7.5);
    expect(r.splits).toHaveLength(2);
    expect(r.splits[0].durationMinutes).toBe(60);
    expect(r.splits[1].durationMinutes).toBe(30);
    expect(r2(sum(r.splits.map((s) => s.baseFee)))).toBe(7.5);
    expect(r2(sum(r.splits.map((s) => s.ownerIncome)))).toBe(r.ownerIncome);
    expect(r2(sum(r.splits.map((s) => s.platformFee)))).toBe(r.platformFee);
    expect(r.splits[1].sources.some((s) => s.kind === 'owner_return')).toBe(true);
  });

  test('不跨日订单只有一个分段，且各列与结算单完全相等', () => {
    const r = settlePrice({
      reservedStart: new Date('2026-10-01T12:00:00Z'),
      reservedEnd: new Date('2026-10-01T14:00:00Z'),
      actualEntry: new Date('2026-10-01T12:00:00Z'),
      actualExit: new Date('2026-10-01T14:00:00Z'),
      usableFrom: new Date('2026-10-01T12:00:00Z'),
      hourlyRate: 5, overnightCap: null, isNewEnergy: false, chargeKwh: 0,
      incidents: [], ruling: null, couponAmount: 0, prepaid: 10,
    });
    expect(r.splits).toHaveLength(1);
    const s = r.splits[0];
    expect(s.baseFee).toBe(r.baseFee);
    expect(s.ownerIncome).toBe(r.ownerIncome);
    expect(s.propertyFee).toBe(r.propertyFee);
    expect(s.platformFee).toBe(r.platformFee);
  });
});
