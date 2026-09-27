import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';

process.env.NODE_ENV = 'test';
for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'AETHEX_API_KEY']) delete process.env[key];
process.env.JWT_SECRET = 'test-secret-not-used-outside-tests';
const { workspaces } = await import('../dist/services/workspaces.js');
const { initialState } = await import('../dist/domain/workspace.js');
const { aethex } = await import('../dist/lib/aethex.js');
const { db } = await import('../dist/services/dbService.js');
const { default: callsRouter } = await import('../dist/routes/calls.js');

test('manual dispatch uses saved customer details, protects call context and isolates practice calls', async () => {
  const state = initialState({ name: 'Saved Studio', owner: 'Owner', category: 'Beauty', phone: '08031112222', address: '12 Admiralty Way', serviceName: 'Saved Service', duration: 30, price: 5000 });
  state.business.voice = { country: 'NG', status: 'active', number: '+2342010000000', agentId: 'agent-saved' };
  state.customers.push({ id: 'customer', name: 'Saved Customer', phone: '+2348035550000', notes: '' });
  const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  state.bookings.push({ id: 'booking', code: 'AAAABBBBCCCC', businessId: state.business.id, customerId: 'customer', serviceId: state.services[0].id, staffId: state.staff[0].id, startTime: `${day}T10:00:00`, endTime: `${day}T10:30:00`, createdAt: new Date().toISOString(), status: 'Pending', notes: '', totalAmount: 5000, requiredAmount: 5000, activity: [] });
  const email = 'owner@example.test', ownerId = `usr_${createHash('sha256').update(email).digest('hex')}`;
  await workspaces.create(ownerId, state);
  const token = jwt.sign({ id: ownerId, email, role: 'owner' }, process.env.JWT_SECRET);
  const calls = [];
  const originalTrigger = aethex.triggerCall, originalSave = db.createCall;
  aethex.triggerCall = async params => { calls.push(params); return { id: 'provider-call', agent_id: params.agentId, direction: 'outbound', from_number: params.fromNumber, to_number: params.toNumber, status: 'queued', created_at: new Date().toISOString() }; };
  db.createCall = async record => record;
  const app = express(); app.use(express.json()); app.use('/calls', callsRouter);
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  async function dispatch(body, expected = 202) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/calls/trigger`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-workspace-id': state.business.id }, body: JSON.stringify(body) });
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  }
  try {
    await dispatch({ bookingId: 'booking', toNumber: '08035550000', customerName: 'Stale name', serviceName: 'Stale service', appointmentDate: 'Yesterday', callType: 'reminder', customPromptVariables: { opening_message: 'Wrong greeting', test_call: true, transfer_available: true } });
    assert.equal(calls[0].dynamicVariables.customer_name, 'Saved Customer');
    assert.equal(calls[0].dynamicVariables.service_name, 'Saved Service');
    assert.match(calls[0].dynamicVariables.opening_message, /Saved Customer/);
    assert.equal(calls[0].dynamicVariables.test_call, false);
    assert.equal(calls[0].dynamicVariables.transfer_available, undefined);
    await dispatch({ bookingId: 'booking', toNumber: '+2348039999999' }, 409);
    await dispatch({ toNumber: 'invalid' }, 400);
    await dispatch({ toNumber: '+2348035550000', callType: 'confirmation' }, 400);
    await dispatch({ bookingId: 'booking', toNumber: '+2348035550000', testCall: true }, 400);
    await dispatch({ toNumber: '+2348035550000', testCall: true, customerName: 'Test Person', serviceName: 'Example Service', appointmentDate: 'Tomorrow', appointmentTime: '10:30 AM' });
    assert.equal(calls[1].dynamicVariables.test_call, true);
    assert.equal(calls[1].metadata.test_call, true);
    assert.equal(calls[1].dynamicVariables.booking_code, 'not provided');
    await dispatch({ toNumber: '+2348035550000', callType: 'manual' });
    assert.equal(calls[2].dynamicVariables.appointment_date, 'not provided');
    db.createCall = async () => { throw new Error('History unavailable'); };
    const accepted = await dispatch({ toNumber: '+2348035550000', callType: 'manual' });
    assert.match(accepted.message, /Call queued.*do not place it again/);
    const snapshot = await workspaces.read(state.business.id);
    snapshot.state.customers[0].voiceCallsBlocked = true;
    await workspaces.save(state.business.id, snapshot.revision, snapshot.state);
    await dispatch({ bookingId: 'booking', toNumber: '+2348035550000' }, 409);
    assert.equal(calls.length, 4, 'rejected requests must not reach the provider');
  } finally {
    aethex.triggerCall = originalTrigger; db.createCall = originalSave;
    await new Promise(resolve => server.close(resolve));
  }
});
