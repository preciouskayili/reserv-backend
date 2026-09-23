import { test } from 'node:test';
import assert from 'node:assert/strict';

// Isolated in-memory workspaces; nothing contacts the voice provider or the database.
process.env.NODE_ENV = 'test';
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'AETHEX_API_KEY']) delete process.env[key];
process.env.VOICE_TOOLS_SECRET = 'v'.repeat(40);
process.env.AETHEX_PUBLIC_WEBHOOK_URL = 'https://api.example.test/api/calls/webhook';

const { initialState } = await import('../dist/domain/workspace.js');
const { workspaces } = await import('../dist/services/workspaces.js');
const { runVoiceTool } = await import('../dist/services/voiceTools.js');
const { createCallVerifier } = await import('../dist/routes/voiceTools.js');
const { syncAgent, toolDefinitions, toolKey, verifyToolKey, agentFingerprint } = await import('../dist/services/voiceAgent.js');
const { callEventUpdate } = await import('../dist/routes/callWebhook.js');

async function business(name = 'Voice Studio') {
  const state = initialState({ name, owner: 'Ada Owner', category: 'Beauty', phone: '08031112222', address: '12 Admiralty Way, Lekki', serviceName: 'Classic Cut', duration: 60, price: 10000 });
  state.business.hours = state.business.hours.map(h => ({ ...h, open: '09:00', close: '17:00', closed: false }));
  state.services[0].deposit = 4000;
  state.business.voice = { country: 'NG', status: 'active', number: '+2342010000000', agentId: `agent-${state.business.id}` };
  const snapshot = await workspaces.create(`user-${state.business.id}`, state);
  return snapshot.state.business.id;
}
// Two days ahead in WAT keeps the time inside the notice and advance-booking windows.
const day = new Date(Date.now() + 3600000 + 2 * 86400000).toISOString().slice(0, 10);

test('a caller can ask about the business, check times, book, reschedule, check payment and cancel', async () => {
  const businessId = await business();
  const caller = { businessId, callId: 'call-1', direction: 'inbound', customerPhone: '+2348035550000' };
  const info = await runVoiceTool('get_business_info', caller, {});
  assert.equal(info.address, '12 Admiralty Way, Lekki');
  assert.match(info.current_local_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal((await runVoiceTool('list_services', caller, {})).services[0].price, '₦10,000');

  const open = await runVoiceTool('check_availability', caller, { service: 'classic', date: day });
  assert.equal(open.open_times[0].start_time, `${day}T09:00`);
  assert.ok((await runVoiceTool('check_availability', caller, { service: 'Classic Cut' })).next_openings.length > 0);
  assert.equal((await runVoiceTool('check_availability', caller, { service: 'Classic Cut', date: day, earliest_time: '15:00' })).open_times[0].start_time, `${day}T15:00`);

  const booked = await runVoiceTool('create_booking', caller, { service: 'Classic Cut', start_time: `${day}T10:00`, customer_name: 'Tolu Caller' });
  assert.equal(booked.booked, true, JSON.stringify(booked));
  assert.equal(booked.payment.outstanding_to_secure_booking, '₦4,000');
  const code = booked.booking_reference;

  // The slot is taken and no longer offered; a second booking at that time is refused.
  assert.ok(!(await runVoiceTool('check_availability', caller, { service: 'Classic Cut', date: day })).open_times.some(s => s.start_time === `${day}T10:00`));
  assert.match((await runVoiceTool('create_booking', caller, { service: 'Classic Cut', start_time: `${day}T10:00`, customer_name: 'Someone Else' })).error, /not available/);

  // Local and international formats of the same number find the booking.
  const mine = await runVoiceTool('find_my_bookings', { ...caller, customerPhone: '08035550000' }, {});
  assert.deepEqual(mine.bookings.map(b => b.booking_reference), [code]);
  assert.equal((await runVoiceTool('find_my_bookings', { ...caller, customerPhone: '+2348099999999' }, {})).bookings.length, 0);

  const moved = await runVoiceTool('reschedule_booking', caller, { booking_reference: code.replace(/(.{4})/g, '$1 ').toLowerCase(), new_start_time: `${day}T13:00` });
  assert.equal(moved.rescheduled, true, JSON.stringify(moved));
  assert.equal(moved.start_time, `${day}T13:00`);
  assert.equal((await runVoiceTool('get_payment_status', caller, { booking_reference: code })).amount_paid, '₦0');
  assert.equal((await runVoiceTool('confirm_attendance', caller, { booking_reference: code })).confirmed, true);
  assert.equal((await runVoiceTool('cancel_booking', caller, { booking_reference: code })).cancelled, true);
  assert.match((await runVoiceTool('cancel_booking', caller, { booking_reference: code })).error, /can no longer be changed/);

  const { state } = await workspaces.read(businessId);
  const booking = state.bookings.find(b => b.code === code);
  assert.equal(booking.status, 'Cancelled');
  assert.ok(booking.activity.every(a => a.actor === 'agent'));
  assert.equal(state.customers.find(c => c.id === booking.customerId).phone, '+2348035550000');
  assert.deepEqual(state.agentActivity.map(a => a.title), ['Cancelled by phone', 'Attendance confirmed by phone', 'Rescheduled by phone', 'Booked by phone']);
});

test('tools explain invalid requests instead of guessing', async () => {
  const businessId = await business('Error Studio');
  const hidden = { businessId, callId: 'call-2', direction: 'inbound' };
  assert.match((await runVoiceTool('create_booking', hidden, { service: 'Classic Cut', start_time: `${day}T10:00`, customer_name: 'No Number' })).error, /number is hidden/);
  assert.match((await runVoiceTool('check_availability', hidden, { service: 'Massage' })).error, /Available services: Classic Cut/);
  assert.match((await runVoiceTool('check_availability', hidden, { service: 'Classic Cut', date: 'tomorrow' })).error, /YYYY-MM-DD/);
  assert.match((await runVoiceTool('cancel_booking', hidden, { booking_reference: 'AAAABBBBCCCC' })).error, /No booking/);
  assert.match((await runVoiceTool('create_booking', hidden, { service: 'Classic Cut', start_time: `${day}T10:07`, customer_name: 'Odd Time', phone: '+2348030000001' })).error, /not available/);
  assert.equal((await runVoiceTool('drop_tables', hidden, {})).error, 'Unknown tool');
});

test('tool requests must come from a live call on the business agent, with its own key', async () => {
  assert.equal(verifyToolKey('biz-1', toolKey('biz-1')), true);
  assert.equal(verifyToolKey('biz-2', toolKey('biz-1')), false);
  assert.equal(verifyToolKey('biz-1', undefined), false);
  let lookups = 0;
  const calls = {
    live: { id: 'live', agent_id: 'agent-a', direction: 'inbound', status: 'in-progress', from_number: '+2348030000000', to_number: '+2342010000000', metadata: {} },
    ended: { id: 'ended', agent_id: 'agent-a', direction: 'inbound', status: 'completed', from_number: '+2348030000000', to_number: '+2342010000000' },
    other: { id: 'other', agent_id: 'agent-b', direction: 'inbound', status: 'in-progress', from_number: '+2348030000000', to_number: '+2342010000000' },
    reminder: { id: 'reminder', agent_id: 'agent-a', direction: 'outbound', status: 'connected', from_number: '+2342010000000', to_number: '+2348031234567', metadata: { business_id: 'biz-a', booking_id: 'booking-1' } },
  };
  const verify = createCallVerifier({ agentFor: async id => (id === 'biz-a' ? 'agent-a' : undefined), findCall: async id => { lookups++; return calls[id] ?? null; }, now: Date.now });
  const ctx = await verify('biz-a', { call_id: 'live' });
  assert.equal(ctx.customerPhone, '+2348030000000');
  await verify('biz-a', { call_id: 'live' });
  assert.equal(lookups, 1, 'verified calls are cached');
  assert.equal(await verify('biz-a', { call_id: 'ended' }), null);
  assert.equal(await verify('biz-a', { call_id: 'other' }), null, 'another business agent cannot use these tools');
  assert.equal(await verify('biz-a', { call_id: 'missing' }), null);
  assert.equal(await verify('biz-a', { call_id: 'live-2', agent_id: 'agent-b' }), null);
  assert.equal(await verify('biz-unknown', { call_id: 'live' }), null);
  const outbound = await verify('biz-a', { call_id: 'reminder' });
  assert.deepEqual([outbound.customerPhone, outbound.bookingId], ['+2348031234567', 'booking-1']);
});

test('agent sync updates the prompt and tools, and removes only stale tools this app registered', async () => {
  const requests = [];
  const businessState = initialState({ name: 'Sync Studio', owner: 'Owner', category: 'Beauty', phone: '08031112222', address: 'Somewhere 1', serviceName: 'Cut', duration: 30, price: 0 });
  const api = { request: async (path, method = 'GET', body) => {
    requests.push({ path, method, body });
    if (method === 'GET') return [
      { id: 't1', name: 'list_services', endpoint_url: 'https://api.example.test/api/voice/tools/x/list_services' },
      { id: 't2', name: 'old_tool', endpoint_url: 'https://api.example.test/api/voice/tools/x/old_tool' },
      { id: 't3', name: 'crm_lookup', endpoint_url: 'https://crm.example.test/lookup' },
    ];
    return {};
  } };
  await syncAgent(api, 'agent-1', businessState.business);
  const agentPatch = requests.find(r => r.path === '/agents/agent-1' && r.method === 'PATCH').body;
  assert.equal(agentPatch.transfer_phone_number, '+2348031112222');
  assert.equal(agentPatch.webhook_url, 'https://api.example.test/api/calls/webhook');
  assert.match(agentPatch.system_prompt, /create_booking/);
  assert.equal(requests.filter(r => r.method === 'POST').length, toolDefinitions(businessState.business.id).length - 1);
  assert.ok(requests.some(r => r.method === 'PATCH' && r.path.endsWith('/tools/t1')));
  assert.deepEqual(requests.filter(r => r.method === 'DELETE').map(r => r.path), ['/agents/agent-1/tools/t2']);
  const tool = toolDefinitions(businessState.business.id)[0];
  assert.equal(tool.headers['X-Reserv-Tool-Key'], toolKey(businessState.business.id));
  assert.ok(tool.endpoint_url.startsWith(`https://api.example.test/api/voice/tools/${businessState.business.id}/`));
  const before = agentFingerprint(businessState.business);
  assert.notEqual(agentFingerprint({ ...businessState.business, phone: '08039998888' }), before, 'a new transfer number triggers a re-sync');
});

test('inbound call-ended events carry what is needed to create their call record', () => {
  const update = callEventUpdate('call.ended', { call_id: 'in-1', status: 'completed', direction: 'inbound', agent_id: 'agent-a', from_number: '+2348030000000', to_number: '+2342010000000', duration_seconds: 42 });
  assert.deepEqual(update.inbound, { agentId: 'agent-a', from: '+2348030000000', to: '+2342010000000', startedAt: undefined });
  assert.equal(callEventUpdate('call.ended', { call_id: 'out-1', status: 'completed', direction: 'outbound', agent_id: 'agent-a' }).inbound, undefined);
});
