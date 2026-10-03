import { validateRefund } from '../src/domain/refund';
import { settlePrice } from '../src/domain/pricing';

const ENTRY = new Date('2026-10-01T13:00:00Z'); // 21:00 +08
const END = new Date('2026-10-01T16:00:00Z'); // 00:00 +08
const EXIT = new Date('2026-10-01T16:00:00Z');

const baseCtx = (over: any = {}) => ({
  reservation: { code: 'R1', status: 'completed', startAt: ENTRY, endAt: END },
  gateEntryAt: ENTRY,
  gateExitAt: EXIT,
  gateEntryMode: 'auto' as const,
  settlement: { prepaid: 15, exitCharge: 0, refund: 0, couponDiscount: 0, ruling: null },
  patrolFindings: [],
  targetRuling: null,
  requestedAmount: 0,
  alreadyRefundedCash: 0,
  couponAlreadyReissued: 0,
  hasOpenRequest: false,
  ...over,
});

describe('退款校验（道闸/巡查/离场时间）', () => {
  test('正常结算、无责任证据：无额外可退', () => {
    const d = validateRefund(baseCtx());
    expect(d.decision).toBe('ineligible');
    expect(d.validatedAmount).toBe(0);
    // 三类校验项齐备
    expect(d.checks.some((c) => c.key === 'gate_entry')).toBe(true);
    expect(d.checks.some((c) => c.key === 'gate_exit')).toBe(true);
    expect(d.checks.some((c) => c.key === 'exit_time')).toBe(true);
  });

  test('巡查发现陌生车占用 + 终判 stranger：净付现金全退并补发原券', () => {
    const d = validateRefund(baseCtx({
      settlement: { prepaid: 25, exitCharge: 0, refund: 0, couponDiscount: 10, ruling: null },
      patrolFindings: [{ finding: 'stranger', at: ENTRY, plate: '沪X99999', note: '陌生车占用' }],
      targetRuling: 'stranger',
      justifiedDriverCash: 0,
    }));
    expect(d.refundable).toBe(true);
    expect(d.validatedAmount).toBe(25);
    expect(d.couponReissue).toBe(10);
    expect(d.checks.some((c) => c.key === 'patrol' && c.detail.includes('陌生'))).toBe(true);
  });

  test('车主错停终判 driver_fault：违约金不退', () => {
    const d = validateRefund(baseCtx({
      settlement: { prepaid: 15, exitCharge: 35, refund: 0, couponDiscount: 0, ruling: 'driver_fault' },
      patrolFindings: [{ finding: 'wrong_park', at: ENTRY }],
      targetRuling: 'driver_fault',
      justifiedDriverCash: 50,
    }));
    expect(d.decision).toBe('ineligible');
    expect(d.validatedAmount).toBe(0);
  });

  test('终判业主责任，重算后应退差额 = 当前净付 - 重算应净付', () => {
    // 当前净付 45，业主责任重算后应付 0（含补偿），应退 45
    const d = validateRefund(baseCtx({
      settlement: { prepaid: 45, exitCharge: 0, refund: 0, couponDiscount: 0, ruling: null },
      targetRuling: 'owner_fault',
      justifiedDriverCash: 0,
    }));
    expect(d.validatedAmount).toBe(45);
  });

  test('车辆尚未离场：挂起待离场结算后核定，不得提前退款', () => {
    const d = validateRefund(baseCtx({
      gateExitAt: null,
      settlement: null,
      reservation: { code: 'R1', status: 'in_garage', startAt: ENTRY, endAt: END },
    }));
    expect(d.decision).toBe('awaiting_exit');
    expect(d.refundable).toBe(false);
  });

  test('道闸无入场记录且未结算：预付全退', () => {
    const d = validateRefund(baseCtx({
      gateEntryAt: null,
      gateExitAt: null,
      settlement: null,
      prepaidEstimate: 20,
      reservation: { code: 'R1', status: 'reserved', startAt: ENTRY, endAt: END },
    }));
    expect(d.decision).toBe('eligible');
    expect(d.validatedAmount).toBe(20);
  });

  test('离场时间早于入场（道闸记录矛盾）：拦截转人工', () => {
    const d = validateRefund(baseCtx({
      gateExitAt: new Date(ENTRY.getTime() - 3600000),
    }));
    expect(d.decision).toBe('ineligible');
    expect(d.reasons.join('；')).toContain('异常');
  });

  test('超时离场：超时费不退，其余责任内费用仍可退', () => {
    const lateExit = new Date(END.getTime() + 60 * 60000);
    const d = validateRefund(baseCtx({
      gateExitAt: lateExit,
      settlement: { prepaid: 15, exitCharge: 6.25, refund: 0, couponDiscount: 0, ruling: null },
      patrolFindings: [{ finding: 'stranger', at: ENTRY }],
      targetRuling: 'stranger',
      justifiedDriverCash: 6.25, // 超时部分仍由车主承担
    }));
    // 当前净付 21.25 - 应承担超时 6.25 = 15
    expect(d.validatedAmount).toBe(15);
    expect(d.checks.some((c) => c.key === 'exit_time' && c.detail.includes('超时'))).toBe(true);
  });

  test('防重复：存在处理中申请直接拒绝，不产生新冲销', () => {
    const d = validateRefund(baseCtx({ hasOpenRequest: true }));
    expect(d.decision).toBe('duplicate');
    expect(d.validatedAmount).toBe(0);
  });

  test('防重复冲销：历史冲正已退 20，本次只退剩余额度', () => {
    const d = validateRefund(baseCtx({
      settlement: { prepaid: 45, exitCharge: 0, refund: 0, couponDiscount: 0, ruling: null },
      alreadyRefundedCash: 20,
      targetRuling: 'owner_fault',
      justifiedDriverCash: 0,
    }));
    expect(d.validatedAmount).toBe(25);
    expect(d.checks.some((c) => c.key === 'reversal_guard')).toBe(true);
  });

  test('申请额小于核定额时以申请额为准', () => {
    const d = validateRefund(baseCtx({
      requestedAmount: 10,
      settlement: { prepaid: 45, exitCharge: 0, refund: 0, couponDiscount: 0, ruling: null },
      targetRuling: 'owner_fault',
      justifiedDriverCash: 0,
    }));
    expect(d.validatedAmount).toBe(10);
  });
});
