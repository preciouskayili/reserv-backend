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
