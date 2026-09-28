import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, HttpError } from '../dist/domain/workspace.js';
import { provisionBusinessNumber, requestBusinessNumber } from '../dist/services/businessVoice.js';
import { workspaces } from '../dist/services/workspaces.js';

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
    numberElsewhere: async () => undefined,
  };
  return { deps, id: snapshot.state.business.id, snapshot: () => snapshot, counts: () => ({ purchases, agents, registrations }) };
}
test('repeated setup requests retain the business number and reject country changes after purchase', async () => {
  const h = fixture();
  await provisionBusinessNumber(h.id, h.deps);
  const read = mock.method(workspaces, 'read', h.deps.read);
  const save = mock.method(workspaces, 'save', h.deps.save);
  const network = mock.method(globalThis, 'fetch', async () => { throw new Error('Existing phone setup must not contact providers'); });
  try {
    for (const status of ['active', 'needs_review', 'failed']) {
      const snapshot = await h.deps.read(h.id);
      snapshot.state.business.voice.status = status;
      await h.deps.save(h.id, snapshot.revision, snapshot.state);
      const revision = h.snapshot().revision;
      const results = await Promise.all(Array.from({ length: 8 }, () => requestBusinessNumber(h.id, 'US')));
      assert.ok(results.every(result => result.state.business.voice.twilioSid === 'twilio-number'));
      assert.equal(h.snapshot().revision, revision);
      await assert.rejects(requestBusinessNumber(h.id, 'GB'), error => error instanceof HttpError && error.status === 409);
      assert.equal(h.snapshot().state.business.voice.country, 'US');
    }
    assert.equal(network.mock.callCount(), 0);
    assert.equal(save.mock.callCount(), 0);
    assert.equal(h.counts().purchases, 1);
  } finally {
    read.mock.restore(); save.mock.restore(); network.mock.restore();
  }
});
test('existing purchased numbers finish registration without permitting new purchases', async () => {
  const h = fixture();
  const snapshot = await h.deps.read(h.id);
  Object.assign(snapshot.state.business.voice, { agentId: 'existing-agent', twilioSid: 'existing-number', number: '+12025550123', status: 'needs_review' });
  await h.deps.save(h.id, snapshot.revision, snapshot.state);
  await provisionBusinessNumber(h.id, h.deps);
  assert.equal(h.snapshot().state.business.voice.status, 'active');
  assert.deepEqual(h.counts(), { purchases: 0, agents: 0, registrations: 1 });
});
test('concurrent provisioning purchases exactly one dedicated number and agent', async () => {
  const h = fixture();
  await Promise.all(Array.from({ length: 8 }, () => provisionBusinessNumber(h.id, h.deps)));
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

test('active agents receive the new opener once and unchanged configurations do not repeat provider writes', async () => {
  const { syncBusinessAgent } = await import('../dist/services/businessVoice.js');
  const { agentFingerprint } = await import('../dist/services/voiceAgent.js');
  const h = fixture();
  await provisionBusinessNumber(h.id, h.deps);
  const requests = [];
  const api = { request: async (path, method, body) => { requests.push({ path, method, body }); return []; } };
  assert.equal(await syncBusinessAgent(h.id, h.deps, api), true);
  assert.equal(requests[0].body.first_message, '{{opening_message}}');
  assert.equal(h.snapshot().state.business.voice.agentConfig, agentFingerprint(h.snapshot().state));
  const count = requests.length;
  assert.equal(await syncBusinessAgent(h.id, h.deps, api), true);
  assert.equal(requests.length, count);
  const changed = await h.deps.read(h.id);
  changed.state.business.name = 'Renamed Studio';
  await h.deps.save(h.id, changed.revision, changed.state);
  assert.equal(await syncBusinessAgent(h.id, h.deps, api), true);
  assert.match(requests[count].body.dynamic_variables.opening_message, /Renamed Studio/);
});

test('a provider sync failure does not mark the business agent as up to date', async () => {
  const { syncBusinessAgent } = await import('../dist/services/businessVoice.js');
  const h = fixture();
  await provisionBusinessNumber(h.id, h.deps);
  assert.equal(await syncBusinessAgent(h.id, h.deps, { request: async () => { throw new Error('Provider unavailable'); } }), false);
  assert.equal(h.snapshot().state.business.voice.agentConfig, undefined);
});

test('a chosen voice is validated, saved without touching other phone state, and changes the agent fingerprint', async () => {
  const { chooseAgentVoice } = await import('../dist/services/businessVoice.js');
  const { agentFingerprint } = await import('../dist/services/voiceAgent.js');
  const h = fixture();
  await provisionBusinessNumber(h.id, h.deps);
  const catalog = async () => ({ voices: [{ id: 'kemi', name: 'Kemi', gender: 'female', tags: [] }] });
  const before = agentFingerprint(h.snapshot().state);
  await assert.rejects(chooseAgentVoice(h.id, 'unknown', h.deps, catalog), error => error instanceof HttpError && error.status === 400);
  await chooseAgentVoice(h.id, 'kemi', h.deps, catalog);
  const voice = h.snapshot().state.business.voice;
  assert.equal(voice.voiceId, 'kemi');
  assert.equal(voice.status, 'active');
  assert.notEqual(agentFingerprint(h.snapshot().state), before);
  const empty = fixture();
  const state = await empty.deps.read(empty.id);
  delete state.state.business.voice;
  await empty.deps.save(empty.id, state.revision, state.state);
  await assert.rejects(chooseAgentVoice(empty.id, 'kemi', empty.deps, catalog), error => error instanceof HttpError && error.status === 409);
});

test('a failed agent creation is retried instead of sticking in review', async () => {
  const h = fixture(); let attempts = 0;
  h.deps.createAgent = async () => { attempts++; if (attempts === 1) throw new Error('Provider rejected the agent'); return 'agent'; };
  await provisionBusinessNumber(h.id, h.deps);
  assert.equal(h.snapshot().state.business.voice.status, 'failed');
  const retry = await h.deps.read(h.id);
  retry.state.business.voice.status = 'queued';
  await h.deps.save(h.id, retry.revision, retry.state);
  await provisionBusinessNumber(h.id, h.deps);
  assert.equal(h.snapshot().state.business.voice.status, 'active');
  assert.equal(attempts, 2);
});

test('no number is bought when the owner account already has one on another workspace', async () => {
  const h = fixture();
  h.deps.numberElsewhere = async () => 'Kingz Cuts';
  await provisionBusinessNumber(h.id, h.deps);
  const voice = h.snapshot().state.business.voice;
  assert.equal(h.counts().purchases, 0);
  assert.equal(voice.status, 'failed');
  assert.equal(voice.purchaseStarted, undefined);
  assert.match(voice.error, /already has a business number on Kingz Cuts/);
});

test('a rejected webhook does not stop the prompt and tools from reaching the agent', async () => {
  process.env.AETHEX_PUBLIC_WEBHOOK_URL = 'https://reserv.example/api/calls/webhook';
  process.env.VOICE_TOOLS_SECRET = 'test-secret';
  try {
    const { syncAgent } = await import('../dist/services/voiceAgent.js');
    const h = fixture();
    const requests = [];
    const api = { request: async (path, method, body) => {
      requests.push({ path, method, body });
      if (body && 'webhook_url' in body) throw new Error('Create a webhook signing secret first');
      return [];
    } };
    await assert.rejects(syncAgent(api, 'agent', h.snapshot().state), /signing secret/);
    assert.equal(requests[0].method, 'PATCH');
    assert.equal('webhook_url' in requests[0].body, false);
    assert.ok(requests.filter(r => r.method === 'POST' && r.path.endsWith('/tools')).length > 5, 'tools registered before the webhook');
    assert.deepEqual(requests.at(-1).body, { webhook_url: 'https://reserv.example/api/calls/webhook' });
  } finally {
    delete process.env.AETHEX_PUBLIC_WEBHOOK_URL; delete process.env.VOICE_TOOLS_SECRET;
  }
});
