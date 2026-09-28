import type { AppState, Booking } from "../domain/model.js";

// Appointments are scheduled in WAT (UTC+01:00), matching the rest of the application.
const OFFSET = "+01:00";
const stamp = (local: string) => Date.parse(`${local.length === 16 ? `${local}:00` : local}${OFFSET}`);
export const localNow = (now: number) => new Date(now + 3600000).toISOString().slice(0, 16);
const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", weekday: "long", day: "numeric", month: "long" });
const timeFormat = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Lagos", hour: "numeric", minute: "2-digit" });
export const spokenTime = (local: string) => `${dayFormat.format(stamp(local))}, ${timeFormat.format(stamp(local))}`;
export const naira = (amount: number) => `₦${amount.toLocaleString("en-NG")}`;
const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** The same facts get_business_info returns, shared so preloaded call context and tools never disagree. */
export function businessInfo(state: AppState, now: number) {
  const b = state.business;
  return {
    name: b.name, description: b.description, address: b.address, phone: b.phone,
    opening_hours: b.hours.map(h => h.closed ? `${h.day}: closed` : `${h.day}: ${h.open}–${h.close}`),
    booking_policy: b.bookingPolicy, cancellation_policy: b.cancellationPolicy, payment_policy: b.depositPolicy,
    faqs: b.faqs, current_local_time: localNow(now), today: spokenTime(localNow(now)).split(",")[0], timezone: "West Africa Time (UTC+1)",
    booking_notice: `Bookings need at least ${b.rules.minNoticeMinutes} minutes' notice and can be made up to ${b.rules.maxAdvanceDays} days ahead.`,
  };
}

export function serviceCatalog(state: Pick<AppState, "services" | "staff">) {
  return state.services.filter(s => s.active).map(s => ({
    name: s.name, description: s.description, duration_minutes: s.duration, price: naira(s.price),
    deposit: s.deposit ? naira(s.deposit) : "none", specialists: state.staff.filter(m => s.staffIds.includes(m.id)).map(m => m.name),
    amount_required_to_secure_booking: naira(s.deposit || s.price),
  }));
}

export function bookingSummary(state: AppState, booking: Booking) {
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

export function paymentSummary(state: AppState, booking: Booking) {
  const payments = (state.payments ?? []).filter(p => p.bookingId === booking.id);
  const paid = payments.filter(p => p.status === "approved" && !p.disputed).reduce((sum, p) => sum + Math.max(0, p.amount - (p.refundedAmount ?? 0)), 0);
  const service = state.services.find(s => s.id === booking.serviceId);
  const total = booking.totalAmount ?? service?.price ?? 0, required = booking.requiredAmount ?? Math.min(total, service?.deposit || total);
  return {
    total_price: naira(total),
    amount_required_before_appointment: naira(required),
    amount_paid: naira(paid),
    outstanding_to_secure_booking: naira(Math.max(0, required - paid)),
    remaining_balance: naira(Math.max(0, total - paid)),
    receipt_under_review: payments.some(p => p.status === "review"),
    payment_policy: state.business.depositPolicy,
  };
}

// Preloaded text lets the agent answer common questions without a tool round trip mid-conversation.
// Limits keep the prompt small enough for fast responses on businesses with long FAQ or service lists.

/** Business facts that change only when the owner edits them; stored as agent defaults and re-synced on change. */
export function businessBrief(state: Pick<AppState, "business">): string {
  const b = state.business;
  const lines = [
    `Address: ${b.address || "not provided"}`,
    `Phone: ${b.phone || "not provided"}`,
    `Opening hours (West Africa Time): ${b.hours.map(h => h.closed ? `${h.day} closed` : `${h.day} ${h.open}–${h.close}`).join("; ")}`,
    `Booking notice: at least ${b.rules.minNoticeMinutes} minutes ahead, up to ${b.rules.maxAdvanceDays} days ahead`,
    b.description && `About: ${clip(b.description, 400)}`,
    b.bookingPolicy && `Booking policy: ${clip(b.bookingPolicy, 400)}`,
    b.cancellationPolicy && `Cancellation policy: ${clip(b.cancellationPolicy, 400)}`,
    b.depositPolicy && `Payment policy: ${clip(b.depositPolicy, 400)}`,
    ...b.faqs.slice(0, 15).map(f => `FAQ: ${clip(f.question, 200)} Answer: ${clip(f.answer, 400)}`),
  ];
  return lines.filter(Boolean).join("\n");
}

export function servicesBrief(state: Pick<AppState, "services" | "staff">): string {
  const services = serviceCatalog(state);
  if (!services.length) return "No services are currently offered.";
  const lines = services.slice(0, 30).map(s =>
    `${s.name}: ${s.price}, ${s.duration_minutes} minutes, ${s.deposit === "none" ? "no deposit, full price secures it" : `deposit ${s.deposit}`}` +
    `${s.specialists.length ? `, specialists ${s.specialists.join(", ")}` : ""}${s.description ? `. ${clip(s.description, 160)}` : ""}`);
  if (services.length > 30) lines.push(`${services.length - 30} more services: use list_services.`);
  return lines.join("\n");
}

/** Booking and payment state read just before dialling, so the opening purpose needs no lookup. */
export function bookingBrief(state: AppState, booking: Booking): string {
  const summary = bookingSummary(state, booking), payment = paymentSummary(state, booking);
  return [
    `Status ${summary.status}`,
    summary.specialist && `specialist ${summary.specialist}`,
    `total price ${payment.total_price}`,
    `required to secure ${payment.amount_required_before_appointment}`,
    `paid ${payment.amount_paid}`,
    `still needed to secure ${payment.outstanding_to_secure_booking}`,
    `remaining balance ${payment.remaining_balance}`,
    `receipt under review: ${payment.receipt_under_review ? "yes" : "no"}`,
  ].filter(Boolean).join("; ");
}

/** Spoken current date and time in WAT, for example "Friday 25 September, 3:40 PM". */
export const currentTime = (now: number) => spokenTime(localNow(now));
