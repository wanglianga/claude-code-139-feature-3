import { settlePrice, SettlementBreakdown } from '../src/domain/pricing';
import { planReversal, planSimpleRefund, accountNets } from '../src/domain/reversal';

const baseInput = {
  reservedStart: new Date('2026-10-01T11:00:00Z'),
  reservedEnd: new Date('2026-10-02T00:00:00Z'),
  actualEntry: new Date('2026-10-01T11:00:00Z'),
  actualExit: new Date('2026-10-02T00:00:00Z'),
  usableFrom: new Date('2026-10-01T11:00:00Z'),
  hourlyRate: 5,
  overnightCap: 45,
  isNewEnergy: false,
  chargeKwh: 0,
  incidents: [] as any[],
  ruling: null,
  couponAmount: 0,
  prepaid: 45,
};

const netOf = (b: SettlementBreakdown, acc: string) =>
  accountNets(b).find((x) => x.account === acc)?.net ?? 0;

const balanced = (b: SettlementBreakdown) => {
  const d = b.ledger.filter((l) => l.direction === 'debit').reduce((a, x) => a + x.amount, 0);
  const c = b.ledger.filter((l) => l.direction === 'credit').reduce((a, x) => a + x.amount, 0);
  return Math.abs(d - c) <= 0.02;
};

describe('结算后冲正单', () => {
  test('原判车主责任 -> 终判陌生车：平台退回车主违约金并先行赔付，业主收益变化对称', () => {
    const oldB = settlePrice({
      ...baseInput,
      incidents: [{ type: 'wrong_parking', started_at: baseInput.actualEntry }],
      ruling: 'driver_fault',
    });
    const newB = settlePrice({
      ...baseInput,
      incidents: [
        { type: 'wrong_parking', started_at: baseInput.actualEntry },
        { type: 'stranger_occupy', started_at: baseInput.actualEntry },
      ],
      ruling: 'stranger',
    });
    const plan = planReversal(oldB, newB, 'appeal_ruling');

    expect(plan.balanced).toBe(true);
    expect(plan.oldRuling).toBe('driver_fault');
    expect(plan.newRuling).toBe('stranger');
    // 车主应被补退（原付 50 违约金，新分账应付 0 且收 20 补偿）
    expect(plan.driverCashDelta).toBeGreaterThan(0);
    // 信用净调整：撤销车主 -10
    expect(plan.creditAdjustments).toContainEqual({ target: 'driver', delta: 10 });
  });

  test('原判车主责任 -> 终判业主责任：业主收益被追回，车主拿到补退', () => {
    const oldB = settlePrice({
      ...baseInput,
      overnightCap: null,
      incidents: [{ type: 'wrong_parking', started_at: baseInput.actualEntry }],
      ruling: 'driver_fault',
    });
    const homeAt = new Date(baseInput.actualEntry.getTime() + 180 * 60000);
    const newB = settlePrice({
      ...baseInput,
      overnightCap: null,
      incidents: [{ type: 'owner_return', started_at: homeAt }],
      ruling: 'owner_fault',
      actualExit: homeAt,
    });
    const plan = planReversal(oldB, newB, 'appeal_ruling');
    expect(plan.balanced).toBe(true);
    expect(plan.ownerNetDelta).toBeLessThan(0);
    expect(plan.ownerClawback).toBeGreaterThan(0);
    expect(plan.driverCashDelta).toBeGreaterThan(0);
    // 撤销车主 -10、施加业主 -5
    expect(plan.creditAdjustments).toContainEqual({ target: 'driver', delta: 10 });
    expect(plan.creditAdjustments).toContainEqual({ target: 'owner', delta: -5 });
  });

  test('同裁决重算：各方净头寸变化为 0，信用不重复冲销', () => {
    const b = settlePrice({ ...baseInput });
    const plan = planReversal(b, b, 'appeal_ruling');
    expect(plan.balanced).toBe(true);
    expect(plan.driverCashDelta).toBe(0);
    expect(plan.ownerNetDelta).toBe(0);
    expect(plan.propertyNetDelta).toBe(0);
    expect(plan.platformNetDelta).toBe(0);
    expect(plan.creditAdjustments).toEqual([]);
  });

  test('各方净头寸变化之和为 0（资金守恒）', () => {
    const cases: Array<[any, any]> = [
      [
        { incidents: [{ type: 'wrong_parking', started_at: baseInput.actualEntry }], ruling: 'driver_fault' },
        { incidents: [{ type: 'stranger_occupy', started_at: baseInput.actualEntry }], ruling: 'stranger' },
      ],
      [
        { incidents: [], ruling: null },
        { incidents: [{ type: 'weak_signal', started_at: baseInput.actualEntry }], ruling: 'platform_fault' },
      ],
      [
        { incidents: [{ type: 'wrong_parking', started_at: baseInput.actualEntry }], ruling: 'driver_fault' },
        { incidents: [{ type: 'owner_return', started_at: new Date(baseInput.actualEntry.getTime() + 120 * 60000) }], ruling: 'owner_fault', actualExit: new Date(baseInput.actualEntry.getTime() + 120 * 60000), overnightCap: null },
      ],
    ];
    for (const [oa, na] of cases) {
      const oldB = settlePrice({ ...baseInput, ...oa });
      const newB = settlePrice({ ...baseInput, ...na });
      const plan = planReversal(oldB, newB, 'appeal_ruling');
      const sum =
        plan.driverCashDelta + plan.ownerNetDelta + plan.propertyNetDelta +
        plan.platformNetDelta + plan.escrowNetDelta + plan.couponPoolNetDelta;
      expect(Math.abs(sum)).toBeLessThanOrEqual(0.05);
      expect(balanced(oldB)).toBe(true);
      expect(balanced(newB)).toBe(true);
    }
  });

  test('纯退款冲正：平台承担现金 + 补发券，借贷平衡且不触及业主/物业', () => {
    const { ledger, balanced: ok } = planSimpleRefund(15, 10);
    expect(ok).toBe(true);
    expect(ledger).toHaveLength(4);
    expect(ledger.some((l) => l.account === 'driver' && l.direction === 'credit' && l.amount === 15)).toBe(true);
    expect(ledger.some((l) => l.account === 'coupon_pool' && l.direction === 'credit' && l.amount === 10)).toBe(true);
    expect(ledger.every((l) => !l.account.startsWith('owner'))).toBe(true);
  });

  test('accountNets：每版分账账户净额之和为 0', () => {
    for (const ruling of [null, 'driver_fault', 'stranger', 'owner_fault']) {
      const b = settlePrice({
        ...baseInput,
        ruling: ruling as any,
        incidents: ruling === 'driver_fault' ? [{ type: 'wrong_parking', started_at: baseInput.actualEntry }] : ruling === 'stranger' ? [{ type: 'stranger_occupy', started_at: baseInput.actualEntry }] : [],
      });
      const sum = accountNets(b).reduce((a, x) => a + x.net, 0);
      expect(Math.abs(sum)).toBeLessThanOrEqual(0.05);
    }
  });
});
