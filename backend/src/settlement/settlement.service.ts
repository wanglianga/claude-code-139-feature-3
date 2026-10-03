import { BadRequestException, Injectable } from '@nestjs/common';
import { JwtUser } from '../auth/auth.service';
import { Ruling, settlePrice, SettlementBreakdown } from '../domain/pricing';
import { planReversal, planSimpleRefund } from '../domain/reversal';

function code(prefix: string) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4)
    .toString(36)
    .toUpperCase()}`;
}

/**
 * 结算引擎：组装分账输入、落账结算单与跨日分段、结算后申诉/退款冲正。
 * 所有方法接收事务 client，与调用方共用同一事务。
 */
@Injectable()
export class SettlementService {
  // ---- 组装分账输入（与控制器中原有逻辑一致，支持强制裁决）----
  async computeBreakdown(
    client: any,
    r: any,
    exitAt: Date,
    chargeKwh: number,
    // undefined = 自动取已关闭申诉终裁；显式传值（含 null）= 强制按该裁决重算，不再回退查库
    forcedRuling?: Ruling | null,
  ): Promise<SettlementBreakdown> {
    const iq = await client.query(
      `SELECT type, created_at, resolved_at, detail FROM incident_tickets
       WHERE reservation_id=$1 ORDER BY created_at`,
      [r.id],
    );
    const incidents = iq.rows.map((i: any) => ({
      type: i.type,
      started_at: i.created_at,
      resolved_at: i.resolved_at,
      detail: i.detail ?? {},
    }));

    let ruling: Ruling | null = forcedRuling === undefined ? null : forcedRuling;
    if (forcedRuling === undefined) {
      const aq = await client.query(
        `SELECT ruling FROM appeals WHERE reservation_id=$1 AND status='closed' ORDER BY ruled_at DESC NULLS LAST LIMIT 1`,
        [r.id],
      );
      ruling = aq.rows[0]?.ruling ?? null;
    }

    const cq = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS amount FROM coupons WHERE used_reservation_id=$1`,
      [r.id],
    );
    const couponAmount = Number(cq.rows[0].amount);

    let usableFrom = r.parking_confirmed_at ?? r.gate_entry_at ?? r.start_at;
    const stranger = iq.rows.find((i: any) => ['stranger_occupy', 'ice_occupy_charger'].includes(i.type));
    if (stranger?.resolved_at && new Date(stranger.resolved_at) > new Date(usableFrom)) {
      usableFrom = stranger.resolved_at;
    }

    let kwh = chargeKwh;
    if (!kwh) {
      const detail = await client.query(
        `SELECT detail FROM service_events WHERE reservation_id=$1 AND type='charging_session' ORDER BY id DESC LIMIT 1`,
        [r.id],
      );
      kwh = Number(detail.rows[0]?.detail?.kwh ?? 0);
    }

    return settlePrice({
      reservedStart: r.start_at,
      reservedEnd: r.end_at,
      actualEntry: r.gate_entry_at ?? r.start_at,
      actualExit: exitAt,
      usableFrom,
      hourlyRate: Number(r.hourly_rate),
      overnightCap: r.overnight_cap != null ? Number(r.overnight_cap) : null,
      isNewEnergy: r.is_new_energy,
      chargeKwh: kwh,
      incidents,
      ruling,
      couponAmount,
      prepaid: Number(
        r.estimated_fee && couponAmount ? Math.max(0, Number(r.estimated_fee) - couponAmount) : (r.estimated_fee ?? 0),
      ),
      reservedSpotCode: r.spot_code ?? null,
    });
  }

  // ---- 落账结算单（含跨日分段）----
  async persistSettlement(
    c: any,
    r: any,
    exitAt: Date,
    b: SettlementBreakdown,
    opts: { kind?: 'original' | 'recomputed'; supersedesId?: number | null; appealId?: number | null; ruling?: Ruling | null } = {},
  ) {
    const ins = await c.query(
      `INSERT INTO settlements(code, reservation_id, spot_id, actual_entry_at, actual_exit_at, usable_from,
         duration_minutes, base_fee, charging_fee, overtime_fee, wrong_park_fine,
         coupon_discount, abnormal_compensation, coupon_compensation, owner_compensation, prepaid, refund, exit_charge, payable,
         owner_income, property_fee, platform_fee, owner_share, property_share, platform_share,
         credit_target, credit_delta, appeal_id, ruling, detail, kind, supersedes_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
       RETURNING *`,
      [
        code('ST'), r.id, r.spot_id, b.actualEntryAt, b.actualExitAt, b.usableFrom,
        b.durationMinutes, b.baseFee, b.chargingFee, b.overtimeFee, b.wrongParkFine,
        b.couponDiscount, b.abnormalCompensation, b.couponCompensation, b.ownerCompensation, b.prepaid, b.refund, b.exitCharge, b.payable,
        b.ownerIncome, b.propertyFee, b.platformFee, b.ownerShare, b.propertyShare, b.platformShare,
        b.creditTarget, b.creditDelta, opts.appealId ?? null, opts.ruling ?? b.ruling,
        JSON.stringify({ notes: b.notes }),
        opts.kind ?? 'original',
        opts.supersedesId ?? null,
      ],
    );
    const settlement = ins.rows[0];

    for (const e of b.ledger) {
      await c.query(
        `INSERT INTO ledger_entries(settlement_id, account, direction, amount, memo)
         VALUES ($1,$2,$3,$4,$5)`,
        [settlement.id, e.account === 'owner' ? `owner:${r.owner_id}` : e.account, e.direction, e.amount, e.memo],
      );
    }

    // 跨日分段：各段业主收益/物业服务费/平台抽成与费用来源
    for (const sp of b.splits) {
      await c.query(
        `INSERT INTO settlement_day_splits(settlement_id, settlement_date, period_from, period_to,
           duration_minutes, spot_code, base_fee, charging_fee, overtime_fee, wrong_park_fine,
           coupon_discount, service_revenue, owner_income, property_fee, platform_fee, sources)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          settlement.id, sp.settlementDate, sp.from, sp.to, sp.durationMinutes, sp.spotCode,
          sp.baseFee, sp.chargingFee, sp.overtimeFee, sp.wrongParkFine, sp.couponDiscount,
          sp.serviceRevenue, sp.ownerIncome, sp.propertyFee, sp.platformFee,
          JSON.stringify(sp.sources),
        ],
      );
    }

    await c.query(`UPDATE reservations SET settled_at=now(), settlement_id=$1 WHERE id=$2`, [settlement.id, r.id]);
    const ledger = await c.query(`SELECT * FROM ledger_entries WHERE settlement_id=$1 ORDER BY id`, [settlement.id]);
    const splits = await c.query(
      `SELECT id, settlement_id, settlement_date::text AS settlement_date, period_from, period_to,
              duration_minutes, spot_code, base_fee, charging_fee, overtime_fee, wrong_park_fine,
              coupon_discount, service_revenue, owner_income, property_fee, platform_fee, sources, created_at
       FROM settlement_day_splits WHERE settlement_id=$1 ORDER BY period_from`,
      [settlement.id],
    );
    return { ...settlement, ledger: ledger.rows, splits: splits.rows, notes: b.notes };
  }

  // ---- 取订单当前生效结算单（最新一版）----
  async latestSettlement(client: any, reservationId: number) {
    const q = await client.query(
      `SELECT * FROM settlements WHERE reservation_id=$1 ORDER BY id DESC LIMIT 1`,
      [reservationId],
    );
    return q.rows[0] ?? null;
  }

  /**
   * 结算后冲正：保留原分账事实，按新裁决重做一版分账，
   * 并写入与原流水成对的红字冲正流水（全局借贷保持平衡）。
   */
  async createReversal(c: any, params: {
    r: any;
    oldSettlement: any;
    oldBreakdown: SettlementBreakdown;
    newBreakdown: SettlementBreakdown;
    kind: 'appeal_ruling' | 'refund_approved';
    reason: string;
    appealId?: number | null;
    refundRequestId?: number | null;
    user: JwtUser;
    couponReissue?: number;
  }) {
    const { r, oldSettlement, oldBreakdown, newBreakdown } = params;
    const plan = planReversal(oldBreakdown, newBreakdown, params.kind);
    if (!plan.balanced) throw new BadRequestException('冲正计划借贷不平衡，已中止以防止资金错误');

    // 1) 重做一版分账（kind=recomputed，指向上一版）
    const newSettlement = await this.persistSettlement(c, r, newBreakdown.actualExitAt ?? new Date(), newBreakdown, {
      kind: 'recomputed',
      supersedesId: oldSettlement.id,
      appealId: params.appealId ?? oldSettlement.appeal_id ?? null,
      ruling: newBreakdown.ruling,
    });

    // 2) 冲正单
    const rv = await c.query(
      `INSERT INTO settlement_reversals(code, settlement_id, reservation_id, appeal_id, refund_request_id,
         kind, reason, old_ruling, new_ruling, refund_to_driver, coupon_reissue,
         owner_clawback, property_clawback, platform_clawback, credit_target, credit_delta, detail, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [
        code('RV'), oldSettlement.id, r.id, params.appealId ?? null, params.refundRequestId ?? null,
        params.kind, params.reason, plan.oldRuling, plan.newRuling,
        Math.max(0, plan.driverCashDelta), params.couponReissue ?? 0,
        plan.ownerClawback, plan.propertyClawback, plan.platformClawback,
        plan.creditAdjustments[0]?.target ?? 'none',
        plan.creditAdjustments.reduce((a, x) => a + x.delta, 0),
        JSON.stringify({ plan, notes: plan.notes }),
        params.user.sub,
      ],
    );
    const reversal = rv.rows[0];

    // 3) 红字冲正流水：把原结算单的每条流水按反方向成对冲销（挂原单 + reversal_id）
    const oldEntries = await c.query(
      `SELECT * FROM ledger_entries WHERE settlement_id=$1 AND reversal_id IS NULL ORDER BY id`,
      [oldSettlement.id],
    );
    for (const e of oldEntries.rows) {
      await c.query(
        `INSERT INTO ledger_entries(settlement_id, reversal_id, account, direction, amount, memo)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          oldSettlement.id, reversal.id, e.account,
          e.direction === 'debit' ? 'credit' : 'debit',
          e.amount,
          `冲正 ${reversal.code}：${e.memo}`,
        ],
      );
    }
    // 4) 补发赔付券（券抵扣不退现金）：平台向券池出资 + 给车主发券
    if ((params.couponReissue ?? 0) > 0) {
      await c.query(
        `INSERT INTO ledger_entries(settlement_id, reversal_id, account, direction, amount, memo)
         VALUES ($1,$2,'platform','debit',$3,$4),($1,$2,'coupon_pool','credit',$3,$5)`,
        [
          oldSettlement.id, reversal.id, params.couponReissue,
          `冲正 ${reversal.code}：平台出资补发赔付券`,
          `冲正 ${reversal.code}：补发赔付券入券池（车主下次抵扣）`,
        ],
      );
      await c.query(
        `INSERT INTO coupons(user_id, code, amount) VALUES ($1,$2,$3) RETURNING *`,
        [r.driver_id, code('RVCPN'), params.couponReissue],
      );
    }

    // 5) 信用净调整（新旧目标可能不同：如原判车主 -10，终判业主 -5）
    for (const adj of plan.creditAdjustments) {
      const targetId = adj.target === 'owner' ? r.owner_id : adj.target === 'driver' ? r.driver_id : null;
      if (targetId) {
        await c.query(`UPDATE users SET credit_score=GREATEST(0, credit_score + $1) WHERE id=$2`, [adj.delta, targetId]);
      }
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
         VALUES ($1,$2,'credit_adjusted',$3,$4,$5)`,
        [
          r.id, r.spot_id, params.user.sub, params.user.role,
          JSON.stringify({ reversal_id: reversal.id, target: adj.target, delta: adj.delta, reason: 'settlement_reversal' }),
        ],
      );
    }

    await c.query(
      `UPDATE settlements SET reversal_count = reversal_count + 1 WHERE id=$1`,
      [oldSettlement.id],
    );
    if (params.refundRequestId) {
      await c.query(`UPDATE refund_requests SET reversal_id=$1 WHERE id=$2`, [reversal.id, params.refundRequestId]);
    }
    await c.query(
      `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
       VALUES ($1,$2,'settlement_reversed',$3,$4,$5)`,
      [
        r.id, r.spot_id, params.user.sub, params.user.role,
        JSON.stringify({
          reversal_id: reversal.id, old_settlement: oldSettlement.code, new_settlement: newSettlement.code,
          kind: params.kind, refund_to_driver: reversal.refund_to_driver,
          owner_clawback: reversal.owner_clawback, property_clawback: reversal.property_clawback,
        }),
      ],
    );

    return { reversal, settlement: newSettlement, plan };
  }

  /**
   * 纯现金/赔付券退款冲正（裁决不变，平台核准补偿）：资金由平台承担。
   */
  async createSimpleRefundReversal(c: any, params: {
    r: any;
    settlement: any;
    cash: number;
    couponAmount: number;
    reason: string;
    refundRequestId: number;
    user: JwtUser;
  }) {
    const { ledger, balanced } = planSimpleRefund(params.cash, params.couponAmount);
    if (!balanced) throw new BadRequestException('退款冲正流水不平衡，已中止');

    const rv = await c.query(
      `INSERT INTO settlement_reversals(code, settlement_id, reservation_id, refund_request_id,
         kind, reason, old_ruling, new_ruling, refund_to_driver, coupon_reissue, detail, created_by)
       VALUES ($1,$2,$3,$4,'refund_approved',$5,$6,$6,$7,$8,$9,$10) RETURNING *`,
      [
        code('RV'), params.settlement.id, params.r.id, params.refundRequestId,
        params.reason, params.settlement.ruling, params.cash, params.couponAmount,
        JSON.stringify({ simpleRefund: true }), params.user.sub,
      ],
    );
    const reversal = rv.rows[0];
    for (const e of ledger) {
      await c.query(
        `INSERT INTO ledger_entries(settlement_id, reversal_id, account, direction, amount, memo)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [params.settlement.id, reversal.id, e.account, e.direction, e.amount, e.memo],
      );
    }
    if (params.couponAmount > 0) {
      await c.query(
        `INSERT INTO coupons(user_id, code, amount) VALUES ($1,$2,$3) RETURNING *`,
        [params.r.driver_id, code('RFCPN'), params.couponAmount],
      );
    }
    await c.query(
      `UPDATE settlements SET reversal_count = reversal_count + 1 WHERE id=$1`,
      [params.settlement.id],
    );
    await c.query(`UPDATE refund_requests SET reversal_id=$1 WHERE id=$2`, [reversal.id, params.refundRequestId]);
    await c.query(
      `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
       VALUES ($1,$2,'settlement_reversed',$3,$4,$5)`,
      [
        params.r.id, params.r.spot_id, params.user.sub, params.user.role,
        JSON.stringify({ reversal_id: reversal.id, kind: 'refund_approved', refund_to_driver: params.cash, coupon_reissue: params.couponAmount }),
      ],
    );
    return reversal;
  }

  async applyCredit(c: any, r: any, target: string, delta: number, user: JwtUser) {
    if (target === 'none' || delta === 0) return;
    const targetId = target === 'owner' ? r.owner_id : target === 'driver' ? r.driver_id : null;
    if (targetId) {
      await c.query(`UPDATE users SET credit_score=GREATEST(0, credit_score + $1) WHERE id=$2`, [delta, targetId]);
    }
    await c.query(
      `INSERT INTO service_events(reservation_id, spot_id, type, actor_role, detail)
       VALUES ($1,$2,'credit_adjusted',$3,$4)`,
      [r.id, r.spot_id, user.role, JSON.stringify({ target, delta })],
    );
  }
}
