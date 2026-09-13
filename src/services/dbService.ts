import { getSupabase, isSupabaseConfigured } from "../lib/supabase.js";

export interface CallRecord {
  business_id?: string;
  id: string;
  booking_id?: string | null;
  aethex_call_id?: string | null;
  agent_id?: string | null;
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
  call_type: "reminder" | "confirmation" | "unpaid_checkin" | "manual";
  duration_seconds?: number | null;
  cost_cents?: number | null;
  transcript?: string;
  recording_url?: string;
  metadata?: Record<string, unknown>;
  error_message?: string;
  created_at: string;
  updated_at?: string;
}

// In-memory fallback cache when live Supabase is not connected
const memoryCalls: CallRecord[] = [];
const memoryBookings: any[] = [];

export class DatabaseService {
  /**
   * Save a new call record
   */
  async createCall(call: CallRecord): Promise<CallRecord> {
    if (isSupabaseConfigured()) {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from("calls")
        .insert({
          id: call.id,
          business_id: call.business_id,
          booking_id: call.booking_id,
          aethex_call_id: call.aethex_call_id,
          agent_id: call.agent_id,
          direction: call.direction,
          from_number: call.from_number,
          to_number: call.to_number,
          status: call.status,
          call_type: call.call_type,
          duration_seconds: call.duration_seconds,
          cost_cents: call.cost_cents,
          transcript: call.transcript || "",
          recording_url: call.recording_url || "",
          metadata: call.metadata || {},
          error_message: call.error_message || "",
        })
        .select()
        .single();

      if (error) throw new Error(error.message);
      if (data) {
        return data as CallRecord;
      }
    }

    // In-memory fallback
    memoryCalls.unshift(call);
    return call;
  }

  /**
   * Update an existing call record
   */
  async updateCall(
    id: string,
    updates: Partial<CallRecord>,
    identifier: "id" | "aethex_call_id" = "id",
  ): Promise<CallRecord | null> {
    if (isSupabaseConfigured()) {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from("calls")
        .update({
          ...updates,
          updated_at: new Date().toISOString(),
        })
        .eq(identifier, id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      if (data) {
        return data as CallRecord;
      }
    }

    const idx = memoryCalls.findIndex(
      (c) => c.id === id || c.aethex_call_id === id,
    );
    if (idx !== -1) {
      memoryCalls[idx] = {
        ...memoryCalls[idx],
        ...updates,
        updated_at: new Date().toISOString(),
      };
      return memoryCalls[idx];
    }
    return null;
  }

  /**
   * Get all calls
   */
  async listCalls(limit = 50, businessId?: string): Promise<CallRecord[]> {
    if (isSupabaseConfigured()) {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from("calls")
        .select("*")
        .eq("business_id", businessId ?? "")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) throw new Error(error.message);
      if (data) {
        return data as CallRecord[];
      }
    }

    return memoryCalls
      .filter((c) => c.business_id === businessId)
      .slice(0, limit);
  }

  /**
   * Get call by ID or Aethex Call ID
   */
  async getCall(id: string, businessId?: string): Promise<CallRecord | null> {
    if (isSupabaseConfigured()) {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from("calls")
        .select("*")
        .eq("business_id", businessId ?? "")
        .eq("id", id)
        .maybeSingle();

      if (error) throw new Error(error.message);
      if (data) {
        return data as CallRecord;
      }
    }

    return (
      memoryCalls.find(
        (c) =>
          c.business_id === businessId &&
          (c.id === id || c.aethex_call_id === id),
      ) || null
    );
  }

  /**
   * Check if a reminder call has already been dispatched for a booking
   */
  async hasReminderCall(bookingId: string): Promise<boolean> {
    if (isSupabaseConfigured()) {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from("calls")
        .select("id")
        .eq("booking_id", bookingId)
        .eq("call_type", "reminder")
        .limit(1);

      if (error) throw new Error(error.message);
      return Boolean(data?.length);
    }

    return memoryCalls.some(
      (c) => c.booking_id === bookingId && c.call_type === "reminder",
    );
  }

  /**
   * Record booking activity
   */
  async addBookingActivity(activity: {
    id: string;
    bookingId: string;
    title: string;
    detail?: string;
    actor: "owner" | "customer" | "agent";
  }): Promise<void> {
    if (isSupabaseConfigured()) {
      const supabase = getSupabase();
      await supabase.from("booking_activity").insert({
        id: activity.id,
        booking_id: activity.bookingId,
        title: activity.title,
        detail: activity.detail || "",
        actor: activity.actor,
      });
    }
  }

  /**
   * Create new booking with memory fallback
   */
  async createBooking(booking: any): Promise<any> {
    if (isSupabaseConfigured()) {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from("bookings")
        .insert(booking)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }
    if (
      memoryBookings.some(
        (existing) =>
          existing.id === booking.id || existing.code === booking.code,
      )
    )
      throw new Error("Booking already exists");
    if (
      memoryBookings.some(
        (existing) =>
          existing.staff_id === booking.staff_id &&
          existing.status !== "Cancelled" &&
          Date.parse(existing.start_time) < Date.parse(booking.end_time) &&
          Date.parse(existing.end_time) > Date.parse(booking.start_time),
      )
    )
      throw new Error("This appointment time is no longer available");
    memoryBookings.unshift(booking);
    return booking;
  }

  /**
   * List bookings with memory fallback
   */
  async listBookings(): Promise<any[]> {
    if (isSupabaseConfigured()) {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from("bookings")
        .select("*, customer:customers(*), service:services(*), staff:staff(*)")
        .order("start_time", { ascending: true });
      if (error) throw new Error(error.message);
      return data;
    }
    return memoryBookings;
  }

  /**
   * Get booking with memory fallback
   */
  async getBooking(identifier: string): Promise<any | null> {
    if (isSupabaseConfigured()) {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from("bookings")
        .select(
          "*, customer:customers(*), service:services(*), staff:staff(*), activity:booking_activity(*)",
        )
        .or(`id.eq.${identifier},code.eq.${identifier}`)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    }
    return (
      memoryBookings.find(
        (b) => b.id === identifier || b.code === identifier,
      ) || null
    );
  }

  /**
   * Update booking with memory fallback
   */
  async updateBooking(identifier: string, updates: any): Promise<any | null> {
    if (isSupabaseConfigured()) {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from("bookings")
        .update({ ...updates, updated_at: new Date().toISOString() })
        .or(`id.eq.${identifier},code.eq.${identifier}`)
        .select()
        .single();
      if (error) throw new Error(error.message);
      return data;
    }
    const idx = memoryBookings.findIndex(
      (b) => b.id === identifier || b.code === identifier,
    );
    if (idx !== -1) {
      memoryBookings[idx] = {
        ...memoryBookings[idx],
        ...updates,
        updated_at: new Date().toISOString(),
      };
      return memoryBookings[idx];
    }
    return null;
  }
}

export const db = new DatabaseService();
