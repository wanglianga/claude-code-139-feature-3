import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { JwtUser } from '../auth/auth.service';
import { DbService } from '../database/db.service';
import { estimateFee, isIntervalCovered, ShareWindow } from '../domain/availability';

function code(prefix: string) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4)
    .toString(36)
    .toUpperCase()}`;
}

class VehicleDto {
  plate: string;
  plate_color?: string;
  is_new_energy?: boolean;
  is_monthly?: boolean;
  is_visitor?: boolean;
}

class CreateReservationDto {
  spot_id: number;
  vehicle_id: number;
  start_at: string;
  end_at: string;
  coupon_id?: number;
}

@Controller()
@UseGuards(AuthGuard)
export class ReservationsController {
  constructor(private db: DbService) {}

  // ---- 车辆档案 ----
  @Get('vehicles')
  listVehicles(@CurrentUser() user: JwtUser) {
    return this.db
      .query(`SELECT * FROM vehicles WHERE user_id=$1 ORDER BY id DESC`, [user.sub])
      .then((r) => r.rows);
  }

  @Get('coupons')
  listCoupons(@CurrentUser() user: JwtUser) {
    return this.db
      .query(
        `SELECT id, code, amount, used_reservation_id, used_at, created_at
         FROM coupons WHERE user_id=$1 ORDER BY id DESC`,
        [user.sub],
      )
      .then((r) => r.rows);
  }

  // 管理员/平台发放补偿券（错停申诉结案、信号差赔付等场景）
  @Roles('admin', 'property')
  @Post('coupons/issue')
  issueCoupon(@Body() body: { user_id: number; amount: number; code?: string }) {
    return this.db
      .query(
        `INSERT INTO coupons(user_id, code, amount) VALUES ($1,$2,$3) RETURNING *`,
        [body.user_id, body.code ?? `CPN${Date.now().toString(36).toUpperCase()}`, body.amount],
      )
      .then((r) => r.rows[0]);
  }

  @Post('vehicles')
  addVehicle(@CurrentUser() user: JwtUser, @Body() dto: VehicleDto) {
    return this.db
      .query(
        `INSERT INTO vehicles(user_id, plate, plate_color, is_new_energy, is_monthly, is_visitor)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          user.sub,
          dto.plate,
          dto.plate_color ?? '蓝牌',
          dto.is_new_energy ?? false,
          dto.is_monthly ?? false,
          dto.is_visitor ?? false,
        ],
      )
      .then((r) => r.rows[0]);
  }

  // ---- 预约 ----
  @Roles('driver')
  @Post('reservations')
  async create(@CurrentUser() user: JwtUser, @Body() dto: CreateReservationDto) {
    const start = new Date(dto.start_at);
    const end = new Date(dto.end_at);
    if (!(start < end)) throw new BadRequestException('预约时间区间非法');

    return this.db.withTx(async (c) => {
      const spotRes = await c.query(
        `SELECT s.*, (SELECT json_agg(json_build_object('weekday',weekday,'start_time',start_time::text,'end_time',end_time::text))
                      FROM spot_share_windows w WHERE w.spot_id=s.id) AS windows
         FROM parking_spots s WHERE s.id=$1 FOR UPDATE`,
        [dto.spot_id],
      );
      const spot = spotRes.rows[0];
      if (!spot) throw new BadRequestException('车位不存在');
      if (spot.review_status !== 'approved') throw new BadRequestException('车位尚未通过物业审核');
      if (!spot.active) throw new BadRequestException('车位已停止共享');

      // 访客车辆规则
      const vehRes = await c.query(`SELECT * FROM vehicles WHERE id=$1 AND user_id=$2`, [
        dto.vehicle_id,
        user.sub,
      ]);
      const vehicle = vehRes.rows[0];
      if (!vehicle) throw new BadRequestException('车辆不存在或不属于本人');
      if (vehicle.is_visitor && !spot.allow_visitor)
        throw new BadRequestException('该车位不允许访客车辆预约');

      // 可共享时段覆盖
      const windows: ShareWindow[] = (spot.windows ?? []).map((w: any) => ({
        weekday: Number(w.weekday),
        start_time: w.start_time,
        end_time: w.end_time,
      }));
      if (!isIntervalCovered(start, end, windows))
        throw new BadRequestException('预约时间不在业主发布的可共享时段内');

      // 时间冲突：同一车位有效预约不得重叠（月租车优先：若发生重叠，月租车优先规则已在排期侧保证）
      const conflictRes = await c.query(
        `SELECT id, code FROM reservations
         WHERE spot_id=$1 AND status IN ('reserved','admitted','in_garage')
           AND start_at < $2 AND $3 < end_at`,
        [dto.spot_id, end, start],
      );
      if (conflictRes.rowCount && conflictRes.rowCount > 0) {
        if (vehicle.is_monthly && spot.monthly_priority) {
          // 月租优先：不直接拒绝，而是标记并将非月租订单转为待协调（演示中仍拒绝以避免一车两位，
          // 但写入调度事件供夜间调度看板展示优先规则）
          await c.query(
            `INSERT INTO service_events(spot_id, type, actor_role, detail)
             VALUES ($1,'monthly_priority_conflict','driver',$2)`,
            [
              dto.spot_id,
              JSON.stringify({ incoming: vehicle.plate, conflicting: conflictRes.rows[0].code }),
            ],
          );
          throw new BadRequestException('该时段已有预约：月租车优先规则触发，系统将为您推荐相邻时段');
        }
        throw new BadRequestException('该时段已被预约');
      }

      // 充电车位只允许新能源车预约充电
      if (spot.near_charger && !vehicle.is_new_energy)
        throw new BadRequestException('带充电桩车位仅限新能源车辆预约');

      const fee = estimateFee(start, end, Number(spot.hourly_rate), spot.overnight_cap ? Number(spot.overnight_cap) : null);

      // 优惠券
      let couponDiscount = 0;
      let couponId: number | null = null;
      if (dto.coupon_id) {
        const cp = await c.query(
          `SELECT * FROM coupons WHERE id=$1 AND user_id=$2 AND used_at IS NULL FOR UPDATE`,
          [dto.coupon_id, user.sub],
        );
        if (!cp.rows[0]) throw new BadRequestException('优惠券不可用');
        couponDiscount = Math.min(Number(cp.rows[0].amount), fee);
        couponId = dto.coupon_id;
      }

      const priority = vehicle.is_monthly ? 'monthly' : 'normal';
      const prepaid = Math.round((fee - couponDiscount) * 100) / 100;
      const rCode = code('R');
      const ins = await c.query(
        `INSERT INTO reservations(code, spot_id, driver_id, vehicle_id, plate, start_at, end_at,
           priority, estimated_fee)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [rCode, dto.spot_id, user.sub, dto.vehicle_id, vehicle.plate, start, end, priority, fee],
      );
      const reservation = ins.rows[0];

      if (couponId) {
        await c.query(`UPDATE coupons SET used_reservation_id=$1, used_at=now() WHERE id=$2`, [
          reservation.id,
          couponId,
        ]);
      }
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
         VALUES ($1,$2,'reservation_created',$3,'driver',$4,$5)`,
        [
          reservation.id,
          dto.spot_id,
          user.sub,
          vehicle.plate,
          JSON.stringify({ estimated_fee: fee, coupon_discount: couponDiscount, prepaid }),
        ],
      );

      return { ...reservation, prepaid, coupon_discount: couponDiscount, windows };
    });
  }

  @Get('reservations')
  async list(@CurrentUser() user: JwtUser, @Query('scope') scope?: string) {
    if (user.role === 'driver' || scope === 'mine') {
      return this.db.query(this.reservationSql(`WHERE r.driver_id=$1`), [user.sub]).then((x) => x.rows);
    }
    if (user.role === 'owner') {
      return this.db
        .query(this.reservationSql(`WHERE s.owner_id=$1`), [user.sub])
        .then((x) => x.rows);
    }
    return this.db.query(this.reservationSql(``)).then((x) => x.rows);
  }

  @Get('reservations/:id')
  async detail(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    const rows = (await this.db.query(this.reservationSql(`WHERE r.id=$1`), [id])).rows;
    const r = rows[0];
    if (!r) throw new BadRequestException('预约不存在');
    if (
      user.role === 'driver' && r.driver_id !== user.sub
    )
      throw new BadRequestException('无权查看该预约');
    const events = await this.db.query(
      `SELECT * FROM service_events WHERE reservation_id=$1 ORDER BY occurred_at, id`,
      [id],
    );
    const incidents = await this.db.query(
      `SELECT * FROM incident_tickets WHERE reservation_id=$1 ORDER BY id`,
      [id],
    );
    const appeals = await this.db.query(`SELECT * FROM appeals WHERE reservation_id=$1 ORDER BY id`, [id]);
    const settlement = await this.db.query(
      `SELECT * FROM settlements WHERE reservation_id=$1 ORDER BY id DESC LIMIT 1`,
      [id],
    );
    return { ...r, events: events.rows, incidents: incidents.rows, appeals: appeals.rows, settlement: settlement.rows[0] ?? null };
  }

  @Roles('driver')
  @Post('reservations/:id/cancel')
  async cancel(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    await this.db.withTx(async (c) => {
      const { rows } = await c.query(`SELECT * FROM reservations WHERE id=$1 AND driver_id=$2 FOR UPDATE`, [
        id,
        user.sub,
      ]);
      const r = rows[0];
      if (!r) throw new BadRequestException('预约不存在');
      if (!['reserved'].includes(r.status)) throw new BadRequestException('当前状态不可取消');
      await c.query(`UPDATE reservations SET status='cancelled' WHERE id=$1`, [id]);
      // 释放优惠券
      await c.query(`UPDATE coupons SET used_reservation_id=NULL, used_at=NULL WHERE used_reservation_id=$1`, [id]);
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role)
         VALUES ($1,$2,'reservation_cancelled',$3,'driver')`,
        [id, r.spot_id, user.sub],
      );
    });
    return { ok: true };
  }

  private reservationSql(where: string) {
    return `
      SELECT r.*, s.code AS spot_code, s.location_desc, s.near_charger, c.name AS community_name,
             u.name AS driver_name, v.is_new_energy, v.is_monthly, v.is_visitor,
             ow.name AS owner_name
      FROM reservations r
      JOIN parking_spots s ON s.id=r.spot_id
      JOIN communities c ON c.id=s.community_id
      JOIN users u ON u.id=r.driver_id
      JOIN users ow ON ow.id=s.owner_id
      LEFT JOIN vehicles v ON v.id=r.vehicle_id
      ${where}
      ORDER BY r.start_at DESC`;
  }
}
