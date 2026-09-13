export interface AethexTriggerCallParams {
  agentId?: string;
  toNumber: string;
  fromNumber?: string;
  dynamicVariables?: Record<string, string | number | boolean>;
  metadata?: Record<string, unknown>;
}

export interface AethexCallResponse {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  call_sid: string | null;
  provider: string;
  direction: "inbound" | "outbound";
  from_number: string;
  to_number: string;
  status:
    | "queued"
    | "ringing"
    | "in-progress"
    | "connected"
    | "completed"
    | "failed"
    | "no-answer"
    | "busy"
    | "canceled";
  initiated_via: string;
  duration_seconds: number | null;
  cost_cents: number | null;
  metadata?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
}

export const isAethexConfigured = (): boolean => {
  return Boolean(process.env.AETHEX_API_KEY);
};

export function normalizeE164(phone: string): string {
  const cleaned = phone.replace(/[\s\-()]/g, "");
  if (cleaned.startsWith("+")) {
    return cleaned;
  }
  // Default to +1 if 10 digits or if country code omitted
  if (cleaned.length === 10) {
    return `+1${cleaned}`;
  }
  if (cleaned.length === 11 && cleaned.startsWith("1")) {
    return `+${cleaned}`;
  }
  return `+${cleaned}`;
}

export class AethexClient {
  private baseUrl: string;
  private apiKey?: string;
  private defaultAgentId?: string;
  private defaultFromNumber?: string;

  constructor() {
    this.baseUrl =
      process.env.AETHEX_API_BASE_URL?.replace(/\/+$/, "") ||
      "https://api.aethexai.com/api/v1";
    this.apiKey = process.env.AETHEX_API_KEY;
    this.defaultAgentId = process.env.AETHEX_AGENT_ID;
    this.defaultFromNumber = process.env.AETHEX_FROM_NUMBER;
  }

  /**
   * Triggers an outbound call via Aethex POST /calls/trigger
   */
  async triggerCall(params: AethexTriggerCallParams): Promise<AethexCallResponse> {
    const agentId = params.agentId || this.defaultAgentId;
    const fromNumber = params.fromNumber || this.defaultFromNumber;
    const toNumber = normalizeE164(params.toNumber);

    if (!isAethexConfigured() || !agentId || !fromNumber) {
      if (process.env.NODE_ENV === "production") throw new Error("Voice calling is not configured");
      console.warn(
        `[Aethex Simulation] Live Aethex credentials missing (API Key: ${Boolean(this.apiKey)}, Agent ID: ${Boolean(agentId)}, From Number: ${Boolean(fromNumber)}). Simulating successful dispatch to ${toNumber}.`
      );

      const mockId = `sim_call_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
      return {
        id: mockId,
        agent_id: agentId || "00000000-0000-0000-0000-000000000000",
        conversation_id: `conv_${mockId}`,
        call_sid: `CA_mock_${mockId}`,
        provider: "aethex_simulated",
        direction: "outbound",
        from_number: fromNumber || "+14155550000",
        to_number: toNumber,
        status: "queued",
        initiated_via: "api",
        duration_seconds: null,
        cost_cents: null,
        metadata: params.metadata || {},
        created_at: new Date().toISOString(),
      };
    }

    const payload = {
      agent_id: agentId,
      to_number: toNumber,
      from_number: fromNumber,
      dynamic_variables: params.dynamicVariables || {},
      metadata: params.metadata || {},
    };

    const response = await fetch(`${this.baseUrl}/calls/trigger`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey!,
        Authorization: `Bearer ${this.apiKey!}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorJson: { message?: string; error?: string } = {};
      try {
        errorJson = JSON.parse(errorText);
      } catch {
        // Fallback if not json
      }
      const message =
        errorJson.message || errorJson.error || `Aethex call trigger failed with status ${response.status}`;
      throw new Error(`[Aethex Error ${response.status}] ${message} (${errorText})`);
    }

    const data = (await response.json()) as AethexCallResponse;
    return data;
  }

  /**
   * Retrieves status and details of a call via GET /calls/:id
   */
  async getCall(callId: string): Promise<AethexCallResponse | null> {
    if (!isAethexConfigured()) {
      return {
        id: callId,
        agent_id: this.defaultAgentId || "simulated-agent",
        conversation_id: `conv_${callId}`,
        call_sid: `CA_${callId}`,
        provider: "aethex_simulated",
        direction: "outbound",
        from_number: this.defaultFromNumber || "+14155550000",
        to_number: "+14155551234",
        status: "completed",
        initiated_via: "api",
        duration_seconds: 48,
        cost_cents: 8,
        created_at: new Date(Date.now() - 60000).toISOString(),
        updated_at: new Date().toISOString(),
      };
    }

    const response = await fetch(`${this.baseUrl}/calls/${callId}`, {
      method: "GET",
      headers: {
        "X-API-Key": this.apiKey!,
        Authorization: `Bearer ${this.apiKey!}`,
      },
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`Failed to fetch call ${callId} from Aethex: ${response.statusText}`);
    }

    return (await response.json()) as AethexCallResponse;
  }

  /**
   * Lists calls from Aethex via GET /calls
   */
  async listCalls(params: {
    limit?: number;
    offset?: number;
    status?: string;
    direction?: "inbound" | "outbound";
  } = {}): Promise<{ data: AethexCallResponse[]; total: number }> {
    if (!isAethexConfigured()) {
      return { data: [], total: 0 };
    }

    const searchParams = new URLSearchParams();
    if (params.limit) searchParams.set("limit", String(params.limit));
    if (params.offset) searchParams.set("offset", String(params.offset));
    if (params.status) searchParams.set("status", params.status);
    if (params.direction) searchParams.set("direction", params.direction);

    const response = await fetch(`${this.baseUrl}/calls?${searchParams.toString()}`, {
      method: "GET",
      headers: {
        "X-API-Key": this.apiKey!,
        Authorization: `Bearer ${this.apiKey!}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to list calls from Aethex: ${response.statusText}`);
    }

    return (await response.json()) as { data: AethexCallResponse[]; total: number };
  }
}

export const aethex = new AethexClient();
