import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { JwtUser } from '../auth/auth.service';
import { DbService } from '../database/db.service';
import { Ruling, settlePrice, SettlementBreakdown, SHARES } from '../domain/pricing';
import { DaySegment, FeeSource, splitSettlementDays } from '../domain/daySplit';
import { validateRefund } from '../domain/refund';
import { buildSpotTimeline, TimelineIncident, TimelineOrder } from '../domain/timeline';

class ExitDto {
  charge_kwh?: number;
  exit_at?: string; // 道闸时钟/离场补录时间
}

class RefundRequestDto {
  amount: number;
  reason?: string;
}

class RefundReviewDto {
  approve: boolean;
  note?: string;
}

const FEE_WAIVED_RULINGS = ['platform_fault', 'property_fault', 'stranger'];

@Controller()
@UseGuards(AuthGuard)
export class SettlementController {
  constructor(private db: DbService) {}

  // 离场结算：把计费规则、异常、申诉裁决合并清算，并按结算日拆分分账
  @Post('reservations/:id/exit')
  async exit(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: ExitDto) {
    return this.db.withTx(async (c) => {
      const rq = await c.query(
        `SELECT r.*, s.hourly_rate, s.overnight_cap, s.near_charger, s.owner_id,
                v.is_new_energy, v.plate AS vplate
         FROM reservations r
         JOIN parking_spots s ON s.id=r.spot_id
         JOIN vehicles v ON v.id=r.vehicle_id
         WHERE r.id=$1 FOR UPDATE`,
        [id],
      );
      const r = rq.rows[0];
      if (!r) throw new BadRequestException('预约不存在');
      if (['completed', 'cancelled'].includes(r.status)) throw new BadRequestException('订单已结束');

      const exitAt = dto.exit_at ? new Date(dto.exit_at) : new Date();
      await c.query(
        `UPDATE reservations SET status='completed',
           gate_exit_at=COALESCE($2::timestamptz, gate_exit_at, now()) WHERE id=$1`,
        [id, exitAt],
      );

      // 充电会话落档：重算分账与跨日拆分的费用归属依据
      if ((dto.charge_kwh ?? 0) > 0) {
        await c.query(
          `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail, occurred_at)
           VALUES ($1,$2,'charging_session',$3,$4,$5,$6,$7)`,
          [id, r.spot_id, user.sub, user.role, r.plate, JSON.stringify({ kwh: dto.charge_kwh }), exitAt],
        );
      }

      const { breakdown, daySegments } = await this.computeBreakdown(c, r, exitAt, dto.charge_kwh ?? 0);
      const settlement = await this.persistSettlement(c, r, exitAt, breakdown, daySegments);

      // 信用分
      if (breakdown.creditTarget !== 'none' && breakdown.creditDelta !== 0) {
        const targetId =
          breakdown.creditTarget === 'owner'
            ? r.owner_id
            : breakdown.creditTarget === 'property'
              ? null
              : r.driver_id;
        if (targetId) {
          await c.query(`UPDATE users SET credit_score=GREATEST(0, credit_score + $1) WHERE id=$2`, [
            breakdown.creditDelta,
            targetId,
          ]);
        }
        await c.query(
          `INSERT INTO service_events(reservation_id, spot_id, type, actor_role, detail)
           VALUES ($1,$2,'credit_adjusted',$3,$4)`,
          [
            id,
            r.spot_id,
            user.role,
            JSON.stringify({ target: breakdown.creditTarget, delta: breakdown.creditDelta }),
          ],
        );
      }

      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
         VALUES ($1,$2,'settlement_completed',$3,$4,$5,$6)`,
        [
          id,
          r.spot_id,
          user.sub,
          user.role,
          r.plate,
          JSON.stringify({ payable: breakdown.payable, refund: breakdown.refund, exit_charge: breakdown.exitCharge }),
        ],
      );

      return settlement;
    });
  }

  // 仅试算（离场前预览账单，含跨日拆分预览）
  @Get('reservations/:id/quote')
  async quote(@CurrentUser() user: JwtUser, @Param('id') id: string, @Query('charge_kwh') kwh?: string) {
    const rq = await this.db.query(
      `SELECT r.*, s.hourly_rate, s.overnight_cap, s.near_charger, s.owner_id, v.is_new_energy
       FROM reservations r
       JOIN parking_spots s ON s.id=r.spot_id
       JOIN vehicles v ON v.id=r.vehicle_id
       WHERE r.id=$1`,
      [id],
    );
    const r = rq.rows[0];
    if (!r) throw new BadRequestException('预约不存在');
    const { breakdown, daySegments } = await this.computeBreakdown(this.db, r, new Date(), Number(kwh ?? 0));
    return { ...breakdown, day_segments: daySegments };
  }

  @Get('reservations/:id/settlement')
  async settlement(@Param('id') id: string) {
    const sq = await this.db.query(
      `SELECT * FROM settlements WHERE reservation_id=$1 AND status='active' ORDER BY id DESC LIMIT 1`,
      [id],
    );
    if (!sq.rows[0]) return null;
    const s = sq.rows[0];
    const ledger = await this.db.query(`SELECT * FROM ledger_entries WHERE settlement_id=$1 ORDER BY id`, [s.id]);
    const segments = await this.db.query(
      `SELECT * FROM settlement_day_segments WHERE settlement_id=$1 ORDER BY from_at`,
      [s.id],
    );
    const reversals = await this.reversalsForReservation(id);
    return { ...s, ledger: ledger.rows, day_segments: segments.rows, reversals };
  }

  // 申诉终裁后重算分账（物业/管理员）：生成冲正单红冲原分账，再按终裁重算新分账
  @Roles('property', 'admin')
  @Post('appeals/:id/resettle')
  async resettle(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.db.withTx(async (c) => {
      const aq = await c.query(`SELECT * FROM appeals WHERE id=$1 AND status='closed'`, [id]);
      const appeal = aq.rows[0];
      if (!appeal) throw new BadRequestException('申诉未终裁，不能重算');
      const rq = await c.query(
        `SELECT r.*, s.hourly_rate, s.overnight_cap, s.near_charger, s.owner_id, v.is_new_energy
         FROM reservations r
         JOIN parking_spots s ON s.id=r.spot_id
         JOIN vehicles v ON v.id=r.vehicle_id
         WHERE r.id=$1 FOR UPDATE`,
        [appeal.reservation_id],
      );
      const r = rq.rows[0];
      const old = await c.query(
        `SELECT * FROM settlements WHERE reservation_id=$1 AND status='active' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [r.id],
      );

      let reversal: any = null;
      if (old.rows[0]) {
        const oldSettlement = old.rows[0];
        // 1) 反向冲销旧结算对信用分的影响（仅系统内账号：车主/业主）
        if (oldSettlement.credit_delta !== 0 && ['driver', 'owner'].includes(oldSettlement.credit_target)) {
          const oldTargetId = oldSettlement.credit_target === 'owner' ? r.owner_id : r.driver_id;
          await c.query(`UPDATE users SET credit_score=GREATEST(0, credit_score - $1) WHERE id=$2`, [
            oldSettlement.credit_delta,
            oldTargetId,
          ]);
        }
        // 2) 生成冲正单（关联原分账与申诉）
        const rvCode = 'RV' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000).toString(36).toUpperCase();
        const rv = await c.query(
          `INSERT INTO settlement_reversals(code, settlement_id, appeal_id, reason, created_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [
            rvCode,
            oldSettlement.id,
            appeal.id,
            `申诉 ${appeal.code} 终裁（${appeal.ruling}）成立，红冲原分账 ${oldSettlement.code} 并按终裁重算`,
            user.sub,
          ],
        );
        reversal = rv.rows[0];
        // 3) 红冲流水：原分账的原始资金流水逐笔生成方向相反的冲正流水（借贷互换，全局仍平衡）；
        //    退款单流水与历史冲正流水不再二次冲正，作为原分账资金史保留
        const oldLedger = await c.query(
          `SELECT * FROM ledger_entries WHERE settlement_id=$1 AND reversal_id IS NULL AND refund_request_id IS NULL ORDER BY id`,
          [oldSettlement.id],
        );
        for (const e of oldLedger.rows) {
          await c.query(
            `INSERT INTO ledger_entries(settlement_id, account, direction, amount, memo, reversal_id)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [
              oldSettlement.id,
              e.account,
              e.direction === 'debit' ? 'credit' : 'debit',
              e.amount,
              `冲正：${e.memo}`,
              reversal.id,
            ],
          );
        }
        // 4) 原分账标记为已冲正（保留档案，不物理删除）
        await c.query(`UPDATE settlements SET status='reversed' WHERE id=$1`, [oldSettlement.id]);
      }

      const exitAt = r.gate_exit_at ?? new Date();
      const { breakdown, daySegments } = await this.computeBreakdown(c, r, exitAt, 0, appeal.ruling, appeal.id);
      const settlement = await this.persistSettlement(c, r, exitAt, breakdown, daySegments, appeal.id, appeal.ruling);

      if (reversal) {
        await c.query(`UPDATE settlement_reversals SET new_settlement_id=$1 WHERE id=$2`, [settlement.id, reversal.id]);
        reversal = { ...reversal, new_settlement_id: settlement.id };
      }

      // 终裁后信用分修正：先回滚旧的影响再施加新的
      if (breakdown.creditDelta !== 0) {
        const targetId = breakdown.creditTarget === 'owner' ? r.owner_id : r.driver_id;
        await c.query(`UPDATE users SET credit_score=GREATEST(0, credit_score + $1) WHERE id=$2`, [
          breakdown.creditDelta,
          targetId,
        ]);
      }
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
         VALUES ($1,$2,'settlement_recomputed',$3,$4,$5)`,
        [
          r.id,
          r.spot_id,
          user.sub,
          user.role,
          JSON.stringify({ appeal_id: id, ruling: appeal.ruling, reversal_id: reversal?.id ?? null }),
        ],
      );
      return { ...settlement, reversal };
    });
  }

  // ---- 车主退款申请：按道闸/巡查/离场时间校验可退金额，避免重复冲销 ----
  @Roles('driver')
  @Post('reservations/:id/refund-requests')
  async createRefundRequest(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: RefundRequestDto) {
    const amount = Number(dto.amount);
    if (!(amount > 0)) throw new BadRequestException('退款金额必须大于 0');
    return this.db.withTx(async (c) => {
      const rq = await c.query(
        `SELECT r.*, s.owner_id FROM reservations r JOIN parking_spots s ON s.id=r.spot_id
         WHERE r.id=$1 AND r.driver_id=$2 FOR UPDATE`,
        [id, user.sub],
      );
      const r = rq.rows[0];
      if (!r) throw new BadRequestException('预约不存在或不属于本人');
      if (r.status !== 'completed') throw new BadRequestException('订单尚未离场结算，不能申请退款');
      const sq = await c.query(
        `SELECT * FROM settlements WHERE reservation_id=$1 AND status='active' ORDER BY id DESC LIMIT 1`,
        [id],
      );
      const s = sq.rows[0];
      if (!s) throw new BadRequestException('订单未结算，不能申请退款');
      const pending = await c.query(
        `SELECT id FROM refund_requests WHERE reservation_id=$1 AND status='pending'`,
        [id],
      );
      if (pending.rows[0]) throw new BadRequestException('已有待审核的退款申请，请勿重复提交');

      const validation = await this.validateRefundFor(c, r, s, amount);
      if (validation.maxRefundable <= 0) {
        throw new BadRequestException(
          `重复冲销校验未通过：实收 ¥${validation.totalPaid.toFixed(2)} 已退 ¥${validation.alreadyRefunded.toFixed(2)}，无可退余额`,
        );
      }
      const code = 'RF' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000).toString(36).toUpperCase();
      const ins = await c.query(
        `INSERT INTO refund_requests(code, reservation_id, settlement_id, driver_id, requested_amount, reason, status, validated_amount, checks)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8) RETURNING *`,
        [code, r.id, s.id, user.sub, amount, dto.reason ?? null, validation.maxRefundable, JSON.stringify(validation.checks)],
      );
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
         VALUES ($1,$2,'refund_requested',$3,'driver',$4)`,
        [r.id, r.spot_id, user.sub, JSON.stringify({ refund_code: code, amount, max_refundable: validation.maxRefundable })],
      );
      return { ...ins.rows[0], validation };
    });
  }

  @Get('refund-requests')
  async listRefundRequests(@CurrentUser() user: JwtUser, @Query('reservation_id') reservationId?: string) {
    const params: any[] = [];
    let where = '1=1';
    if (user.role === 'driver') {
      params.push(user.sub);
      where += ` AND f.driver_id=$${params.length}`;
    } else if (user.role === 'owner') {
      params.push(user.sub);
      where += ` AND s.owner_id=$${params.length}`;
    }
    if (reservationId) {
      params.push(Number(reservationId));
      where += ` AND f.reservation_id=$${params.length}`;
    }
    return this.db
      .query(
        `SELECT f.*, r.code AS reservation_code, r.plate, sp.code AS spot_code, u.name AS driver_name,
                rv.name AS reviewer_name
         FROM refund_requests f
         JOIN reservations r ON r.id=f.reservation_id
         JOIN parking_spots sp ON sp.id=r.spot_id
         JOIN users u ON u.id=f.driver_id
         JOIN parking_spots s ON s.id=r.spot_id
         LEFT JOIN users rv ON rv.id=f.reviewed_by
         WHERE ${where}
         ORDER BY f.id DESC LIMIT 200`,
        params,
      )
      .then((q) => q.rows);
  }

  // 物业/管理员审批退款：事务内重算校验，超额部分自动截断，可退余额为 0 时自动拒绝（防重复冲销）
  @Roles('property', 'admin')
  @Post('refund-requests/:id/review')
  async reviewRefundRequest(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: RefundReviewDto) {
    return this.db.withTx(async (c) => {
      const fq = await c.query(`SELECT * FROM refund_requests WHERE id=$1 FOR UPDATE`, [id]);
      const f = fq.rows[0];
      if (!f) throw new BadRequestException('退款申请不存在');
      if (f.status !== 'pending') throw new BadRequestException('该申请已处理，不能重复审批');

      const rq = await c.query(
        `SELECT r.*, s.owner_id FROM reservations r JOIN parking_spots s ON s.id=r.spot_id WHERE r.id=$1 FOR UPDATE`,
        [f.reservation_id],
      );
      const r = rq.rows[0];
      const sq = await c.query(`SELECT * FROM settlements WHERE id=$1`, [f.settlement_id]);
      const s = sq.rows[0];

      // 审批时重新校验（期间可能已有其他退款到账）
      const validation = await this.validateRefundFor(c, r, s, Number(f.requested_amount));

      let status: 'approved' | 'rejected';
      let approvedAmount = 0;
      let note = dto.note ?? '';
      if (!dto.approve) {
        status = 'rejected';
      } else if (validation.approvedAmount <= 0) {
        status = 'rejected';
        note = [note, '系统重复冲销校验：可退余额为 0，自动拒绝'].filter(Boolean).join('；');
      } else {
        status = 'approved';
        approvedAmount = validation.approvedAmount;
        if (approvedAmount < Number(f.requested_amount)) {
          note = [note, `申请 ¥${Number(f.requested_amount).toFixed(2)} 超出可退上限，按 ¥${approvedAmount.toFixed(2)} 核准`]
            .filter(Boolean)
            .join('；');
        }
      }

      await c.query(
        `UPDATE refund_requests SET status=$1, validated_amount=$2, checks=$3, review_note=$4, reviewed_by=$5, reviewed_at=now()
         WHERE id=$6`,
        [status, status === 'approved' ? approvedAmount : 0, JSON.stringify(validation.checks), note || null, user.sub, id],
      );

      if (status === 'approved') {
        // 退款资金流水：托管账户 → 车主（成对入账，全局借贷平衡）
        await c.query(
          `INSERT INTO ledger_entries(settlement_id, account, direction, amount, memo, refund_request_id)
           VALUES ($1,'escrow','debit',$2,$3,$4)`,
          [s.id, approvedAmount, `退款单 ${f.code} 托管退款给车主（道闸/巡查/离场时间校验通过）`, f.id],
        );
        await c.query(
          `INSERT INTO ledger_entries(settlement_id, account, direction, amount, memo, refund_request_id)
           VALUES ($1,'driver','credit',$2,$3,$4)`,
          [s.id, approvedAmount, `退款单 ${f.code} 退款到账（申请 ¥${Number(f.requested_amount).toFixed(2)}）`, f.id],
        );
      }
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          r.id,
          r.spot_id,
          status === 'approved' ? 'refund_approved' : 'refund_rejected',
          user.sub,
          user.role,
          JSON.stringify({ refund_code: f.code, approved_amount: approvedAmount, note }),
        ],
      );
      return { ...(await c.query(`SELECT * FROM refund_requests WHERE id=$1`, [id])).rows[0], validation };
    });
  }

  // 冲正单追溯（物业/管理员全量；业主限自己车位；车主限本人订单）
  @Get('reversals')
  async listReversals(@CurrentUser() user: JwtUser) {
    const params: any[] = [];
    let where = '1=1';
    if (user.role === 'owner') {
      params.push(user.sub);
      where += ` AND sp.owner_id=$${params.length}`;
    } else if (user.role === 'driver') {
      params.push(user.sub);
      where += ` AND r.driver_id=$${params.length}`;
    }
    return this.db
      .query(
        `SELECT rv.*, os.code AS settlement_code, ns.code AS new_settlement_code,
                a.code AS appeal_code, a.ruling, r.code AS reservation_code, sp.code AS spot_code,
                u.name AS created_by_name
         FROM settlement_reversals rv
         JOIN settlements os ON os.id=rv.settlement_id
         LEFT JOIN settlements ns ON ns.id=rv.new_settlement_id
         LEFT JOIN appeals a ON a.id=rv.appeal_id
         JOIN reservations r ON r.id=os.reservation_id
         JOIN parking_spots sp ON sp.id=os.spot_id
         LEFT JOIN users u ON u.id=rv.created_by
         WHERE ${where}
         ORDER BY rv.id DESC LIMIT 200`,
        params,
      )
      .then((q) => q.rows);
  }

  // 分账流水总览（物业/管理员/业主看自己车位）
  @Get('ledger')
  async ledger(
    @CurrentUser() user: JwtUser,
    @Query('account') account?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const params: any[] = [];
    let where = '1=1';
    if (account) {
      params.push(account);
      where += ` AND l.account=$${params.length}`;
    }
    if (from) {
      params.push(new Date(from));
      where += ` AND l.created_at >= $${params.length}`;
    }
    if (to) {
      params.push(new Date(to));
      where += ` AND l.created_at <= $${params.length}`;
    }
    if (user.role === 'owner') {
      params.push(user.sub);
      where += ` AND s.spot_id IN (SELECT id FROM parking_spots WHERE owner_id=$${params.length})`;
    }
    return this.db
      .query(
        `SELECT l.*, st.code AS settlement_code, r.code AS reservation_code, r.spot_id, sp.code AS spot_code
         FROM ledger_entries l
         JOIN settlements st ON st.id=l.settlement_id
         JOIN reservations r ON r.id=st.reservation_id
         JOIN parking_spots sp ON sp.id=st.spot_id
         WHERE ${where}
         ORDER BY l.id DESC LIMIT 300`,
        params,
      )
      .then((q) => q.rows);
  }

  // ---- 单车位一晚时间轴：解释每段时间谁使用/谁付款/谁违约 ----
  @Get('spots/:id/timeline')
  async timeline(
    @Param('id') id: string,
    @Query('date') date?: string, // YYYY-MM-DD（当晚起点，默认今晚）
    @Query('start') startQ?: string, // 审计任意时间窗（优先于 date）
    @Query('end') endQ?: string,
  ) {
    const spot = await this.db.query(`SELECT * FROM parking_spots WHERE id=$1`, [id]);
    if (!spot.rows[0]) throw new BadRequestException('车位不存在');

    // 默认"今晚"：当天 18:00 到次日 09:00；也可用 start/end 指定任意审计窗口
    let nightStart: Date;
    let nightEnd: Date;
    if (startQ && endQ) {
      nightStart = new Date(startQ);
      nightEnd = new Date(endQ);
    } else {
      const base = date ? new Date(`${date}T18:00:00`) : (() => {
        const d = new Date();
        d.setHours(18, 0, 0, 0);
        return d;
      })();
      nightStart = base;
      nightEnd = new Date(base.getTime() + 15 * 3600000);
    }

    const oq = await this.db.query(
      `SELECT r.id, r.code, u.name AS driver_name, r.plate, r.status, r.start_at, r.end_at,
              r.gate_entry_at, r.parking_confirmed_at, r.gate_exit_at,
              st.ruling, st.base_fee, st.overtime_fee, st.wrong_park_fine,
              st.abnormal_compensation, st.payable,
              (SELECT MIN(occurred_at) FROM service_events e
                WHERE e.reservation_id=r.id AND e.type IN ('parking_confirmed','gate_entry')) AS dummy
       FROM reservations r
       JOIN users u ON u.id=r.driver_id
       LEFT JOIN settlements st ON st.reservation_id=r.id AND st.status='active'
       WHERE r.spot_id=$1 AND r.start_at < $2 AND r.end_at > $3
       ORDER BY r.start_at`,
      [id, nightEnd, nightStart],
    );

    // usable_from：识别成功/可使用时间点（被陌生车占用则以占用解除时间为准，简化用停车确认时间）
    const orders: TimelineOrder[] = oq.rows.map((o: any) => ({
      id: o.id,
      code: o.code,
      driverName: o.driver_name,
      plate: o.plate,
      status: o.status,
      reservedStart: o.start_at,
      reservedEnd: o.end_at,
      gateEntryAt: o.gate_entry_at,
      parkingConfirmedAt: o.parking_confirmed_at,
      gateExitAt: o.gate_exit_at,
      usableFrom: o.parking_confirmed_at ?? o.gate_entry_at,
      settlement: o.ruling || o.base_fee != null
        ? {
            ruling: o.ruling,
            baseFee: Number(o.base_fee ?? 0),
            overtimeFee: Number(o.overtime_fee ?? 0),
            wrongParkFine: Number(o.wrong_park_fine ?? 0),
            abnormalCompensation: Number(o.abnormal_compensation ?? 0),
            payable: Number(o.payable ?? 0),
          }
        : null,
    }));

    const iq = await this.db.query(
      `SELECT id, type, status, plate, created_at, resolved_at, resolution, reservation_id
       FROM incident_tickets
       WHERE spot_id=$1 AND created_at < $2 AND (resolved_at IS NULL OR resolved_at > $3)
       ORDER BY created_at`,
      [id, nightEnd, nightStart],
    );
    const incidents: TimelineIncident[] = iq.rows.map((i: any) => ({
      id: i.id,
      type: i.type,
      status: i.status,
      plate: i.plate,
      createdAt: i.created_at,
      resolvedAt: i.resolved_at,
      resolution: i.resolution,
      reservationId: i.reservation_id,
    }));

    const segments = buildSpotTimeline(nightStart, nightEnd, orders, incidents);
    return {
      spot: { id: spot.rows[0].id, code: spot.rows[0].code },
      night_start: nightStart,
      night_end: nightEnd,
      orders,
      incidents,
      segments,
    };
  }

  // ---- 核心：组装分账输入 + 跨日拆分 ----
  private async computeBreakdown(
    client: any,
    r: any,
    exitAt: Date,
    chargeKwh: number,
    forcedRuling?: Ruling | null,
    appealId?: number,
  ): Promise<{ breakdown: SettlementBreakdown; daySegments: DaySegment[] }> {
    // 该笔服务关联的异常
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

    // 申诉裁决（优先使用传入的终裁，其次取已关闭申诉）
    let ruling: Ruling | null = forcedRuling ?? null;
    if (!ruling) {
      const aq = await client.query(
        `SELECT ruling FROM appeals WHERE reservation_id=$1 AND status='closed' ORDER BY ruled_at DESC NULLS LAST LIMIT 1`,
        [r.id],
      );
      ruling = aq.rows[0]?.ruling ?? null;
    }

    // 优惠券抵扣（预约时已核销，这里从 coupon 关联反查）
    const cq = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS amount FROM coupons WHERE used_reservation_id=$1`,
      [r.id],
    );
    const couponAmount = Number(cq.rows[0].amount);

    // usable_from：若存在陌生车占用，为占用解除时间；否则入场/停车确认时间
    let usableFrom = r.parking_confirmed_at ?? r.gate_entry_at ?? r.start_at;
    const stranger = iq.rows.find((i: any) => ['stranger_occupy', 'ice_occupy_charger'].includes(i.type));
    if (stranger?.resolved_at && new Date(stranger.resolved_at) > new Date(usableFrom)) {
      usableFrom = stranger.resolved_at;
    }

    // 充电量结算优先使用已持久化的值（重算场景）
    let kwh = chargeKwh;
    let chargingAt: Date | null = null;
    const chargeEvent = await client.query(
      `SELECT detail, occurred_at FROM service_events WHERE reservation_id=$1 AND type='charging_session' ORDER BY id DESC LIMIT 1`,
      [r.id],
    );
    if (!kwh) {
      kwh = Number(chargeEvent.rows[0]?.detail?.kwh ?? 0);
    }
    chargingAt = chargeEvent.rows[0]?.occurred_at ?? null;

    // 退款审批通道已先行退还的金额：结算/重算时从应退中扣减，避免重复冲销
    const refundedQ = await client.query(
      `SELECT COALESCE(SUM(validated_amount),0) AS total FROM refund_requests
       WHERE reservation_id=$1 AND status='approved'`,
      [r.id],
    );

    const breakdown = settlePrice({
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
      prepaid: Number(r.estimated_fee && couponAmount ? Math.max(0, Number(r.estimated_fee) - couponAmount) : (r.estimated_fee ?? 0)),
      externalRefunded: Number(refundedQ.rows[0].total),
    });

    // ---- 跨日分账：按实际占用时段拆分到每个结算日，并标注每段费用来源 ----
    const sources = this.buildFeeSources(r, iq.rows, breakdown, kwh, chargingAt, exitAt);
    const daySegments = splitSettlementDays({
      usableFrom: breakdown.usableFrom ?? breakdown.billableEnd,
      billableEnd: breakdown.billableEnd,
      baseFee: breakdown.baseFee,
      chargingFee: breakdown.chargingFee,
      chargingAt,
      overtimeFee: breakdown.overtimeFee,
      overtimeFrom:
        breakdown.overtimeFee > 0
          ? new Date(new Date(r.end_at).getTime() + 10 * 60000) // 预约结束 + 离场宽限
          : null,
      overtimeTo: breakdown.overtimeFee > 0 ? exitAt : null,
      ownerShare: SHARES.owner,
      propertyShare: SHARES.property,
      sources,
    });

    return { breakdown, daySegments };
  }

  // 每段费用来源：换位调度 / 优惠券抵扣 / 物业人工放行 / 业主回家 / 陌生车占用 / 信号差 / 错停 / 充电
  private buildFeeSources(
    r: any,
    incidentRows: any[],
    b: SettlementBreakdown,
    kwh: number,
    chargingAt: Date | null,
    exitAt: Date,
  ): FeeSource[] {
    const sources: FeeSource[] = [];
    if (b.couponDiscount > 0) {
      sources.push({ type: 'coupon', label: `优惠券抵扣 ¥${b.couponDiscount.toFixed(2)}`, amount: b.couponDiscount, at: r.created_at });
    }
    for (const i of incidentRows) {
      const at = i.created_at;
      switch (i.type) {
        case 'manual_release':
          sources.push({ type: 'manual_release', label: `物业人工放行（${i.detail?.note ?? '核对预约后开闸'}）`, at });
          break;
        case 'spot_swap':
          sources.push({
            type: 'spot_swap',
            label: `换位调度：${i.detail?.from_spot ?? '?'} → ${i.detail?.to_spot ?? '?'}（${i.detail?.reason ?? '物业协调'}）`,
            at,
          });
          break;
        case 'owner_return':
          sources.push({ type: 'owner_return', label: '业主临时回家，共享服务提前终止', at });
          break;
        case 'stranger_occupy':
          sources.push({ type: 'stranger_occupy', label: '陌生车辆占用，等待期间不计费', at });
          break;
        case 'ice_occupy_charger':
          sources.push({ type: 'stranger_occupy', label: '燃油车占用充电位，等待期间不计费', at });
          break;
        case 'weak_signal':
          sources.push({ type: 'weak_signal', label: '地下车库信号差，使用离线导航', at });
          break;
        case 'wrong_parking':
          sources.push({ type: 'wrong_parking', label: `错停核验（实际停放 ${i.detail?.actual ?? '?'}）`, at });
          break;
        case 'visitor_overstay':
          sources.push({ type: 'overstay', label: '访客超时，宽限后 1.5× 计费', at });
          break;
      }
    }
    if (kwh > 0 && b.chargingFee > 0) {
      sources.push({
        type: 'charging',
        label: `充电 ${kwh}kWh × 1.2 元 = ¥${b.chargingFee.toFixed(2)}`,
        amount: b.chargingFee,
        at: chargingAt ?? exitAt,
      });
    }
    return sources;
  }

  // 退款校验上下文：汇总道闸、巡查、离场时间与已退金额
  private async validateRefundFor(client: any, r: any, s: any, requestedAmount: number) {
    const approved = await client.query(
      `SELECT COALESCE(SUM(validated_amount),0) AS total FROM refund_requests
       WHERE reservation_id=$1 AND status='approved'`,
      [r.id],
    );
    const patrols = await client.query(
      `SELECT patrolled_at, note FROM patrol_logs
       WHERE spot_id=$1 AND patrolled_at BETWEEN $2::timestamptz - interval '2 hours' AND $3::timestamptz + interval '2 hours'
       ORDER BY patrolled_at`,
      [r.spot_id, r.start_at, r.end_at],
    );
    // 结算后若申诉已终裁（尚未重算），按最新终裁口径校验免单
    const appealQ = await client.query(
      `SELECT ruling FROM appeals WHERE reservation_id=$1 AND status='closed' ORDER BY ruled_at DESC NULLS LAST LIMIT 1`,
      [r.id],
    );
    const effectiveRuling = s?.ruling ?? appealQ.rows[0]?.ruling ?? null;
    return validateRefund({
      prepaid: Number(s?.prepaid ?? 0),
      exitCharge: Number(s?.exit_charge ?? 0),
      settledPayable: Number(s?.payable ?? 0),
      settledRefund: Number(s?.refund ?? 0),
      approvedRefunds: Number(approved.rows[0].total),
      requestedAmount,
      gateEntryAt: r.gate_entry_at ?? null,
      gateExitAt: r.gate_exit_at ?? null,
      reservedEnd: r.end_at,
      patrols: patrols.rows.map((p: any) => ({
        at: p.patrolled_at,
        finding: String(p.note ?? '').split(':')[0] || 'normal',
        note: p.note,
      })),
      feeWaived: FEE_WAIVED_RULINGS.includes(effectiveRuling ?? ''),
    });
  }

  private async reversalsForReservation(reservationId: string) {
    const q = await this.db.query(
      `SELECT rv.*, os.code AS settlement_code, ns.code AS new_settlement_code, a.code AS appeal_code
       FROM settlement_reversals rv
       JOIN settlements os ON os.id=rv.settlement_id
       LEFT JOIN settlements ns ON ns.id=rv.new_settlement_id
       LEFT JOIN appeals a ON a.id=rv.appeal_id
       WHERE os.reservation_id=$1
       ORDER BY rv.id DESC`,
      [reservationId],
    );
    return q.rows;
  }

  private async persistSettlement(
    c: any,
    r: any,
    exitAt: Date,
    b: SettlementBreakdown,
    daySegments: DaySegment[],
    appealId?: number,
    ruling?: Ruling | null,
  ) {
    const code = 'ST' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1000).toString(36).toUpperCase();
    const ins = await c.query(
      `INSERT INTO settlements(code, reservation_id, spot_id, actual_entry_at, actual_exit_at, usable_from,
         duration_minutes, base_fee, charging_fee, overtime_fee, wrong_park_fine,
         coupon_discount, abnormal_compensation, coupon_compensation, owner_compensation, prepaid, refund, exit_charge, payable,
         owner_income, property_fee, platform_fee, owner_share, property_share, platform_share,
         credit_target, credit_delta, appeal_id, ruling, detail, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
               $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,'active')
       RETURNING *`,
      [
        code, r.id, r.spot_id, b.actualEntryAt, b.actualExitAt, b.usableFrom,
        b.durationMinutes, b.baseFee, b.chargingFee, b.overtimeFee, b.wrongParkFine,
        b.couponDiscount, b.abnormalCompensation, b.couponCompensation, b.ownerCompensation, b.prepaid, b.refund, b.exitCharge, b.payable,
        b.ownerIncome, b.propertyFee, b.platformFee, b.ownerShare, b.propertyShare, b.platformShare,
        b.creditTarget, b.creditDelta, appealId ?? null, ruling ?? b.ruling,
        JSON.stringify({ notes: b.notes, cross_day: daySegments.length > 1 }),
      ],
    );
    const settlement = ins.rows[0];
    await c.query(`UPDATE reservations SET settled_at=now(), settlement_id=$1 WHERE id=$2`, [
      settlement.id,
      r.id,
    ]);
    for (const e of b.ledger) {
      await c.query(
        `INSERT INTO ledger_entries(settlement_id, account, direction, amount, memo)
         VALUES ($1,$2,$3,$4,$5)`,
        [settlement.id, e.account === 'owner' ? `owner:${r.owner_id}` : e.account, e.direction, e.amount, e.memo],
      );
    }
    // 跨日分账段落库（含单结算日订单，便于财务页统一展示每段费用来源）
    for (const seg of daySegments) {
      await c.query(
        `INSERT INTO settlement_day_segments(settlement_id, settlement_date, from_at, to_at, minutes,
           base_fee, charging_fee, overtime_fee, service_revenue, owner_income, property_fee, platform_fee, sources)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          settlement.id,
          seg.settlementDate,
          seg.from,
          seg.to,
          seg.minutes,
          seg.baseFee,
          seg.chargingFee,
          seg.overtimeFee,
          seg.serviceRevenue,
          seg.ownerIncome,
          seg.propertyFee,
          seg.platformFee,
          JSON.stringify(seg.sources),
        ],
      );
    }
    const ledger = await c.query(`SELECT * FROM ledger_entries WHERE settlement_id=$1 ORDER BY id`, [settlement.id]);
    return { ...settlement, ledger: ledger.rows, day_segments: daySegments, notes: b.notes };
  }
}
