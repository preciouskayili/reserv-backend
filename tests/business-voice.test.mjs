import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, HttpError } from '../dist/domain/workspace.js';
import { provisionBusinessNumber } from '../dist/services/businessVoice.js';

function fixture() {
  let snapshot = { revision: 1, state: initialState({ name: 'Test Studio', owner: 'Test Owner', category: 'Wellness', phone: '+2348000000000', address: 'Test address', serviceName: 'Consultation', duration: 30, price: 1000 }) };
  snapshot.state.business.voice = { country: 'US', status: 'queued' };
  let purchases = 0, agents = 0, registrations = 0;
  const deps = {
    read: async () => structuredClone(snapshot),
    save: async (_id, revision, state) => {
      if (revision !== snapshot.revision) throw new HttpError(409, 'Conflict');
      snapshot = { revision: revision + 1, state: structuredClone(state) };
      return structuredClone(snapshot);
    },
    findAgent: async () => undefined,
    createAgent: async () => { agents++; return 'agent'; },
    findNumber: async () => ({ number: '+12025550123', requiresVerification: false }),
    ownedNumber: async () => null,
    buyNumber: async number => { purchases++; return { number, sid: 'twilio-number' }; },
    register: async () => { registrations++; return 'aethex-number'; },
  };
  return { deps, id: snapshot.state.business.id, snapshot: () => snapshot, counts: () => ({ purchases, agents, registrations }) };
}
test('concurrent provisioning purchases exactly one dedicated number and agent', async () => {
  const h = fixture();
  await Promise.all([provisionBusinessNumber(h.id, h.deps), provisionBusinessNumber(h.id, h.deps)]);
  assert.equal(h.snapshot().state.business.voice.status, 'active');
  assert.deepEqual(h.counts(), { purchases: 1, agents: 1, registrations: 1 });
  await provisionBusinessNumber(h.id, h.deps);
  assert.equal(h.counts().purchases, 1);
});
test('an ambiguous purchase is not repeated and can reconcile the already-owned number', async () => {
  const h = fixture(); let attempts = 0;
  h.deps.buyNumber = async () => { attempts++; throw new Error('Timeout after purchase'); };
  await provisionBusinessNumber(h.id, h.deps);
  assert.equal(h.snapshot().state.business.voice.status, 'needs_review');
  await provisionBusinessNumber(h.id, h.deps);
  assert.equal(attempts, 1);
  h.deps.ownedNumber = async number => ({ number, sid: 'owned' });
  await provisionBusinessNumber(h.id, h.deps);
  assert.equal(h.snapshot().state.business.voice.status, 'active');
  assert.equal(attempts, 1);
});
test('registration retries reuse the purchased number; verification requirements prevent purchase', async () => {
  const h = fixture();
  h.deps.register = async () => { throw new Error('Registration unavailable'); };
  await provisionBusinessNumber(h.id, h.deps);
  assert.equal(h.counts().purchases, 1);
  h.deps.register = async () => 'registered';
  await provisionBusinessNumber(h.id, h.deps);
  assert.equal(h.snapshot().state.business.voice.status, 'active');
  assert.equal(h.counts().purchases, 1);
  const regulated = fixture();
  regulated.deps.findNumber = async () => ({ number: '+12025550123', requiresVerification: true });
  await provisionBusinessNumber(regulated.id, regulated.deps);
  assert.equal(regulated.counts().purchases, 0);
  assert.match(regulated.snapshot().state.business.voice.error, /verification/);
});
