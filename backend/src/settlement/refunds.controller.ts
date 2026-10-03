import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { JwtUser } from '../auth/auth.service';
import { DbService } from '../database/db.service';
import { Ruling } from '../domain/pricing';
import { RefundCheckInput, validateRefund } from '../domain/refund';
import { SettlementService } from './settlement.service';

function code(prefix: string) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4)
    .toString(36)
    .toUpperCase()}`;
}

class CreateRefundDto {
  reason!: string;
  amount?: number;
}

class ReviewRefundDto {
  ruling?: Ruling; // 审批时可指定责任裁决（须与已关闭申诉终裁一致，或由物业/管理员核准）
  note?: string;
  force_cash?: number; // 不改裁决时平台酌情核准的现金补偿
  force_coupon?: number; // 不改裁决时酌情补发赔付券
}

const RULING_ALLOWED: Ruling[] = [
  'driver_fault', 'owner_fault', 'platform_fault', 'property_fault', 'stranger', 'mixed', 'no_fault',
];

/**
 * 车主退款：平台按道闸记录、物业巡查、离场时间三类客观证据核定可退金额，
 * 物业/管理员审核通过后生成与原分账关联的冲正单，防止重复冲销。
 */
@Controller()
@UseGuards(AuthGuard)
export class RefundsController {
  constructor(
    private db: DbService,
    private settlements: SettlementService,
  ) {}

  // ---- 组装退款校验输入（事务内外均可调用）----
  private async buildCheckInput(
    client: any,
    r: any,
    requestedAmount: number,
    targetRuling: Ruling | null | undefined,
    excludeRefundId?: number,
  ): Promise<RefundCheckInput> {
    const entryEv = await client.query(
      `SELECT type, occurred_at FROM service_events
       WHERE reservation_id=$1 AND type IN ('gate_entry','manual_release')
       ORDER BY occurred_at, id LIMIT 1`,
      [r.id],
    );
    const gateEntryAt = r.gate_entry_at ?? entryEv.rows[0]?.occurred_at ?? null;
    const gateEntryMode = entryEv.rows[0]
      ? entryEv.rows[0].type === 'manual_release'
        ? ('manual' as const)
        : ('auto' as const)
      : null;

    const settlement = await this.settlements.latestSettlement(client, r.id);

    // 巡查证据（该车位、预约时间窗内）
    const pq = await client.query(
      `SELECT note, plate, patrolled_at FROM patrol_logs
       WHERE spot_id=$1 AND patrolled_at BETWEEN $2 AND $3
       ORDER BY patrolled_at`,
      [r.spot_id, r.start_at, r.gate_exit_at ?? r.end_at],
    );
    const patrolFindings = pq.rows.map((p: any) => ({
      finding: String(p.note ?? '').split(':')[0].trim(),
      at: p.patrolled_at,
      plate: p.plate,
      note: p.note,
    }));

    const sig = await client.query(
      `SELECT 1 FROM service_events WHERE reservation_id=$1 AND type='weak_signal_report' LIMIT 1`,
      [r.id],
    );

    let ruling: Ruling | null = targetRuling ?? null;
    if (!ruling) {
      const aq = await client.query(
        `SELECT ruling FROM appeals WHERE reservation_id=$1 AND status='closed' ORDER BY ruled_at DESC NULLS LAST LIMIT 1`,
        [r.id],
      );
      ruling = aq.rows[0]?.ruling ?? null;
    }

    // 历次冲正已退现金/已补发券（防重复冲销）
    const rvq = await client.query(
      `SELECT COALESCE(SUM(refund_to_driver),0) AS cash, COALESCE(SUM(coupon_reissue),0) AS coupon
       FROM settlement_reversals WHERE reservation_id=$1`,
      [r.id],
    );
    const alreadyCash = Number(rvq.rows[0].cash);
    const alreadyCoupon = Number(rvq.rows[0].coupon);

    const open = await client.query(
      `SELECT 1 FROM refund_requests
       WHERE reservation_id=$1 AND status IN ('pending','approved') AND id <> $2
       ORDER BY id LIMIT 1`,
      [r.id, excludeRefundId ?? 0],
    );

    const base: RefundCheckInput = {
      reservation: { code: r.code, status: r.status, startAt: r.start_at, endAt: r.end_at },
      gateEntryAt,
      gateExitAt: r.gate_exit_at ?? null,
      gateEntryMode,
      settlement: settlement
        ? {
            prepaid: Number(settlement.prepaid),
            exitCharge: Number(settlement.exit_charge),
            refund: Number(settlement.refund),
            couponDiscount: Number(settlement.coupon_discount),
            ruling: settlement.ruling,
          }
        : null,
      prepaidEstimate: Number(r.estimated_fee ?? 0),
      patrolFindings,
      hasWeakSignal: !!sig.rows[0],
      targetRuling: ruling,
      requestedAmount,
      alreadyRefundedCash: alreadyCash,
      couponAlreadyReissued: alreadyCoupon,
      hasOpenRequest: !!open.rows[0],
    };
    if (!base.targetRuling) return base;

    // 有目标裁决：按终裁重算，得出车主"本应净付现金"
    if (settlement) {
      const exitAt = r.gate_exit_at ?? r.end_at;
      const kwh = Number(settlement.charging_fee ?? 0) > 0
        ? Number(settlement.charging_fee) / 1.2
        : 0;
      const neu = await this.settlements.computeBreakdown(client, r, exitAt, kwh, base.targetRuling);
      return { ...base, justifiedDriverCash: Math.max(0, neu.payable) };
    }
    return base;
  }

  // ---- 车主申请退款 ----
  @Roles('driver')
  @Post('reservations/:id/refunds')
  async apply(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: CreateRefundDto) {
    if (!dto?.reason?.trim()) throw new BadRequestException('请填写退款事由');
    return this.db.withTx(async (c) => {
      const rq = await c.query(
        `SELECT r.*, s.code AS spot_code, s.owner_id, s.hourly_rate, s.overnight_cap, v.is_new_energy
         FROM reservations r
         JOIN parking_spots s ON s.id=r.spot_id
         JOIN vehicles v ON v.id=r.vehicle_id
         WHERE r.id=$1 AND r.driver_id=$2 FOR UPDATE`,
        [id, user.sub],
      );
      const r = rq.rows[0];
      if (!r) throw new BadRequestException('预约不存在或不属于本人');
      if (r.status === 'cancelled') throw new BadRequestException('订单已取消');

      const checkInput = await this.buildCheckInput(c, r, Math.max(0, Number(dto.amount ?? 0)), undefined);
      const decision = validateRefund(checkInput);

      const ins = await c.query(
        `INSERT INTO refund_requests(code, reservation_id, driver_id, status, reason, requested_amount,
           validated_amount, coupon_reissue, settlement_id, checks)
         VALUES ($1,$2,$3,'pending',$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          code('RF'), r.id, user.sub, dto.reason, Math.max(0, Number(dto.amount ?? 0)),
          decision.validatedAmount, decision.couponReissue,
          (await this.settlements.latestSettlement(c, r.id))?.id ?? null,
          JSON.stringify(decision.checks),
        ],
      );
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
         VALUES ($1,$2,'refund_requested',$3,'driver',$4,$5)`,
        [
          r.id, r.spot_id, user.sub, r.plate,
          JSON.stringify({
            refund_id: ins.rows[0].id,
            decision: decision.decision,
            validated: decision.validatedAmount,
            coupon_reissue: decision.couponReissue,
            suggested_ruling: decision.suggestedRuling,
          }),
        ],
      );
      return { refund: ins.rows[0], validation: decision };
    });
  }

  // ---- 退款申请列表 ----
  @Get('refunds')
  async list(@CurrentUser() user: JwtUser) {
    let where = '1=1';
    const params: any[] = [];
    if (user.role === 'driver') {
      params.push(user.sub);
      where = `rr.driver_id=$${params.length}`;
    } else if (user.role === 'owner') {
      params.push(user.sub);
      where = `s.owner_id=$${params.length}`;
    }
    return this.db
      .query(
        `SELECT rr.*, r.code AS reservation_code, r.plate, r.spot_id, sp.code AS spot_code,
                u.name AS driver_name, rv.code AS reversal_code
         FROM refund_requests rr
         JOIN reservations r ON r.id=rr.reservation_id
         JOIN parking_spots sp ON sp.id=r.spot_id
         JOIN users u ON u.id=rr.driver_id
         LEFT JOIN settlement_reversals rv ON rv.id=rr.reversal_id
         WHERE ${where}
         ORDER BY rr.id DESC LIMIT 200`,
        params,
      )
      .then((q) => q.rows);
  }

  @Get('refunds/:id')
  async detail(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    const q = await this.db.query(
      `SELECT rr.*, r.code AS reservation_code, r.plate, sp.code AS spot_code,
              u.name AS driver_name, rv.code AS reversal_code
       FROM refund_requests rr
       JOIN reservations r ON r.id=rr.reservation_id
       JOIN parking_spots sp ON sp.id=r.spot_id
       JOIN users u ON u.id=rr.driver_id
       LEFT JOIN settlement_reversals rv ON rv.id=rr.reversal_id
       WHERE rr.id=$1`,
      [id],
    );
    const row = q.rows[0];
    if (!row) throw new BadRequestException('退款申请不存在');
    if (user.role === 'driver' && row.driver_id !== user.sub) throw new BadRequestException('无权查看该申请');
    return row;
  }

  // ---- 物业/管理员审核：通过（核定金额生成冲正单）----
  @Roles('property', 'admin')
  @Post('refunds/:id/approve')
  async approve(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: ReviewRefundDto = {}) {
    if (dto.ruling && !RULING_ALLOWED.includes(dto.ruling)) throw new BadRequestException('裁决类型非法');
    return this.db.withTx(async (c) => {
      const rq = await c.query(`SELECT * FROM refund_requests WHERE id=$1 FOR UPDATE`, [id]);
      const rr = rq.rows[0];
      if (!rr) throw new BadRequestException('退款申请不存在');
      if (!['pending'].includes(rr.status)) throw new BadRequestException('该申请已处理，不得重复冲销');

      const xq = await c.query(
        `SELECT r.*, s.code AS spot_code, s.owner_id, s.hourly_rate, s.overnight_cap, v.is_new_energy
         FROM reservations r
         JOIN parking_spots s ON s.id=r.spot_id
         JOIN vehicles v ON v.id=r.vehicle_id
         WHERE r.id=$1 FOR UPDATE`,
        [rr.reservation_id],
      );
      const r = xq.rows[0];
      const settlement = await this.settlements.latestSettlement(c, r.id);

      // 平台酌情现金/券补偿（不改裁决）
      const forceCash = Math.max(0, Number(dto.force_cash ?? 0));
      const forceCoupon = Math.max(0, Number(dto.force_coupon ?? 0));

      if (!settlement) {
        // 未结算：未入场/预约未使用 -> 直接取消并释放券，无资金流水
        if (r.status === 'reserved') {
          await c.query(`UPDATE reservations SET status='cancelled' WHERE id=$1`, [r.id]);
          await c.query(
            `UPDATE coupons SET used_reservation_id=NULL, used_at=NULL WHERE used_reservation_id=$1`,
            [r.id],
          );
        }
        await c.query(
          `UPDATE refund_requests SET status='paid', reviewed_by=$1, reviewed_at=now(), paid_at=now(),
             reject_reason=$2 WHERE id=$3`,
          [user.sub, dto.note ?? '未入场/未结算，预付取消、优惠券释放', id],
        );
        await this.refundEvent(c, r, user, { refund_id: rr.id, outcome: 'cancelled_no_settlement' });
        return { ok: true, outcome: 'cancelled_no_settlement' };
      }

      const targetRuling: Ruling | null = dto.ruling ?? (
        await c.query(
          `SELECT ruling FROM appeals WHERE reservation_id=$1 AND status='closed' ORDER BY ruled_at DESC NULLS LAST LIMIT 1`,
          [r.id],
        )
      ).rows[0]?.ruling ?? null;

      // 重新核定（以审核时最新事实）
      const checkInput = await this.buildCheckInput(c, r, Number(rr.requested_amount ?? 0), targetRuling, rr.id);
      const decision = validateRefund(checkInput);
      if (decision.decision === 'awaiting_exit') throw new BadRequestException('车辆尚未离场，离场结算后再核定');
      if (decision.decision === 'duplicate') throw new BadRequestException('存在处理中的退款申请');

      let reversal;
      let outcome = 'reversed';

      if (targetRuling && (decision.validatedAmount > 0 || decision.couponReissue > 0)) {
        // 按终裁重做分账的完整冲正
        const exitAt = r.gate_exit_at ?? r.end_at;
        const kwh = Number(settlement.charging_fee ?? 0) > 0 ? Number(settlement.charging_fee) / 1.2 : 0;
        const oldBreakdown = await this.settlements.computeBreakdown(c, r, exitAt, kwh, settlement.ruling ?? null);
        const newBreakdown = await this.settlements.computeBreakdown(c, r, exitAt, kwh, targetRuling);
        const result = await this.settlements.createReversal(c, {
          r,
          oldSettlement: settlement,
          oldBreakdown,
          newBreakdown,
          kind: 'refund_approved',
          reason: dto.note ?? `退款申请 ${rr.code} 审核通过：道闸/巡查/离场时间证据核定，按 ${targetRuling} 冲正重算`,
          refundRequestId: rr.id,
          user,
          couponReissue: decision.couponReissue,
        });
        reversal = result.reversal;
      } else if (forceCash > 0 || forceCoupon > 0 || decision.validatedAmount > 0) {
        // 裁决不变：平台酌情/事实补偿的纯退款冲正（资金由平台承担）
        const cash = round2(Math.max(forceCash, decision.validatedAmount));
        const coupon = round2(Math.max(forceCoupon, decision.couponReissue));
        reversal = await this.settlements.createSimpleRefundReversal(c, {
          r,
          settlement,
          cash,
          couponAmount: coupon,
          reason: dto.note ?? `退款申请 ${rr.code} 审核通过：平台核准现金补偿（裁决不变）`,
          refundRequestId: rr.id,
          user,
        });
      } else {
        throw new BadRequestException(decision.reasons.join('；') || '按道闸、巡查与离场时间证据核定，无可退金额');
      }

      await c.query(
        `UPDATE refund_requests SET status='paid', validated_amount=$1, coupon_reissue=$2,
           settlement_id=$3, reversal_id=$4, reviewed_by=$5, reviewed_at=now(), paid_at=now(),
           checks=$6, reject_reason=$7 WHERE id=$8`,
        [
          Number(reversal.refund_to_driver),
          Number(reversal.coupon_reissue),
          settlement.id,
          reversal.id,
          user.sub,
          JSON.stringify(decision.checks),
          dto.note ?? null,
          id,
        ],
      );
      await this.refundEvent(c, r, user, {
        refund_id: rr.id, reversal_id: reversal.id, outcome,
        cash: Number(reversal.refund_to_driver), coupon: Number(reversal.coupon_reissue),
      });
      return { ok: true, reversal, decision };
    });
  }

  // ---- 物业/管理员驳回 ----
  @Roles('property', 'admin')
  @Post('refunds/:id/reject')
  async reject(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.db.withTx(async (c) => {
      const rq = await c.query(`SELECT * FROM refund_requests WHERE id=$1 FOR UPDATE`, [id]);
      const rr = rq.rows[0];
      if (!rr) throw new BadRequestException('退款申请不存在');
      if (!['pending'].includes(rr.status)) throw new BadRequestException('该申请已处理');
      const x = await c.query(`SELECT * FROM reservations WHERE id=$1`, [rr.reservation_id]);
      await c.query(
        `UPDATE refund_requests SET status='rejected', reviewed_by=$1, reviewed_at=now(), reject_reason=$2 WHERE id=$3`,
        [user.sub, body?.reason ?? '道闸、巡查与离场时间证据不支持退款', id],
      );
      await this.refundEvent(c, x.rows[0], user, { refund_id: rr.id, outcome: 'rejected' });
      return { ok: true };
    });
  }

  private async refundEvent(c: any, r: any, user: JwtUser, detail: any) {
    if (!r) return;
    await c.query(
      `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
       VALUES ($1,$2,'refund_reviewed',$3,$4,$5)`,
      [r.id, r.spot_id, user.sub, user.role, JSON.stringify(detail)],
    );
  }
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
