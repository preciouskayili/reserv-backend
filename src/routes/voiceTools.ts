import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { aethex, type AethexCallResponse } from "../lib/aethex.js";
import { HttpError } from "../domain/workspace.js";
import { workspaces } from "../services/workspaces.js";
import { TOOL_KEY_HEADER, verifyToolKey } from "../services/voiceAgent.js";
import { runVoiceTool, voiceTools, type VoiceCallContext } from "../services/voiceTools.js";

const LIVE = new Set(["queued", "ringing", "in-progress", "connected"]);
const invocation = z.object({
  arguments: z.record(z.string(), z.unknown()).optional(),
  agent_id: z.string().max(100).optional(),
  conversation_id: z.string().max(100).optional(),
  call_id: z.string().min(1).max(100),
});

export interface VoiceToolDependencies {
  /** The business's active agent id, if it has one. */
  agentFor: (businessId: string) => Promise<string | undefined>;
  findCall: (callId: string, conversationId?: string) => Promise<AethexCallResponse | null>;
  now: () => number;
}

const live: VoiceToolDependencies = {
  async agentFor(businessId) {
    try {
      const voice = (await workspaces.read(businessId)).state.business.voice;
      return voice?.status === "active" ? voice.agentId : undefined;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return undefined;
      throw error;
    }
  },
  async findCall(callId, conversationId) {
    // Tool requests must complete within Aethex's ten-second limit, so provider lookups are brief.
    const direct = await aethex.getCall(callId, 3500).catch(() => null);
    if (direct) return direct;
    const recent = await aethex.recentCalls(50, 3500).catch(() => []);
    return recent.find(c => c.id === callId || (conversationId && c.conversation_id === conversationId)) ?? null;
  },
  now: Date.now,
};

/** Confirms a tool request belongs to a live call on this business's own agent. */
export function createCallVerifier(deps: VoiceToolDependencies) {
  const cache = new Map<string, { ctx: VoiceCallContext; expires: number }>();
  return async function verify(businessId: string, body: z.infer<typeof invocation>): Promise<VoiceCallContext | null> {
    const key = `${businessId}:${body.call_id}`;
    const cached = cache.get(key);
    if (cached && cached.expires > deps.now()) return cached.ctx;
    const agentId = await deps.agentFor(businessId);
    if (!agentId || (body.agent_id && body.agent_id !== agentId)) return null;
    const call = await deps.findCall(body.call_id, body.conversation_id);
    if (!call || call.agent_id !== agentId || !LIVE.has(call.status)) return null;
    const metadata = call.metadata ?? {};
    const ctx: VoiceCallContext = {
      businessId,
      callId: call.id,
      direction: call.direction,
      customerPhone: (call.direction === "inbound" ? call.from_number : call.to_number) || undefined,
      bookingId: metadata.business_id === businessId && typeof metadata.booking_id === "string" ? metadata.booking_id : undefined,
    };
    if (cache.size > 2000) for (const [k, v] of cache) if (v.expires <= deps.now()) cache.delete(k);
    cache.set(key, { ctx, expires: deps.now() + 15 * 60000 });
    return ctx;
  };
}

export function createVoiceToolRouter(deps: VoiceToolDependencies = live) {
  const router = Router();
  const verify = createCallVerifier(deps);
  const names = new Set(voiceTools.map(t => t.name));
  router.post(
    "/:businessId/:tool",
    // Authenticate before counting, so unauthenticated traffic cannot exhaust a business's limit.
    (req, res, next) => {
      const businessId = String(req.params.businessId);
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(businessId) || !verifyToolKey(businessId, req.get(TOOL_KEY_HEADER)))
        return res.status(401).json({ error: "Unauthorized" });
      next();
    },
    rateLimit({ windowMs: 60000, limit: 240, standardHeaders: true, legacyHeaders: false, keyGenerator: req => String(req.params.businessId) }),
    async (req, res) => {
      const businessId = String(req.params.businessId), tool = String(req.params.tool);
      if (!names.has(tool)) return res.status(404).json({ error: "Unknown tool" });
      const body = invocation.safeParse(req.body);
      if (!body.success) return res.status(400).json({ error: "Invalid tool request" });
      let ctx;
      try { ctx = await verify(businessId, body.data); }
      catch { return res.status(503).json({ error: "The booking system is temporarily unavailable. Offer a transfer or a call back." }); }
      if (!ctx) return res.status(403).json({ error: "This call could not be verified" });
      // Expected failures return 200 with an error field, so the agent hears the reason instead of a status code.
      return res.json(await runVoiceTool(tool, ctx, body.data.arguments ?? {}, deps.now()));
    },
  );
  return router;
}
