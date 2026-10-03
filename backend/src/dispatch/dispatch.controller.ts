import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser, Roles } from '../auth/auth.guard';
import { JwtUser } from '../auth/auth.service';
import { DbService } from '../database/db.service';
import { OperationsController } from '../operations/operations.controller';

const INCIDENT_INFO: Record<string, { label: string; noticeTemplate: string }> = {
  owner_return: {
    label: '业主临时回家',
    noticeTemplate: '您的共享车位业主临时回家，平台正为您协调就近车位并按实际时长结算',
  },
  visitor_overstay: {
    label: '访客车辆超时',
    noticeTemplate: '您的预约已到期，请尽快离场；超出 10 分钟宽限后将按 1.5× 计超时费',
  },
  stranger_occupy: {
    label: '陌生车辆占用',
    noticeTemplate: '您预约的车位被陌生车辆占用，物业已到场处理，等待期间不计费，平台兜底补偿',
  },
  recognition_fail: {
    label: '道闸识别失败',
    noticeTemplate: '道闸识别失败，已通知物业人工核验，请准备好预约码',
  },
  weak_signal: {
    label: '地下车库信号差',
    noticeTemplate: '检测到您所在区域信号弱，已下发离线导航码与离线账单',
  },
  ice_occupy_charger: {
    label: '燃油车占用充电位',
    noticeTemplate: '充电车位被燃油车占用，物业已通知挪车，请稍候或改停相邻充电位',
  },
  wrong_parking: {
    label: '车主停错车位',
    noticeTemplate: '系统检测到您未停在预约车位，请立即挪车至预约车位，超时将计入错停违约',
  },
  manual_release: {
    label: '物业人工放行',
    noticeTemplate: '物业已人工放行，入场服务已绑定到您的预约单',
  },
  spot_swap: {
    label: '换位调度',
    noticeTemplate: '物业已为您协调换位至相邻车位，订单费用按实际占用时段连续计算',
  },
};

@Controller('dispatch')
@UseGuards(AuthGuard)
export class DispatchController {
  constructor(private db: DbService) {}

  // 夜间调度看板（物业/管理员）
  @Roles('property', 'admin', 'owner')
  @Get('incidents')
  async list(@CurrentUser() user: JwtUser, @Query('status') status?: string, @Query('night') night?: string) {
    const params: any[] = [];
    let where = '1=1';
    if (status) {
      params.push(status);
      where += ` AND i.status=$${params.length}`;
    }
    if (user.role === 'owner') {
      params.push(user.sub);
      where += ` AND s.owner_id=$${params.length}`;
    }
    const { rows } = await this.db.query(
      `SELECT i.*, s.code AS spot_code, c.name AS community_name, r.code AS reservation_code,
              u.name AS reporter_name
       FROM incident_tickets i
       LEFT JOIN parking_spots s ON s.id=i.spot_id
       LEFT JOIN communities c ON c.id=s.community_id
       LEFT JOIN reservations r ON r.id=i.reservation_id
       LEFT JOIN users u ON u.id=i.resolved_by
       WHERE ${where}
       ORDER BY CASE i.status WHEN 'open' THEN 0 WHEN 'notified' THEN 1 ELSE 2 END, i.created_at DESC
       LIMIT 200`,
      params,
    );
    return rows.map((r) => ({ ...r, label: INCIDENT_INFO[r.type]?.label ?? r.type }));
  }

  // 业主上报"临时回家"：触发挪车协调，打断当前订单
  @Roles('owner')
  @Post('owner-return')
  async ownerReturn(
    @CurrentUser() user: JwtUser,
    @Body() body: { spot_id: number; eta_minutes?: number; note?: string; occurred_at?: string },
  ) {
    const occurredAt = body.occurred_at ? new Date(body.occurred_at) : new Date();
    return this.db.withTx(async (c) => {
      const spot = await c.query(`SELECT * FROM parking_spots WHERE id=$1 AND owner_id=$2`, [
        body.spot_id,
        user.sub,
      ]);
      if (!spot.rows[0]) throw new BadRequestException('车位不存在或不属于本人');

      const active = await c.query(
        `SELECT * FROM reservations WHERE spot_id=$1 AND status IN ('reserved','admitted','in_garage')
         ORDER BY start_at ASC LIMIT 1`,
        [body.spot_id],
      );
      const reservationId = active.rows[0]?.id ?? null;
      const plate = active.rows[0]?.plate ?? null;

      const ins = await c.query(
        `INSERT INTO incident_tickets(code, spot_id, reservation_id, type, status, plate, reporter_role, description, detail, created_at)
         VALUES ($1,$2,$3,'owner_return','open',$4,'owner',$5,$6,$7) RETURNING *`,
        [
          'T' + Date.now().toString(36).toUpperCase(),
          body.spot_id,
          reservationId,
          plate,
          body.note ?? `业主预计 ${body.eta_minutes ?? 30} 分钟后回家`,
          JSON.stringify({ eta_minutes: body.eta_minutes ?? 30, owner_home_at: occurredAt }),
          occurredAt,
        ],
      );
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail, occurred_at)
         VALUES ($1,$2,'owner_return_report',$3,'owner',$4,$5,$6)`,
        [
          reservationId,
          body.spot_id,
          user.sub,
          plate,
          JSON.stringify({ eta_minutes: body.eta_minutes ?? 30, owner_home_at: occurredAt }),
          occurredAt,
        ],
      );
      // 给在场车主发挪车通知
      if (reservationId) {
        await c.query(
          `INSERT INTO move_notices(ticket_id, target_plate, channel, message, delivered_at)
           VALUES ($1,$2,'app_push',$3, now())`,
          [ins.rows[0].id, plate, INCIDENT_INFO.owner_return.noticeTemplate],
        );
        await c.query(`UPDATE incident_tickets SET status='notified' WHERE id=$1`, [ins.rows[0].id]);
      }
      const ticket = (await c.query(`SELECT * FROM incident_tickets WHERE id=$1`, [ins.rows[0].id])).rows[0];
      return { ok: true, ticket, reservation_id: reservationId };
    });
  }

  // 上报访客超时（系统定时任务或物业触发）
  @Roles('property', 'admin')
  @Post('overstay')
  async overstay(@CurrentUser() user: JwtUser, @Body() body: { reservation_id: number }) {
    const r = await this.db.query(`SELECT * FROM reservations WHERE id=$1`, [body.reservation_id]);
    const res = r.rows[0];
    if (!res) throw new BadRequestException('预约不存在');
    const ops = new OperationsController(this.db);
    const ticket = await ops.upsertOpenTicket(this.db, {
      spotId: res.spot_id,
      reservationId: res.id,
      type: 'visitor_overstay',
      plate: res.plate,
      reporterRole: user.role,
      description: '访客车辆超出预约结束时间仍未离场',
      detail: { reserved_end: res.end_at },
    });
    await this.db.query(
      `INSERT INTO move_notices(ticket_id, target_plate, channel, message, delivered_at)
       VALUES ($1,$2,'app_push',$3, now())`,
      [ticket.id, res.plate, INCIDENT_INFO.visitor_overstay.noticeTemplate],
    );
    await this.db.query(
      `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
       VALUES ($1,$2,'overstay_warning',$3,$4,$5,$6)`,
      [res.id, res.spot_id, user.sub, user.role, res.plate, JSON.stringify({ reserved_end: res.end_at })],
    );
    await this.db.query(`UPDATE incident_tickets SET status='notified' WHERE id=$1`, [ticket.id]);
    return { ok: true, ticket_id: ticket.id };
  }

  // 换位调度：物业把进行中订单协调到相邻车位（业主回家/陌生车占用等场景），
  // 订单延续不换单，费用按实际占用时段连续计算，换位事件进入财务页费用来源
  @Roles('property', 'admin')
  @Post('spot-swap')
  async spotSwap(
    @CurrentUser() user: JwtUser,
    @Body() body: { reservation_id: number; to_spot_id: number; reason?: string; occurred_at?: string },
  ) {
    const occurredAt = body.occurred_at ? new Date(body.occurred_at) : new Date();
    return this.db.withTx(async (c) => {
      const rq = await c.query(
        `SELECT r.*, s.code AS from_spot_code, v.is_new_energy, v.is_visitor
         FROM reservations r
         JOIN parking_spots s ON s.id=r.spot_id
         JOIN vehicles v ON v.id=r.vehicle_id
         WHERE r.id=$1 FOR UPDATE`,
        [body.reservation_id],
      );
      const r = rq.rows[0];
      if (!r) throw new BadRequestException('预约不存在');
      if (!['admitted', 'in_garage'].includes(r.status))
        throw new BadRequestException('仅进行中（已入场）的订单可换位调度');

      const sq = await c.query(`SELECT * FROM parking_spots WHERE id=$1`, [body.to_spot_id]);
      const target = sq.rows[0];
      if (!target) throw new BadRequestException('目标车位不存在');
      if (target.id === r.spot_id) throw new BadRequestException('目标车位与当前车位相同');
      if (target.review_status !== 'approved' || !target.active)
        throw new BadRequestException('目标车位未通过审核或已停止共享');
      if (target.near_charger && !r.is_new_energy)
        throw new BadRequestException('目标车位为充电位，仅限新能源车');
      if (r.is_visitor && !target.allow_visitor)
        throw new BadRequestException('目标车位不允许访客车');

      // 剩余时段不得与目标车位已有预约冲突
      const conflict = await c.query(
        `SELECT code FROM reservations
         WHERE spot_id=$1 AND status IN ('reserved','admitted','in_garage')
           AND start_at < $2 AND $3 < end_at LIMIT 1`,
        [target.id, r.end_at, occurredAt],
      );
      if (conflict.rows[0]) throw new BadRequestException(`目标车位该时段已被预约（${conflict.rows[0].code}）`);

      await c.query(`UPDATE reservations SET spot_id=$1 WHERE id=$2`, [target.id, r.id]);
      const reason = body.reason ?? '物业现场协调换位';
      await c.query(
        `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail, occurred_at)
         VALUES ($1,$2,'spot_swap',$3,$4,$5,$6,$7)`,
        [
          r.id,
          target.id,
          user.sub,
          user.role,
          r.plate,
          JSON.stringify({
            from_spot: r.from_spot_code,
            from_spot_id: r.spot_id,
            to_spot: target.code,
            to_spot_id: target.id,
            reason,
          }),
          occurredAt,
        ],
      );
      const ticket = await c.query(
        `INSERT INTO incident_tickets(code, spot_id, reservation_id, type, status, plate, reporter_role, description, resolution, detail, resolved_by, resolved_at, created_at)
         VALUES ($1,$2,$3,'spot_swap','resolved',$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *`,
        [
          'T' + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 100),
          target.id,
          r.id,
          r.plate,
          user.role,
          `换位调度：${r.from_spot_code} → ${target.code}`,
          reason,
          JSON.stringify({ from_spot: r.from_spot_code, from_spot_id: r.spot_id, to_spot: target.code, to_spot_id: target.id, reason }),
          user.sub,
          occurredAt,
        ],
      );
      await c.query(
        `INSERT INTO move_notices(ticket_id, target_plate, channel, message, delivered_at)
         VALUES ($1,$2,'app_push+led',$3, now())`,
        [ticket.rows[0].id, r.plate, `您的车位已协调换位：${r.from_spot_code} → ${target.code}，订单费用按实际占用连续计算`],
      );
      return { ok: true, ticket: ticket.rows[0], from_spot: r.from_spot_code, to_spot: target.code };
    });
  }

  // 平台/物业派发挪车通知（陌生车/燃油车/错停）
  @Roles('property', 'admin')
  @Post('incidents/:id/notify')
  async notify(@CurrentUser() user: JwtUser, @Param('id') id: string, @Body() body?: { channel?: string; message?: string }) {
    const { rows } = await this.db.query(`SELECT * FROM incident_tickets WHERE id=$1 FOR UPDATE`, [id]);
    const t = rows[0];
    if (!t) throw new BadRequestException('工单不存在');
    const info = INCIDENT_INFO[t.type];
    await this.db.query(
      `INSERT INTO move_notices(ticket_id, target_plate, channel, message, delivered_at)
       VALUES ($1,$2,$3,$4, now())`,
      [id, t.plate ?? '未知车牌', body?.channel ?? 'app_push+led', body?.message ?? info?.noticeTemplate ?? '请立即挪车'],
    );
    await this.db.query(`UPDATE incident_tickets SET status='notified' WHERE id=$1`, [id]);
    await this.db.query(
      `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
       VALUES ($1,$2,'move_notice_sent',$3,$4,$5,$6)`,
      [t.reservation_id, t.spot_id, user.sub, user.role, t.plate, JSON.stringify({ channel: body?.channel ?? 'app_push+led' })],
    );
    return { ok: true };
  }

  // 工单处置完成（业主已回家自用/陌生车已驶离/车辆已挪位等）
  @Roles('property', 'admin', 'owner')
  @Post('incidents/:id/resolve')
  async resolve(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() body: { resolution: string; waive_overtime?: boolean; resolved_at?: string },
  ) {
    const { rows } = await this.db.query(`SELECT * FROM incident_tickets WHERE id=$1 FOR UPDATE`, [id]);
    const t = rows[0];
    if (!t) throw new BadRequestException('工单不存在');
    await this.db.query(
      `UPDATE incident_tickets SET status='resolved', resolution=$1, resolved_by=$2,
         resolved_at=COALESCE($5::timestamptz, now()),
         detail=jsonb_set(COALESCE(detail,'{}'::jsonb), '{waive_overtime}', $3::jsonb)
       WHERE id=$4`,
      [body.resolution, user.sub, JSON.stringify(!!body.waive_overtime), id, body.resolved_at ?? null],
    );
    await this.db.query(
      `INSERT INTO service_events(reservation_id, spot_id, type, actor_id, actor_role, plate, detail)
       VALUES ($1,$2,'incident_resolved',$3,$4,$5,$6)`,
      [
        t.reservation_id,
        t.spot_id,
        user.sub,
        user.role,
        t.plate,
        JSON.stringify({ type: t.type, resolution: body.resolution, waive_overtime: body.waive_overtime }),
      ],
    );
    return { ok: true };
  }

  @Get('incidents/:id/notices')
  async notices(@Param('id') id: string) {
    return this.db
      .query(`SELECT * FROM move_notices WHERE ticket_id=$1 ORDER BY id`, [id])
      .then((r) => r.rows);
  }

  // 调度看板所需汇总数据
  @Roles('property', 'admin')
  @Get('overview')
  async overview() {
    const byType = await this.db.query(
      `SELECT type, status, count(*)::int AS n FROM incident_tickets
       WHERE created_at > now() - interval '24 hours'
       GROUP BY type, status ORDER BY type, status`,
    );
    const activeReservations = await this.db.query(
      `SELECT count(*)::int AS n FROM reservations WHERE status IN ('reserved','admitted','in_garage')
        AND start_at > now() - interval '12 hours'`,
    );
    return { incidents_24h: byType.rows, active_reservations: activeReservations.rows[0].n };
  }
}
