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
