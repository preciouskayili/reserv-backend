import cron, { type ScheduledTask } from "node-cron";
import { randomUUID } from "node:crypto";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";
import {
  aethex,
  isAethexConfigured,
  type AethexTriggerCallParams,
  type AethexCallResponse,
} from "../lib/aethex.js";
import { workspaces } from "./workspaces.js";
import { db, type CallRecord } from "./dbService.js";
import type { AppState, Booking } from "../domain/model.js";
let scheduledTask: ScheduledTask | null = null;
let isJobRunning = false;
let lastRunStats: CheckRemindersResult | null = null;
export interface CheckRemindersResult {
  checked: number;
  dispatched: number;
  failed: number;
  durationMs: number;
  timestamp: string;
  skippedDueToConcurrency?: boolean;
  error?: string;
}
type CallType = "reminder" | "unpaid_checkin";
type Claim = {
  business_id: string;
  booking_id: string;
  appointment_time: string;
};
type PreviousClaim = { created_at: string };
export interface CallSchedulerDependencies {
  all: () => Promise<{ state: AppState }[]>;
  read: (id: string) => Promise<{ state: AppState }>;
  lastDispatch: (
    businessId: string,
    bookingId: string,
  ) => Promise<PreviousClaim | null>;
  lastUnpaid: (
    businessId: string,
    bookingId: string,
  ) => Promise<PreviousClaim | null>;
  claim: (claim: Claim) => Promise<boolean>;
  trigger: (params: AethexTriggerCallParams) => Promise<AethexCallResponse>;
  save: (call: CallRecord) => Promise<unknown>;
  now: () => number;
}
export function bookingTime(value: string): number {
  return Date.parse(
    /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}+01:00`,
  );
}
export function isCallDue(
  state: AppState,
  booking: Booking,
  type: CallType,
  now: number,
  lastUnpaid: PreviousClaim | null = null,
): boolean {
  const settings = state.settings.calls;
  const starts = bookingTime(booking.startTime);
  if (
    !settings ||
    !Number.isFinite(starts) ||
    starts <= now ||
    !["Confirmed", "Pending", "Needs confirmation", "Rescheduled"].includes(
      booking.status,
    )
  )
    return false;
  if (type === "reminder")
    return settings.enabled && starts - now <= settings.reminderMinutes * 60000;
  if (!settings.unpaidEnabled) return false;
  const payments = (state.payments ?? []).filter(
    (p) => p.bookingId === booking.id,
  );
  // Give staff time to review a submitted receipt before asking for payment again.
  if (payments.some((p) => p.status === "review")) return false;
  const paid = payments
    .filter((p) => p.status === "approved" && !p.disputed)
    .reduce(
      (sum, p) => sum + Math.max(0, p.amount - (p.refundedAmount ?? 0)),
      0,
    );
  const service = state.services.find((s) => s.id === booking.serviceId);
  const total = booking.totalAmount ?? service?.price ?? 0;
  const required =
    booking.requiredAmount ?? Math.min(total, service?.deposit || total);
  if (paid >= required) return false;
  const previous = bookingTime(lastUnpaid?.created_at ?? booking.createdAt);
  return (
    Number.isFinite(previous) &&
    now - previous >= settings.unpaidIntervalMinutes * 60000
  );
}
const liveDependencies: CallSchedulerDependencies = {
  all: () => workspaces.all(),
  read: (id) => workspaces.read(id),
  now: Date.now,
  async lastDispatch(businessId, bookingId) {
    const { data, error } = await getSupabase()
      .from("reminder_claims")
      .select("created_at")
      .eq("business_id", businessId)
      .eq("booking_id", bookingId)
      .like("appointment_time", "dispatch:%")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("Call dispatch storage is unavailable");
    return data;
  },
  async lastUnpaid(businessId, bookingId) {
    const { data, error } = await getSupabase()
      .from("reminder_claims")
      .select("created_at")
      .eq("business_id", businessId)
      .eq("booking_id", bookingId)
      .like("appointment_time", "unpaid:%")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("Follow-up storage is unavailable");
    return data;
  },
  async claim(value) {
    const { error } = await getSupabase().from("reminder_claims").insert(value);
    if (error?.code === "23505") return false;
    if (error) throw new Error("Reminder storage is unavailable");
    return true;
  },
  trigger: (params) => aethex.triggerCall(params),
  save: (call) => db.createCall(call),
};
// appointment_time is an opaque text deduplication key in the existing claims table.
// Reminder keys retain the appointment time; unpaid keys identify the previous attempt.
// Concurrent workers see the same predecessor and only one can claim the next attempt.
export async function runCallReminders(
  deps: CallSchedulerDependencies,
): Promise<CheckRemindersResult> {
  const start = deps.now();
  const result: CheckRemindersResult = {
    checked: 0,
    dispatched: 0,
    failed: 0,
    durationMs: 0,
    timestamp: new Date(start).toISOString(),
  };
  for (const { state } of await deps.all()) {
    if (state.business.voice?.status !== "active") continue;
    if (!state.settings.calls?.enabled && !state.settings.calls?.unpaidEnabled)
      continue;
    for (const booking of state.bookings) {
      if (
        !["Confirmed", "Pending", "Needs confirmation", "Rescheduled"].includes(
          booking.status,
        ) ||
        bookingTime(booking.startTime) <= deps.now()
      )
        continue;
      const lastDispatch = await deps.lastDispatch(
        state.business.id,
        booking.id,
      );
      if (
        lastDispatch &&
        deps.now() - bookingTime(lastDispatch.created_at) < 5 * 60000
      )
        continue;
      for (const type of ["reminder", "unpaid_checkin"] as const) {
        if (type === "unpaid_checkin" && !state.settings.calls?.unpaidEnabled)
          continue;
        const previous =
          type === "unpaid_checkin"
            ? await deps.lastUnpaid(state.business.id, booking.id)
            : null;
        if (!isCallDue(state, booking, type, deps.now(), previous)) continue;
        result.checked++;
        const key =
          type === "reminder"
            ? booking.startTime
            : `unpaid:${previous?.created_at ?? booking.createdAt}`;
        if (
          !(await deps.claim({
            business_id: state.business.id,
            booking_id: booking.id,
            appointment_time: key,
          }))
        )
          continue;
        // A common claim also prevents reminder/payment calls racing across server replicas.
        if (
          !(await deps.claim({
            business_id: state.business.id,
            booking_id: booking.id,
            appointment_time: `dispatch:${lastDispatch?.created_at ?? booking.createdAt}`,
          }))
        )
          break;
        // Refresh after claiming, so a payment, cancellation, or setting change observed now stops the call.
        const { state: current } = await deps.read(state.business.id);
        const currentBooking = current.bookings.find(
          (b) => b.id === booking.id,
        );
        if (
          !currentBooking ||
          currentBooking.startTime !== booking.startTime ||
          !isCallDue(current, currentBooking, type, deps.now(), previous)
        )
          continue;
        const customer = current.customers.find(
          (c) => c.id === currentBooking.customerId,
        );
        const service = current.services.find(
          (s) => s.id === currentBooking.serviceId,
        );
        if (!customer || !service) continue;
        // Keep claims on ambiguous provider failures: never automatically redial after a timeout.
        try {
          const metadata = {
            business_id: current.business.id,
            booking_id: booking.id,
            call_type: type,
          };
          if (current.business.voice?.status !== "active") continue;
          const call = await deps.trigger({
            fromNumber: current.business.voice.number,
            agentId: current.business.voice.agentId,
            toNumber: customer.phone,
            dynamicVariables: {
              business_name: current.business.name,
              customer_name: customer.name,
              service_name: service.name,
              appointment_date: booking.startTime.slice(0, 10),
              appointment_time: booking.startTime.slice(11, 16),
              call_type: type,
            },
            metadata,
          });
          await deps.save({
            id: randomUUID(),
            business_id: current.business.id,
            booking_id: booking.id,
            aethex_call_id: call.id,
            agent_id: call.agent_id,
            direction: call.direction,
            from_number: call.from_number,
            to_number: call.to_number,
            status: call.status,
            call_type: type,
            metadata,
            created_at: call.created_at,
          });
          result.dispatched++;
        } catch {
          result.failed++;
        }
        break; // Never place both a reminder and a payment call for this booking in the same tick.
      }
    }
  }
  result.durationMs = deps.now() - start;
  return result;
}
export async function checkAndDispatchReminders(): Promise<CheckRemindersResult> {
  const result: CheckRemindersResult = {
    checked: 0,
    dispatched: 0,
    failed: 0,
    durationMs: 0,
    timestamp: new Date().toISOString(),
  };
  if (isJobRunning) return { ...result, skippedDueToConcurrency: true };
  if (
    !isSupabaseConfigured() ||
    !isAethexConfigured() ||
    !process.env.AETHEX_FROM_NUMBER ||
    !process.env.AETHEX_AGENT_ID
  ) {
    lastRunStats = {
      ...result,
      error:
        "Configure storage, the voice agent, and an outbound number before enabling automatic calls.",
    };
    return lastRunStats;
  }
  isJobRunning = true;
  try {
    lastRunStats = await runCallReminders(liveDependencies);
  } catch (error) {
    lastRunStats = {
      ...result,
      error: error instanceof Error ? error.message : "Reminder check failed",
    };
  } finally {
    isJobRunning = false;
  }
  return lastRunStats!;
}
export function startCallScheduler(customCron?: string) {
  if (process.env.ENABLE_CALL_SCHEDULER !== "true" || scheduledTask) return;
  const expression =
    customCron || process.env.CALL_REMINDER_CRON || "*/5 * * * *";
  if (!cron.validate(expression)) throw new Error("Invalid CALL_REMINDER_CRON");
  scheduledTask = cron.schedule(expression, () => {
    void checkAndDispatchReminders();
  });
}
export function stopCallScheduler() {
  scheduledTask?.stop();
  scheduledTask = null;
}
export function getCallSchedulerStatus() {
  return {
    active: !!scheduledTask,
    cronPattern: process.env.CALL_REMINDER_CRON || "*/5 * * * *",
    isJobRunning,
    lastRunTimestamp: lastRunStats?.timestamp ?? null,
    lastRunStats,
  };
}
