import cron, { type ScheduledTask } from "node-cron";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";
import { aethex, normalizeE164 } from "../lib/aethex.js";
import { db } from "./dbService.js";

let scheduledTask: ScheduledTask | null = null;
let isJobRunning = false;
let lastRunTimestamp: string | null = null;
let lastRunStats: {
  checked: number;
  dispatched: number;
  durationMs: number;
  error?: string;
  skippedDueToConcurrency?: boolean;
} | null = null;

export interface CheckRemindersResult {
  checked: number;
  dispatched: number;
  durationMs: number;
  timestamp: string;
  skippedDueToConcurrency?: boolean;
  error?: string;
}

/**
 * Checks for upcoming bookings that are due for an automated voice reminder call.
 * Safe to run concurrently (guarded by isJobRunning execution lock).
 */
export async function checkAndDispatchReminders(): Promise<CheckRemindersResult> {
  const startTime = Date.now();

  // Concurrency lock: prevent multiple overlapping ticks
  if (isJobRunning) {
    console.warn(
      "[CallScheduler] Previous reminder job is still actively running. Skipping this tick to prevent duplicate calls.",
    );
    const result: CheckRemindersResult = {
      checked: 0,
      dispatched: 0,
      durationMs: 0,
      timestamp: new Date().toISOString(),
      skippedDueToConcurrency: true,
    };
    return result;
  }

  isJobRunning = true;
  let checkedCount = 0;
  let dispatchedCount = 0;

  try {
    if (!isSupabaseConfigured()) {
      const result: CheckRemindersResult = {
        checked: 0,
        dispatched: 0,
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
      lastRunTimestamp = result.timestamp;
      lastRunStats = { ...result };
      return result;
    }

    const supabase = getSupabase();

    // 1. Fetch business settings to see if reminder calls are enabled
    const { data: settings } = await supabase
      .from("business_settings")
      .select("*")
      .eq("business_id", "bloom")
      .maybeSingle();

    if (!settings || !settings.calls_enabled) {
      const result: CheckRemindersResult = {
        checked: 0,
        dispatched: 0,
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
      lastRunTimestamp = result.timestamp;
      lastRunStats = { ...result };
      return result;
    }

    const reminderMinutes = settings.reminder_minutes || 120;
    const now = new Date();
    const reminderWindowStart = new Date(
      now.getTime() + (reminderMinutes - 15) * 60 * 1000,
    );
    const reminderWindowEnd = new Date(
      now.getTime() + (reminderMinutes + 15) * 60 * 1000,
    );

    // 2. Query bookings within the reminder window that are active
    const { data: bookings, error } = await supabase
      .from("bookings")
      .select(
        "*, customer:customers(*), service:services(*), business:businesses(*)",
      )
      .in("status", ["Confirmed", "Needs confirmation", "Pending"])
      .gte("start_time", reminderWindowStart.toISOString())
      .lte("start_time", reminderWindowEnd.toISOString());

    if (error || !bookings) {
      console.error(
        "[CallScheduler] Error querying bookings for reminder calls:",
        error?.message,
      );
      const result: CheckRemindersResult = {
        checked: 0,
        dispatched: 0,
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        error: error?.message,
      };
      lastRunTimestamp = result.timestamp;
      lastRunStats = { ...result };
      return result;
    }

    checkedCount = bookings.length;

    for (const booking of bookings) {
      const customer = booking.customer;
      const service = booking.service;
      const business = booking.business;

      if (!customer?.phone) continue;

      // 3. Idempotency check: Ensure customer has not already received a reminder call for this booking
      const alreadyCalled = await db.hasReminderCall(booking.id);
      if (alreadyCalled) {
        continue;
      }

      try {
        const toNumber = normalizeE164(customer.phone);
        const appointmentDate = new Date(booking.start_time).toLocaleDateString(
          "en-US",
          {
            weekday: "long",
            month: "short",
            day: "numeric",
          },
        );
        const appointmentTime = new Date(booking.start_time).toLocaleTimeString(
          "en-US",
          {
            hour: "numeric",
            minute: "2-digit",
          },
        );

        console.log(
          `[CallScheduler] Dispatching automated reminder call to ${customer.name} (${toNumber}) for booking ${booking.code}`,
        );

        const callResponse = await aethex.triggerCall({
          toNumber,
          dynamicVariables: {
            customer_name: customer.name,
            business_name: business?.name || "Bloom Studio",
            service_name: service?.name || "appointment",
            appointment_date: appointmentDate,
            appointment_time: appointmentTime,
            call_type: "reminder",
          },
          metadata: {
            booking_id: booking.id,
            booking_code: booking.code,
            scheduled_by: "node_cron",
          },
        });

        await db.createCall({
          id: crypto.randomUUID(),
          booking_id: booking.id,
          aethex_call_id: callResponse.id,
          agent_id: callResponse.agent_id,
          direction: "outbound",
          from_number: callResponse.from_number,
          to_number: callResponse.to_number,
          status: callResponse.status,
          call_type: "reminder",
          duration_seconds: null,
          metadata: { scheduled_by: "node_cron" },
          created_at: callResponse.created_at,
        });

        await db.addBookingActivity({
          id: crypto.randomUUID(),
          bookingId: booking.id,
          title: "Automated reminder call dispatched",
          detail: `Aethex Voice AI placed a reminder call to ${customer.name} at ${toNumber}.`,
          actor: "agent",
        });

        dispatchedCount++;
      } catch (err: any) {
        console.error(
          `[CallScheduler] Failed to dispatch reminder for booking ${booking.id}:`,
          err?.message || err,
        );
      }
    }

    const durationMs = Date.now() - startTime;
    const result: CheckRemindersResult = {
      checked: checkedCount,
      dispatched: dispatchedCount,
      durationMs,
      timestamp: new Date().toISOString(),
    };
    lastRunTimestamp = result.timestamp;
    lastRunStats = { ...result };
    return result;
  } catch (err: any) {
    console.error(
      "[CallScheduler] Unexpected error during reminder tick:",
      err,
    );
    const result: CheckRemindersResult = {
      checked: checkedCount,
      dispatched: dispatchedCount,
      durationMs: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      error: err?.message || String(err),
    };
    lastRunTimestamp = result.timestamp;
    lastRunStats = { ...result };
    return result;
  } finally {
    isJobRunning = false;
  }
}

/**
 * Starts the automated reminder cron runner using node-cron.
 * Default schedule is every 5 minutes (expression: every 5 minutes).
 */
export function startCallScheduler(customCron?: string): void {
  if (process.env.ENABLE_CALL_SCHEDULER === "false") {
    console.log(
      "[CallScheduler] Automated reminder scheduler disabled (ENABLE_CALL_SCHEDULER=false)",
    );
    return;
  }

  if (scheduledTask) {
    console.log("[CallScheduler] node-cron scheduler is already running.");
    return;
  }

  const rawExpression =
    customCron || process.env.CALL_REMINDER_CRON || "*/5 * * * *";
  const isValid = cron.validate(rawExpression);

  if (!isValid) {
    console.warn(
      `[CallScheduler] Invalid cron expression: "${rawExpression}". Falling back to "*/5 * * * *"`,
    );
  }

  const cronPattern = isValid ? rawExpression : "*/5 * * * *";

  console.log(
    `[CallScheduler] Initializing node-cron runner with pattern: "${cronPattern}"`,
  );

  scheduledTask = cron.schedule(cronPattern, async () => {
    console.log(
      `[CallScheduler] [${new Date().toISOString()}] Running scheduled booking reminder check...`,
    );
    try {
      const stats = await checkAndDispatchReminders();
      if (!stats.skippedDueToConcurrency) {
        console.log(
          `[CallScheduler] Cron check finished: ${stats.dispatched} calls dispatched, ${stats.checked} eligible (${stats.durationMs}ms)`,
        );
      }
    } catch (err: any) {
      console.error(
        "[CallScheduler] Error during scheduled cron execution:",
        err?.message || err,
      );
    }
  });

  // Optional background startup scan
  checkAndDispatchReminders().catch((err) => {
    console.warn(
      "[CallScheduler] Startup initial scan failed:",
      err?.message || err,
    );
  });
}

/**
 * Stops the running node-cron task
 */
export function stopCallScheduler(): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
    console.log("[CallScheduler] node-cron scheduler stopped.");
  }
}

/**
 * Returns current status of the scheduler for monitoring/health endpoints
 */
export function getCallSchedulerStatus() {
  return {
    active: scheduledTask !== null,
    cronPattern: process.env.CALL_REMINDER_CRON || "*/5 * * * *",
    isJobRunning,
    lastRunTimestamp,
    lastRunStats,
  };
}
