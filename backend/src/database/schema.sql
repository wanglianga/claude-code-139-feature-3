-- 社区共享停车平台：完整库表结构
-- 覆盖：车位发布 -> 预约 -> 入场 -> 异常 -> 离场 -> 分账 全链路

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','driver','property','admin')),
  phone TEXT,
  credit_score INT NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS communities (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT
);

CREATE TABLE IF NOT EXISTS parking_spots (
  id BIGSERIAL PRIMARY KEY,
  community_id BIGINT NOT NULL REFERENCES communities(id),
  code TEXT NOT NULL,
  owner_id BIGINT NOT NULL REFERENCES users(id),
  location_desc TEXT,
  near_charger BOOLEAN NOT NULL DEFAULT false,
  charger_power_kw NUMERIC(6,1),
  allow_visitor BOOLEAN NOT NULL DEFAULT true,
  monthly_priority BOOLEAN NOT NULL DEFAULT false,
  hourly_rate NUMERIC(10,2) NOT NULL,
  overnight_cap NUMERIC(10,2),
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending','approved','rejected','revoked')),
  review_remark TEXT,
  reviewed_by BIGINT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(community_id, code)
);

-- 可共享时段：weekday 0=周日 ... 6=周六；end_time <= start_time 表示跨天（如 19:00->08:00）
CREATE TABLE IF NOT EXISTS spot_share_windows (
  id BIGSERIAL PRIMARY KEY,
  spot_id BIGINT NOT NULL REFERENCES parking_spots(id) ON DELETE CASCADE,
  weekday INT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  UNIQUE(spot_id, weekday)
);

CREATE TABLE IF NOT EXISTS vehicles (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plate TEXT NOT NULL,
  plate_color TEXT NOT NULL DEFAULT '蓝牌',
  is_new_energy BOOLEAN NOT NULL DEFAULT false,
  is_monthly BOOLEAN NOT NULL DEFAULT false,
  is_visitor BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, plate)
);

CREATE TABLE IF NOT EXISTS reservations (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  spot_id BIGINT NOT NULL REFERENCES parking_spots(id),
  driver_id BIGINT NOT NULL REFERENCES users(id),
  vehicle_id BIGINT NOT NULL REFERENCES vehicles(id),
  plate TEXT NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN (
    'reserved','admitted','in_garage','completed','cancelled','noshow'
  )),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','monthly')),
  estimated_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  gate_entry_at TIMESTAMPTZ,
  parking_confirmed_at TIMESTAMPTZ,
  gate_exit_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  settlement_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reservations_spot_time ON reservations(spot_id, start_at, end_at);

-- 同一笔停车服务的全链路事件：入场道闸/车牌识别/导航引导/计费/离场结算
CREATE TABLE IF NOT EXISTS service_events (
  id BIGSERIAL PRIMARY KEY,
  reservation_id BIGINT REFERENCES reservations(id),
  spot_id BIGINT REFERENCES parking_spots(id),
  type TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id BIGINT REFERENCES users(id),
  actor_role TEXT,
  plate TEXT,
  gate TEXT,
  confidence NUMERIC(5,2),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_events_reservation ON service_events(reservation_id);
CREATE INDEX IF NOT EXISTS idx_events_spot_time ON service_events(spot_id, occurred_at);

-- 夜间调度异常工单
CREATE TABLE IF NOT EXISTS incident_tickets (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  spot_id BIGINT REFERENCES parking_spots(id),
  reservation_id BIGINT REFERENCES reservations(id),
  type TEXT NOT NULL CHECK (type IN (
    'owner_return','visitor_overstay','stranger_occupy','recognition_fail',
    'weak_signal','ice_occupy_charger','wrong_parking','manual_release'
  )),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','notified','resolved','closed','cancelled')),
  plate TEXT,
  reporter_role TEXT,
  description TEXT,
  resolution TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_by BIGINT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS move_notices (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES incident_tickets(id) ON DELETE CASCADE,
  target_plate TEXT NOT NULL,
  channel TEXT NOT NULL,
  message TEXT,
  delivered_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS appeals (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  reservation_id BIGINT NOT NULL REFERENCES reservations(id),
  spot_id BIGINT NOT NULL REFERENCES parking_spots(id),
  appellant_id BIGINT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','investigating','upheld','rejected','closed')),
  ruling TEXT CHECK (ruling IN (
    'driver_fault','owner_fault','platform_fault','property_fault','stranger','mixed','no_fault'
  )),
  ruling_note TEXT,
  ruled_by BIGINT REFERENCES users(id),
  ruled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS appeal_evidence (
  id BIGSERIAL PRIMARY KEY,
  appeal_id BIGINT NOT NULL REFERENCES appeals(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN (
    'plate_recognition','reservation','photo','gate_log','owner_home','patrol','appeal_statement','signal'
  )),
  title TEXT NOT NULL,
  content TEXT,
  media_url TEXT,
  captured_at TIMESTAMPTZ,
  uploaded_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coupons (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL,
  used_reservation_id BIGINT REFERENCES reservations(id),
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 结算单：业主收益/物业服务费/平台抽成/优惠券/退款/异常补偿合并清算
CREATE TABLE IF NOT EXISTS settlements (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  reservation_id BIGINT UNIQUE NOT NULL REFERENCES reservations(id),
  spot_id BIGINT NOT NULL REFERENCES parking_spots(id),
  actual_entry_at TIMESTAMPTZ,
  actual_exit_at TIMESTAMPTZ,
  usable_from TIMESTAMPTZ,
  duration_minutes INT NOT NULL DEFAULT 0,
  base_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  charging_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  overtime_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  wrong_park_fine NUMERIC(10,2) NOT NULL DEFAULT 0,
  coupon_discount NUMERIC(10,2) NOT NULL DEFAULT 0,
  abnormal_compensation NUMERIC(10,2) NOT NULL DEFAULT 0,
  coupon_compensation NUMERIC(10,2) NOT NULL DEFAULT 0,
  owner_compensation NUMERIC(10,2) NOT NULL DEFAULT 0,
  prepaid NUMERIC(10,2) NOT NULL DEFAULT 0,
  refund NUMERIC(10,2) NOT NULL DEFAULT 0,
  exit_charge NUMERIC(10,2) NOT NULL DEFAULT 0,
  payable NUMERIC(10,2) NOT NULL DEFAULT 0,
  owner_income NUMERIC(10,2) NOT NULL DEFAULT 0,
  property_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  platform_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  owner_share NUMERIC(5,4) NOT NULL,
  property_share NUMERIC(5,4) NOT NULL,
  platform_share NUMERIC(5,4) NOT NULL,
  credit_target TEXT NOT NULL DEFAULT 'driver',
  credit_delta INT NOT NULL DEFAULT 0,
  appeal_id BIGINT REFERENCES appeals(id),
  ruling TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 资金流水（业主/车主/物业/平台/券池共同追溯）
CREATE TABLE IF NOT EXISTS ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  settlement_id BIGINT NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  account TEXT NOT NULL,           -- driver / owner:<uid> / property / platform / coupon_pool
  direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  amount NUMERIC(10,2) NOT NULL,
  memo TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_settlement ON ledger_entries(settlement_id);

-- 跨日分账：车辆凌晨离场跨越多个结算日（UTC+8 日界），按实际占用时段拆分
-- 业主收益/物业服务费/平台抽成；每段记录费用来源（正常使用/换位/优惠券/人工放行/异常）
CREATE TABLE IF NOT EXISTS settlement_day_splits (
  id BIGSERIAL PRIMARY KEY,
  settlement_id BIGINT NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  settlement_date DATE NOT NULL,              -- 结算日（UTC+8 日历日）
  period_from TIMESTAMPTZ NOT NULL,
  period_to TIMESTAMPTZ NOT NULL,
  duration_minutes INT NOT NULL DEFAULT 0,
  spot_code TEXT,                             -- 该段实际占用车位（换位时与预约车位不同）
  base_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  charging_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  overtime_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  wrong_park_fine NUMERIC(10,2) NOT NULL DEFAULT 0,
  coupon_discount NUMERIC(10,2) NOT NULL DEFAULT 0,
  service_revenue NUMERIC(10,2) NOT NULL DEFAULT 0,
  owner_income NUMERIC(10,2) NOT NULL DEFAULT 0,
  property_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  platform_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb, -- 每段费用来源说明 [{kind,label,amount?,at?}]
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_day_split_settlement ON settlement_day_splits(settlement_id);
CREATE INDEX IF NOT EXISTS idx_day_split_date ON settlement_day_splits(settlement_date);

-- 车主退款申请：平台按道闸/巡查/离场时间校验可退金额，审批通过后生成冲正单，防重复冲销
CREATE TABLE IF NOT EXISTS refund_requests (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  reservation_id BIGINT NOT NULL REFERENCES reservations(id),
  driver_id BIGINT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','paid','cancelled')),
  reason TEXT NOT NULL,
  requested_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  validated_amount NUMERIC(10,2) NOT NULL DEFAULT 0,   -- 平台校验后确认的现金可退额
  coupon_reissue NUMERIC(10,2) NOT NULL DEFAULT 0,    -- 券抵扣部分不退现金，补发等额赔付券
  settlement_id BIGINT REFERENCES settlements(id),
  reversal_id BIGINT,
  checks JSONB NOT NULL DEFAULT '[]'::jsonb,          -- 道闸/巡查/离场时间/防重 校验项
  reject_reason TEXT,
  reviewed_by BIGINT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refund_reservation ON refund_requests(reservation_id);
CREATE INDEX IF NOT EXISTS idx_refund_driver ON refund_requests(driver_id);

-- 结算后冲正单：申诉成立或退款审核通过后生成，冲正流水与原分账成对、借贷必须平衡
CREATE TABLE IF NOT EXISTS settlement_reversals (
  id BIGSERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  settlement_id BIGINT NOT NULL REFERENCES settlements(id),   -- 原分账
  reservation_id BIGINT NOT NULL REFERENCES reservations(id),
  appeal_id BIGINT REFERENCES appeals(id),
  refund_request_id BIGINT REFERENCES refund_requests(id),
  kind TEXT NOT NULL CHECK (kind IN ('appeal_ruling','refund_approved')),
  reason TEXT NOT NULL,
  old_ruling TEXT,
  new_ruling TEXT,
  refund_to_driver NUMERIC(10,2) NOT NULL DEFAULT 0,  -- 本次实际退给车主现金
  coupon_reissue NUMERIC(10,2) NOT NULL DEFAULT 0,
  owner_clawback NUMERIC(10,2) NOT NULL DEFAULT 0,
  property_clawback NUMERIC(10,2) NOT NULL DEFAULT 0,
  platform_clawback NUMERIC(10,2) NOT NULL DEFAULT 0,
  credit_target TEXT,
  credit_delta INT NOT NULL DEFAULT 0,                 -- 冲正导致的信用净调整
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reversal_settlement ON settlement_reversals(settlement_id);
CREATE INDEX IF NOT EXISTS idx_reversal_reservation ON settlement_reversals(reservation_id);

CREATE TABLE IF NOT EXISTS patrol_logs (
  id BIGSERIAL PRIMARY KEY,
  spot_id BIGINT REFERENCES parking_spots(id),
  guard_id BIGINT REFERENCES users(id),
  plate TEXT,
  note TEXT,
  media_url TEXT,
  patrolled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 幂等迁移：为旧版本库补充后续新增列
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS coupon_compensation NUMERIC(10,2) NOT NULL DEFAULT 0;
-- 一笔服务可因申诉改判产生多版结算单（original -> recomputed），去掉一对一唯一约束
ALTER TABLE settlements DROP CONSTRAINT IF EXISTS settlements_reservation_id_key;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'original'
  CHECK (kind IN ('original','recomputed'));
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS supersedes_id BIGINT REFERENCES settlements(id);
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS reversal_count INT NOT NULL DEFAULT 0;
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS reversal_id BIGINT REFERENCES settlement_reversals(id);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'refund_requests_reversal_fk'
  ) THEN
    ALTER TABLE refund_requests ADD CONSTRAINT refund_requests_reversal_fk
      FOREIGN KEY (reversal_id) REFERENCES settlement_reversals(id);
  END IF;
END $$;
