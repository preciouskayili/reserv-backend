-- Customers can call a business's number; the voice agent's inbound calls are logged with their own type.
BEGIN;
ALTER TABLE public.calls DROP CONSTRAINT IF EXISTS calls_call_type_check;
ALTER TABLE public.calls ADD CONSTRAINT calls_call_type_check
  CHECK (call_type IN ('reminder', 'confirmation', 'unpaid_checkin', 'manual', 'inbound'));
COMMIT;
NOTIFY pgrst, 'reload schema';
