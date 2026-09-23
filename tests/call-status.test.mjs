import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCallStatusRefresher } from '../dist/services/callStatus.js';
import { DatabaseService } from '../dist/services/dbService.js';

const call = { id: 'local', business_id: 'business', aethex_call_id: 'remote', status: 'queued' };
test('call history repairs busy calls and preserves zero duration and cost', async () => {
  let saved;
  const refresh = createCallStatusRefresher({
    get: async () => ({ id: 'remote', status: 'busy', duration_seconds: 0, cost_cents: 0 }),
    save: async (_id, update) => (saved = { ...call, ...update }),
  });
  assert.equal((await refresh(call)).status, 'busy');
  assert.equal(saved.duration_seconds, 0);
  assert.equal(saved.cost_cents, 0);
});
test('connected calls refresh, concurrent polls coalesce, and terminal calls do not poll', async () => {
  let reads = 0;
  const refresh = createCallStatusRefresher({
    get: async () => { reads++; await new Promise(resolve => setTimeout(resolve, 5)); return { id: 'remote', status: 'completed', duration_seconds: 50 }; },
    save: async (_id, update) => ({ ...call, ...update }),
  });
  const [first, second] = await Promise.all([refresh({ ...call, status: 'connected' }), refresh(call)]);
  assert.equal(first.status, 'completed');
  assert.deepEqual(first, second);
  assert.equal(reads, 1);
  await refresh(first);
  assert.equal(reads, 1);
});
test('provider outages and mismatched IDs keep stored history intact', async () => {
  for (const get of [async () => { throw new Error('offline'); }, async () => null, async () => ({ id: 'someone-else', status: 'completed' })]) {
    const refresh = createCallStatusRefresher({ get, save: async () => assert.fail('must not update') });
    assert.deepEqual(await refresh(call), call);
  }
});
test('an older poll cannot overwrite a terminal webhook result', async () => {
  const db = new DatabaseService();
  await db.createCall({ ...call, id: 'race', status: 'completed' });
  const result = await db.updateCall('race', { status: 'ringing' }, 'id', true);
  assert.equal(result.status, 'completed');
});
