// 结算后冲正（红字冲销 + 重做）：财务分账已落账后申诉成立/退款核准时，
// 保留原分账与原流水作为事实，生成冲正单：反向流水成对冲销旧信用影响与资金归属，
// 再按终裁结果重做一版分账；全局借贷必须始终平衡。纯函数，便于单元测试。

import { Ruling, SettlementBreakdown } from './pricing';

export interface AccountNet {
  account: string;
  net: number; // 贷-借（正=净流入该账户）
}

export interface CreditAdjustment {
  target: 'driver' | 'owner' | 'property' | 'none';
  delta: number; // 本次应对该方信用分施加的净调整
}

export interface ReversalPlan {
  kind: 'appeal_ruling' | 'refund_approved';
  oldRuling: Ruling | null;
  newRuling: Ruling | null;
  // 各方账户净头寸变化（新分账相对原分账；正=净流入，负=净追回）
  driverCashDelta: number; // 正数=本次应再退给车主的现金
  ownerNetDelta: number; // 负数=应从业主收益追回
  propertyNetDelta: number;
  platformNetDelta: number;
  escrowNetDelta: number;
  couponPoolNetDelta: number;
  ownerClawback: number;
  propertyClawback: number;
  platformClawback: number;
  creditAdjustments: CreditAdjustment[];
  // 新分账自身声明的离场退款额（相对新预付口径）
  newRefund: number;
  balanced: boolean;
  notes: string[];
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function accountNets(b: SettlementBreakdown, ownerAccount = 'owner'): AccountNet[] {
  const map = new Map<string, number>();
  for (const e of b.ledger) {
    const acc = e.account === 'owner' ? ownerAccount : e.account;
    map.set(acc, round2((map.get(acc) ?? 0) + (e.direction === 'credit' ? e.amount : -e.amount)));
  }
  return [...map.entries()].map(([account, net]) => ({ account, net: round2(net) }));
}

function netOf(b: SettlementBreakdown, account: string): number {
  // 固定 owner 映射名，避免把业主流水并入所查询的目标账户
  return accountNets(b, 'owner').find((x) => x.account === account)?.net ?? 0;
}

/**
 * 由新旧两版清算结果生成冲正计划。
 * 车主现金按 driver 账户净额差计算（原分账里 driver 借=付费、贷=收回退款）。
 */
export function planReversal(
  old: SettlementBreakdown,
  neu: SettlementBreakdown,
  kind: ReversalPlan['kind'],
): ReversalPlan {
  const notes: string[] = [];
  const ownerNetOld = netOf(old, 'owner');
  const ownerNetNew = netOf(neu, 'owner');
  const propertyOld = netOf(old, 'property');
  const propertyNew = netOf(neu, 'property');
  const platformOld = netOf(old, 'platform');
  const platformNew = netOf(neu, 'platform');
  const escrowOld = netOf(old, 'escrow');
  const escrowNew = netOf(neu, 'escrow');
  const couponOld = netOf(old, 'coupon_pool');
  const couponNew = netOf(neu, 'coupon_pool');

  // driver 账户：借为支付、贷为收款；净额（贷-借）为车主的净流入（通常为负=净付）。
  // 净额上升的部分即本次需要再退给车主的现金。
  const driverOld = netOf(old, 'driver');
  const driverNew = netOf(neu, 'driver');
  const driverCashDelta = round2(driverNew - driverOld);

  const ownerNetDelta = round2(ownerNetNew - ownerNetOld);
  const propertyNetDelta = round2(propertyNew - propertyOld);
  const platformNetDelta = round2(platformNew - platformOld);
  const escrowNetDelta = round2(escrowNew - escrowOld);
  const couponPoolNetDelta = round2(couponNew - couponOld);

  const ownerClawback = round2(Math.max(0, -ownerNetDelta));
  const propertyClawback = round2(Math.max(0, -propertyNetDelta));
  const platformClawback = round2(Math.max(0, -platformNetDelta));

  if (ownerClawback > 0) notes.push(`从业主已结算收益中追回 ¥${ownerClawback}`);
  if (propertyClawback > 0) notes.push(`从物业服务费中追回 ¥${propertyClawback}`);
  if (driverCashDelta > 0) notes.push(`向车主补退现金 ¥${driverCashDelta}`);
  if (platformNetDelta > 0) notes.push(`平台本次补记留存/违约金余额 ¥${platformNetDelta}`);
  if (platformNetDelta < 0) notes.push(`平台垫付/兜底新增 ¥${round2(-platformNetDelta)}（保留向责任方追缴权）`);
  if (couponPoolNetDelta !== 0) notes.push(`券池出资调整 ¥${couponPoolNetDelta}`);

  // ---- 信用净调整：先反向冲销旧影响，再施加新影响（目标方可能不同）----
  const adjMap = new Map<string, number>();
  const addAdj = (target: string, delta: number) => {
    if (target === 'none' || delta === 0) return;
    adjMap.set(target, round2((adjMap.get(target) ?? 0) + delta));
  };
  addAdj(old.creditTarget, -old.creditDelta);
  addAdj(neu.creditTarget, neu.creditDelta);
  const creditAdjustments: CreditAdjustment[] = [...adjMap.entries()]
    .filter(([, d]) => d !== 0)
    .map(([target, delta]) => ({ target: target as CreditAdjustment['target'], delta }));

  // 借贷平衡校验：新旧两版流水各自平衡，且各方净头寸变化之和为 0
  const sumDelta = round2(
    driverCashDelta + ownerNetDelta + propertyNetDelta + platformNetDelta + escrowNetDelta + couponPoolNetDelta,
  );

  return {
    kind,
    oldRuling: old.ruling,
    newRuling: neu.ruling,
    driverCashDelta,
    ownerNetDelta,
    propertyNetDelta,
    platformNetDelta,
    escrowNetDelta,
    couponPoolNetDelta,
    ownerClawback,
    propertyClawback,
    platformClawback,
    creditAdjustments,
    newRefund: neu.refund,
    balanced: Math.abs(sumDelta) <= 0.05,
    notes,
  };
}

/**
 * 纯退款冲正（不改裁决）：已结算后平台核准额外现金退款与补发券，
 * 资金由平台承担（异常服务兜底），用于无改判但事实成立的补偿场景。
 */
export function planSimpleRefund(cashAmount: number, couponAmount: number): {
  ledger: Array<{ account: string; direction: 'debit' | 'credit'; amount: number; memo: string }>;
  balanced: boolean;
} {
  const ledger: Array<{ account: string; direction: 'debit' | 'credit'; amount: number; memo: string }> = [];
  if (cashAmount > 0) {
    ledger.push({ account: 'platform', direction: 'debit', amount: round2(cashAmount), memo: '平台核准退款：现金退还车主' });
    ledger.push({ account: 'driver', direction: 'credit', amount: round2(cashAmount), memo: '退款审核通过，现金退还' });
  }
  if (couponAmount > 0) {
    ledger.push({ account: 'platform', direction: 'debit', amount: round2(couponAmount), memo: '平台核准退款：补发赔付券出资' });
    ledger.push({ account: 'coupon_pool', direction: 'credit', amount: round2(couponAmount), memo: '补发赔付券入券池（车主下次抵扣）' });
  }
  const debit = ledger.filter((l) => l.direction === 'debit').reduce((a, b) => a + b.amount, 0);
  const credit = ledger.filter((l) => l.direction === 'credit').reduce((a, b) => a + b.amount, 0);
  return { ledger, balanced: Math.abs(debit - credit) <= 0.02 };
}
