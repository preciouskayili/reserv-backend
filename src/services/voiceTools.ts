import { randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../domain/workspace.js";
import type { AppState, Booking, Service, StaffMember } from "../domain/model.js";
import { workspaces, type Snapshot } from "./workspaces.js";
import { changeReservation, checkSlot, createReservation, phoneKey } from "./reservations.js";

/** The verified call a tool request belongs to. Only the phone network sets these values, never the caller. */
export interface VoiceCallContext {
  businessId: string;
  callId: string;
  direction: "inbound" | "outbound";
  /** The customer's side of the call: the caller for inbound calls, the dialled number for outbound. */
  customerPhone?: string;
  bookingId?: string;
}

export type ToolResult = Record<string, unknown>;

// Appointments are scheduled in WAT (UTC+01:00), matching the rest of the application.
const OFFSET = "+01:00";
const stamp = (local: string) => Date.parse(`${local.length === 16 ? `${local}:00` : local}${OFFSET}`);
const localNow = (now: number) => new Date(now + 3600000).toISOString().slice(0, 16);
const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", weekday: "long", day: "numeric", month: "long" });
const timeFormat = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Lagos", hour: "numeric", minute: "2-digit" });
export const spokenTime = (local: string) => `${dayFormat.format(stamp(local))}, ${timeFormat.format(stamp(local))}`;
const naira = (amount: number) => `₦${amount.toLocaleString("en-NG")}`;
const ACTIVE = ["Confirmed", "Pending", "Needs confirmation", "Rescheduled"];

const dateArg = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD for dates");
const timeArg = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:00)?$/, "Use YYYY-MM-DDTHH:MM for times");
const clockArg = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM for times of day");
const codeArg = z.string().trim().transform(v => v.replace(/[\s-]/g, "").toUpperCase()).pipe(z.string().regex(/^[A-Z0-9]{12}$/, "Booking references are 12 letters and numbers"));

/** Resolves a spoken service name (or id) to one active service. */
function findService(state: AppState, value: string): Service {
  const active = state.services.filter(s => s.active);
  const wanted = value.trim().toLowerCase();
  const exact = active.find(s => s.id === value || s.name.toLowerCase() === wanted);
  if (exact) return exact;
  const partial = active.filter(s => s.name.toLowerCase().includes(wanted) || (wanted.length > 3 && wanted.includes(s.name.toLowerCase())));
  if (partial.length === 1) return partial[0];
  const names = (partial.length ? partial : active).map(s => s.name).join(", ");
  throw new HttpError(400, partial.length ? `Several services match "${value}": ${names}. Ask which one.` : `No service called "${value}". Available services: ${names}.`);
}

function findStaff(state: AppState, service: Service, value?: string): StaffMember | undefined {
  if (!value?.trim()) return undefined;
  const eligible = state.staff.filter(m => service.staffIds.includes(m.id));
  const wanted = value.trim().toLowerCase();
  const match = eligible.find(m => m.id === value || m.name.toLowerCase() === wanted)
    ?? eligible.find(m => m.name.toLowerCase().split(/\s+/).includes(wanted) || m.name.toLowerCase().includes(wanted));
  if (!match) throw new HttpError(400, `${value} does not offer ${service.name}. Specialists for it: ${eligible.map(m => m.name).join(", ") || "none"}.`);
  return match;
}

/** Start times (WAT, YYYY-MM-DDTHH:MM) on a date, with the specialists free at each. */
export function openSlots(snapshot: Snapshot, service: Service, date: string, staff?: StaffMember, earliest?: string, latest?: string) {
  const { state } = snapshot;
  const hours = state.business.hours[(new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7];
  if (!hours || hours.closed) return [];
  const minutes = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
  const people = staff ? [staff] : state.staff.filter(m => service.staffIds.includes(m.id));
  const slots: { start: string; staff: StaffMember[] }[] = [];
  for (let m = minutes(hours.open); m + service.duration <= minutes(hours.close); m += state.business.rules.slotMinutes) {
    const clock = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    if ((earliest && clock < earliest) || (latest && clock > latest)) continue;
    const free = people.filter(person => {
      try { checkSlot(snapshot, { serviceId: service.id, staffId: person.id, startTime: `${date}T${clock}:00` }); return true; }
      catch { return false; }
    });
    if (free.length) slots.push({ start: `${date}T${clock}`, staff: free });
  }
  return slots;
}

function bookingSummary(state: AppState, booking: Booking) {
  const service = state.services.find(s => s.id === booking.serviceId);
  const staff = state.staff.find(m => m.id === booking.staffId);
  return {
    booking_reference: booking.code,
    service: service?.name ?? "Service",
    specialist: staff?.name,
    start_time: booking.startTime.slice(0, 16),
    when: spokenTime(booking.startTime.slice(0, 16)),
    status: booking.status,
  };
}

function paymentSummary(state: AppState, booking: Booking) {
  const payments = (state.payments ?? []).filter(p => p.bookingId === booking.id);
  const paid = payments.filter(p => p.status === "approved" && !p.disputed).reduce((sum, p) => sum + Math.max(0, p.amount - (p.refundedAmount ?? 0)), 0);
  const total = booking.totalAmount ?? 0, required = booking.requiredAmount ?? total;
  return {
    total_price: naira(total),
    amount_required_before_appointment: naira(required),
    amount_paid: naira(paid),
    outstanding_to_secure_booking: naira(Math.max(0, required - paid)),
    receipt_under_review: payments.some(p => p.status === "review"),
    payment_policy: state.business.depositPolicy,
  };
}

/** Retries a read-modify-save when another session saved the workspace first. */
async function withLatest<T>(businessId: string, change: (snapshot: Snapshot) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const snapshot = await workspaces.read(businessId);
    try { return await change(snapshot); }
    catch (error) {
      const stale = error instanceof HttpError && error.status === 409 && /changed in another session/.test(error.message);
      if (!stale || attempt >= 2) throw error;
    }
  }
}

function logAgent(state: AppState, kind: "created" | "rescheduled" | "confirmed", title: string, detail: string) {
  state.agentActivity = [{ id: randomUUID(), kind, title, detail, time: new Date().toISOString() }, ...state.agentActivity].slice(0, 500);
}

/** Bookings the caller may manage: matching phone number, or the booking an outbound call is about. */
function callerBookings(state: AppState, ctx: VoiceCallContext, now: number) {
  const phone = ctx.customerPhone ? phoneKey(ctx.customerPhone) : undefined;
  const customers = new Set(state.customers.filter(c => phone && phoneKey(c.phone) === phone).map(c => c.id));
  return state.bookings
    .filter(b => (customers.has(b.customerId) || b.id === ctx.bookingId) && ACTIVE.includes(b.status) && Date.parse(`${b.endTime}${OFFSET}`) > now)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

function bookingByCode(state: AppState, code: string) {
  const booking = state.bookings.find(b => b.code === code);
  if (!booking) throw new HttpError(404, "No booking has that reference. Check it with the caller, or use find_my_bookings.");
  return booking;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run: (ctx: VoiceCallContext, args: unknown, now: number) => Promise<ToolResult>;
}

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });

export const voiceTools: ToolDefinition[] = [
  {
    name: "get_business_info",
    description: "Get the business's address and directions, opening hours, phone number, policies, FAQs, and the current date and time. Use for any question about location, hours or policies, and whenever you need today's date.",
    parameters: object({}),
    async run(ctx, _args, now) {
      const { state } = await workspaces.read(ctx.businessId);
      const b = state.business;
      return {
        name: b.name, description: b.description, address: b.address, phone: b.phone,
        opening_hours: b.hours.map(h => h.closed ? `${h.day}: closed` : `${h.day}: ${h.open}–${h.close}`),
        booking_policy: b.bookingPolicy, cancellation_policy: b.cancellationPolicy, payment_policy: b.depositPolicy,
        faqs: b.faqs, current_local_time: localNow(now), today: spokenTime(localNow(now)).split(",")[0], timezone: "West Africa Time (UTC+1)",
        booking_notice: `Bookings need at least ${b.rules.minNoticeMinutes} minutes' notice and can be made up to ${b.rules.maxAdvanceDays} days ahead.`,
      };
    },
  },
  {
    name: "list_services",
    description: "List the services offered, with prices in Naira, durations, deposits and which specialists provide each.",
    parameters: object({}),
    async run(ctx) {
      const { state } = await workspaces.read(ctx.businessId);
      return {
        services: state.services.filter(s => s.active).map(s => ({
          name: s.name, description: s.description, duration_minutes: s.duration, price: naira(s.price),
          deposit: s.deposit ? naira(s.deposit) : "none", specialists: state.staff.filter(m => s.staffIds.includes(m.id)).map(m => m.name),
        })),
      };
    },
  },
  {
    name: "check_availability",
    description: "Find open appointment times for a service. Give a date to see that day, or omit it to find the next days with openings. Always check before offering or booking a time.",
    parameters: object({
      service: str("Service name as listed by list_services"),
      date: str("Optional date, YYYY-MM-DD"),
      specialist: str("Optional specialist name"),
      earliest_time: str("Optional earliest start, HH:MM 24-hour"),
      latest_time: str("Optional latest start, HH:MM 24-hour"),
    }, ["service"]),
    async run(ctx, raw, now) {
      const args = z.object({ service: z.string().min(1), date: dateArg.optional(), specialist: z.string().optional(), earliest_time: clockArg.optional(), latest_time: clockArg.optional() }).parse(raw);
      const snapshot = await workspaces.read(ctx.businessId);
      const service = findService(snapshot.state, args.service);
      const staff = findStaff(snapshot.state, service, args.specialist);
      const describe = (slots: ReturnType<typeof openSlots>, limit: number) => slots.slice(0, limit).map(s => ({ start_time: s.start, when: spokenTime(s.start), specialists: s.staff.map(m => m.name) }));
      if (args.date) {
        const slots = openSlots(snapshot, service, args.date, staff, args.earliest_time, args.latest_time);
        return { service: service.name, date: args.date, open_times: describe(slots, 12), more_available: Math.max(0, slots.length - 12), ...(slots.length ? {} : { note: "No openings that day. Try another date or omit the date." }) };
      }
      const days = [];
      const today = localNow(now).slice(0, 10);
      const horizon = Math.min(snapshot.state.business.rules.maxAdvanceDays, 30);
      for (let offset = 0; offset <= horizon && days.length < 3; offset++) {
        const date = new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
        const slots = openSlots(snapshot, service, date, staff, args.earliest_time, args.latest_time);
        if (slots.length) days.push({ date, day: spokenTime(slots[0].start).split(",")[0], open_times: describe(slots, 6), more_available: Math.max(0, slots.length - 6) });
      }
      return { service: service.name, next_openings: days, ...(days.length ? {} : { note: "No openings in the booking window." }) };
    },
  },
  {
    name: "create_booking",
    description: "Book an appointment. Only call after checking availability, reading the service, day, time and name back to the caller, and hearing them agree. Uses the caller's phone number unless they give another.",
    parameters: object({
      service: str("Service name"),
      start_time: str("Start time from check_availability, YYYY-MM-DDTHH:MM"),
      customer_name: str("Caller's full name"),
      specialist: str("Optional specialist name; omit to use any available specialist"),
      phone: str("Optional phone number with country code, only if the caller wants a different number from the one they are calling from"),
      notes: str("Optional short note for the business"),
    }, ["service", "start_time", "customer_name"]),
    async run(ctx, raw) {
      const args = z.object({ service: z.string().min(1), start_time: timeArg, customer_name: z.string().trim().min(2).max(100), specialist: z.string().optional(), phone: z.string().optional(), notes: z.string().max(500).optional() }).parse(raw);
      const phone = args.phone?.trim() || ctx.customerPhone;
      if (!phone) throw new HttpError(400, "The caller's number is hidden. Ask for a phone number with country code and pass it as phone.");
      const startTime = `${args.start_time.slice(0, 16)}:00`;
      return withLatest(ctx.businessId, async snapshot => {
        const service = findService(snapshot.state, args.service);
        const staff = findStaff(snapshot.state, service, args.specialist)
          ?? openSlots(snapshot, service, startTime.slice(0, 10)).find(s => s.start === startTime.slice(0, 16))?.staff[0];
        if (!staff) throw new HttpError(409, "That time is not available. Check availability again and offer another time.");
        logAgent(snapshot.state, "created", "Booked by phone", `${args.customer_name} · ${service.name} · ${spokenTime(startTime.slice(0, 16))}`);
        const { snapshot: saved, booking } = await createReservation(snapshot, { serviceId: service.id, staffId: staff.id, startTime, name: args.customer_name, phone, notes: args.notes ?? "" }, "agent");
        return {
          booked: true, ...bookingSummary(saved.state, booking),
          ...(booking.requiredAmount ? { payment: paymentSummary(saved.state, booking) } : {}),
          instruction: "Tell the caller they are booked and read the booking reference slowly in groups of four characters.",
        };
      });
    },
  },
  {
    name: "find_my_bookings",
    description: "Find the caller's upcoming bookings using the number they are calling from (or the booking this call is about). Use before cancelling, rescheduling or answering questions about an existing booking.",
    parameters: object({}),
    async run(ctx, _args, now) {
      const { state } = await workspaces.read(ctx.businessId);
      const bookings = callerBookings(state, ctx, now);
      if (!bookings.length) return { bookings: [], note: ctx.customerPhone ? "No upcoming bookings for this phone number. Ask for their booking reference instead." : "The caller's number is hidden. Ask for their booking reference." };
      return { customer_name: state.customers.find(c => c.id === bookings[0].customerId)?.name, bookings: bookings.slice(0, 5).map(b => bookingSummary(state, b)) };
    },
  },
  {
    name: "cancel_booking",
    description: "Cancel a booking. Only call after reading the booking back to the caller and hearing them confirm they want to cancel. Mention the cancellation policy first.",
    parameters: object({ booking_reference: str("12-character booking reference") }, ["booking_reference"]),
    async run(ctx, raw) {
      const { booking_reference } = z.object({ booking_reference: codeArg }).parse(raw);
      return withLatest(ctx.businessId, async snapshot => {
        const booking = bookingByCode(snapshot.state, booking_reference);
        logAgent(snapshot.state, "rescheduled", "Cancelled by phone", `${bookingSummary(snapshot.state, booking).service} · ${spokenTime(booking.startTime.slice(0, 16))}`);
        const saved = await changeReservation(snapshot, booking_reference, { action: "cancel" }, "agent");
        return { cancelled: true, ...bookingSummary(saved.state, bookingByCode(saved.state, booking_reference)) };
      });
    },
  },
  {
    name: "reschedule_booking",
    description: "Move a booking to a new time. Check availability first, read the new time back and get the caller's agreement before calling.",
    parameters: object({
      booking_reference: str("12-character booking reference"),
      new_start_time: str("New start time from check_availability, YYYY-MM-DDTHH:MM"),
      specialist: str("Optional specialist name; omit to keep the current specialist if free, otherwise any available one"),
    }, ["booking_reference", "new_start_time"]),
    async run(ctx, raw) {
      const args = z.object({ booking_reference: codeArg, new_start_time: timeArg, specialist: z.string().optional() }).parse(raw);
      const startTime = `${args.new_start_time.slice(0, 16)}:00`;
      return withLatest(ctx.businessId, async snapshot => {
        const booking = bookingByCode(snapshot.state, args.booking_reference);
        const service = snapshot.state.services.find(s => s.id === booking.serviceId);
        if (!service) throw new HttpError(409, "This booking's service is no longer offered. Transfer the caller or ask them to contact the business.");
        const named = findStaff(snapshot.state, service, args.specialist);
        const free = (id: string) => { try { checkSlot(snapshot, { serviceId: service.id, staffId: id, startTime }, booking.id); return true; } catch { return false; } };
        const staffId = named?.id ?? (free(booking.staffId) ? booking.staffId : service.staffIds.find(free));
        if (!staffId) throw new HttpError(409, "That time is not available. Check availability again and offer another time.");
        const previous = spokenTime(booking.startTime.slice(0, 16));
        logAgent(snapshot.state, "rescheduled", "Rescheduled by phone", `${service.name} · ${previous} → ${spokenTime(startTime.slice(0, 16))}`);
        const saved = await changeReservation(snapshot, args.booking_reference, { action: "reschedule", staffId, startTime }, "agent");
        return { rescheduled: true, previous_time: previous, ...bookingSummary(saved.state, bookingByCode(saved.state, args.booking_reference)) };
      });
    },
  },
  {
    name: "get_payment_status",
    description: "Check how much has been paid on a booking and what is still owed. You cannot take payments on the phone.",
    parameters: object({ booking_reference: str("12-character booking reference") }, ["booking_reference"]),
    async run(ctx, raw) {
      const { booking_reference } = z.object({ booking_reference: codeArg }).parse(raw);
      const { state } = await workspaces.read(ctx.businessId);
      const booking = bookingByCode(state, booking_reference);
      return { ...bookingSummary(state, booking), ...paymentSummary(state, booking), how_to_pay: "The customer can pay or upload a transfer receipt from their booking page. Never take card details on the phone." };
    },
  },
  {
    name: "confirm_attendance",
    description: "Record that the customer confirmed they will attend. Use on reminder calls when the customer says they are coming.",
    parameters: object({ booking_reference: str("12-character booking reference") }, ["booking_reference"]),
    async run(ctx, raw) {
      const { booking_reference } = z.object({ booking_reference: codeArg }).parse(raw);
      return withLatest(ctx.businessId, async snapshot => {
        const booking = bookingByCode(snapshot.state, booking_reference);
        if (!ACTIVE.includes(booking.status)) throw new HttpError(409, `This booking is ${booking.status.toLowerCase()}.`);
        booking.activity.push({ id: randomUUID(), title: "Customer confirmed attendance", detail: "Confirmed by phone", time: new Date().toISOString(), actor: "agent" });
        // Payment-dependent statuses stay as they are; attendance only resolves an explicit confirmation request.
        if (booking.status === "Needs confirmation") booking.status = "Confirmed";
        logAgent(snapshot.state, "confirmed", "Attendance confirmed by phone", `${bookingSummary(snapshot.state, booking).service} · ${spokenTime(booking.startTime.slice(0, 16))}`);
        const saved = await workspaces.save(ctx.businessId, snapshot.revision, snapshot.state);
        return { confirmed: true, ...bookingSummary(saved.state, bookingByCode(saved.state, booking_reference)) };
      });
    },
  },
];

/** Runs a tool and converts expected failures into messages the agent can relay. */
export async function runVoiceTool(name: string, ctx: VoiceCallContext, args: unknown, now = Date.now()): Promise<ToolResult> {
  const tool = voiceTools.find(t => t.name === name);
  if (!tool) return { error: "Unknown tool" };
  try {
    return await tool.run(ctx, args ?? {}, now);
  } catch (error) {
    if (error instanceof z.ZodError) return { error: error.issues[0]?.message ?? "Invalid details" };
    if (error instanceof HttpError && error.status < 500) return { error: error.message };
    console.error("[Voice tools] Tool failed", { tool: name, businessId: ctx.businessId, callId: ctx.callId });
    return { error: "The booking system is temporarily unavailable. Apologise and offer to transfer the caller or ask them to call back shortly." };
  }
}
