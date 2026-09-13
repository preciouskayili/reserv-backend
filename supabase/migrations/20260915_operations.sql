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
