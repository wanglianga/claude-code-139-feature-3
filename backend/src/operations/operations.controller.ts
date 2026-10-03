import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { JwtUser } from '../auth/auth.service';
import { DbService } from '../database/db.service';

function normalizePlate(p: string) {
  return (p || '').replace(/[^0-9A-Z一-龥]/gi, '').toUpperCase();
}

/**
 * 道闸 + 车牌识别 + 导航引导 + 离场。
 * 识别失败/信号差/人工放行全部写入同一笔停车服务的 service_events。
 */
@Controller('operations')
@UseGuards(AuthGuard)
export class OperationsController {
  constructor(private db: DbService) {}

  // 道闸摄像头识别到车牌，返回是否放行及匹配的预约
  @Post('gate/recognize')
  async recognize(
    @CurrentUser() user: JwtUser,
    @Body() body: { plate: string; gate: string; confidence?: number },
  ) {
    const plate = normalizePlate(body.plate);
    const confidence = body.confidence ?? 0.95;
    const now = new Date();

    // 匹配未来 2 小时内入场 / 进行中的预约
    const { rows } = await this.db.query(
      `SELECT r.*, s.code AS spot_code, s.location_desc, c.name AS community_name,
              v.is_new_energy, v.is_visitor
       FROM reservations r
       JOIN parking_spots s ON s.id=r.spot_id
       JOIN communities c ON c.id=s.community_id
       JOIN vehicles v ON v.id=r.vehicle_id
       WHERE REPLACE(REPLACE(UPPER(r.plate),' ',''),'-','')=$1
         AND r.status IN ('reserved','admitted')
         AND r.start_at BETWEEN now() - interval '3 hour' AND now() + interval '3 hour'
       ORDER BY r.start_at ASC LIMIT 1`,
      [plate],
    );
    const match = rows[0];

    // 低置信度 -> 识别失败事件 + 工单
    if (confidence < 0.75 || !match) {
      let reservationId: number | null = null;
      let spotId: number | null = null;
      if (match) {
        reservationId = match.id;
        spotId = match.spot_id;
      }
      await this.db.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_role, plate, gate, confidence, detail)
         VALUES ($1,$2,'recognition_fail','property',$3,$4,$5,$6)`,
        [
          reservationId,
          spotId,
          plate,
          body.gate,
          confidence,
          JSON.stringify({ matched: !!match, hint: match ? '低置信度，需人工复核' : '无匹配预约' }),
        ],
      );
      if (!match) {
        const t = await this.db.query(
          `INSERT INTO incident_tickets(code, spot_id, reservation_id, type, status, plate, reporter_role, description, detail)
           VALUES ($1,NULL,NULL,'recognition_fail','open',$2,'gate',$3,$4) RETURNING id`,
          [
            'T' + Date.now().toString(36).toUpperCase(),
            body.plate,
            `道闸 ${body.gate} 车牌识别${confidence < 0.75 ? '置信度过低' : '无匹配预约'}`,
            JSON.stringify({ confidence, gate: body.gate }),
          ],
        );
        return {
          admitted: false,
          reason: confidence < 0.75 ? 'recognition_low_confidence' : 'no_reservation',
          confidence,
          ticket_id: t.rows[0].id,
          guidance: null,
        };
      }
    }

    if (!match) {
      return { admitted: false, reason: 'no_reservation', confidence, guidance: null };
    }

    return {
      admitted: confidence >= 0.75,
      reason: confidence >= 0.75 ? 'matched' : 'low_confidence_match',
      confidence,
      reservation: {
        id: match.id,
        code: match.code,
        spot_code: match.spot_code,
        location_desc: match.location_desc,
        community_name: match.community_name,
        is_new_energy: match.is_new_energy,
        is_visitor: match.is_visitor,
      },
      guidance: this.buildGuidance(match),
    };
  }

  // 确认入场开闸（自动识别成功 / 物业人工放行均走此入口）
  @Post('gate/admit')
  async admit(
    @CurrentUser() user: JwtUser,
    @Body() body: { reservation_id: number; plate: string; gate: string; mode: 'auto' | 'manual'; confidence?: number; note?: string; entry_at?: string },
  ) {
    return this.db.withTx(async (c) => {
      const { rows } = await c.query(
        `SELECT r.*, s.code AS spot_code, s.location_desc, c.name AS community_name
         FROM reservations r
         JOIN parking_spots s ON s.id=r.spot_id
         JOIN communities c ON c.id=s.community_id
         WHERE r.id=$1 FOR UPDATE`,
        [body.reservation_id],
      );
      const r = rows[0];
      if (!r) throw new BadRequestException('预约不存在');
      if (!['reserved', 'admitted'].includes(r.status)) throw new BadRequestException('预约状态不可入场');

      const manual = body.mode === 'manual';
      await c.query(
        `UPDATE reservations SET status='admitted', gate_entry_at=COALESCE($2::timestamptz, gate_entry_at, now()) WHERE id=$1`,
        [r.id, body.entry_at ?? null],
      );
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, gate, confidence, detail, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::timestamptz, now()))`,
        [
          r.id,
          r.spot_id,
          manual ? 'manual_release' : 'gate_entry',
          user.sub,
          user.role,
          body.plate,
          body.gate,
          body.confidence ?? (manual ? null : 0.95),
          JSON.stringify({ mode: body.mode, note: body.note ?? null }),
          body.entry_at ?? null,
        ],
      );
      if (manual) {
        await c.query(
          `INSERT INTO incident_tickets(code, spot_id, reservation_id, type, status, plate, reporter_role, description, resolution, resolved_by, resolved_at, created_at)
           VALUES ($1,$2,$3,'manual_release','resolved',$4,'property',$5,$6,$7,now(),COALESCE($8::timestamptz, now()))`,
          [
            'T' + Date.now().toString(36).toUpperCase(),
            r.spot_id,
            r.id,
            body.plate,
            body.note ?? '物业核对预约后人工放行',
            body.note ?? '人工放行完成',
            user.sub,
            body.entry_at ?? null,
          ],
        );
      }
      return {
        ok: true,
        entry_at: new Date(),
        guidance: this.buildGuidance({ ...r }),
      };
    });
  }

  // 导航引导播报（地下车库信号差时仍由本地缓存的预约数据生成）
  @Post('navigation/guidance')
  guidance(@CurrentUser() user: JwtUser, @Body() body: { reservation_id: number; signal?: 'good' | 'weak' }) {
    return this.db
      .query(
        `SELECT r.*, s.code AS spot_code, s.location_desc, s.near_charger, c.name AS community_name
         FROM reservations r JOIN parking_spots s ON s.id=r.spot_id JOIN communities c ON c.id=s.community_id
         WHERE r.id=$1`,
        [body.reservation_id],
      )
      .then((q) => {
        const r = q.rows[0];
        if (!r) throw new BadRequestException('预约不存在');
        if (body.signal === 'weak') {
          this.db.query(
            `INSERT INTO service_events(reservation_id, spot_id, type, actor_role, detail)
             VALUES ($1,$2,'weak_signal_report','driver',$3)`,
            [r.id, r.spot_id, JSON.stringify({ offline_guidance: true })],
          );
        }
        return { ...this.buildGuidance(r), offline_cached: body.signal === 'weak' };
      });
  }

  // 车主上报/确认信号差
  @Roles('driver')
  @Post('reservations/:id/report-signal')
  async reportSignal(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() body: { area?: string }) {
    const r = await this.db.query(`SELECT * FROM reservations WHERE id=$1`, [id]);
    if (!r.rows[0]) throw new BadRequestException('预约不存在');
    await this.db.query(
      `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, detail)
       VALUES ($1,$2,'weak_signal_report',$3,'driver',$4)`,
      [id, r.rows[0].spot_id, user.sub, JSON.stringify({ area: body.area ?? 'B2 层' })],
    );
    await this.upsertOpenTicket(this.db, {
      spotId: r.rows[0].spot_id,
      reservationId: id,
      type: 'weak_signal',
      plate: r.rows[0].plate,
      reporterRole: 'driver',
      description: '地下车库信号差，导航/支付联网中断，已下发离线导航码',
      detail: { area: body.area ?? 'B2 层' },
    });
    return { ok: true, offline_tip: '请使用离线导航码前往车位，出场前可离线记账、联网后补结算' };
  }

  // 车辆停放确认（车位地磁/车主打卡）——真正"可用"时点
  @Post('reservations/:id/parked')
  async parked(@CurrentUser() user: JwtUser, @Body() body: { actual_spot_code?: string; note?: string; parked_at?: string }, @Param('id') id: string) {
    return this.db.withTx(async (c) => {
      const { rows } = await c.query(
        `SELECT r.*, s.code AS spot_code FROM reservations r JOIN parking_spots s ON s.id=r.spot_id
         WHERE r.id=$1 FOR UPDATE`,
        [id],
      );
      const r = rows[0];
      if (!r) throw new BadRequestException('预约不存在');
      if (!['admitted'].includes(r.status)) throw new BadRequestException('尚未入场或已离场');
      await c.query(
        `UPDATE reservations SET status='in_garage',
           parking_confirmed_at=COALESCE($2::timestamptz, parking_confirmed_at, now()) WHERE id=$1`,
        [id, body.parked_at ?? null],
      );
      const wrong = body.actual_spot_code && body.actual_spot_code !== r.spot_code;
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          id,
          r.spot_id,
          wrong ? 'wrong_parking_detected' : 'parking_confirmed',
          user.sub,
          user.role,
          r.plate,
          JSON.stringify({ expected: r.spot_code, actual: body.actual_spot_code ?? r.spot_code, note: body.note }),
        ],
      );
      if (wrong) {
        await c.query(
          `INSERT INTO incident_tickets(code, spot_id, reservation_id, type, status, plate, reporter_role, description, detail, created_at)
           VALUES ($1,$2,$3,'wrong_parking','open',$4,'driver',$5,$6,COALESCE($7::timestamptz, now()))`,
          [
            'T' + Date.now().toString(36).toUpperCase(),
            r.spot_id,
            id,
            r.plate,
            `车辆停在 ${body.actual_spot_code}，预约车位为 ${r.spot_code}`,
            JSON.stringify({ expected: r.spot_code, actual: body.actual_spot_code }),
            body.parked_at ?? null,
          ],
        );
      }
      return { ok: true, wrong_parking: !!wrong };
    });
  }

  // 物业巡查登记（错停/陌生车/燃油车占充电位）
  @Roles('property', 'admin')
  @Post('patrol')
  async patrol(
    @CurrentUser() user: JwtUser,
    @Body() body: { spot_id: number; plate?: string; finding: 'normal' | 'stranger' | 'wrong_park' | 'ice_on_charger'; note?: string; media_url?: string; patrolled_at?: string },
  ) {
    const now = body.patrolled_at ? new Date(body.patrolled_at) : new Date();
    await this.db.query(
      `INSERT INTO patrol_logs(spot_id, guard_id, plate, note, media_url, patrolled_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [body.spot_id, user.sub, body.plate ?? null, `${body.finding}: ${body.note ?? ''}`, body.media_url ?? null, now],
    );
    await this.db.query(
      `INSERT INTO service_events(spot_id, type, actor_id, actor_role, plate, detail)
       VALUES ($1,'patrol_log',$2,'property',$3,$4)`,
      [
        body.spot_id,
        user.sub,
        body.plate ?? null,
        JSON.stringify({ finding: body.finding, note: body.note, media_url: body.media_url }),
      ],
    );

    if (body.finding !== 'normal') {
      const map = {
        stranger: 'stranger_occupy',
        wrong_park: 'wrong_parking',
        ice_on_charger: 'ice_occupy_charger',
      } as const;
      // 尝试关联时间窗重叠的同车位预约（车主已预约但受阻未入场 / 已入场 / 已在库），
      // 优先取在场程度最高的订单，使巡查证据进入该订单退款/分账校验
      const rel = await this.db.query(
        `SELECT id FROM reservations
         WHERE spot_id=$1 AND status IN ('reserved','admitted','in_garage')
           AND $2::timestamptz BETWEEN start_at - interval '3 hour' AND end_at + interval '3 hour'
         ORDER BY CASE status WHEN 'in_garage' THEN 0 WHEN 'admitted' THEN 1 ELSE 2 END, start_at DESC
         LIMIT 1`,
        [body.spot_id, now],
      );
      const ticket = await this.upsertOpenTicket(this.db, {
        spotId: body.spot_id,
        reservationId: rel.rows[0]?.id ? String(rel.rows[0].id) : null,
        type: map[body.finding],
        plate: body.plate ?? null,
        reporterRole: 'property',
        description: body.note ?? `巡查发现 ${body.finding}`,
        detail: { media_url: body.media_url },
        createdAt: now,
      });
      return { ok: true, ticket_id: ticket?.id ?? null, finding: body.finding };
    }
    return { ok: true, finding: body.finding };
  }

  @Get('patrol')
  patrolLogs(@Query('spot_id') spotId?: string) {
    return this.db
      .query(
        `SELECT p.*, u.name AS guard_name FROM patrol_logs p
         JOIN users u ON u.id=p.guard_id
         ${spotId ? 'WHERE p.spot_id=$1' : ''}
         ORDER BY p.patrolled_at DESC LIMIT 100`,
        spotId ? [spotId] : [],
      )
      .then((r) => r.rows);
  }

  private buildGuidance(r: any) {
    return {
      community: r.community_name,
      spot_code: r.spot_code,
      steps: [
        `进入${r.community_name ?? '小区'}后沿主通道行驶`,
        r.location_desc ? `按标识到达：${r.location_desc}` : `按标识到达车位 ${r.spot_code}`,
        r.near_charger ? '该车位靠近充电桩，请将充电枪连接至车辆左侧接口' : '该车位为普通车位，减速倒车入位',
        '入位后请在 App 点击"我已停好"完成停放确认',
      ],
      voice: `您的预约车位是 ${r.spot_code}，请按地面箭头行驶，全程限速 5 公里`,
    };
  }

  async upsertOpenTicket(
    client: any,
    t: {
      spotId: number | null;
      reservationId: string | number | null;
      type: string;
      plate: string | null;
      reporterRole: string;
      description: string;
      detail?: Record<string, any>;
      createdAt?: Date;
    },
  ) {
    const exist = await client.query(
      `SELECT id FROM incident_tickets
       WHERE type=$1 AND status IN ('open','notified')
         AND (spot_id=$2 OR ($2 IS NULL AND spot_id IS NULL))
         AND (reservation_id=$3 OR ($3 IS NULL AND reservation_id IS NULL))
       ORDER BY id DESC LIMIT 1`,
      [t.type, t.spotId, t.reservationId ? Number(t.reservationId) : null],
    );
    if (exist.rows[0]) return { id: exist.rows[0].id };
    const ins = await client.query(
      `INSERT INTO incident_tickets(code, spot_id, reservation_id, type, status, plate, reporter_role, description, detail, created_at)
       VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$8,COALESCE($9::timestamptz, now())) RETURNING *`,
      [
        'T' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 100),
        t.spotId,
        t.reservationId ? Number(t.reservationId) : null,
        t.type,
        t.plate,
        t.reporterRole,
        t.description,
        JSON.stringify(t.detail ?? {}),
        t.createdAt ?? null,
      ],
    );
    return ins.rows[0];
  }
}
