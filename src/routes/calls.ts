import {
  requireWorkspace,
  type WorkspaceRequest,
} from "../middleware/requireWorkspace.js";
import { workspaces } from "../services/workspaces.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { businessCallConfig } from "../services/businessVoice.js";
import { HttpError } from "../domain/workspace.js";
import { refreshCallStatus, refreshCallList } from "../services/callStatus.js";
import { aethex, normalizeE164 } from "../lib/aethex.js";
import { db, type CallRecord } from "../services/dbService.js";
import {
  checkAndDispatchReminders,
  getCallSchedulerStatus,
} from "../services/callScheduler.js";

const router = Router();

router.get("/status", requireAuth, requireWorkspace, async (req: WorkspaceRequest, res) => {
  const { state } = await workspaces.read(req.workspaceId!);
  const scheduler = getCallSchedulerStatus();
  const voice = state.business.voice;
  const phoneReady = voice?.status === "active" && !!voice.number && !!voice.agentId;
  res.json({
    available: phoneReady && scheduler.active && !!process.env.AETHEX_API_KEY?.trim() && !scheduler.lastRunStats?.error,
    phoneReady,
    lastCheckedAt: scheduler.lastRunTimestamp,
  });
});

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
  rateLimit({ windowMs: 60000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: "Too many call requests. Please wait a minute." } }),
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

      const snapshot = await workspaces.read(req.workspaceId!);
      const { state } = snapshot;
      const booking = bookingId ? state.bookings.find((b) => b.id === bookingId) : undefined;
      if (bookingId && !booking)
        return res.status(404).json({ error: "Reservation not found" });
      const formattedToNumber = normalizeE164(toNumber);

      const dynamicVariables: Record<string, string | number | boolean> = {
        ...customPromptVariables,
        customer_name: customerName || "there",
        business_name: state.business.name,
        service_name: serviceName || "your upcoming appointment",
        appointment_date: appointmentDate || "today",
        appointment_time: appointmentTime || "your scheduled time",
        call_type: callType,
        booking_code: booking?.code ?? "not provided",
      };

      const metadata: Record<string, unknown> = {
        business_id: req.workspaceId,
        booking_id: bookingId,
        call_type: callType,
        dispatched_at: new Date().toISOString(),
      };

      // Dispatch via Aethex Voice AI
      const aethexResponse = await aethex.triggerCall({
        ...businessCallConfig(snapshot),
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
      return res.status(error instanceof HttpError ? error.status : 500).json({
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
      const stored = await db.listCalls(limit, req.workspaceId!);
      const calls = await refreshCallList(stored);
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
    return res.status(result.error || result.failed ? 503 : 200).json({
      success: !result.error && result.failed === 0,
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

      return res.json({ call: await refreshCallStatus(call) });
    } catch (error) {
      console.error("[Calls API] Get error:", error);
      return res.status(500).json({ error: "Failed to fetch call" });
    }
  },
);

export default router;
