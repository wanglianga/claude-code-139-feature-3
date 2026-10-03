import { settlePrice, SHARES, PRICING } from '../src/domain/pricing';

const baseInput = {
  reservedStart: new Date('2026-10-01T19:00:00Z'),
  reservedEnd: new Date('2026-10-02T08:00:00Z'),
  actualEntry: new Date('2026-10-01T19:00:00Z'),
  actualExit: new Date('2026-10-02T08:00:00Z'),
  usableFrom: new Date('2026-10-01T19:00:00Z'),
  hourlyRate: 5,
  overnightCap: 45,
  isNewEnergy: true,
  chargeKwh: 20,
  incidents: [],
  ruling: null,
  couponAmount: 0,
  prepaid: 45,
};

describe('settlePrice', () => {
  test('夜间封顶：13 小时 × 5 元应被 45 元封顶', () => {
    const r = settlePrice({ ...baseInput, chargeKwh: 0, prepaid: 45 });
    expect(r.baseFee).toBe(45);
    expect(r.payable).toBe(45);
    expect(r.exitCharge).toBe(0);
    expect(r.refund).toBe(0);
  });

  test('充电费按 kWh 单价另计', () => {
    const r = settlePrice({ ...baseInput, chargeKwh: 20 });
    expect(r.chargingFee).toBeCloseTo(24, 2);
    expect(r.payable).toBe(69);
  });

  test('超时 30 分钟以上按 1.5× 计超时费且信用 -3', () => {
    const r = settlePrice({
      ...baseInput,
      chargeKwh: 0,
      incidents: [{ type: 'visitor_overstay' }],
      actualExit: new Date('2026-10-02T09:00:00Z'), // 超 60 分钟，宽限 10 分钟后 50 分钟
    });
    const expectedOvertime = Math.round(((50 / 60) * 5 * 1.5) * 100) / 100;
    expect(r.overtimeFee).toBe(expectedOvertime);
    expect(r.creditTarget).toBe('driver');
    expect(r.creditDelta).toBe(-3);
  });

  test('业主临时回家：按实际时长计费 + 补偿车主，业主收益扣减，业主信用 -5', () => {
    const r = settlePrice({
      ...baseInput,
      chargeKwh: 0,
      overnightCap: null,
      incidents: [{ type: 'owner_return', started_at: new Date('2026-10-01T22:00:00Z') }],
      ruling: 'owner_fault',
      actualExit: new Date('2026-10-01T22:00:00Z'),
      prepaid: 45,
    });
    expect(r.durationMinutes).toBe(180);
    expect(r.baseFee).toBe(15);
    expect(r.abnormalCompensation).toBeGreaterThanOrEqual(PRICING.ownerReturnCompensation);
    expect(r.creditTarget).toBe('owner');
    expect(r.creditDelta).toBe(-5);
    // 预付 45，实际使用费 15，业主现金补偿 20：应付 0，退款 = 45 - (15-20) = 50
    expect(r.payable).toBe(0);
    expect(r.refund).toBe(50);
  });

  test('车主错停：违约金 + 业主补偿 + 信用 -10', () => {
    const r = settlePrice({
      ...baseInput,
      chargeKwh: 0,
      incidents: [{ type: 'wrong_parking' }],
      ruling: 'driver_fault',
      prepaid: 45,
    });
    expect(r.wrongParkFine).toBe(50);
    expect(r.ownerCompensation).toBe(30);
    expect(r.creditDelta).toBe(-10);
    // 流水里必须有业主补偿
    expect(r.ledger.some((l) => l.account === 'owner' && l.memo.includes('错停补偿'))).toBe(true);
  });

  test('陌生车占用：平台兜底补偿车主与业主，向陌生车主追责标记', () => {
    const r = settlePrice({
      ...baseInput,
      chargeKwh: 0,
      incidents: [{ type: 'stranger_occupy' }],
      ruling: 'stranger',
    });
    expect(r.abnormalCompensation).toBeGreaterThan(0);
    expect(r.ownerCompensation).toBeGreaterThan(0);
    // 平台分成被扣减（可能为负的垫付）
    expect(r.notes.some((n) => n.includes('追缴'))).toBe(true);
  });

  test('优惠券抵扣不超过应收，且出现在资金流水', () => {
    const r = settlePrice({ ...baseInput, chargeKwh: 0, couponAmount: 60, prepaid: 0 });
    expect(r.couponDiscount).toBe(45);
    expect(r.payable).toBe(0);
    expect(r.ledger.some((l) => l.account === 'coupon_pool')).toBe(true);
  });

  test('三方分成比例为 70/10/20', () => {
    expect(SHARES.owner).toBe(0.7);
    expect(SHARES.property).toBe(0.1);
    expect(SHARES.platform).toBe(0.2);
    const r = settlePrice({ ...baseInput, chargeKwh: 0, couponAmount: 0, prepaid: 45 });
    // 净收入池 45：业主 31.5，物业 4.5，平台 9
    expect(r.ownerIncome).toBe(31.5);
    expect(r.propertyFee).toBe(4.5);
    expect(r.platformFee).toBe(9);
  });

  test('平台全责：费用全免、预付退还、不扣车主信用', () => {
    const r = settlePrice({
      ...baseInput,
      chargeKwh: 0,
      incidents: [{ type: 'recognition_fail' }],
      ruling: 'platform_fault',
      prepaid: 45,
    });
    expect(r.baseFee).toBe(0);
    expect(r.payable).toBe(0);
    expect(r.refund).toBe(45);
    expect(r.creditDelta).toBe(0);
  });

  test('退款单已先行退还的金额不再重复退款（避免重复冲销），流水仍平衡', () => {
    const r = settlePrice({
      ...baseInput,
      chargeKwh: 0,
      ruling: 'platform_fault',
      prepaid: 45,
      externalRefunded: 45, // 退款单已退 45
    });
    expect(r.refund).toBe(0); // 不再重复退
    expect(r.notes.some((n) => n.includes('不再重复退款'))).toBe(true);
    const debit = r.ledger.filter((l) => l.direction === 'debit').reduce((a, b) => a + b.amount, 0);
    const credit = r.ledger.filter((l) => l.direction === 'credit').reduce((a, b) => a + b.amount, 0);
    expect(Math.abs(debit - credit)).toBeLessThanOrEqual(0.05);
    // 托管不再把已外部退还的部分分给平台
    expect(r.ledger.some((l) => l.account === 'platform' && l.direction === 'credit' && l.amount >= 45)).toBe(false);
  });

  test('资金流水借贷平衡（车主净付 = 各方净收）', () => {
    const cases = [
      { ...baseInput },
      { ...baseInput, ruling: 'driver_fault', incidents: [{ type: 'wrong_parking' }] },
      { ...baseInput, ruling: 'owner_fault', incidents: [{ type: 'owner_return', started_at: baseInput.reservedStart }] },
      { ...baseInput, ruling: 'stranger', incidents: [{ type: 'stranger_occupy' }], couponAmount: 10 },
    ];
    for (const c of cases) {
      const r = settlePrice(c as any);
      const debit = r.ledger.filter((l) => l.direction === 'debit').reduce((a, b) => a + b.amount, 0);
      const credit = r.ledger.filter((l) => l.direction === 'credit').reduce((a, b) => a + b.amount, 0);
      // 借方总额（车主+平台垫付）与贷方总额（含预付冲抵）允许 1 分钱舍入误差
      expect(Math.abs(debit - credit)).toBeLessThanOrEqual(0.05);
    }
  });
});
