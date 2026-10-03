import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { JwtUser } from '../auth/auth.service';
import { DbService } from '../database/db.service';
import { PRICING } from '../domain/pricing';
import { buildSpotTimeline, TimelineIncident, TimelineOrder } from '../domain/timeline';
import { SettlementService } from './settlement.service';

class ExitDto {
  charge_kwh?: number;
  charge_at?: string; // 充电发生时点（跨日订单归属结算日用，缺省取离场时间）
  exit_at?: string; // 道闸时钟/离场补录时间
}

@Controller()
@UseGuards(AuthGuard)
export class SettlementController {
  constructor(
    private db: DbService,
    private settlements: SettlementService,
  ) {}

  // 离场结算：把计费规则、异常、申诉裁决合并清算
  @Post('reservations/:id/exit')
  async exit(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() dto: ExitDto) {
    return this.db.withTx(async (c) => {
      const rq = await c.query(
        `SELECT r.*, s.hourly_rate, s.overnight_cap, s.near_charger, s.owner_id, s.code AS spot_code,
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

      // 充电会话留痕（跨日订单按充电发生时点归属结算日）
      if (dto.charge_kwh && dto.charge_kwh > 0) {
        await c.query(
          `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, occurred_at, detail)
           VALUES ($1,$2,'charging_session',$3,$4,$5,COALESCE($6::timestamptz, now()),$7)`,
          [
            id, r.spot_id, user.sub, user.role, r.plate,
            dto.charge_at ? new Date(dto.charge_at) : exitAt,
            JSON.stringify({ kwh: dto.charge_kwh }),
          ],
        );
      }

      const breakdown = await this.settlements.computeBreakdown(c, r, exitAt, dto.charge_kwh ?? 0);
      const settlement = await this.settlements.persistSettlement(c, r, exitAt, breakdown);

      await this.settlements.applyCredit(c, r, breakdown.creditTarget, breakdown.creditDelta, user);

      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
         VALUES ($1,$2,'settlement_completed',$3,$4,$5,$6)`,
        [
          id,
          r.spot_id,
          user.sub,
          user.role,
          r.plate,
          JSON.stringify({
            payable: breakdown.payable,
            refund: breakdown.refund,
            exit_charge: breakdown.exitCharge,
            day_splits: breakdown.splits.length,
          }),
        ],
      );

      return settlement;
    });
  }

  // 仅试算（离场前预览账单）
  @Get('reservations/:id/quote')
  async quote(@CurrentUser() user: JwtUser, @Param('id') id: string, @Query('charge_kwh') kwh?: string) {
    const rq = await this.db.query(
      `SELECT r.*, s.hourly_rate, s.overnight_cap, s.near_charger, s.owner_id, s.code AS spot_code, v.is_new_energy
       FROM reservations r
       JOIN parking_spots s ON s.id=r.spot_id
       JOIN vehicles v ON v.id=r.vehicle_id
       WHERE r.id=$1`,
      [id],
    );
    const r = rq.rows[0];
    if (!r) throw new BadRequestException('预约不存在');
    return this.settlements.computeBreakdown(this.db, r, new Date(), Number(kwh ?? 0));
  }

  @Get('reservations/:id/settlement')
  async settlement(@Param('id') id: string) {
    const sq = await this.db.query(
      `SELECT * FROM settlements WHERE reservation_id=$1 ORDER BY id DESC LIMIT 1`,
      [id],
    );
    if (!sq.rows[0]) return null;
    const ledger = await this.db.query(
      `SELECT * FROM ledger_entries WHERE settlement_id=$1 ORDER BY id`,
      [sq.rows[0].id],
    );
    const splits = await this.db.query(
      `SELECT id, settlement_id, settlement_date::text AS settlement_date, period_from, period_to,
              duration_minutes, spot_code, base_fee, charging_fee, overtime_fee, wrong_park_fine,
              coupon_discount, service_revenue, owner_income, property_fee, platform_fee, sources, created_at
       FROM settlement_day_splits WHERE settlement_id=$1 ORDER BY period_from`,
      [sq.rows[0].id],
    );
    const reversals = await this.db.query(
      `SELECT * FROM settlement_reversals WHERE reservation_id=$1 ORDER BY id`,
      [id],
    );
    const versions = await this.db.query(
      `SELECT id, code, kind, ruling, payable, refund, owner_income, property_fee, platform_fee,
              supersedes_id, reversal_count, created_at
       FROM settlements WHERE reservation_id=$1 ORDER BY id`,
      [id],
    );
    return { ...sq.rows[0], ledger: ledger.rows, splits: splits.rows, reversals: reversals.rows, versions: versions.rows };
  }

  // 申诉终裁后冲正重算（物业/管理员）：不再删除原分账，而是红字冲销 + 重做并关联原分账
  @Roles('property', 'admin')
  @Post('appeals/:id/resettle')
  async resettle(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.db.withTx(async (c) => {
      const aq = await c.query(`SELECT * FROM appeals WHERE id=$1 AND status='closed'`, [id]);
      const appeal = aq.rows[0];
      if (!appeal) throw new BadRequestException('申诉未终裁，不能重算');

      const rq = await c.query(
        `SELECT r.*, s.hourly_rate, s.overnight_cap, s.near_charger, s.owner_id, s.code AS spot_code, v.is_new_energy
         FROM reservations r
         JOIN parking_spots s ON s.id=r.spot_id
         JOIN vehicles v ON v.id=r.vehicle_id
         WHERE r.id=$1 FOR UPDATE`,
        [appeal.reservation_id],
      );
      const r = rq.rows[0];

      const old = await this.settlements.latestSettlement(c, r.id);
      if (!old) throw new BadRequestException('订单尚未离场结算，无法冲正；请先离场结算');

      // 幂等：分账金额只取决于裁决。当前生效分账的裁决已等于终裁（离场时已采用或已冲正重做），
      // 则资金口径无需再变，直接返回当前版本，避免重复冲销。
      if ((old.ruling ?? null) === (appeal.ruling ?? null)) {
        const ledger = await c.query(`SELECT * FROM ledger_entries WHERE settlement_id=$1 ORDER BY id`, [old.id]);
        const splits = await c.query(
          `SELECT * FROM settlement_day_splits WHERE settlement_id=$1 ORDER BY period_from`,
          [old.id],
        );
        return { ...old, ledger: ledger.rows, splits: splits.rows, idempotent: true };
      }

      const exitAt = r.gate_exit_at ?? new Date();
      // 重算必须沿用结算时同一事实：由旧充电费反推 kWh，避免因事件缺失改变账单
      const kwh = Number(old.charging_fee ?? 0) > 0 ? Number(old.charging_fee) / PRICING.chargerPricePerKwh : 0;
      const oldBreakdown = await this.settlements.computeBreakdown(c, r, exitAt, kwh, old.ruling ?? null);
      const newBreakdown = await this.settlements.computeBreakdown(c, r, exitAt, kwh, appeal.ruling);

      const result = await this.settlements.createReversal(c, {
        r,
        oldSettlement: old,
        oldBreakdown,
        newBreakdown,
        kind: 'appeal_ruling',
        reason: appeal.ruling_note ?? `申诉 ${appeal.code} 终裁成立（${appeal.ruling}），原分账冲正后按终裁重做`,
        appealId: appeal.id,
        user,
        couponReissue: newBreakdown.couponCompensation > 0 ? newBreakdown.couponCompensation : undefined,
      });
      return { ...result.settlement, reversal: result.reversal, plan: result.plan };
    });
  }

  // 分账流水总览（物业/管理员/业主看自己车位；含冲正红字流水）
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
        `SELECT l.*, st.code AS settlement_code, st.kind AS settlement_kind, rv.code AS reversal_code,
                r.code AS reservation_code, r.spot_id, sp.code AS spot_code
         FROM ledger_entries l
         JOIN settlements st ON st.id=l.settlement_id
         JOIN reservations r ON r.id=st.reservation_id
         JOIN parking_spots sp ON sp.id=st.spot_id
         LEFT JOIN settlement_reversals rv ON rv.id=l.reversal_id
         WHERE ${where}
         ORDER BY l.id DESC LIMIT 500`,
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
      const base = date
        ? new Date(`${date}T18:00:00`)
        : (() => {
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
       LEFT JOIN LATERAL (
         SELECT * FROM settlements WHERE reservation_id=r.id ORDER BY id DESC LIMIT 1
       ) st ON true
       WHERE r.spot_id=$1 AND r.start_at < $2 AND r.end_at > $3
       ORDER BY r.start_at`,
      [id, nightEnd, nightStart],
    );

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
}
