// Creates an isolated local PostgreSQL cluster. Never reads app database credentials.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'reserv-checkout-db-'));
const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port; await new Promise(r => probe.close(r));
const args = ['-h','127.0.0.1','-p',String(port),'-d','postgres','-v','ON_ERROR_STOP=1','-At'];
const sql = async text => (await exec('psql', [...args, '-c', text])).stdout.trim();
let started = false;
try {
  await exec('initdb', ['-D',directory,'-A','trust','--no-locale']);
  await exec('pg_ctl', ['-D',directory,'-l',join(directory,'server.log'),'-o',`-p ${port} -h 127.0.0.1`,'start']); started = true;
  await sql('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  await exec('psql', [...args,'-f','supabase/full_schema.sql']);
  await exec('psql', [...args,'-f','supabase/full_schema.sql']);
  await exec('psql', [...args,'-f','tests/sql/checkout.sql']);
  const state = { business: { id: 'concurrent', name: 'Concurrent', slug: 'concurrent', owner: 'Owner', category: 'Beauty', phone: '+2348000000000', address: 'Abuja' }, payments: [], bookings: [{ id: 'booking-one', code: 'ABCDABCDABCD', status: 'Pending', totalAmount: 100, requiredAmount: 100, activity: [] }] };
  await sql(`SELECT create_workspace('owner','${JSON.stringify(state)}'::jsonb); SELECT replace_workspace_state('concurrent',1,'${JSON.stringify(state)}'::jsonb);`);
  const reserve = "SELECT reserve_checkout('ABCDABCDABCD','paystack',false,'full','test@example.test',uuid_generate_v4(),'https://reserv.example')->>'id'";
  const ids = await Promise.all(Array.from({ length: 8 }, () => sql(reserve)));
  assert.equal(new Set(ids).size, 1, 'concurrent clicks created separate attempts');
  await Promise.all(Array.from({ length: 8 }, () => sql(`SELECT settle_checkout('${ids[0]}','txn-concurrent',10000,'NGN',false)`)));
  assert.equal(await sql("SELECT jsonb_array_length(state->'payments') FROM workspace_state WHERE business_id='concurrent'"), '1');
  assert.equal(await sql("SELECT revision FROM workspace_state WHERE business_id='concurrent'"), '3', 'duplicate callbacks changed revision');
  assert.equal(await sql("SELECT has_function_privilege('anon','public.settle_checkout(uuid,text,bigint,text,boolean)','EXECUTE')"), 'f');
  assert.equal(await sql("SELECT has_function_privilege('authenticated','public.reserve_checkout(text,text,boolean,text,text,uuid,text)','EXECUTE')"), 'f');
  process.stdout.write('PASS: repeat migration, payment invariants, refund deduplication, 8 concurrent starts, 8 concurrent settlements, function permissions.\n');
} finally {
  if (started) await exec('pg_ctl', ['-D',directory,'stop','-m','fast']);
  await rm(directory, { recursive: true, force: true });
}
