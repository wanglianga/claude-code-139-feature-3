/* 端到端冒烟：真实 HTTP + PostgreSQL，覆盖
   发布审核 → 预约(券/月租) → 识别入场 → 导航/信号差 → 停放确认 → 陌生车/错停/业主回家/人工放行
   → 挪车通知 → 申诉证据链裁决 → 离场分账 → 信用 → 同车位多订单时间轴 → 资金流水
   事件时间通过道闸时钟参数（entry_at/parked_at/exit_at/occurred_at）锚定到"今晚"时间线。 */
const BASE = process.env.API_BASE || 'http://127.0.0.1:3000/api';
const RUN = String(Date.now()).slice(-6);

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`, extra ?? '');
  }
}

async function api(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  }
  return json;
}

async function login(username) {
  const r = await api('POST', '/auth/login', null, { username, password: 'Pass1234' });
  return { token: r.accessToken, user: r.user };
}

function ledgerBalanced(entries) {
  const d = entries.filter((e) => e.direction === 'debit').reduce((a, b) => a + Number(b.amount), 0);
  const c = entries.filter((e) => e.direction === 'credit').reduce((a, b) => a + Number(b.amount), 0);
  return Math.abs(d - c) <= 0.02;
}

async function main() {
  // ---- 今晚时间线锚点：T0 = 10 分钟后（整秒），所有现场事件以此为准 ----
  const T0 = new Date(Math.ceil((Date.now() + 10 * 60000) / 60000) * 60000);
  const at = (min) => new Date(T0.getTime() + min * 60000).toISOString();
  const windowStart = at(-30);
  const windowEnd = at(380);

  console.log('== 1. 登录、发券、物业审核队列 ==');
  const owner = await login('owner1');
  const driver1 = await login('driver1');
  const driver2 = await login('driver2');
  const prop = await login('property1');
  const admin = await login('admin1');
  check('四类角色登录成功', !!(owner.token && driver1.token && driver2.token && prop.token && admin.token));

  // 为可重复执行，给 driver1 新发一张 10 元夜间券
  await api('POST', '/coupons/issue', admin.token, { user_id: driver1.user.id, amount: 10, code: `NIGHT${RUN}` });
  const coupons = await api('GET', '/coupons', driver1.token);
  const coupon = coupons.find((c) => !c.used_at && Number(c.amount) === 10);

  // driver2 补录一辆新能源车（用于同车位当晚第二单）
  const ne2 = await api('POST', '/vehicles', driver2.token, {
    plate: `沪E${RUN.slice(0, 5)}`,
    plate_color: '绿牌',
    is_new_energy: true,
  });

  const windows = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_time: '00:00', end_time: '23:59' }));
  const codes = { A: `E${RUN}1`, B: `E${RUN}2`, C: `E${RUN}3`, D: `E${RUN}4` };
  async function publish(code, opts = {}) {
    return api('POST', '/spots', owner.token, {
      community_id: 1,
      code,
      location_desc: `冒烟车位 ${code}`,
      near_charger: opts.charger ?? false,
      charger_power_kw: opts.charger ? 7 : undefined,
      allow_visitor: true,
      monthly_priority: opts.monthly ?? false,
      hourly_rate: 5,
      overnight_cap: 45,
      windows,
    });
  }
  const [spotA, spotB, spotC, spotD] = await Promise.all([
    publish(codes.A, { charger: true, monthly: true }),
    publish(codes.B),
    publish(codes.C),
    publish(codes.D, { charger: true }),
  ]);
  check('业主发布 4 个车位，初始待审核', spotA.review_status === 'pending');
  for (const s of [spotA, spotB, spotC, spotD]) {
    await api('POST', `/spots/${s.id}/review`, prop.token, { pass: true, remark: '产权材料齐全' });
  }
  const approved = await api('GET', `/spots/${spotA.id}`, prop.token);
  check('物业审核通过后车位可预约', approved.review_status === 'approved');
  const openSpots = await api('GET', '/spots?community_id=1&need_charger=true', driver1.token);
  check('车主可按充电桩筛选可预约车位', openSpots.some((s) => s.id === spotA.id));

  const vehicles1 = await api('GET', '/vehicles', driver1.token);
  const neCar = vehicles1.find((v) => v.is_new_energy);
  const vehicles2 = await api('GET', '/vehicles', driver2.token);
  const visitorCar = vehicles2.find((v) => v.is_visitor);
  check('车辆档案：新能源月租车 / 访客车 / 第二辆新能源车就绪', !!neCar && !!visitorCar && !!ne2);

  console.log('== 2. 订单 A：识别入场 → 导航/信号差 → 充电离场，用券分账 ==');
  const reserveA = await api('POST', '/reservations', driver1.token, {
    spot_id: spotA.id,
    vehicle_id: neCar.id,
    start_at: at(0),
    end_at: at(180),
    coupon_id: coupon.id,
  });
  check('预约预估 3 小时费用 15 元', Number(reserveA.estimated_fee) === 15, reserveA.estimated_fee);
  check('10 元券抵扣后预付 5 元', reserveA.prepaid === 5 && reserveA.coupon_discount === 10, reserveA);

  const rec = await api('POST', '/operations/gate/recognize', prop.token, {
    plate: neCar.plate,
    gate: '南门入口',
    confidence: 0.96,
  });
  check('道闸车牌识别命中预约并返回导航引导', rec.admitted === true && !!rec.guidance?.voice, rec);
  const recFail = await api('POST', '/operations/gate/recognize', prop.token, {
    plate: '沪UNKNOWN',
    gate: '南门入口',
    confidence: 0.4,
  });
  check('陌生车牌/低置信度拒绝入场并生成识别失败工单', recFail.admitted === false && !!recFail.ticket_id);

  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveA.id,
    plate: neCar.plate,
    gate: '南门入口',
    mode: 'auto',
    entry_at: at(0),
  });
  const sig = await api('POST', `/operations/reservations/${reserveA.id}/report-signal`, driver1.token, {
    area: 'B2 层 E 区',
  });
  check('地下车库信号差：下发离线导航提示', sig.offline_tip.includes('离线'));
  const parkedA = await api('POST', `/operations/reservations/${reserveA.id}/parked`, driver1.token, {
    actual_spot_code: codes.A,
    parked_at: at(0),
  });
  check('正常停放确认无误判', parkedA.wrong_parking === false);

  const stA = await api('POST', `/reservations/${reserveA.id}/exit`, driver1.token, {
    charge_kwh: 20,
    exit_at: at(180),
  });
  check('A 离场生成结算单', stA.code?.startsWith('ST'));
  check('A 充电费 20kWh × 1.2 = 24 元', Number(stA.charging_fee) === 24);
  check('A 券抵扣 10 元落账', Number(stA.coupon_discount) === 10);
  check('A 业主分成按 70% 计提（39 元池 → 27.3）', Number(stA.owner_income) >= 27.2 && Number(stA.owner_income) <= 27.4, stA.owner_income);
  check('A 离场补缴 24 元（充电费），无退款', Number(stA.exit_charge) === 24 && Number(stA.refund) === 0, stA);
  check('A 资金流水借贷平衡', ledgerBalanced(stA.ledger));

  console.log('== 3. 订单 A2：同一充电位当晚第二单（第二位车主、另一辆新能源车）==');
  const reserveA2 = await api('POST', '/reservations', driver2.token, {
    spot_id: spotA.id,
    vehicle_id: ne2.id,
    start_at: at(190),
    end_at: at(300),
  });
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveA2.id,
    plate: ne2.plate,
    gate: '南门入口',
    mode: 'auto',
    entry_at: at(190),
  });
  await api('POST', `/operations/reservations/${reserveA2.id}/parked`, driver2.token, {
    actual_spot_code: codes.A,
    parked_at: at(195),
  });
  const stA2 = await api('POST', `/reservations/${reserveA2.id}/exit`, driver2.token, { exit_at: at(300) });
  check('A2 离场结算完成', stA2.code?.startsWith('ST'));

  const tlA = await api('GET', `/spots/${spotA.id}/timeline?start=${encodeURIComponent(windowStart)}&end=${encodeURIComponent(windowEnd)}`, driver1.token);
  check('时间轴覆盖当晚两笔订单', tlA.orders.length === 2, tlA.orders.map((o) => o.code));
  const driverSegs = tlA.segments.filter((s) => s.occupantKind === 'driver');
  check(
    '时间轴解释两段使用分别由两位车主使用、各自付费',
    new Set(driverSegs.map((s) => s.reservationId)).size === 2 &&
      driverSegs.every((s) => s.payer.includes('计费')),
    driverSegs.map((s) => `${s.occupant}#${s.reservationId}/${s.payer}`),
  );

  console.log('== 4. 订单 B：人工放行 → 停错车位 → 挪车通知 → 证据链裁决车主责任 → 违约金分账 ==');
  const reserveB = await api('POST', '/reservations', driver2.token, {
    spot_id: spotB.id,
    vehicle_id: visitorCar.id,
    start_at: at(0),
    end_at: at(120),
  });
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveB.id,
    plate: visitorCar.plate,
    gate: '北门入口',
    mode: 'manual',
    note: '车主报识别失败，核对预约码后人工放行',
    entry_at: at(0),
  });
  const parkedB = await api('POST', `/operations/reservations/${reserveB.id}/parked`, driver2.token, {
    actual_spot_code: `E${RUN}9`,
    note: '跟着其他车辆下到 B1',
    parked_at: at(10),
  });
  check('停放核验识别出错停并自动开工单', parkedB.wrong_parking === true);

  const openInc = await api('GET', '/dispatch/incidents?status=open', prop.token);
  const wrongTicket = openInc.find((t) => t.type === 'wrong_parking' && t.reservation_id === reserveB.id);
  check('夜间调度看板收到错停工单', !!wrongTicket, openInc.map((t) => `${t.type}:${t.reservation_id}`));
  await api('POST', `/dispatch/incidents/${wrongTicket.id}/notify`, prop.token, {
    message: '请 10 分钟内挪车至预约车位',
  });
  const notices = await api('GET', `/dispatch/incidents/${wrongTicket.id}/notices`, prop.token);
  check('挪车通知已送达', notices.length >= 1 && !!notices[0].delivered_at);

  const appealB = await api('POST', '/appeals', driver2.token, {
    reservation_id: reserveB.id,
    reason: '现场指示不清导致停错，申请免除违约金',
    evidence: [
      {
        source: 'photo',
        title: '现场照片',
        content: '地面箭头磨损',
        captured_at: at(12),
        stance: 'support',
      },
    ],
  });
  check('申诉自动汇聚车牌识别/道闸/预约证据并给出建议', !!appealB.adjudication.ruling, appealB.adjudication);
  check('自动裁决建议为车主责任', appealB.adjudication.ruling === 'driver_fault', appealB.adjudication.ruling);
  await api('POST', `/appeals/${appealB.appeal.id}/rule`, prop.token, {
    ruling: 'driver_fault',
    note: '车牌识别与停放核验均证明停错车位，证据充分',
  });
  const stB = await api('POST', `/reservations/${reserveB.id}/exit`, driver2.token, { exit_at: at(120) });
  check('B 错停违约金 50 元', Number(stB.wrong_park_fine) === 50);
  check('B 其中 30 元补偿业主', Number(stB.owner_compensation) === 30);
  check('B 车主信用 -10', Number(stB.credit_delta) === -10 && stB.credit_target === 'driver');
  check('B 流水含业主错停补偿', stB.ledger.some((l) => l.account.startsWith('owner') && l.memo.includes('错停补偿')));
  check('B 流水借贷平衡', ledgerBalanced(stB.ledger));
  const me2 = await api('GET', '/auth/me', driver2.token);
  check('B 车主信用分落库（本段 -10）', me2.credit_score === driver2.user.creditScore - 10, `${driver2.user.creditScore}->${me2.credit_score}`);

  console.log('== 5. 订单 C：业主临时回家 → 挪车协调 → 判业主责任 → 业主补偿车主并扣信用 ==');
  const reserveC = await api('POST', '/reservations', driver1.token, {
    spot_id: spotC.id,
    vehicle_id: neCar.id,
    start_at: at(0),
    end_at: at(240),
  });
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveC.id,
    plate: neCar.plate,
    gate: '南门入口',
    mode: 'manual',
    entry_at: at(0),
  });
  await api('POST', `/operations/reservations/${reserveC.id}/parked`, driver1.token, {
    actual_spot_code: codes.C,
    parked_at: at(5),
  });
  const ownerReturn = await api('POST', '/dispatch/owner-return', owner.token, {
    spot_id: spotC.id,
    eta_minutes: 20,
    note: '临时有客人要送回家',
    occurred_at: at(90),
  });
  check('业主回家自动通知在场车主并开工单', !!ownerReturn.ticket && ownerReturn.ticket.status === 'notified');
  await api('POST', `/dispatch/incidents/${ownerReturn.ticket.id}/resolve`, prop.token, {
    resolution: '车主已配合挪车至临时车位，业主自用',
    resolved_at: at(100),
  });
  const appealC = await api('POST', '/appeals', driver1.token, {
    reservation_id: reserveC.id,
    reason: '业主突然回家要求挪车，服务中断',
  });
  check('系统依据业主回家时间证据自动建议业主责任', appealC.adjudication.ruling === 'owner_fault', appealC.adjudication);
  await api('POST', `/appeals/${appealC.appeal.id}/rule`, prop.token, {
    ruling: 'owner_fault',
    note: '共享时段内业主回家违约成立',
  });
  const stC = await api('POST', `/reservations/${reserveC.id}/exit`, driver1.token, { exit_at: at(100) });
  check('C 按实际可用时长计费（85 分钟）', stC.duration_minutes === 85, stC.duration_minutes);
  check('C 业主现金补偿车主 20 元并随退款发放', Number(stC.abnormal_compensation) === 20 && Number(stC.refund) > 20, stC);
  check('C 流水借贷平衡', ledgerBalanced(stC.ledger));
  const reC = await api('POST', `/appeals/${appealC.appeal.id}/resettle`, prop.token);
  check('终裁后可重算分账且借贷仍平衡', reC.code?.startsWith('ST') && ledgerBalanced(reC.ledger));
  const meOwner = await api('GET', '/auth/me', owner.token);
  check('业主信用分落库（本段 -5）', meOwner.credit_score === owner.user.creditScore - 5, `${owner.user.creditScore}->${meOwner.credit_score}`);

  console.log('== 6. 订单 D：陌生车占用充电位 → 巡查/挪车通知 → 时间轴归责 → 平台兜底赔付与追缴 ==');
  const reserveD = await api('POST', '/reservations', driver1.token, {
    spot_id: spotD.id,
    vehicle_id: neCar.id,
    start_at: at(0),
    end_at: at(120),
  });
  const patrol = await api('POST', '/operations/patrol', prop.token, {
    spot_id: spotD.id,
    plate: '沪X99999',
    finding: 'stranger',
    note: '夜间巡查发现陌生车辆占用已预约充电位',
    media_url: `evidence/patrol-${RUN}.jpg`,
    patrolled_at: at(0),
  });
  await api('POST', `/dispatch/incidents/${patrol.ticket_id}/notify`, prop.token);
  const tlD = await api(
    'GET',
    `/spots/${spotD.id}/timeline?start=${encodeURIComponent(at(-30))}&end=${encodeURIComponent(at(130))}`,
    prop.token,
  );
  const strangerSeg = tlD.segments.find((s) => s.occupantKind === 'stranger');
  check(
    '时间轴明确标出陌生车占用段：预约车主不计费、平台兜底、向陌生车主追缴',
    !!strangerSeg && strangerSeg.plate === '沪X99999' && strangerSeg.payer.includes('平台兜底') && strangerSeg.liability.includes('陌生车主'),
    strangerSeg,
  );
  await api('POST', `/dispatch/incidents/${patrol.ticket_id}/resolve`, prop.token, {
    resolution: '联系到陌生车主，已驶离',
    resolved_at: at(30),
  });
  const appealD = await api('POST', '/appeals', driver1.token, {
    reservation_id: reserveD.id,
    reason: '到场发现车位被陌生车占用，无法停车',
  });
  check('巡查+车牌证据自动建议陌生车责任', appealD.adjudication.ruling === 'stranger', appealD.adjudication);
  await api('POST', `/appeals/${appealD.appeal.id}/rule`, prop.token, {
    ruling: 'stranger',
    note: '巡查照片+车牌识别确认陌生车占用',
  });
  const stD = await api('POST', `/reservations/${reserveD.id}/exit`, driver1.token, { exit_at: at(120) });
  check('D 判陌生车责任：服务费全免', Number(stD.base_fee) === 0);
  check('D 平台先行赔付业主 30 元', Number(stD.owner_compensation) === 30);
  check('D 现金补偿车主 20 元并退还预付', Number(stD.abnormal_compensation) === 20 && Number(stD.refund) >= 20);
  check('D 不影响预约车主信用', stD.credit_delta === 0 || stD.credit_target === 'none', stD);
  check('D 流水含平台先行赔付（追缴）记录', stD.ledger.some((l) => l.memo.includes('先行赔付')));
  check('D 流水借贷平衡', ledgerBalanced(stD.ledger));

  console.log('== 7. 共同追溯：分账流水、调度总览、单订单全链路事件、巡查档案 ==');  const ledger = await api('GET', '/ledger', prop.token);
  check(
    '分账流水覆盖车主/业主/物业/平台/券池/托管账户',
    ['escrow', 'property', 'platform', 'coupon_pool'].every((a) => ledger.some((l) => l.account === a || l.account.startsWith(a))),
  );
  check('业主流水包含补偿与分成收款', ledger.some((l) => l.account.startsWith('owner:') && l.direction === 'credit'));
  check('券池流水记录优惠券出资', ledger.some((l) => l.account === 'coupon_pool' && l.direction === 'debit'));

  const overview = await api('GET', '/dispatch/overview', prop.token);
  check('调度总览统计异常工单', Array.isArray(overview.incidents_24h) && overview.incidents_24h.length > 0);

  const detailA = await api('GET', `/reservations/${reserveA.id}`, driver1.token);
  check(
    '单订单全链路可追溯：预约/入场/信号/停放/结算事件齐全',
    ['reservation_created', 'gate_entry', 'weak_signal_report', 'parking_confirmed', 'settlement_completed'].every(
      (t) => detailA.events.some((e) => e.type === t),
    ),
    detailA.events.map((e) => e.type),
  );
  const appealDetail = await api('GET', `/appeals/${appealB.appeal.id}`, prop.token);
  check(
    '错停申诉档案含六类证据来源中的车牌识别/道闸/预约/陈述/照片',
    ['plate_recognition', 'gate_log', 'reservation', 'appeal_statement', 'photo'].every((src) =>
      appealDetail.evidence.concat(
        appealDetail.adjudication.evidenceTimeline.map((e) => ({ source: e.source })),
      ).some((e) => e.source === src),
    ),
    appealDetail.evidence.map((e) => e.source),
  );
  const patrolLogs = await api('GET', '/operations/patrol?spot_id=' + spotD.id, prop.token);
  check('物业巡查记录可查并关联现场照片', patrolLogs.some((p) => p.note.includes('陌生车辆') && p.media_url));

  // ================= 本题新增：跨日分账 / 换位费用来源 / 退款校验 / 冲正单 =================
  const dayFmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const iso = (d) => d.toISOString();

  console.log('== 8. 订单 E：凌晨离场跨两个结算日，按实际占用时段拆分分账并标注费用来源 ==');
  const spotE = await publish(`E${RUN}5`, { charger: true });
  await api('POST', `/spots/${spotE.id}/review`, prop.token, { pass: true, remark: '产权材料齐全' });
  await api('POST', '/coupons/issue', admin.token, { user_id: driver1.user.id, amount: 10, code: `NG2${RUN}` });
  const couponE = (await api('GET', '/coupons', driver1.token)).find((c) => c.code === `NG2${RUN}`);
  // 今日 22:00 → 次日 02:00（本地时区），凌晨离场跨越两个结算日
  const crossStart = new Date(); crossStart.setHours(22, 0, 0, 0); crossStart.setSeconds(0, 0);
  const crossEnd = new Date(crossStart.getTime() + 4 * 3600000);
  const reserveE = await api('POST', '/reservations', driver1.token, {
    spot_id: spotE.id, vehicle_id: neCar.id,
    start_at: iso(crossStart), end_at: iso(crossEnd), coupon_id: couponE.id,
  });
  check('E 跨日预约创建（4 小时预估 20 元，券后预付 10 元）', reserveE.prepaid === 10, reserveE);
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveE.id, plate: neCar.plate, gate: '北门入口', mode: 'manual',
    note: '识别失败，核对预约码人工放行', entry_at: iso(new Date(crossStart.getTime() + 5 * 60000)),
  });
  await api('POST', `/operations/reservations/${reserveE.id}/parked`, driver1.token, {
    actual_spot_code: `E${RUN}5`, parked_at: iso(new Date(crossStart.getTime() + 10 * 60000)),
  });
  await api('POST', `/reservations/${reserveE.id}/exit`, driver1.token, {
    charge_kwh: 10, exit_at: iso(crossEnd),
  });
  const stE = await api('GET', `/reservations/${reserveE.id}/settlement`, driver1.token);
  check('E 结算跨越两个结算日', stE.day_segments.length === 2, stE.day_segments.map((s) => s.settlement_date));
  check(
    'E 两段结算日分别为离场当日与次日',
    String(stE.day_segments[0].settlement_date).slice(0, 10) === dayFmt(crossStart) &&
      String(stE.day_segments[1].settlement_date).slice(0, 10) === dayFmt(crossEnd),
    stE.day_segments.map((s) => s.settlement_date),
  );
  check(
    'E 按实际占用分钟切段（22:10→24:00 = 110 分钟，00:00→02:00 = 120 分钟）',
    stE.day_segments[0].minutes === 110 && stE.day_segments[1].minutes === 120,
    stE.day_segments.map((s) => s.minutes),
  );
  const sumSeg = (k) => stE.day_segments.reduce((a, s) => a + Number(s[k]), 0);
  check(
    'E 各段基础费/充电费/业主收益/物业费合计与结算单守恒',
    Math.abs(sumSeg('base_fee') - Number(stE.base_fee)) < 0.005 &&
      Math.abs(sumSeg('charging_fee') - Number(stE.charging_fee)) < 0.005 &&
      Math.abs(sumSeg('owner_income') - Number(stE.owner_income)) < 0.02 &&
      Math.abs(sumSeg('property_fee') - Number(stE.property_fee)) < 0.02,
    { seg: stE.day_segments.map((s) => [s.base_fee, s.charging_fee, s.owner_income, s.property_fee]), st: [stE.base_fee, stE.charging_fee, stE.owner_income, stE.property_fee] },
  );
  check('E 充电费 12 元归属次日段（充电结算时点）', Number(stE.day_segments[1].charging_fee) === 12 && Number(stE.day_segments[0].charging_fee) === 0);
  const srcTypes = (i) => stE.day_segments[i].sources.map((s) => s.type);
  check(
    'E 费用来源：首日段含优惠券与物业人工放行，次日段含充电服务',
    srcTypes(0).includes('coupon') && srcTypes(0).includes('manual_release') && srcTypes(1).includes('charging'),
    stE.day_segments.map((s) => s.sources),
  );
  check('E 结算单标记跨日', stE.detail?.cross_day === true, stE.detail);

  console.log('== 9. 订单 F：换位调度 → 财务页费用来源展示换位段 ==');
  const spotF1 = await publish(`E${RUN}6`);
  const spotF2 = await publish(`E${RUN}7`);
  await api('POST', `/spots/${spotF1.id}/review`, prop.token, { pass: true });
  await api('POST', `/spots/${spotF2.id}/review`, prop.token, { pass: true });
  const reserveF = await api('POST', '/reservations', driver2.token, {
    spot_id: spotF1.id, vehicle_id: visitorCar.id, start_at: at(0), end_at: at(180),
  });
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveF.id, plate: visitorCar.plate, gate: '南门入口', mode: 'auto', entry_at: at(0),
  });
  await api('POST', `/operations/reservations/${reserveF.id}/parked`, driver2.token, {
    actual_spot_code: `E${RUN}6`, parked_at: at(5),
  });
  const swap = await api('POST', '/dispatch/spot-swap', prop.token, {
    reservation_id: reserveF.id, to_spot_id: spotF2.id,
    reason: 'F1 车位地锁故障，协调至相邻车位', occurred_at: at(60),
  });
  check('换位调度执行成功并记录原/新车位', swap.from_spot === `E${RUN}6` && swap.to_spot === `E${RUN}7`, swap);
  const detailF = await api('GET', `/reservations/${reserveF.id}`, driver2.token);
  check('换位后订单绑定新车位且事件流含换位记录', detailF.spot_id === spotF2.id && detailF.events.some((e) => e.type === 'spot_swap'));
  const stF = await api('POST', `/reservations/${reserveF.id}/exit`, driver2.token, { exit_at: at(150) });
  check('F 离场结算流水借贷平衡', ledgerBalanced(stF.ledger));
  const stFDetail = await api('GET', `/reservations/${reserveF.id}/settlement`, driver2.token);
  check(
    'F 财务段费用来源含换位调度（原车位 → 新车位）',
    stFDetail.day_segments.length === 1 &&
      stFDetail.day_segments[0].sources.some((s) => s.type === 'spot_swap' && s.label.includes(`E${RUN}6`) && s.label.includes(`E${RUN}7`)),
    stFDetail.day_segments.map((s) => s.sources),
  );
  const incF = await api('GET', '/dispatch/incidents', prop.token);
  check('换位调度生成已处置工单', incF.some((t) => t.type === 'spot_swap' && t.reservation_id === reserveF.id && t.status === 'resolved'));

  console.log('== 10. 退款校验：道闸/巡查/离场时间核验可退金额，重复冲销被拦截 ==');
  // 订单 E 正常缴费，无可退余额
  let noBalErr = '';
  try {
    await api('POST', `/reservations/${reserveE.id}/refund-requests`, driver1.token, { amount: 5, reason: '测试' });
  } catch (e) { noBalErr = e.message; }
  check('正常缴费订单退款被重复冲销校验拦截（可退余额 0）', noBalErr.includes('重复冲销'), noBalErr);

  // 订单 G：结算后申诉终裁平台责任 → 退款校验放行 → 重复申请被拦截
  const spotG = await publish(`E${RUN}8`);
  await api('POST', `/spots/${spotG.id}/review`, prop.token, { pass: true });
  const reserveG = await api('POST', '/reservations', driver1.token, {
    spot_id: spotG.id, vehicle_id: neCar.id, start_at: at(0), end_at: at(240),
  });
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveG.id, plate: neCar.plate, gate: '南门入口', mode: 'auto', entry_at: at(0),
  });
  await api('POST', `/operations/reservations/${reserveG.id}/parked`, driver1.token, {
    actual_spot_code: `E${RUN}8`, parked_at: at(5),
  });
  const stG = await api('POST', `/reservations/${reserveG.id}/exit`, driver1.token, { exit_at: at(240) });
  // 计费自停放确认 at(5) 起：235 分钟 × 5 元/时 = 19.58 元，预付 20 元多退 0.42 元
  check('G 正常结算应付 19.58 元（235 分钟），预付多退 0.42 元', Number(stG.payable) === 19.58 && Number(stG.refund) === 0.42, stG);
  const appealG = await api('POST', '/appeals', driver1.token, {
    reservation_id: reserveG.id, reason: '车库信号全程中断，离线导航不可用，申请平台责任免单退款',
  });
  await api('POST', `/appeals/${appealG.appeal.id}/rule`, prop.token, { ruling: 'platform_fault', note: '信号记录属实，平台责任' });
  const rf = await api('POST', `/reservations/${reserveG.id}/refund-requests`, driver1.token, {
    amount: 20, reason: '平台责任免单，申请退还预付 20 元',
  });
  check('退款申请受理为待审核', rf.status === 'pending' && rf.code.startsWith('RF'), rf);
  check(
    '退款校验给出道闸/巡查/离场时间/重复冲销四项明细',
    ['gate', 'patrol', 'exit_time', 'duplicate'].every((k) => rf.validation.checks.some((c) => c.key === k)),
    rf.validation.checks,
  );
  check('按终裁免单口径校验可退上限 = 实付 20 - 已退 0.42 = 19.58 元', rf.validation.maxRefundable === 19.58, rf.validation);
  const rfReview = await api('POST', `/refund-requests/${rf.id}/review`, prop.token, { approve: true, note: '校验属实，同意退款' });
  check('申请超额部分自动截断，按 19.58 元核准到账', rfReview.status === 'approved' && Number(rfReview.validated_amount) === 19.58, rfReview);
  const stGLedger = await api('GET', `/reservations/${reserveG.id}/settlement`, driver1.token);
  check(
    '退款资金流水：托管 → 车主 19.58 元且全单借贷平衡',
    stGLedger.ledger.some((l) => l.account === 'driver' && l.direction === 'credit' && Number(l.amount) === 19.58 && l.memo.includes('退款单')) &&
      ledgerBalanced(stGLedger.ledger),
    stGLedger.ledger.filter((l) => l.memo.includes('退款单')),
  );
  let dupErr = '';
  try {
    await api('POST', `/reservations/${reserveG.id}/refund-requests`, driver1.token, { amount: 20, reason: '重复申请' });
  } catch (e) { dupErr = e.message; }
  check('同一订单重复退款被拦截（避免重复冲销）', dupErr.includes('重复冲销'), dupErr);

  console.log('== 11. 冲正单：财务结算后申诉成立，红冲原分账并关联新分账 ==');
  const reG = await api('POST', `/appeals/${appealG.appeal.id}/resettle`, prop.token);
  check('重算生成冲正单（RV）并关联原分账', reG.reversal?.code?.startsWith('RV') && reG.code?.startsWith('ST'), reG.reversal);
  check(
    '新分账不重复退款：19.58 元已经退款单退还，仅补退原结算被冲正的 0.42 元',
    Number(reG.refund) === 0.42 && reG.notes.some((n) => n.includes('不再重复退款')),
    { refund: reG.refund, notes: reG.notes },
  );
  check('新分账借贷平衡', ledgerBalanced(reG.ledger));
  const stGF = await api('GET', `/reservations/${reserveG.id}/settlement`, driver1.token);
  check(
    '当前有效分账为重算后新单，冲正单关联原分账与新分账',
    stGF.id === reG.id && stGF.reversals.length === 1 &&
      stGF.reversals[0].settlement_code === stG.code && stGF.reversals[0].new_settlement_code === reG.code,
    stGF.reversals,
  );
  const ledgerAll = await api('GET', '/ledger', prop.token);
  const rvEntries = ledgerAll.filter((l) => l.settlement_code === stG.code && String(l.memo).startsWith('冲正：'));
  check('原分账档案保留并附红冲流水（冲正：前缀）', rvEntries.length >= 2, rvEntries.length);
  check('红冲后全平台流水借贷仍平衡', ledgerBalanced(ledgerAll));
  const reversals = await api('GET', '/reversals', prop.token);
  check(
    '冲正单可追溯：关联申诉、原分账、新分账',
    reversals.some((rv) => rv.code === reG.reversal.code && rv.appeal_code === appealG.appeal.code && rv.new_settlement_code === reG.code),
    reversals.map((r) => r.code),
  );
  const refundsDrv = await api('GET', '/refund-requests', driver1.token);
  check('车主可查询退款记录与审批结果', refundsDrv.some((f) => f.id === rf.id && f.status === 'approved'));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('SMOKE_OK');
}

main().catch((e) => {
  console.error('SMOKE_FATAL', e);
  process.exit(1);
});
