-- Combined installation: no database reset or sample business seed.

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


-- Apply using a database owner connection. Backend requires SUPABASE_SERVICE_ROLE_KEY.
BEGIN;
ALTER TABLE businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_settings ENABLE ROW LEVEL SECURITY;
COMMIT;


BEGIN;
CREATE TABLE IF NOT EXISTS public.workspace_members (
 business_id text NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
 user_id text NOT NULL, role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','admin','staff')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(business_id,user_id)
);
CREATE INDEX IF NOT EXISTS workspace_members_user ON public.workspace_members(user_id);
CREATE TABLE IF NOT EXISTS public.workspace_state (
 business_id text PRIMARY KEY REFERENCES public.businesses(id) ON DELETE CASCADE,
 state jsonb NOT NULL, revision integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.reservation_links (
 code text PRIMARY KEY, business_id text NOT NULL REFERENCES public.workspace_state(business_id) ON DELETE CASCADE,
 booking_id text NOT NULL, UNIQUE(business_id,booking_id)
);
ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reservation_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS business_id text REFERENCES public.businesses(id);
ALTER TABLE public.calls DROP CONSTRAINT IF EXISTS calls_booking_id_fkey;
CREATE INDEX IF NOT EXISTS calls_business ON public.calls(business_id);

CREATE OR REPLACE FUNCTION public.create_workspace(p_user text, p_state jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE wid text := p_state->'business'->>'id';
BEGIN
 INSERT INTO businesses(id,name,slug,owner,category,phone,address) VALUES(wid,p_state->'business'->>'name',p_state->'business'->>'slug',p_state->'business'->>'owner',p_state->'business'->>'category',p_state->'business'->>'phone',p_state->'business'->>'address');
 INSERT INTO workspace_members(business_id,user_id,role) VALUES(wid,p_user,'owner');
 INSERT INTO workspace_state(business_id,state) VALUES(wid,p_state);
 RETURN jsonb_build_object('state',p_state,'revision',1);
END $$;

CREATE OR REPLACE FUNCTION public.replace_workspace_state(p_id text, p_revision integer, p_state jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE next_revision integer;
BEGIN
 IF p_state->'business'->>'id' IS DISTINCT FROM p_id THEN RAISE EXCEPTION 'invalid workspace'; END IF;
 UPDATE workspace_state SET state=p_state, revision=revision+1, updated_at=now() WHERE business_id=p_id AND revision=p_revision RETURNING revision INTO next_revision;
 IF next_revision IS NULL THEN RAISE EXCEPTION 'revision conflict' USING ERRCODE='40001'; END IF;
 UPDATE businesses SET name=p_state->'business'->>'name',slug=p_state->'business'->>'slug',owner=p_state->'business'->>'owner',phone=p_state->'business'->>'phone',address=p_state->'business'->>'address' WHERE id=p_id;
 DELETE FROM reservation_links WHERE business_id=p_id;
 INSERT INTO reservation_links(code,business_id,booking_id) SELECT value->>'code',p_id,value->>'id' FROM jsonb_array_elements(p_state->'bookings');
 RETURN jsonb_build_object('state',p_state,'revision',next_revision);
END $$;
REVOKE ALL ON FUNCTION public.create_workspace(text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.replace_workspace_state(text,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_workspace(text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.replace_workspace_state(text,integer,jsonb) TO service_role;
-- Private receipts; only the backend service-role key may issue signed downloads.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES('receipts','receipts',false,8388608,ARRAY['image/jpeg','image/png','image/webp','application/pdf']) ON CONFLICT(id) DO NOTHING;
COMMIT;


BEGIN;
CREATE TABLE IF NOT EXISTS public.reminder_claims (
 business_id text NOT NULL REFERENCES public.workspace_state(business_id) ON DELETE CASCADE,
 booking_id text NOT NULL, appointment_time text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(business_id,booking_id,appointment_time)
);
ALTER TABLE public.reminder_claims ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS public.login_challenges (
 email text PRIMARY KEY, code_hash text NOT NULL, expires_at timestamptz NOT NULL,
 last_sent_at timestamptz NOT NULL DEFAULT now(), attempts integer NOT NULL DEFAULT 0
);
ALTER TABLE public.login_challenges ENABLE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION public.put_login_challenge(p_email text,p_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE affected integer;
BEGIN
 INSERT INTO login_challenges(email,code_hash,expires_at) VALUES(p_email,p_hash,now()+interval '10 minutes')
 ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash,expires_at=excluded.expires_at,last_sent_at=now(),attempts=0 WHERE login_challenges.last_sent_at < now()-interval '60 seconds';
 GET DIAGNOSTICS affected = ROW_COUNT;
 RETURN affected=1;
END $$;
CREATE OR REPLACE FUNCTION public.consume_login_challenge(p_email text,p_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE challenge login_challenges%ROWTYPE;
BEGIN
 SELECT * INTO challenge FROM login_challenges WHERE email=p_email FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF challenge.expires_at < now() OR challenge.attempts>=5 THEN DELETE FROM login_challenges WHERE email=p_email; RETURN false; END IF;
 UPDATE login_challenges SET attempts=attempts+1 WHERE email=p_email;
 IF challenge.code_hash <> p_hash THEN RETURN false; END IF;
 DELETE FROM login_challenges WHERE email=p_email;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.put_login_challenge(text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.consume_login_challenge(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.put_login_challenge(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_login_challenge(text,text) TO service_role;
COMMIT;
NOTIFY pgrst, 'reload schema';


BEGIN;
CREATE TABLE IF NOT EXISTS public.checkout_attempts (
 id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
 business_id text NOT NULL REFERENCES public.workspace_state(business_id),
 booking_id text NOT NULL,
 reservation_code text NOT NULL,
 provider text NOT NULL CHECK(provider IN ('paystack','stripe')),
 live_mode boolean NOT NULL,
 choice text NOT NULL CHECK(choice IN ('deposit','full')),
 idempotency_key uuid NOT NULL,
 email text NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor > 0 AND amount_minor <= 10000000000),
 currency text NOT NULL DEFAULT 'NGN' CHECK(currency='NGN'),
 status text NOT NULL DEFAULT 'initializing' CHECK(status IN ('initializing','pending','succeeded','expired')),
 provider_reference text NOT NULL UNIQUE,
 provider_session text,
 provider_transaction text,
 checkout_url text,
 return_url text NOT NULL,
 lease_until timestamptz,
 needs_review boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(business_id,booking_id,idempotency_key),
 UNIQUE(provider,provider_transaction)
);
CREATE UNIQUE INDEX IF NOT EXISTS checkout_one_active_booking ON public.checkout_attempts(business_id,booking_id) WHERE status IN ('initializing','pending');
ALTER TABLE public.checkout_attempts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.reserve_checkout(p_code text,p_provider text,p_live boolean,p_choice text,p_email text,p_key uuid,p_return_url text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE wid text; doc jsonb; booking jsonb; attempt checkout_attempts%ROWTYPE; paid numeric; total numeric; required numeric; amount numeric; aid uuid := uuid_generate_v4();
BEGIN
 SELECT business_id INTO wid FROM reservation_links WHERE code=p_code;
 IF wid IS NULL THEN RAISE EXCEPTION 'Reservation not found' USING ERRCODE='P0002'; END IF;
 SELECT state INTO doc FROM workspace_state WHERE business_id=wid FOR UPDATE;
 SELECT value INTO booking FROM jsonb_array_elements(doc->'bookings') WHERE value->>'code'=p_code;
 IF booking IS NULL THEN RAISE EXCEPTION 'Reservation not found' USING ERRCODE='P0002'; END IF;
 IF booking->>'status' IN ('Cancelled','Completed') THEN RAISE EXCEPTION 'This reservation cannot accept payments' USING ERRCODE='P0001'; END IF;
 SELECT * INTO attempt FROM checkout_attempts WHERE business_id=wid AND booking_id=booking->>'id' AND idempotency_key=p_key;
 IF FOUND THEN
  IF attempt.provider<>p_provider OR attempt.choice<>p_choice OR attempt.live_mode<>p_live THEN RAISE EXCEPTION 'This retry belongs to a different checkout' USING ERRCODE='P0001'; END IF;
  RETURN to_jsonb(attempt);
 END IF;
 SELECT * INTO attempt FROM checkout_attempts WHERE business_id=wid AND booking_id=booking->>'id' AND status IN ('initializing','pending');
 IF FOUND THEN
  IF attempt.provider<>p_provider OR attempt.choice<>p_choice OR attempt.live_mode<>p_live THEN RAISE EXCEPTION 'Resume the existing checkout before choosing another payment method or amount' USING ERRCODE='P0001'; END IF;
  RETURN to_jsonb(attempt);
 END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(coalesce(doc->'payments','[]')) p WHERE p->>'bookingId'=booking->>'id' AND p->>'status'='review') THEN RAISE EXCEPTION 'A transfer receipt is already awaiting review' USING ERRCODE='P0001'; END IF;
 IF EXISTS(SELECT FROM checkout_attempts a JOIN checkout_adjustments adj ON adj.attempt_id=a.id WHERE a.business_id=wid AND a.booking_id=booking->>'id') THEN RAISE EXCEPTION 'This booking has a refund or dispute. Contact the studio before making another payment' USING ERRCODE='P0001'; END IF;
 SELECT coalesce(sum((p->>'amount')::numeric),0)*100 INTO paid FROM jsonb_array_elements(coalesce(doc->'payments','[]')) p WHERE p->>'bookingId'=booking->>'id' AND p->>'status'='approved';
 total := (booking->>'totalAmount')::numeric*100;
 required := (booking->>'requiredAmount')::numeric*100;
 amount := CASE WHEN p_choice='full' THEN total-paid ELSE required-paid END;
 IF amount IS NULL OR amount<=0 OR amount<>trunc(amount) OR total<>trunc(total) OR paid<>trunc(paid) THEN RAISE EXCEPTION 'No valid balance is due for this payment choice' USING ERRCODE='P0001'; END IF;
 INSERT INTO checkout_attempts(id,business_id,booking_id,reservation_code,provider,live_mode,choice,idempotency_key,email,amount_minor,provider_reference,return_url)
 VALUES(aid,wid,booking->>'id',p_code,p_provider,p_live,p_choice,p_key,p_email,amount::bigint,'rsv-'||aid::text,p_return_url) RETURNING * INTO attempt;
 RETURN to_jsonb(attempt);
END $$;

-- Settlement and reservation state are committed together. Callbacks and webhooks use this same operation.
CREATE OR REPLACE FUNCTION public.settle_checkout(p_id uuid,p_transaction text,p_amount bigint,p_currency text,p_live boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE attempt checkout_attempts%ROWTYPE; wid text; doc jsonb; booking jsonb; paid numeric; review_needed boolean; payment jsonb; new_revision integer;
BEGIN
 SELECT business_id INTO wid FROM checkout_attempts WHERE id=p_id;
 IF wid IS NULL THEN RAISE EXCEPTION 'Checkout not found' USING ERRCODE='P0002'; END IF;
 SELECT state INTO doc FROM workspace_state WHERE business_id=wid FOR UPDATE;
 SELECT * INTO attempt FROM checkout_attempts WHERE id=p_id FOR UPDATE;
 IF attempt.amount_minor<>p_amount OR attempt.currency<>p_currency OR attempt.live_mode<>p_live OR coalesce(p_transaction,'')='' THEN RAISE EXCEPTION 'Verified payment does not match checkout' USING ERRCODE='P0001'; END IF;
 IF attempt.status='succeeded' THEN
  IF attempt.provider_transaction<>p_transaction THEN RAISE EXCEPTION 'Payment reference mismatch' USING ERRCODE='P0001'; END IF;
  RETURN to_jsonb(attempt);
 END IF;
 SELECT value INTO booking FROM jsonb_array_elements(doc->'bookings') WHERE value->>'id'=attempt.booking_id;
 IF booking IS NULL THEN RAISE EXCEPTION 'Payment needs reconciliation: booking missing' USING ERRCODE='P0001'; END IF;
 SELECT coalesce(sum((p->>'amount')::numeric-coalesce((p->>'refundedAmount')::numeric,0)),0) INTO paid FROM jsonb_array_elements(coalesce(doc->'payments','[]')) p WHERE p->>'bookingId'=attempt.booking_id AND p->>'status'='approved' AND NOT coalesce((p->>'disputed')::boolean,false);
 review_needed := booking->>'status' IN ('Cancelled','Completed') OR paid+p_amount::numeric/100 > (booking->>'totalAmount')::numeric;
 UPDATE checkout_attempts SET status='succeeded',provider_transaction=p_transaction,needs_review=review_needed,updated_at=now(),lease_until=NULL WHERE id=p_id;
 payment := jsonb_build_object('id',p_id::text,'bookingId',attempt.booking_id,'amount',p_amount::numeric/100,'method','gateway','status','approved','provider',attempt.provider,'reference',attempt.provider_reference,'needsReview',review_needed,'createdAt',now());
 doc := jsonb_set(doc,'{payments}',coalesce(doc->'payments','[]')||jsonb_build_array(payment));
 booking := jsonb_set(booking,'{activity}',coalesce(booking->'activity','[]')||jsonb_build_array(jsonb_build_object('id',p_id::text,'title',CASE WHEN review_needed THEN 'Payment received — studio review required' ELSE 'Payment verified by '||initcap(attempt.provider) END,'time',now(),'actor','customer')));
 IF NOT review_needed AND paid+p_amount::numeric/100 >= (booking->>'requiredAmount')::numeric THEN booking := jsonb_set(booking,'{status}','"Confirmed"'); END IF;
 doc := jsonb_set(doc,'{bookings}',(SELECT jsonb_agg(CASE WHEN value->>'id'=attempt.booking_id THEN booking ELSE value END) FROM jsonb_array_elements(doc->'bookings')));
 UPDATE workspace_state SET state=doc,revision=revision+1,updated_at=now() WHERE business_id=wid RETURNING revision INTO new_revision;
 SELECT * INTO attempt FROM checkout_attempts WHERE id=p_id;
 RETURN to_jsonb(attempt);
END $$;

CREATE TABLE IF NOT EXISTS public.checkout_adjustments (
 attempt_id uuid NOT NULL REFERENCES public.checkout_attempts(id),
 external_id text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('refund','dispute')),
 amount_minor bigint NOT NULL CHECK(amount_minor>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(attempt_id,external_id)
);
ALTER TABLE public.checkout_adjustments ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON public.checkout_attempts, public.checkout_adjustments TO service_role;
CREATE OR REPLACE FUNCTION public.adjust_checkout(p_id uuid,p_external text,p_kind text,p_amount bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE wid text; doc jsonb; attempt checkout_attempts%ROWTYPE; refunded bigint; disputed boolean; payment jsonb; booking jsonb; net numeric;
BEGIN
 SELECT business_id INTO wid FROM checkout_attempts WHERE id=p_id;
 IF wid IS NULL THEN RAISE EXCEPTION 'Checkout not found' USING ERRCODE='P0002'; END IF;
 SELECT state INTO doc FROM workspace_state WHERE business_id=wid FOR UPDATE;
 SELECT * INTO attempt FROM checkout_attempts WHERE id=p_id FOR UPDATE;
 IF attempt.status<>'succeeded' THEN RAISE EXCEPTION 'Original payment must be reconciled first' USING ERRCODE='P0001'; END IF;
 IF p_kind NOT IN ('refund','dispute') OR p_amount<0 OR p_amount>attempt.amount_minor OR coalesce(p_external,'')='' THEN RAISE EXCEPTION 'Invalid payment adjustment' USING ERRCODE='P0001'; END IF;
 INSERT INTO checkout_adjustments(attempt_id,external_id,kind,amount_minor) VALUES(p_id,p_external,p_kind,p_amount)
 ON CONFLICT(attempt_id,external_id) DO UPDATE SET amount_minor=greatest(checkout_adjustments.amount_minor,excluded.amount_minor);
 SELECT coalesce(sum(amount_minor) FILTER(WHERE kind='refund'),0),coalesce(bool_or(kind='dispute'),false) INTO refunded,disputed FROM checkout_adjustments WHERE attempt_id=p_id;
 IF refunded>attempt.amount_minor THEN RAISE EXCEPTION 'Refund exceeds original payment' USING ERRCODE='P0001'; END IF;
 SELECT value INTO payment FROM jsonb_array_elements(doc->'payments') WHERE value->>'id'=p_id::text;
 IF coalesce((payment->>'refundedAmount')::numeric,0)=refunded::numeric/100 AND coalesce((payment->>'disputed')::boolean,false)=disputed THEN RETURN; END IF;
 payment := payment||jsonb_build_object('refundedAmount',refunded::numeric/100,'disputed',disputed);
 doc := jsonb_set(doc,'{payments}',(SELECT jsonb_agg(CASE WHEN value->>'id'=p_id::text THEN payment ELSE value END) FROM jsonb_array_elements(doc->'payments')));
 SELECT value INTO booking FROM jsonb_array_elements(doc->'bookings') WHERE value->>'id'=attempt.booking_id;
 SELECT coalesce(sum((p->>'amount')::numeric-coalesce((p->>'refundedAmount')::numeric,0)),0) INTO net FROM jsonb_array_elements(doc->'payments') p WHERE p->>'bookingId'=attempt.booking_id AND p->>'status'='approved' AND NOT coalesce((p->>'disputed')::boolean,false);
 IF booking->>'status' NOT IN ('Cancelled','Completed') AND net<(booking->>'requiredAmount')::numeric THEN booking:=jsonb_set(booking,'{status}','"Pending"'); END IF;
 booking:=jsonb_set(booking,'{activity}',coalesce(booking->'activity','[]')||jsonb_build_array(jsonb_build_object('id',uuid_generate_v4()::text,'title',CASE WHEN disputed THEN 'Payment dispute — contact the studio' ELSE 'Payment refund recorded' END,'time',now(),'actor','customer')));
 doc:=jsonb_set(doc,'{bookings}',(SELECT jsonb_agg(CASE WHEN value->>'id'=attempt.booking_id THEN booking ELSE value END) FROM jsonb_array_elements(doc->'bookings')));
 UPDATE checkout_attempts SET needs_review=true,updated_at=now() WHERE id=p_id;
 UPDATE workspace_state SET state=doc,revision=revision+1,updated_at=now() WHERE business_id=wid;
END $$;
REVOKE ALL ON FUNCTION public.adjust_checkout(uuid,text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_checkout(uuid,text,text,bigint) TO service_role;

-- Every snapshot save, including receipt uploads, takes the same workspace row lock.
-- This closes races between checkout creation, receipt uploads and owner edits.
CREATE OR REPLACE FUNCTION public.guard_checkout_state() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE attempt checkout_attempts%ROWTYPE; old_booking jsonb; new_booking jsonb; payment jsonb;
BEGIN
 FOR payment IN SELECT value FROM jsonb_array_elements(coalesce(OLD.state->'payments','[]')) WHERE value->>'method'='gateway' LOOP
  IF NOT EXISTS(SELECT FROM jsonb_array_elements(coalesce(NEW.state->'payments','[]')) p WHERE (p-'refundedAmount'-'disputed')=(payment-'refundedAmount'-'disputed')) THEN RAISE EXCEPTION 'Verified gateway payments cannot be edited' USING ERRCODE='P0001'; END IF;
 END LOOP;
 FOR payment IN SELECT value FROM jsonb_array_elements(coalesce(NEW.state->'payments','[]')) WHERE value->>'method'='gateway' LOOP
  IF NOT EXISTS(SELECT FROM jsonb_array_elements(coalesce(OLD.state->'payments','[]')) p WHERE (p-'refundedAmount'-'disputed')=(payment-'refundedAmount'-'disputed')) AND NOT EXISTS(SELECT FROM checkout_attempts WHERE id::text=payment->>'id' AND business_id=NEW.business_id AND booking_id=payment->>'bookingId' AND status='succeeded' AND amount_minor=(payment->>'amount')::numeric*100 AND payment->>'status'='approved') THEN RAISE EXCEPTION 'Gateway payment must be verified first' USING ERRCODE='P0001'; END IF;
  IF coalesce((payment->>'refundedAmount')::numeric,0)*100<>(SELECT coalesce(sum(amount_minor),0) FROM checkout_adjustments WHERE attempt_id::text=payment->>'id' AND kind='refund') OR coalesce((payment->>'disputed')::boolean,false)<>EXISTS(SELECT FROM checkout_adjustments WHERE attempt_id::text=payment->>'id' AND kind='dispute') THEN RAISE EXCEPTION 'Payment adjustments must be verified' USING ERRCODE='P0001'; END IF;
 END LOOP;
 IF EXISTS(SELECT FROM jsonb_array_elements(coalesce(NEW.state->'payments','[]')) p WHERE p->>'method'='transfer' AND NOT EXISTS(SELECT FROM jsonb_array_elements(coalesce(OLD.state->'payments','[]')) old_p WHERE old_p=p) AND EXISTS(SELECT FROM checkout_attempts a JOIN checkout_adjustments adj ON adj.attempt_id=a.id WHERE a.business_id=NEW.business_id AND a.booking_id=p->>'bookingId')) THEN RAISE EXCEPTION 'This payment needs reconciliation before another receipt can be submitted' USING ERRCODE='P0001'; END IF;
 FOR attempt IN SELECT * FROM checkout_attempts WHERE business_id=NEW.business_id AND status IN ('initializing','pending') LOOP
  SELECT value INTO old_booking FROM jsonb_array_elements(OLD.state->'bookings') WHERE value->>'id'=attempt.booking_id;
  SELECT value INTO new_booking FROM jsonb_array_elements(NEW.state->'bookings') WHERE value->>'id'=attempt.booking_id;
  IF new_booking IS NULL OR new_booking->'totalAmount' IS DISTINCT FROM old_booking->'totalAmount' OR new_booking->'requiredAmount' IS DISTINCT FROM old_booking->'requiredAmount' THEN RAISE EXCEPTION 'A checkout is open for this booking; its amount cannot change' USING ERRCODE='P0001'; END IF;
  IF EXISTS(SELECT FROM jsonb_array_elements(coalesce(NEW.state->'payments','[]')) p WHERE p->>'bookingId'=attempt.booking_id AND p->>'method'<>'gateway' AND NOT EXISTS(SELECT FROM jsonb_array_elements(coalesce(OLD.state->'payments','[]')) old_p WHERE old_p=p)) THEN RAISE EXCEPTION 'A checkout is open for this booking; resume it before submitting another payment' USING ERRCODE='P0001'; END IF;
 END LOOP;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_checkout_state ON public.workspace_state;
CREATE TRIGGER protect_checkout_state BEFORE UPDATE OF state ON public.workspace_state FOR EACH ROW EXECUTE FUNCTION public.guard_checkout_state();
REVOKE ALL ON FUNCTION public.reserve_checkout(text,text,boolean,text,text,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.settle_checkout(uuid,text,bigint,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_checkout(text,text,boolean,text,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_checkout(uuid,text,bigint,text,boolean) TO service_role;
COMMIT;
NOTIFY pgrst, 'reload schema';

-- Customers can call a business's number; the voice agent's inbound calls are logged with their own type.
BEGIN;
ALTER TABLE public.calls DROP CONSTRAINT IF EXISTS calls_call_type_check;
ALTER TABLE public.calls ADD CONSTRAINT calls_call_type_check
  CHECK (call_type IN ('reminder', 'confirmation', 'unpaid_checkin', 'manual', 'inbound'));
COMMIT;
NOTIFY pgrst, 'reload schema';
