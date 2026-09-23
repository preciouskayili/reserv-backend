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
  return ["AETHEX_API_KEY", "AETHEX_AGENT_ID", "AETHEX_FROM_NUMBER"].every(key => Boolean(process.env[key]?.trim()));
};

export function normalizeE164(phone: string): string {
  const cleaned = phone.replace(/[\s\-()]/g, "");
  // Local Nigerian numbers use the workspace's current WAT/Nigeria locale.
  const normalized = /^0[789]\d{9}$/.test(cleaned)
    ? `+234${cleaned.slice(1)}`
    : cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new Error("Enter a phone number with its country code, for example +234...");
  }
  return normalized;
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
    this.apiKey = process.env.AETHEX_API_KEY?.trim();
    this.defaultAgentId = process.env.AETHEX_AGENT_ID?.trim();
    this.defaultFromNumber = process.env.AETHEX_FROM_NUMBER?.trim();
  }

  /**
   * Triggers an outbound call via Aethex POST /calls/trigger
   */
  async triggerCall(params: AethexTriggerCallParams): Promise<AethexCallResponse> {
    const agentId = params.agentId || this.defaultAgentId;
    const fromNumber = params.fromNumber || this.defaultFromNumber;
    const toNumber = normalizeE164(params.toNumber);

    if (!this.apiKey || !agentId || !fromNumber) {
      throw new Error("Voice calling is not configured. Check the API key, agent, and outbound number.");
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
      signal: AbortSignal.timeout(20000),
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey!,
        Authorization: `Bearer ${this.apiKey!}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Voice provider rejected the call (HTTP ${response.status}). Check the agent, phone number, and account balance in Aethex.`);
    }

    const data = (await response.json()) as AethexCallResponse;
    return data;
  }

  /**
   * Retrieves status and details of a call via GET /calls/:id
   */
  async getCall(callId: string, timeoutMs = 20000): Promise<AethexCallResponse | null> {
    if (!this.apiKey) throw new Error("Voice calling is not configured");

    const response = await fetch(`${this.baseUrl}/calls/${encodeURIComponent(callId)}`, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
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

  /** Most recent calls across agents; used to match a tool request whose call id differs from the call record id. */
  async recentCalls(limit = 50, timeoutMs = 20000): Promise<AethexCallResponse[]> {
    if (!this.apiKey) throw new Error("Voice calling is not configured");
    const response = await fetch(`${this.baseUrl}/calls?limit=${limit}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "X-API-Key": this.apiKey, Authorization: `Bearer ${this.apiKey}` },
    });
    if (!response.ok) throw new Error(`Failed to list calls from Aethex: ${response.statusText}`);
    const value = (await response.json()) as { data?: AethexCallResponse[] };
    return Array.isArray(value.data) ? value.data : [];
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
      signal: AbortSignal.timeout(20000),
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
