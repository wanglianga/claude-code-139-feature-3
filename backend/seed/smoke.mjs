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

  const windows = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start_time: '00:00', end_time: '24:00' }));
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

  console.log('== 7. 跨日分账：凌晨离场跨越两个结算日（UTC+8 日界）==');
  // 北京时区明天 23:00（=UTC 15:00）入场，后天 01:00（=UTC 17:00）离场，恰好跨午夜
  const bjNow = new Date(Date.now() + 8 * 3600000);
  const crossStart = new Date(Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), bjNow.getUTCDate() + 1, 15, 0, 0));
  const crossMid = new Date(crossStart.getTime() + 60 * 60000); // 北京 00:00 日界
  const crossEnd = new Date(crossStart.getTime() + 120 * 60000);
  const day1 = new Date(crossStart.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const day2 = new Date(crossEnd.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  const iso = (d) => d.toISOString();
  check('跨日锚点跨越两个北京自然日', day1 !== day2 && crossMid.toISOString() === new Date(Date.UTC(crossMid.getUTCFullYear(), crossMid.getUTCMonth(), crossMid.getUTCDate(), 16, 0, 0)).toISOString());

  await api('POST', '/coupons/issue', admin.token, { user_id: driver1.user.id, amount: 5, code: `CROSS${RUN}` });
  const crossCoupons = await api('GET', '/coupons', driver1.token);
  const crossCoupon = crossCoupons.find((c) => !c.used_at && c.code === `CROSS${RUN}`);

  const spotE = await publish(`E${RUN}5`);
  await api('POST', `/spots/${spotE.id}/review`, prop.token, { pass: true, remark: '跨日分账演示车位' });
  const reserveE = await api('POST', '/reservations', driver1.token, {
    spot_id: spotE.id, vehicle_id: neCar.id,
    start_at: iso(crossStart), end_at: iso(crossEnd), coupon_id: crossCoupon.id,
  });
  check('E 跨日订单 2 小时费用 10 元、5 元券后预付 5 元', Number(reserveE.estimated_fee) === 10 && reserveE.prepaid === 5);
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveE.id, plate: neCar.plate, gate: '北门入口', mode: 'manual',
    note: '凌晨车辆，物业人工放行', entry_at: iso(crossStart),
  });
  await api('POST', `/operations/reservations/${reserveE.id}/parked`, driver1.token, {
    actual_spot_code: spotE.code /* code 字段为发布时的 E...5 */, parked_at: iso(crossStart),
  });
  const stE = await api('POST', `/reservations/${reserveE.id}/exit`, driver1.token, { exit_at: iso(crossEnd) });
  check('E 结算单含两个跨日分段', stE.splits.length === 2, stE.splits?.map((s) => s.settlement_date));
  check('E 分段结算日为相邻两个北京自然日', stE.splits[0].settlement_date === day1 && stE.splits[1].settlement_date === day2);
  check('E 各段 60 分钟，基础费 5+5=10', stE.splits[0].duration_minutes === 60 && stE.splits[1].duration_minutes === 60
    && Number(stE.splits[0].base_fee) + Number(stE.splits[1].base_fee) === 10);
  const sumE = (k) => stE.splits.reduce((a, s) => a + Number(s[k]), 0);
  check('E 分段业主收益合计=结算单业主收益（3.5+3.5=7）', Math.abs(sumE('owner_income') - Number(stE.owner_income)) <= 0.01, `${sumE('owner_income')} vs ${stE.owner_income}`);
  check('E 分段物业服务费合计=结算单（0.5+0.5=1）', Math.abs(sumE('property_fee') - Number(stE.property_fee)) <= 0.01);
  check('E 分段平台抽成合计=结算单（1+1=2）', Math.abs(sumE('platform_fee') - Number(stE.platform_fee)) <= 0.01);
  check('E 优惠券按各日服务费占比拆到两段（2.5+2.5=5）', Math.abs(sumE('coupon_discount') - 5) <= 0.01);
  check('E 第一段费用来源标注物业人工放行', stE.splits[0].sources.some((x) => x.kind === 'manual_release'), JSON.stringify(stE.splits[0].sources));
  check('E 每段都含三方分成来源说明', stE.splits.every((s) => s.sources.some((x) => x.kind === 'share')));
  check('E 结算单流水借贷平衡', ledgerBalanced(stE.ledger));

  console.log('== 8. 跨日换位（错停）：违约金与补偿按错停发生日入账 ==');
  const spotE3 = await publish(`E${RUN}6`);
  await api('POST', `/spots/${spotE3.id}/review`, prop.token, { pass: true, remark: '跨日换位演示' });
  const reserveE3 = await api('POST', '/reservations', driver2.token, {
    spot_id: spotE3.id, vehicle_id: ne2.id, start_at: iso(crossStart), end_at: iso(crossEnd),
  });
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveE3.id, plate: ne2.plate, gate: '南门入口', mode: 'auto', entry_at: iso(crossStart),
  });
  const parkedE3 = await api('POST', `/operations/reservations/${reserveE3.id}/parked`, driver2.token, {
    actual_spot_code: `E${RUN}9`, note: '凌晨光线暗停错区域', parked_at: new Date(crossStart.getTime() + 30 * 60000).toISOString(),
  });
  check('E3 凌晨 23:30 停错车位被识别', parkedE3.wrong_parking === true);
  const appealE3 = await api('POST', '/appeals', driver2.token, { reservation_id: reserveE3.id, reason: '凌晨地库灯光昏暗误停' });
  await api('POST', `/appeals/${appealE3.appeal.id}/rule`, prop.token, { ruling: 'driver_fault', note: '停放核验证据充分' });
  const stE3 = await api('POST', `/reservations/${reserveE3.id}/exit`, driver2.token, { exit_at: iso(crossEnd) });
  check('E3 错停违约金 50 元全部归到第一结算日（23:30 发生）', Number(stE3.splits[0].wrong_park_fine) === 50 && Number(stE3.splits[1].wrong_park_fine) === 0);
  check('E3 第一分段费用来源说明换位事实（含实际车位）', stE3.splits[0].sources.some((x) => x.kind === 'spot_change' && x.label.includes(`E${RUN}9`)));
  check('E3 分段各项合计与结算单一致', Math.abs(stE3.splits.reduce((a, s) => a + Number(s.owner_income), 0) - Number(stE3.owner_income)) <= 0.01
    && Math.abs(stE3.splits.reduce((a, s) => a + Number(s.platform_fee), 0) - Number(stE3.platform_fee)) <= 0.01);

  console.log('== 9. 退款校验：道闸/巡查/离场时间核定 + 防重复冲销 ==');
  // 9.1 未入场退款：预约未使用，审核通过直接取消并释放（无资金流水）
  const spotG = await publish(`E${RUN}7`);
  await api('POST', `/spots/${spotG.id}/review`, prop.token, { pass: true, remark: '未入场退款演示' });
  const reserveG = await api('POST', '/reservations', driver1.token, {
    spot_id: spotG.id, vehicle_id: neCar.id, start_at: at(360), end_at: at(420),
  });
  const rfG0 = await api('POST', `/reservations/${reserveG.id}/refunds`, driver1.token, { reason: '行程取消，尚未入场' });
  check('未入场申请退款：核定可退预付（取消释放，不产生冲账）', rfG0.validation.decision === 'eligible' && Number(rfG0.refund.validated_amount) === 5, rfG0.validation);
  const rfGApprove = await api('POST', `/refunds/${rfG0.refund.id}/approve`, prop.token, { note: '未入场，取消预约' });
  check('未入场退款审核：订单取消、预付不冲账', rfGApprove.outcome === 'cancelled_no_settlement');
  const detailG = await api('GET', `/reservations/${reserveG.id}`, driver1.token);
  check('G 订单状态已取消', detailG.status === 'cancelled');

  // 9.2 已结算正常单申请退款：无责任证据 -> 核定 0；物业平台酌情补偿走纯退款冲正
  const spotH = await publish(`E${RUN}8`);
  await api('POST', `/spots/${spotH.id}/review`, prop.token, { pass: true, remark: '酌情补偿演示' });
  const reserveH = await api('POST', '/reservations', driver1.token, {
    spot_id: spotH.id, vehicle_id: neCar.id, start_at: at(360), end_at: at(420),
  });
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveH.id, plate: neCar.plate, gate: '南门入口', mode: 'auto', entry_at: at(360),
  });
  await api('POST', `/operations/reservations/${reserveH.id}/parked`, driver1.token, {
    actual_spot_code: `E${RUN}8`, parked_at: at(360),
  });
  const stH = await api('POST', `/reservations/${reserveH.id}/exit`, driver1.token, { exit_at: at(420) });
  const rfH0 = await api('POST', `/reservations/${reserveH.id}/refunds`, driver1.token, { reason: '出场缴费机卡顿，体验不佳申请部分退款' });
  check('正常结算单无责任证据：核定可退 0（道闸/离场时间一致）', rfH0.validation.decision === 'ineligible' && Number(rfH0.refund.validated_amount) === 0);
  check('退款校验含道闸入场、离场、离场时间三类核验', ['gate_entry', 'gate_exit', 'exit_time'].every((k) => rfH0.validation.checks.some((c) => c.key === k)));
  const rfHApprove = await api('POST', `/refunds/${rfH0.refund.id}/approve`, prop.token, {
    note: '缴费机故障属实，平台补偿现金 3 元 + 赔付券 2 元', force_cash: 3, force_coupon: 2,
  });
  check('平台酌情补偿通过并生成退款冲正单', rfHApprove.reversal?.code?.startsWith('RV') && Number(rfHApprove.reversal.refund_to_driver) === 3 && Number(rfHApprove.reversal.coupon_reissue) === 2);
  const detailH = await api('GET', `/reservations/${reserveH.id}/settlement`, driver1.token);
  const revEntriesH = detailH.ledger.filter((l) => l.reversal_id);
  const revDebitH = revEntriesH.filter((l) => l.direction === 'debit').reduce((a, l) => a + Number(l.amount), 0);
  const revCreditH = revEntriesH.filter((l) => l.direction === 'credit').reduce((a, l) => a + Number(l.amount), 0);
  check('H 冲正红字流水成对（平台现金借/车主贷 + 平台券出资借/券池贷），借贷平衡',
    revEntriesH.some((l) => l.account === 'driver' && l.direction === 'credit' && Number(l.amount) === 3)
    && revEntriesH.some((l) => l.account === 'platform' && l.direction === 'debit' && Number(l.amount) === 3)
    && revEntriesH.some((l) => l.account === 'platform' && l.direction === 'debit' && Number(l.amount) === 2)
    && revEntriesH.some((l) => l.account === 'coupon_pool' && l.direction === 'credit' && Number(l.amount) === 2)
    && Math.abs(revDebitH - revCreditH) <= 0.01,
    revEntriesH);
  const couponH = await api('GET', '/coupons', driver1.token);
  check('H 赔付券已发放至车主账户', couponH.some((c) => Number(c.amount) === 2 && !c.used_at));

  // 9.3 重复申请/重复冲销拦截
  const rfHDup = await api('POST', `/reservations/${reserveH.id}/refunds`, driver1.token, { reason: '再次申请' });
  check('已处理订单再次申请时系统进行重复申请校验（记录在案）', ['duplicate', 'ineligible'].includes(rfHDup.validation.decision));

  console.log('== 10. 结算后申诉成立：陌生车场景退款触发冲正单并关联原分账 ==');
  const spotF = await publish(`E${RUN}9`);
  await api('POST', `/spots/${spotF.id}/review`, prop.token, { pass: true, remark: '退款冲正演示' });
  const reserveF = await api('POST', '/reservations', driver1.token, {
    spot_id: spotF.id, vehicle_id: neCar.id, start_at: at(360), end_at: at(480),
  });
  // 巡查发现陌生车占用（车主未入场），30 分钟后驶离；离场时无终裁 -> 先按正常结算
  const patrolF = await api('POST', '/operations/patrol', prop.token, {
    spot_id: spotF.id, plate: '沪X88888', finding: 'stranger',
    note: '夜间巡查发现陌生车占用预约位', patrolled_at: at(360),
  });
  await api('POST', `/dispatch/incidents/${patrolF.ticket_id}/resolve`, prop.token, { resolution: '陌生车驶离', resolved_at: at(390) });
  const stF0 = await api('POST', `/reservations/${reserveF.id}/exit`, driver1.token, { exit_at: at(480) });
  check('F 无终裁先按实际占用结算（90 分钟，预付有退差）', Number(stF0.base_fee) === 7.5 && Number(stF0.refund) === 2.5, `${stF0.base_fee}/${stF0.refund}`);
  const rfF0 = await api('POST', `/reservations/${reserveF.id}/refunds`, driver1.token, { reason: '到场车位被陌生车占用，申请退款' });
  check('F 退款校验采纳巡查证据并给出 stranger 责任建议', rfF0.validation.suggestedRuling === 'stranger'
    && rfF0.validation.checks.some((c) => c.key === 'patrol' && c.detail.includes('陌生')));
  check('F 无终裁前不直接核定现金（避免错误冲销）', Number(rfF0.refund.validated_amount) === 0 && rfF0.refund.status === 'pending');
  // 物业依证据核准：按 stranger 责任冲正重算
  const rfFApprove = await api('POST', `/refunds/${rfF0.refund.id}/approve`, prop.token, {
    ruling: 'stranger', note: '巡查照片与车牌证据成立，平台兜底，向陌生车主追缴',
  });
  check('F 核准生成冲正单并关联原分账', rfFApprove.reversal?.kind === 'refund_approved' && Number(rfFApprove.reversal.settlement_id) === Number(stF0.id), rfFApprove.reversal);
  // 原分账车主净付 7.5；stranger 重算后应付 0 且应收 20 现金补偿 -> 补退 27.5
  check('F 冲正补退车主现金 27.5 元（原净付 7.5 + 平台先行补偿 20）', Math.abs(Number(rfFApprove.reversal.refund_to_driver) - 27.5) <= 0.01, rfFApprove.reversal.refund_to_driver);

  const detailF = await api('GET', `/reservations/${reserveF.id}/settlement`, driver1.token);
  check('F 当前生效分账为重做版（kind=recomputed，指向上一版）', detailF.kind === 'recomputed' && Number(detailF.supersedes_id) === Number(stF0.id), `${detailF.kind}/${detailF.supersedes_id}/${stF0.id}`);
  check('F 重做版按 stranger 全免（服务费 0、平台先行赔付）', Number(detailF.base_fee) === 0 && Number(detailF.owner_compensation) === 30);
  check('F 结算查询返回两个版本与冲正单', detailF.versions.length === 2 && detailF.reversals.length === 1);
  const oldLedgerViaLedger = await api('GET', `/ledger?account=escrow`, prop.token);
  const redEntries = oldLedgerViaLedger.filter((l) => l.settlement_code === stF0.code && l.reversal_code);
  check('F 原分账保留且挂成对红字冲正流水（摘要含冲正单号）', redEntries.length >= 2 && redEntries.every((l) => /冲正 RV/.test(l.memo)), redEntries.map((l) => l.memo));
  check('F 冲正单与原结算单绑定可追溯（流水带 reversal_code）', redEntries.every((l) => !!l.reversal_code));

  // 重复冲销防护：退款单已 paid，再次审核必须拒绝
  let secondApproveErr = '';
  try {
    await api('POST', `/refunds/${rfF0.refund.id}/approve`, prop.token, {});
  } catch (e) {
    secondApproveErr = e.message;
  }
  check('F 已出账退款单再次审核被拒绝（防重复冲销）', /已处理|重复/.test(secondApproveErr), secondApproveErr);

  // 车主侧退款列表
  const myRefunds = await api('GET', '/refunds', driver1.token);
  check('车主可查退款申请状态（paid/pending/cancelled 场景齐全）', myRefunds.some((x) => x.status === 'paid' && x.reversal_code?.startsWith('RV')));

  console.log('== 10b. 财务结算后申诉成立：resettle 生成申诉冲正单（先结算后终裁）==');
  const spotI = await publish(`E${RUN}10`);
  await api('POST', `/spots/${spotI.id}/review`, prop.token, { pass: true, remark: '结算后申诉冲正演示' });
  const reserveI = await api('POST', '/reservations', driver1.token, {
    spot_id: spotI.id, vehicle_id: neCar.id, start_at: at(360), end_at: at(420),
  });
  await api('POST', '/operations/gate/admit', prop.token, {
    reservation_id: reserveI.id, plate: neCar.plate, gate: '南门入口', mode: 'auto', entry_at: at(360),
  });
  await api('POST', `/operations/reservations/${reserveI.id}/parked`, driver1.token, {
    actual_spot_code: `E${RUN}10`, parked_at: at(360),
  });
  const stI0 = await api('POST', `/reservations/${reserveI.id}/exit`, driver1.token, { exit_at: at(420) });
  check('I 先按正常单结算（1 小时 5 元，无退款）', Number(stI0.base_fee) === 5 && Number(stI0.refund) === 0);
  const appealI = await api('POST', '/appeals', driver1.token, {
    reservation_id: reserveI.id,
    reason: '地库导航全程无信号被引到错误区域，平台服务瑕疵',
    evidence: [{ source: 'signal', title: '信号记录', content: '弱信号上报，使用离线导航', captured_at: at(365), stance: 'support' }],
  });
  await api('POST', `/appeals/${appealI.appeal.id}/rule`, prop.token, {
    ruling: 'platform_fault', note: '信号服务瑕疵成立，费用全免并发赔付券',
  });
  const rsI = await api('POST', `/appeals/${appealI.appeal.id}/resettle`, prop.token);
  check('I 终裁后生成申诉冲正单（kind=appeal_ruling，关联申诉与原分账）',
    rsI.reversal?.kind === 'appeal_ruling' && Number(rsI.reversal.appeal_id) === Number(appealI.appeal.id)
    && Number(rsI.reversal.settlement_id) === Number(stI0.id), rsI.reversal);
  check('I 冲正补退预付 5 元并补发 15 元赔付券',
    Math.abs(Number(rsI.reversal.refund_to_driver) - 5) <= 0.01 && Number(rsI.reversal.coupon_reissue) === 15,
    rsI.reversal);
  const detailI = await api('GET', `/reservations/${reserveI.id}/settlement`, driver1.token);
  check('I 当前生效为重做版：服务费全免（base=0）', detailI.kind === 'recomputed' && Number(detailI.base_fee) === 0);
  check('I 结算查询包含两版分账与一张申诉冲正单', detailI.versions.length === 2 && detailI.reversals.length === 1
    && detailI.reversals[0].appeal_id === String(appealI.appeal.id), detailI.reversals);
  const ledgerI = await api('GET', `/ledger?account=escrow`, prop.token);
  const oldRowsI = ledgerI.filter((l) => l.settlement_code === stI0.code);
  const redRowsI = oldRowsI.filter((l) => l.reversal_code);
  check('I 原分账每条托管流水都有对应红字冲正（反向成对、笔数相等）',
    redRowsI.length >= 2 && redRowsI.length === oldRowsI.length - redRowsI.length,
    { red: redRowsI.length, total: oldRowsI.length });
  const couponsI = await api('GET', '/coupons', driver1.token);
  check('I 15 元赔付券已入账', couponsI.some((c) => Number(c.amount) === 15 && !c.used_at));
  // 再次 resettle 必须幂等，不产生第二张冲正单
  const rsI2 = await api('POST', `/appeals/${appealI.appeal.id}/resettle`, prop.token);
  check('I 同一终裁重复 resettle 幂等返回，不再冲销', rsI2.idempotent === true);
  const detailI2 = await api('GET', `/reservations/${reserveI.id}/settlement`, driver1.token);
  check('I 冲正单仍只有一张（防重复冲销）', detailI2.reversals.length === 1);

  console.log('== 11. 共同追溯：分账流水、调度总览、单订单全链路事件、巡查档案 ==');
  const ledger = await api('GET', '/ledger', prop.token);
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

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('SMOKE_OK');
}

main().catch((e) => {
  console.error('SMOKE_FATAL', e);
  process.exit(1);
});
