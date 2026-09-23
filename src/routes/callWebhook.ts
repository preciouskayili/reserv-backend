import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, raw } from "express";
import { z } from "zod";
import { db, type CallRecord } from "../services/dbService.js";
import { workspaces } from "../services/workspaces.js";

// https://developers.aethexai.com/docs/concepts/webhooks
export function verifyCallSignature(
  body: Buffer,
  header: string | undefined,
  secret: string | undefined,
  now = Date.now(),
): boolean {
  if (!header || !secret) return false;
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/i.exec(header);
  if (!match || Math.abs(Math.floor(now / 1000) - Number(match[1])) > 300)
    return false;
  const expected = createHmac("sha256", secret)
    .update(`${match[1]}.`)
    .update(body)
    .digest();
  return timingSafeEqual(expected, Buffer.from(match[2], "hex"));
}
const ended = z.object({
  call_id: z.string().min(1).max(100),
  status: z.enum(["completed", "failed", "no-answer", "busy", "canceled"]),
  duration_seconds: z.number().min(0).nullable().optional(),
  cost_cents: z.number().min(0).nullable().optional(),
  transcript_text: z.string().optional(),
  transcript: z.unknown().optional(),
  agent_id: z.string().max(100).optional(),
  direction: z.enum(["inbound", "outbound"]).optional(),
  from_number: z.string().max(40).optional(),
  to_number: z.string().max(40).optional(),
  started_at: z.string().max(40).optional(),
});
const recording = z.object({
  call_id: z.string().min(1).max(100),
  audio_url: z
    .string()
    .url()
    .refine((value) => value.startsWith("https://")),
});
export function callEventUpdate(
  event: string | undefined,
  body: unknown,
): { id: string; updates: Partial<CallRecord>; inbound?: { agentId: string; from: string; to: string; startedAt?: string } } | null {
  if (event === "call.ended") {
    const value = ended.parse(body);
    return {
      id: value.call_id,
      ...(value.direction === "inbound" && value.agent_id
        ? { inbound: { agentId: value.agent_id, from: value.from_number ?? "", to: value.to_number ?? "", startedAt: value.started_at } }
        : {}),
      updates: {
        status: value.status,
        duration_seconds: value.duration_seconds,
        cost_cents: value.cost_cents,
        transcript:
          value.transcript_text ??
          (typeof value.transcript === "string" ? value.transcript : undefined),
      },
    };
  }
  if (event === "recording.ready") {
    const value = recording.parse(body);
    return { id: value.call_id, updates: { recording_url: value.audio_url } };
  }
  return null;
}
const agentBusinesses = new Map<string, string>();
async function businessForAgent(agentId: string): Promise<string | undefined> {
  const cached = agentBusinesses.get(agentId);
  if (cached) return cached;
  for (const { state } of await workspaces.all()) {
    if (state.business.voice?.agentId) agentBusinesses.set(state.business.voice.agentId, state.business.id);
  }
  return agentBusinesses.get(agentId);
}

/** Customers calling in have no record until the call ends; one is created from the signed event. */
async function recordInboundCall(
  id: string,
  updates: Partial<CallRecord>,
  inbound: NonNullable<ReturnType<typeof callEventUpdate>>["inbound"],
): Promise<boolean> {
  if (!inbound) return false;
  const businessId = await businessForAgent(inbound.agentId);
  if (!businessId) return false;
  const startedAt = inbound.startedAt && Number.isFinite(Date.parse(inbound.startedAt)) ? new Date(inbound.startedAt).toISOString() : new Date().toISOString();
  try {
    await db.createCall({
      // A deterministic id makes redelivered events idempotent.
      id: `inbound:${id}`, business_id: businessId, booking_id: null, aethex_call_id: id, agent_id: inbound.agentId,
      direction: "inbound", from_number: inbound.from, to_number: inbound.to, status: "completed", call_type: "inbound",
      metadata: {}, created_at: startedAt, ...updates,
    });
  } catch (error) {
    if (!(error instanceof Error && /duplicate key/i.test(error.message))) throw error;
  }
  return true;
}

export const callWebhook = Router();
callWebhook.post(
  "/",
  raw({ type: "application/json", limit: "2mb" }),
  async (req, res) => {
    if (
      !Buffer.isBuffer(req.body) ||
      !verifyCallSignature(
        req.body,
        req.get("x-aethex-signature"),
        process.env.AETHEX_WEBHOOK_SECRET,
      )
    )
      return res.status(401).json({ error: "Invalid webhook signature" });
    let update;
    try {
      update = callEventUpdate(
        req.get("x-aethex-event"),
        JSON.parse(req.body.toString("utf8")),
      );
    } catch {
      return res.status(400).json({ error: "Invalid call event" });
    }
    if (!update) return res.json({ received: true });
    try {
      // Field-specific assignments are idempotent; recording and call-end events can arrive in either order.
      const saved = await db.updateCall(
        update.id,
        update.updates,
        "aethex_call_id",
      );
      // Ask for a retry if the event raced the initial call record insert.
      if (!saved && (await recordInboundCall(update.id, update.updates, update.inbound)))
        return res.json({ received: true });
      if (!saved)
        return res.status(503).json({ error: "Call record not available yet" });
      return res.json({ received: true });
    } catch {
      return res.status(503).json({ error: "Call update could not be saved" });
    }
  },
);
