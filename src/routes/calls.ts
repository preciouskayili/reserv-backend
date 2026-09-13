import {
  requireWorkspace,
  type WorkspaceRequest,
} from "../middleware/requireWorkspace.js";
import { workspaces } from "../services/workspaces.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { aethex, normalizeE164 } from "../lib/aethex.js";
import { db, type CallRecord } from "../services/dbService.js";
import {
  checkAndDispatchReminders,
  getCallSchedulerStatus,
} from "../services/callScheduler.js";

const router = Router();

const triggerCallSchema = z.object({
  bookingId: z.string().optional(),
  toNumber: z.string().min(6, "Phone number is required"),
  customerName: z.string().optional(),
  serviceName: z.string().optional(),
  appointmentTime: z.string().optional(),
  appointmentDate: z.string().optional(),
  businessName: z.string().optional(),
  callType: z
    .enum(["reminder", "confirmation", "unpaid_checkin", "manual"])
    .default("reminder"),
  customPromptVariables: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
});

/**
 * POST /api/calls/trigger
 * Triggers an automated or on-demand voice call to a customer
 */
router.post(
  "/trigger",
  requireAuth,
  requireWorkspace,
  async (req: WorkspaceRequest, res: Response) => {
    try {
      const parseResult = triggerCallSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({
          error: "Validation failed",
          details: parseResult.error.flatten().fieldErrors,
        });
      }

      const {
        bookingId,
        toNumber,
        customerName,
        serviceName,
        appointmentTime,
        appointmentDate,
        businessName,
        callType,
        customPromptVariables,
      } = parseResult.data;

      const { state } = await workspaces.read(req.workspaceId!);
      if (bookingId && !state.bookings.some((b) => b.id === bookingId))
        return res.status(404).json({ error: "Reservation not found" });
      const formattedToNumber = normalizeE164(toNumber);

      const dynamicVariables: Record<string, string | number | boolean> = {
        customer_name: customerName || "there",
        business_name: state.business.name,
        service_name: serviceName || "your upcoming appointment",
        appointment_date: appointmentDate || "today",
        appointment_time: appointmentTime || "your scheduled time",
        call_type: callType,
        ...customPromptVariables,
      };

      const metadata: Record<string, unknown> = {
        business_id: req.workspaceId,
        booking_id: bookingId,
        call_type: callType,
        dispatched_at: new Date().toISOString(),
      };

      // Dispatch via Aethex Voice AI
      const aethexResponse = await aethex.triggerCall({
        toNumber: formattedToNumber,
        dynamicVariables,
        metadata,
      });

      const callRecord: CallRecord = {
        id: crypto.randomUUID(),
        business_id: req.workspaceId!,
        booking_id: bookingId || null,
        aethex_call_id: aethexResponse.id,
        agent_id: aethexResponse.agent_id,
        direction: aethexResponse.direction,
        from_number: aethexResponse.from_number,
        to_number: aethexResponse.to_number,
        status: aethexResponse.status,
        call_type: callType,
        duration_seconds: aethexResponse.duration_seconds,
        cost_cents: aethexResponse.cost_cents,
        metadata,
        created_at: aethexResponse.created_at,
      };

      const savedCall = await db.createCall(callRecord);

      return res.status(202).json({
        message: "Call queued successfully",
        call: savedCall,
        aethex_call_id: aethexResponse.id,
      });
    } catch (error) {
      console.error("[Calls API] Trigger error:", error);
      return res.status(500).json({
        error: "Failed to dispatch call",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  },
);

/**
 * GET /api/calls
 * List call history
 */
router.get(
  "/",
  requireAuth,
  requireWorkspace,
  async (req: WorkspaceRequest, res: Response) => {
    try {
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const calls = await db.listCalls(limit, req.workspaceId!);
      return res.json({ calls, total: calls.length });
    } catch (error) {
      console.error("[Calls API] List error:", error);
      return res.status(500).json({ error: "Failed to retrieve calls" });
    }
  },
);

function isCronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return process.env.NODE_ENV !== "production";
  }

  const headerSecret = req.headers["x-cron-secret"];
  const authHeader = req.headers.authorization;
  const bearerSecret = authHeader?.startsWith("Bearer ")
    ? authHeader.substring(7)
    : null;

  return headerSecret === secret || bearerSecret === secret;
}

/**
 * POST /api/calls/cron/reminders
 * Trigger a reminder check execution tick manually or via external/Railway cron
 */
router.post("/cron/reminders", async (req: Request, res: Response) => {
  if (!isCronAuthorized(req)) {
    return res
      .status(401)
      .json({ error: "Unauthorized: Invalid or missing cron secret" });
  }

  try {
    const result = await checkAndDispatchReminders();
    return res.json({
      success: true,
      ...result,
    });
  } catch (error: any) {
    console.error("[Calls API] Manual cron trigger failed:", error);
    return res.status(500).json({
      error: "Cron execution failed",
      message: error?.message || "Unknown error",
    });
  }
});

/**
 * GET /api/calls/cron/status
 * Get the current status, statistics, and schedule of the node-cron reminder runner
 */
router.get("/cron/status", (req: Request, res: Response) => {
  if (!isCronAuthorized(req)) {
    return res
      .status(401)
      .json({ error: "Unauthorized: Invalid or missing cron secret" });
  }

  const status = getCallSchedulerStatus();
  return res.json({
    status: "ok",
    scheduler: status,
  });
});

/**
 * GET /api/calls/:id
 * Retrieve call status
 */
router.get(
  "/:id",
  requireAuth,
  requireWorkspace,
  async (req: WorkspaceRequest, res: Response) => {
    try {
      const id = String(req.params.id);
      const call = await db.getCall(id, req.workspaceId!);
      if (!call) {
        return res.status(404).json({ error: "Call not found" });
      }

      // Refresh live status from Aethex if in-progress or queued
      if (
        call.aethex_call_id &&
        ["queued", "ringing", "in-progress"].includes(call.status)
      ) {
        try {
          const liveStatus = await aethex.getCall(call.aethex_call_id);
          if (liveStatus && liveStatus.status !== call.status) {
            const updated = await db.updateCall(call.id, {
              status: liveStatus.status,
              duration_seconds: liveStatus.duration_seconds,
              cost_cents: liveStatus.cost_cents,
            });
            return res.json({ call: updated || call });
          }
        } catch {
          // Fall back to stored state
        }
      }

      return res.json({ call });
    } catch (error) {
      console.error("[Calls API] Get error:", error);
      return res.status(500).json({ error: "Failed to fetch call" });
    }
  },
);

/**
 * POST /api/calls/webhook
 * Webhook receiver for Aethex call updates and transcripts
 */
router.post("/webhook", async (req: Request, res: Response) => {
  const secret = process.env.AETHEX_WEBHOOK_SECRET;
  if (!secret || req.headers["x-webhook-secret"] !== secret) {
    return res.status(401).json({ error: "Invalid webhook credentials" });
  }
  try {
    const event = req.body;
    const callId = event.call_id || event.id;
    const status = event.status;
    const duration = event.duration_seconds;
    const transcript = event.transcript;
    const recordingUrl = event.recording_url;

    if (callId) {
      await db.updateCall(callId, {
        status: status || undefined,
        duration_seconds: duration || undefined,
        transcript: transcript || undefined,
        recording_url: recordingUrl || undefined,
      }, "aethex_call_id");

      console.log(
        `[Aethex Webhook] Updated call ${callId} status to: ${status}`,
      );
    }

    return res.json({ received: true });
  } catch (error) {
    console.error("[Calls Webhook] Error:", error);
    return res.status(500).json({ error: "Webhook processing error" });
  }
});

export default router;
