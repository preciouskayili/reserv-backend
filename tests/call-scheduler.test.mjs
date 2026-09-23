import { test } from "node:test";
import assert from "node:assert/strict";
import { initialState } from "../dist/domain/workspace.js";
import {
  isCallDue,
  runCallReminders,
  bookingTime,
} from "../dist/services/callScheduler.js";

const now = Date.parse("2026-09-21T10:00:00Z");

function fixture() {
  const state = initialState({
    name: "Studio",
    owner: "Test Owner",
    category: "Wellness",
    phone: "+2348000000000",
    address: "Test address",
    serviceName: "Consultation",
    duration: 45,
    price: 5000,
  });
  state.business.voice = {
    country: "US",
    status: "active",
    number: "+18022101485",
    agentId: "agent",
  };
  state.settings.calls = {
    enabled: false,
    reminderMinutes: 120,
    unpaidEnabled: true,
    unpaidIntervalMinutes: 60,
  };
  state.customers.push({
    id: "customer",
    name: "Customer",
    phone: "+2348000000000",
    notes: "",
  });
  state.bookings.push({
    id: "booking",
    businessId: state.business.id,
    code: "ABCDEFGHIJKL",
    customerId: "customer",
    serviceId: state.services[0].id,
    staffId: state.staff[0].id,
    startTime: "2026-09-21T12:00:00",
    endTime: "2026-09-21T12:45:00",
    createdAt: "2026-09-21T08:00:00Z",
    totalAmount: 5000,
    requiredAmount: 2000,
    status: "Pending",
    notes: "",
    activity: [],
  });
  return state;
}

test("unpaid calls are independent, wait for their interval, and stop at the required payment", () => {
  const state = fixture(),
    booking = state.bookings[0];
  assert.equal(isCallDue(state, booking, "reminder", now), false);
  assert.equal(isCallDue(state, booking, "unpaid_checkin", now), true);
  assert.equal(
    isCallDue(state, booking, "unpaid_checkin", now, {
      created_at: "2026-09-21T09:30:00Z",
    }),
    false,
  );
  state.payments.push({
    id: "payment",
    bookingId: booking.id,
    amount: 2000,
    status: "review",
    method: "transfer",
    createdAt: new Date(now).toISOString(),
  });

  assert.equal(isCallDue(state, booking, "unpaid_checkin", now), false);
  state.payments[0].status = "approved";
  assert.equal(isCallDue(state, booking, "unpaid_checkin", now), false);
  state.payments[0].refundedAmount = 1000;
  assert.equal(isCallDue(state, booking, "unpaid_checkin", now), true);
  booking.status = "Cancelled";
  assert.equal(isCallDue(state, booking, "unpaid_checkin", now), false);
  booking.status = "Completed";
  assert.equal(isCallDue(state, booking, "unpaid_checkin", now), false);
  booking.status = "Pending";
  assert.equal(
    isCallDue(state, booking, "unpaid_checkin", now + 3600000),
    false,
  );
});

test("wall-time and explicit timezone timestamps are handled consistently", () => {
  assert.equal(bookingTime("2026-09-21T11:00:00"), now);
  assert.equal(bookingTime("2026-09-21T11:00:00+01:00"), now);
  assert.equal(bookingTime("2026-09-21T10:00:00Z"), now);
});

function harness(state) {
  const claims = new Map(),
    calls = [],
    records = [];
  let clock = now;
  const deps = {
    now: () => clock,
    all: async () => [{ state: structuredClone(state) }],
    read: async () => ({ state: structuredClone(state) }),
    lastDispatch: async () =>
      [...claims.values()]
        .filter((c) => c.appointment_time.startsWith("dispatch:"))
        .at(-1) ?? null,
    lastUnpaid: async () =>
      [...claims.values()]
        .filter((c) => c.appointment_time.startsWith("unpaid:"))
        .at(-1) ?? null,
    claim: async (claim) => {
      const key = JSON.stringify(claim);
      if (claims.has(key)) return false;
      claims.set(key, { ...claim, created_at: new Date(clock).toISOString() });
      return true;
    },
    trigger: async (params) => {
      calls.push(params);
      return {
        id: `call-${calls.length}`,
        agent_id: "agent",
        direction: "outbound",
        from_number: "+18022101485",
        to_number: params.toNumber,
        status: "queued",
        created_at: new Date(clock).toISOString(),
      };
    },
    save: async (record) => {
      records.push(record);
    },
  };
  return {
    deps,
    claims,
    calls,
    records,
    advance: (value) => {
      clock += value;
    },
  };
}
test("concurrent workers dispatch once and repeat only after the configured interval", async () => {
  const state = fixture();
  state.bookings[0].startTime = "2026-09-23T12:00:00";
  const h = harness(state);
  await Promise.all([runCallReminders(h.deps), runCallReminders(h.deps)]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].dynamicVariables.call_type, "unpaid_checkin");
  assert.equal(h.records[0].call_type, "unpaid_checkin");
  await runCallReminders(h.deps);
  assert.equal(h.calls.length, 1);
  h.advance(3600000);
  await runCallReminders(h.deps);
  assert.equal(h.calls.length, 2);
});
test("provider timeouts retain claims and do not cause an immediate retry", async () => {
  const h = harness(fixture());
  let attempts = 0;
  h.deps.trigger = async () => {
    attempts++;
    throw new Error("Timeout");
  };
  const result = await runCallReminders(h.deps);
  assert.equal(result.failed, 1);
  await runCallReminders(h.deps);
  assert.equal(attempts, 1);
});
test("a newly observed payment or cancellation stops an already claimed call", async () => {
  for (const change of ["payment", "cancel"]) {
    const state = fixture(),
      h = harness(state);
    h.deps.read = async () => {
      const current = structuredClone(state);
      if (change === "cancel") current.bookings[0].status = "Cancelled";
      else
        current.payments.push({
          bookingId: "booking",
          amount: 2000,
          status: "approved",
        });
      return { state: current };
    };
    await runCallReminders(h.deps);
    assert.equal(h.calls.length, 0);
  }
});
test("a reminder and unpaid call never dispatch together in the same tick", async () => {
  const state = fixture();
  state.settings.calls.enabled = true;
  const h = harness(state);
  await runCallReminders(h.deps);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].dynamicVariables.call_type, "reminder");
});

test("concurrent reminder and unpaid workers share a dispatch lock", async () => {
  const state = fixture();
  state.settings.calls.enabled = true;
  const h = harness(state);
  await Promise.all([runCallReminders(h.deps), runCallReminders(h.deps)]);
  assert.equal(h.calls.length, 1);
  await runCallReminders(h.deps);
  assert.equal(h.calls.length, 1);
});
