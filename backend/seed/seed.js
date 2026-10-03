/* 种子数据：幂等执行，重复运行不会产生重复账号
   用法：DB_PORT=5433 node seed/seed.js （默认读 .env / 环境变量） */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'parking',
});

const WINDOWS = [
  [1, '19:00', '08:00'],
  [2, '19:00', '08:00'],
  [3, '19:00', '08:00'],
  [4, '19:00', '08:00'],
  [5, '20:00', '09:00'],
  [6, '00:00', '24:00'],
  [0, '00:00', '24:00'],
];

async function main() {
  const candidates = [
    path.join(__dirname, '..', 'src', 'database', 'schema.sql'),
    path.join(__dirname, '..', 'dist', 'database', 'schema.sql'),
  ];
  const schemaFile = candidates.find((p) => fs.existsSync(p));
  if (!schemaFile) throw new Error('schema.sql not found: ' + candidates.join(', '));
  const schema = fs.readFileSync(schemaFile, 'utf8');
  await pool.query(schema);

  async function user(username, name, role, phone) {
    const hash = await bcrypt.hash('Pass1234', 10);
    const q = await pool.query(
      `INSERT INTO users(username,password_hash,name,role,phone)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (username) DO UPDATE SET name=EXCLUDED.name
       RETURNING id, username, name, role`,
      [username, hash, name, role, phone],
    );
    return q.rows[0];
  }

  const owner = await user('owner1', '王业主', 'owner', '13800000001');
  const owner2 = await user('owner2', '李业主', 'owner', '13800000002');
  const driver = await user('driver1', '陈车主', 'driver', '13900000001');
  const driver2 = await user('driver2', '赵访客', 'driver', '13900000002');
  const property = await user('property1', '物业值班员小周', 'property', '13700000001');
  await user('admin1', '平台管理员', 'admin', '13600000001');

  const comm = await pool.query(
    `INSERT INTO communities(id,name,address) VALUES (1,'阳光花园社区','高新区锦阳路 88 号')
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
  );
  const communityId = comm.rows[0].id;

  async function spot(code, ownerId, extra) {
    const q = await pool.query(
      `INSERT INTO parking_spots(community_id, code, owner_id, location_desc, near_charger,
         charger_power_kw, allow_visitor, monthly_priority, hourly_rate, overnight_cap,
         review_status, reviewed_by, reviewed_at, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'approved',$11, now(), true)
       ON CONFLICT (community_id, code) DO UPDATE SET active=true, review_status='approved'
       RETURNING id`,
      [
        communityId, code, ownerId,
        extra.loc, extra.charger, extra.kw ?? null,
        extra.visitor ?? true, extra.monthly ?? false,
        extra.rate, extra.cap ?? null, property.id,
      ],
    );
    const id = q.rows[0].id;
    for (const [weekday, st, et] of WINDOWS) {
      await pool.query(
        `INSERT INTO spot_share_windows(spot_id, weekday, start_time, end_time)
         VALUES ($1,$2,$3::time,$4::time)
         ON CONFLICT (spot_id, weekday) DO UPDATE SET start_time=EXCLUDED.start_time, end_time=EXCLUDED.end_time`,
        [id, weekday, st, et],
      );
    }
    return id;
  }

  await spot('B2-108', owner.id, { loc: '地下二层 B 区，靠 3 号充电桩', charger: true, kw: 7, monthly: true, rate: 5, cap: 45 });
  await spot('B2-109', owner.id, { loc: '地下二层 B 区，108 旁标准车位', charger: false, rate: 4, cap: 35 });
  await spot('B1-021', owner2.id, { loc: '地下一层 A 区电梯口', charger: false, rate: 4, cap: 30, visitor: false });

  // 一个待审核车位（供物业审核流程演示）
  await pool.query(
    `INSERT INTO parking_spots(community_id, code, owner_id, location_desc, near_charger,
       allow_visitor, monthly_priority, hourly_rate, overnight_cap, review_status)
     VALUES ($1,'B1-022',$2,'地下一层 A 区（新登记）',false,true,false,3.5,28,'pending')
     ON CONFLICT (community_id, code) DO NOTHING`,
    [communityId, owner2.id],
  );

  async function vehicle(userId, plate, opts = {}) {
    await pool.query(
      `INSERT INTO vehicles(user_id, plate, plate_color, is_new_energy, is_monthly, is_visitor)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, plate) DO UPDATE SET is_new_energy=EXCLUDED.is_new_energy,
         is_monthly=EXCLUDED.is_monthly, is_visitor=EXCLUDED.is_visitor`,
      [
        userId, plate, opts.color || '蓝牌',
        opts.ne ?? false, opts.monthly ?? false, opts.visitor ?? false,
      ],
    );
  }
  await vehicle(driver.id, '沪AD88899', { color: '绿牌', ne: true, monthly: true });
  await vehicle(driver2.id, '沪A12345', { visitor: true });

  // 优惠券
  await pool.query(
    `INSERT INTO coupons(user_id, code, amount)
     SELECT $1, 'WELCOME-NIGHT-10', 10
     WHERE NOT EXISTS (SELECT 1 FROM coupons WHERE user_id=$1 AND code='WELCOME-NIGHT-10')`,
    [driver.id],
  );

  console.log('SEED_OK');
  console.log('测试账号（密码均为 Pass1234）：');
  console.log('  owner1 / driver1 / driver2 / property1 / admin1');
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
