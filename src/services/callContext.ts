import type { AppState, Booking } from "../domain/model.js";
import { HttpError } from "../domain/workspace.js";
import { normalizeE164 } from "../lib/aethex.js";
import { bookingBrief, currentTime } from "./callBriefing.js";

export type OutboundCallType = "reminder" | "confirmation" | "unpaid_checkin" | "manual";
export const appointmentTimestamp = (value: string) => Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}+01:00`);
export const inboundOpening = (businessName: string) => `Hello, thank you for calling ${businessName}. How can I help you today?`;
export const outboundOpening = (businessName: string, customerName?: string) =>
  `Hello, this is the virtual receptionist calling from ${businessName}. ${customerName?.trim() ? `Am I speaking with ${customerName.trim()}?` : "May I ask who I'm speaking with?"}`;

export function callsBlocked(state: AppState, phone: string): boolean {
  return state.customers.some(customer => {
    try { return customer.voiceCallsBlocked && normalizeE164(customer.phone) === normalizeE164(phone); }
    catch { return false; }
  });
}

/** Both scheduled and on-demand calls use the saved booking, never browser-supplied labels. */
export function bookingCallContext(state: AppState, booking: Booking, type: OutboundCallType, now = Date.now()) {
  const customer = state.customers.find(c => c.id === booking.customerId);
  const service = state.services.find(s => s.id === booking.serviceId);
  const starts = appointmentTimestamp(booking.startTime);
  if (!customer || !service) throw new HttpError(409, "This reservation is missing its customer or service.");
  if (!["Confirmed", "Pending", "Needs confirmation", "Rescheduled"].includes(booking.status) || !Number.isFinite(starts) || starts <= now)
    throw new HttpError(409, "Only upcoming, active reservations can receive calls.");
  if (callsBlocked(state, customer.phone)) throw new HttpError(409, "This customer has asked not to receive calls.");
  let toNumber: string;
  try { toNumber = normalizeE164(customer.phone); }
  catch { throw new HttpError(400, "Update the customer's phone number before calling."); }
  return {
    toNumber,
    dynamicVariables: {
      opening_message: outboundOpening(state.business.name, customer.name),
      business_name: state.business.name,
      customer_name: customer.name,
      service_name: service.name,
      appointment_date: new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(starts),
      appointment_time: new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Lagos", hour: "numeric", minute: "2-digit" }).format(starts),
      call_type: type,
      booking_code: booking.code,
      test_call: false,
      // Read at dial time so the agent can state the reason for calling without a mid-call lookup.
      booking_details: bookingBrief(state, booking),
      current_time: currentTime(now),
    },
  };
}
