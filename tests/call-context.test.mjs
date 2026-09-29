import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState } from '../dist/domain/workspace.js';
import { agentSettings, SYSTEM_PROMPT } from '../dist/services/voiceAgent.js';
import { bookingCallContext, outboundOpening } from '../dist/services/callContext.js';

function fixture() {
  const state = initialState({ name: 'Bloom Studio', owner: 'Owner', category: 'Beauty', phone: '08031112222', address: '12 Admiralty Way', serviceName: 'Classic Cut', duration: 30, price: 5000 });
  state.customers.push({ id: 'customer', name: 'Ada Okafor', phone: '08035550000', notes: '' });
  state.bookings.push({ id: 'booking', code: 'AAAABBBBCCCC', businessId: state.business.id, customerId: 'customer', serviceId: state.services[0].id, startTime: '2026-10-05T23:30:00Z', status: 'Pending' });
  return state;
}
const now = Date.parse('2026-10-01T12:00:00Z');

test('the provider opener switches per call without changing the inbound agent defaults', () => {
  const state = fixture();
  const settings = agentSettings(state);
  const render = vars => settings.first_message.replace(/{{(\w+)}}/g, (_, key) => vars[key]);
  assert.equal(render(settings.dynamic_variables), 'Hello, thank you for calling Bloom Studio. How can I help you today?');
  for (const callType of ['reminder', 'confirmation', 'unpaid_checkin', 'manual']) {
    const call = bookingCallContext(state, state.bookings[0], callType, now);
    const variables = { ...settings.dynamic_variables, ...call.dynamicVariables };
    assert.equal(render(variables), 'Hello, this is the virtual receptionist calling from Bloom Studio. Am I speaking with Ada Okafor?');
    assert.doesNotMatch(render(variables), /Classic Cut|October|paid|AAAABBBBCCCC|How can I help|thank you for calling/);
    assert.equal(variables.call_type, callType);
    assert.equal(variables.appointment_date, 'Tuesday, 6 October 2026');
    assert.equal(variables.appointment_time, '12:30 AM');
    assert.equal(call.toNumber, '+2348035550000');
    for (const [, variable] of SYSTEM_PROMPT.matchAll(/{{(\w+)}}/g)) assert.ok(variable in variables, `Missing prompt variable: ${variable}`);
  }
  assert.equal(settings.dynamic_variables.call_type, 'inbound');
  for (const [, variable] of SYSTEM_PROMPT.matchAll(/{{(\w+)}}/g)) assert.ok(variable in settings.dynamic_variables, `Missing inbound default: ${variable}`);
  assert.match(SYSTEM_PROMPT, /Call type: {{call_type}}/);
  assert.match(outboundOpening('Bloom Studio'), /May I ask who I'm speaking with/);
});

test('outbound booking context rejects completed, cancelled, past and opted-out bookings', () => {
  const state = fixture(), booking = state.bookings[0];
  for (const status of ['Completed', 'Cancelled']) {
    booking.status = status;
    assert.throws(() => bookingCallContext(state, booking, 'reminder', now), /upcoming, active/);
  }
  booking.status = 'Confirmed';
  assert.throws(() => bookingCallContext(state, booking, 'reminder', now + 10 * 86400000), /upcoming, active/);
  state.customers.push({ id: 'other', name: 'Another profile', phone: '+2348035550000', voiceCallsBlocked: true });
  assert.throws(() => bookingCallContext(state, booking, 'reminder', now), /asked not to receive calls/);
});

test('transfer configuration disables missing and self-referencing destinations', () => {
  const state = fixture();
  state.business.voice = { status: 'active', number: '+2348031112222' };
  assert.equal(agentSettings(state).transfer_phone_number, null);
  assert.equal(agentSettings(state).dynamic_variables.transfer_available, false);
  state.business.phone = '';
  assert.equal(agentSettings(state).transfer_phone_number, null);
});

test('business facts and dial-time booking details are preloaded so answers need no tool call', () => {
  const state = fixture();
  state.business.faqs = [{ question: 'Is there parking?', answer: 'Yes, behind the building.' }];
  const settings = agentSettings(state);
  assert.match(settings.dynamic_variables.business_profile, /12 Admiralty Way/);
  assert.match(settings.dynamic_variables.business_profile, /Is there parking\? Answer: Yes, behind the building\./);
  assert.match(settings.dynamic_variables.services_catalog, /Classic Cut: ₦5,000, 30 minutes/);
  assert.equal(settings.soft_timeout_seconds, 6);
  assert.equal(settings.voice_id, undefined);
  state.business.voice = { status: 'active', voiceId: 'chosen-voice' };
  assert.equal(agentSettings(state).voice_id, 'chosen-voice');
  const call = bookingCallContext(state, state.bookings[0], 'unpaid_checkin', now);
  assert.match(call.dynamicVariables.booking_details, /Status Pending; .*total price ₦5,000; .*paid ₦0/);
  assert.equal(call.dynamicVariables.current_time, 'Thursday 1 October, 1:00 PM');
});
