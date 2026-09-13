\set ON_ERROR_STOP on
BEGIN;
DO $$
DECLARE doc jsonb; a jsonb; b jsonb; original jsonb; result jsonb; booking jsonb;
BEGIN
 doc := '{"business":{"id":"payment-test","name":"Payment Test","slug":"payment-test","owner":"Owner","category":"Beauty","phone":"+2348000000000","address":"Abuja"},"payments":[],"bookings":[{"id":"booking-a","code":"ABCDEFGHIJKL","status":"Pending","totalAmount":10000,"requiredAmount":5000,"activity":[]},{"id":"booking-b","code":"MNOPQRSTUVWX","status":"Pending","totalAmount":10000,"requiredAmount":5000,"activity":[]}]}'::jsonb;
 PERFORM create_workspace('payment-owner',doc);
 PERFORM replace_workspace_state('payment-test',1,doc);
 a := reserve_checkout('ABCDEFGHIJKL','paystack',false,'deposit','a@example.test','aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa','https://reserv.example');
 b := reserve_checkout('ABCDEFGHIJKL','paystack',false,'deposit','a@example.test','bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb','https://reserv.example');
 IF a->>'id' <> b->>'id' OR (a->>'amount_minor')::bigint<>500000 THEN RAISE EXCEPTION 'duplicate checkout or wrong amount'; END IF;
 BEGIN
  PERFORM reserve_checkout('ABCDEFGHIJKL','stripe',false,'deposit','a@example.test',uuid_generate_v4(),'https://reserv.example');
  RAISE EXCEPTION 'second provider was accepted' USING ERRCODE='XX000';
 EXCEPTION WHEN raise_exception THEN NULL; END;
 BEGIN
  PERFORM settle_checkout((a->>'id')::uuid,'txn-a',1,'NGN',false);
  RAISE EXCEPTION 'wrong amount accepted' USING ERRCODE='XX000';
 EXCEPTION WHEN raise_exception THEN NULL; END;
 BEGIN
  PERFORM settle_checkout((a->>'id')::uuid,'txn-a',500000,'USD',false);
  RAISE EXCEPTION 'wrong currency accepted' USING ERRCODE='XX000';
 EXCEPTION WHEN raise_exception THEN NULL; END;
 BEGIN
  PERFORM replace_workspace_state('payment-test',2,jsonb_set(doc,'{payments}','[{"id":"receipt-a","bookingId":"booking-a","amount":5000,"method":"transfer","status":"review"}]'));
  RAISE EXCEPTION 'receipt bypassed active checkout' USING ERRCODE='XX000';
 EXCEPTION WHEN raise_exception THEN NULL; END;
 BEGIN
  PERFORM replace_workspace_state('payment-test',2,jsonb_set(doc,'{bookings,0,totalAmount}','1'));
  RAISE EXCEPTION 'price changed during checkout' USING ERRCODE='XX000';
 EXCEPTION WHEN raise_exception THEN NULL; END;
 result := settle_checkout((a->>'id')::uuid,'txn-a',500000,'NGN',false);
 result := settle_checkout((a->>'id')::uuid,'txn-a',500000,'NGN',false);
 SELECT state INTO original FROM workspace_state WHERE business_id='payment-test';
 IF jsonb_array_length(original->'payments')<>1 OR original->'bookings'->0->>'status'<>'Confirmed' THEN RAISE EXCEPTION 'duplicate settlement or missing confirmation'; END IF;
 BEGIN
  PERFORM replace_workspace_state('payment-test',3,jsonb_set(original,'{payments}','[]'));
  RAISE EXCEPTION 'gateway payment was removed' USING ERRCODE='XX000';
 EXCEPTION WHEN raise_exception THEN NULL; END;
 BEGIN
  PERFORM replace_workspace_state('payment-test',2,doc);
  RAISE EXCEPTION 'stale snapshot overwrote settlement' USING ERRCODE='XX000';
 EXCEPTION WHEN serialization_failure THEN NULL; END;
 b := reserve_checkout('MNOPQRSTUVWX','stripe',false,'full','b@example.test',uuid_generate_v4(),'https://reserv.example');
 PERFORM replace_workspace_state('payment-test',3,jsonb_set(original,'{bookings,1,status}','"Cancelled"'));
 result := settle_checkout((b->>'id')::uuid,'txn-b',1000000,'NGN',false);
 IF NOT (result->>'needs_review')::boolean THEN RAISE EXCEPTION 'late payment not flagged'; END IF;
 SELECT state INTO doc FROM workspace_state WHERE business_id='payment-test';
 IF doc->'bookings'->1->>'status'<>'Cancelled' THEN RAISE EXCEPTION 'late payment reactivated cancellation'; END IF;
 -- Same durable key returns the original paid attempt, even after a later balance is due.
 b := reserve_checkout('ABCDEFGHIJKL','paystack',false,'deposit','a@example.test','aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa','https://reserv.example');
 IF a->>'id' <> b->>'id' THEN RAISE EXCEPTION 'idempotent retry created another charge'; END IF;
 PERFORM adjust_checkout((a->>'id')::uuid,'refund-one','refund',100000);
 PERFORM adjust_checkout((a->>'id')::uuid,'refund-one','refund',100000);
 PERFORM adjust_checkout((a->>'id')::uuid,'refund-two','refund',50000);
 SELECT state INTO doc FROM workspace_state WHERE business_id='payment-test';
 IF (doc->'payments'->0->>'refundedAmount')::numeric<>1500 THEN RAISE EXCEPTION 'refund deduplication failed'; END IF;
 IF doc->'bookings'->0->>'status'<>'Pending' THEN RAISE EXCEPTION 'refunded booking still confirmed'; END IF;
 PERFORM adjust_checkout((a->>'id')::uuid,'dispute-one','dispute',0);
 SELECT state INTO doc FROM workspace_state WHERE business_id='payment-test';
 IF NOT (doc->'payments'->0->>'disputed')::boolean THEN RAISE EXCEPTION 'dispute missing'; END IF;
 BEGIN
  PERFORM reserve_checkout('ABCDEFGHIJKL','paystack',false,'full','a@example.test',uuid_generate_v4(),'https://reserv.example');
  RAISE EXCEPTION 'refunded booking invited second charge' USING ERRCODE='XX000';
 EXCEPTION WHEN raise_exception THEN NULL; END;
 BEGIN
  PERFORM replace_workspace_state('payment-test',(SELECT revision FROM workspace_state WHERE business_id='payment-test'),jsonb_set(doc,'{payments,0,refundedAmount}','0'));
  RAISE EXCEPTION 'refund was editable by owner' USING ERRCODE='XX000';
 EXCEPTION WHEN raise_exception THEN NULL; END;
END $$;
ROLLBACK;
