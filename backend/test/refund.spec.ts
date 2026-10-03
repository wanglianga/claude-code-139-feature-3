import { validateRefund, RefundCheckInput } from '../src/domain/refund';

const T = (s: string) => new Date(s);

const baseInput: RefundCheckInput = {
  prepaid: 40, // 预约预付
  exitCharge: 10, // 离场补缴
  settledPayable: 40, // 结算应付
  settledRefund: 10, // 结算时已退
  approvedRefunds: 0,
  requestedAmount: 20,
  gateEntryAt: T('2026-10-01T22:00:00'),
  gateExitAt: T('2026-10-02T02:00:00'),
  reservedEnd: T('2026-10-02T06:00:00'),
  patrols: [],
  feeWaived: false,
};

describe('validateRefund 退款校验', () => {
  test('可退上限 = 实付 - 已退 - 校验后应付；上限为 0 时自动拒绝', () => {
    const r = validateRefund(baseInput);
    // 实付 50，结算已退 10，应付 40 → 上限 0
    expect(r.maxRefundable).toBe(0);
    expect(r.autoReject).toBe(true);
    expect(r.checks.find((c) => c.key === 'duplicate')?.passed).toBe(false);
  });

  test('结算多收时可退：提前离场按实际离场时间计费后的余额可退', () => {
    const r = validateRefund({
      ...baseInput,
      settledPayable: 20, // 按 02:00 实际离场只应计 20
      settledRefund: 0,
      requestedAmount: 30,
    });
    // 实付 50 - 已退 0 - 应付 20 = 30
    expect(r.maxRefundable).toBe(30);
    expect(r.approvedAmount).toBe(30);
    expect(r.autoReject).toBe(false);
    expect(r.checks.find((c) => c.key === 'exit_time')?.detail).toContain('提前');
  });

  test('申请金额超过可退上限时按上限截断', () => {
    const r = validateRefund({
      ...baseInput,
      settledPayable: 20,
      settledRefund: 0,
      requestedAmount: 999,
    });
    expect(r.approvedAmount).toBe(30);
  });

  test('道闸无入场记录：服务未交付，应付清零，实付全退', () => {
    const r = validateRefund({
      ...baseInput,
      gateEntryAt: null,
      gateExitAt: null,
      settledPayable: 40,
      settledRefund: 0,
      requestedAmount: 50,
    });
    expect(r.validatedCharges).toBe(0);
    expect(r.maxRefundable).toBe(50);
    expect(r.checks.find((c) => c.key === 'gate')?.detail).toContain('未实际入场');
  });

  test('巡查发现陌生车占用：服务未交付，应付核减为 0', () => {
    const r = validateRefund({
      ...baseInput,
      settledPayable: 40,
      settledRefund: 0,
      requestedAmount: 50,
      patrols: [{ at: T('2026-10-01T23:00:00'), finding: 'stranger', note: 'stranger: 陌生车占用' }],
    });
    expect(r.validatedCharges).toBe(0);
    expect(r.maxRefundable).toBe(50);
    expect(r.checks.find((c) => c.key === 'patrol')?.detail).toContain('占用');
  });

  test('裁决免单（平台/物业/陌生车责任）：应付清零', () => {
    const r = validateRefund({
      ...baseInput,
      feeWaived: true,
      settledRefund: 0,
      requestedAmount: 50,
    });
    expect(r.validatedCharges).toBe(0);
    expect(r.maxRefundable).toBe(50);
    expect(r.checks.find((c) => c.key === 'exit_time')?.detail).toContain('全免');
  });

  test('重复冲销防护：历史已批准退款扣减后可退余额为 0，自动拒绝', () => {
    const first = validateRefund({ ...baseInput, settledPayable: 20, settledRefund: 0, requestedAmount: 30 });
    expect(first.approvedAmount).toBe(30);
    // 第二次申请：已批准 30 计入
    const second = validateRefund({
      ...baseInput,
      settledPayable: 20,
      settledRefund: 0,
      approvedRefunds: first.approvedAmount,
      requestedAmount: 30,
    });
    expect(second.maxRefundable).toBe(0);
    expect(second.approvedAmount).toBe(0);
    expect(second.autoReject).toBe(true);
    expect(second.checks.find((c) => c.key === 'duplicate')?.detail).toContain('拒绝重复冲销');
  });

  test('部分已退时第二次申请仅可退差额', () => {
    const r = validateRefund({
      ...baseInput,
      settledPayable: 20,
      settledRefund: 0,
      approvedRefunds: 20, // 已批准 20
      requestedAmount: 30,
    });
    // 50 - 20 - 20 = 10
    expect(r.maxRefundable).toBe(10);
    expect(r.approvedAmount).toBe(10);
  });
});
