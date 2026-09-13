-- Base tables, without sample customers or businesses. Safe to run before the workspace migration.
-- ==============================================================================
-- RESERV - SUPABASE DATABASE SCHEMA
-- Relational schema matching frontend models, payment flows, and Aethex call logs
-- ==============================================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Businesses
CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  owner TEXT NOT NULL,
  category TEXT DEFAULT 'Studio',
  description TEXT DEFAULT '',
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  hours JSONB NOT NULL DEFAULT '[]'::jsonb,
  booking_policy TEXT DEFAULT '',
  cancellation_policy TEXT DEFAULT '',
  deposit_policy TEXT DEFAULT '',
  faqs JSONB DEFAULT '[]'::jsonb,
  rules JSONB DEFAULT '{"minNoticeMinutes": 60, "maxAdvanceDays": 30, "slotMinutes": 30}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Services
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  business_id TEXT REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  duration INTEGER NOT NULL DEFAULT 60,
  price NUMERIC(10, 2) NOT NULL DEFAULT 0,
  deposit NUMERIC(10, 2) NOT NULL DEFAULT 0,
  staff_ids JSONB DEFAULT '[]'::jsonb,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Staff Members
CREATE TABLE IF NOT EXISTS staff (
  id TEXT PRIMARY KEY,
  business_id TEXT REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT DEFAULT 'Stylist',
  initials TEXT NOT NULL,
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Customers
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  business_id TEXT REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

-- 5. Bookings
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  business_id TEXT REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id TEXT REFERENCES customers(id) ON DELETE RESTRICT,
  service_id TEXT REFERENCES services(id) ON DELETE RESTRICT,
  staff_id TEXT REFERENCES staff(id) ON DELETE RESTRICT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Confirmed', 'Pending', 'Needs confirmation', 'Cancelled', 'Completed', 'Rescheduled')),
  notes TEXT DEFAULT '',
  total_amount NUMERIC(10, 2) DEFAULT 0,
  required_amount NUMERIC(10, 2) DEFAULT 0,
  reminder TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bookings_code ON bookings(code);
CREATE INDEX IF NOT EXISTS idx_bookings_business ON bookings(business_id);
CREATE INDEX IF NOT EXISTS idx_bookings_start_time ON bookings(start_time);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);

-- 6. Booking Activity Timeline
CREATE TABLE IF NOT EXISTS booking_activity (
  id TEXT PRIMARY KEY,
  booking_id TEXT REFERENCES bookings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  detail TEXT DEFAULT '',
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'customer', 'agent')),
  time TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_booking_activity_booking ON booking_activity(booking_id);

-- 7. Payments
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT REFERENCES bookings(id) ON DELETE CASCADE,
  amount NUMERIC(10, 2) NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('gateway', 'transfer')),
  status TEXT NOT NULL CHECK (status IN ('review', 'approved', 'rejected')),
  receipt_id TEXT,
  receipt_name TEXT,
  receipt_url TEXT,
  rejection_reason TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- 8. Calls (Aethex Voice AI Calls)
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY DEFAULT uuid_generate_v4()::text,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  aethex_call_id TEXT,
  agent_id TEXT,
  direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('inbound', 'outbound')),
  from_number TEXT NOT NULL,
  to_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'ringing', 'in-progress', 'connected', 'completed', 'failed', 'no-answer', 'busy', 'canceled')),
  call_type TEXT NOT NULL DEFAULT 'reminder' CHECK (call_type IN ('reminder', 'confirmation', 'unpaid_checkin', 'manual')),
  duration_seconds NUMERIC(8, 2),
  cost_cents INTEGER,
  transcript TEXT DEFAULT '',
  recording_url TEXT DEFAULT '',
  metadata JSONB DEFAULT '{}'::jsonb,
  error_message TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calls_booking ON calls(booking_id);
CREATE INDEX IF NOT EXISTS idx_calls_aethex_call_id ON calls(aethex_call_id);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);

-- 9. Business Settings & Automated Call Preferences
CREATE TABLE IF NOT EXISTS business_settings (
  business_id TEXT PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  owner_name TEXT NOT NULL,
  owner_email TEXT DEFAULT '',
  owner_phone TEXT DEFAULT '',
  calls_enabled BOOLEAN DEFAULT FALSE,
  reminder_minutes INTEGER DEFAULT 120,
  unpaid_enabled BOOLEAN DEFAULT FALSE,
  unpaid_interval_minutes INTEGER DEFAULT 1440,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ==============================================================================
