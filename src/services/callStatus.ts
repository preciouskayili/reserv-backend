import { aethex, type AethexCallResponse } from "../lib/aethex.js";
import { db, type CallRecord } from "./dbService.js";

const active = new Set(["queued", "ringing", "in-progress", "connected"]);
interface Dependencies {
  get: (id: string) => Promise<AethexCallResponse | null>;
  save: (id: string, update: Partial<CallRecord>) => Promise<CallRecord | null>;
}

// Webhooks remain authoritative. Polling repairs missed events without placing another call.
export function createCallStatusRefresher(deps: Dependencies) {
  const pending = new Map<string, Promise<CallRecord>>();
  return async function refresh(call: CallRecord): Promise<CallRecord> {
    if (!call.aethex_call_id || !active.has(call.status)) return call;
    const key = `${call.business_id}:${call.id}`;
    const existing = pending.get(key);
    if (existing) return existing;
    const task = (async () => {
      try {
        const live = await deps.get(call.aethex_call_id!);
        if (!live || live.id !== call.aethex_call_id) return call;
        return await deps.save(call.id, {
          status: live.status,
          duration_seconds: live.duration_seconds,
          cost_cents: live.cost_cents,
        }) ?? call;
      } catch {
        return call;
      }
    })();
    pending.set(key, task);
    try { return await task; }
    finally { pending.delete(key); }
  };
}

export const refreshCallStatus = createCallStatusRefresher({
  get: id => aethex.getCall(id, 5000),
  save: (id, update) => db.updateCall(id, update, "id", true),
});

export async function refreshCallList(calls: CallRecord[]) {
  const selected = new Set(calls.filter(call => active.has(call.status))
    .sort((a, b) => (a.updated_at ?? a.created_at).localeCompare(b.updated_at ?? b.created_at))
    .slice(0, 10).map(call => call.id));
  return Promise.all(calls.map(call => selected.has(call.id) ? refreshCallStatus(call) : call));
}
