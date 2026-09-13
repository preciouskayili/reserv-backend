import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../domain/workspace.js";
import { workspaces, type Snapshot } from "./workspaces.js";
import type { Booking } from "../domain/model.js";

export const bookingInput = z
  .object({
    serviceId: z.string(),
    staffId: z.string(),
    startTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/),
    name: z.string().trim().min(2).max(100),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[\d\s()-]{10,20}$/),
    notes: z.string().max(2000).default(""),
  })
  .strict();

const stamp = (s: string) => Date.parse(`${s}+01:00`);

export function checkSlot(
  snapshot: Snapshot,
  input: { serviceId: string; staffId: string; startTime: string },
  exclude?: string,
) {
  const { state } = snapshot;
  const service = state.services.find(
    (s) => s.id === input.serviceId && s.active,
  );
  if (!service || !service.staffIds.includes(input.staffId))
    throw new HttpError(400, "Choose an available service and specialist");
  const start = stamp(input.startTime),
    now = Date.now();
  if (
    !Number.isFinite(start) ||
    start < now + state.business.rules.minNoticeMinutes * 60000 ||
    start > now + state.business.rules.maxAdvanceDays * 86400000
  )
    throw new HttpError(400, "Choose a time within the booking window");
  const localDay = new Date(
    `${input.startTime.slice(0, 10)}T12:00:00Z`,
  ).getUTCDay();

  const hours = state.business.hours[(localDay + 6) % 7];
  const minutes =
    Number(input.startTime.slice(11, 13)) * 60 +
    Number(input.startTime.slice(14, 16));

  const toMinutes = (v: string) =>
    Number(v.slice(0, 2)) * 60 + Number(v.slice(3));

  if (
    hours.closed ||
    minutes < toMinutes(hours.open) ||
    minutes + service.duration > toMinutes(hours.close) ||
    (minutes - toMinutes(hours.open)) % state.business.rules.slotMinutes !== 0
  )
    throw new HttpError(400, "Choose a time during business hours");

  const end = new Date(
    Date.parse(input.startTime + "Z") + service.duration * 60000,
  )
    .toISOString()
    .slice(0, 19);

  if (
    state.bookings.some(
      (b) =>
        b.id !== exclude &&
        b.staffId === input.staffId &&
        !["Cancelled", "Completed"].includes(b.status) &&
        stamp(b.startTime) < stamp(end) &&
        stamp(b.endTime) > start,
    )
  )
    throw new HttpError(409, "That time was just booked. Choose another time.");
  return { service, end };
}

export async function createReservation(snapshot: Snapshot, raw: unknown) {
  const parsed = bookingInput.safeParse(raw);
  if (!parsed.success)
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message || "Check your reservation details",
    );

  const input = parsed.data,
    { service, end } = checkSlot(snapshot, input),
    state = snapshot.state;

  const phone = input.phone.replace(/[^\d+]/g, "");

  let customer = state.customers.find(
    (c) => c.phone.replace(/[^\d+]/g, "") === phone && c.name === input.name,
  );

  // A public caller cannot overwrite an existing customer's profile.
  if (!customer) {
    customer = {
      id: randomUUID(),
      name: input.name,
      phone: input.phone,
      notes: "",
    };
    state.customers.push(customer);
  }

  let code: string;

  do {
    code = Array.from(
      { length: 12 },
      () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[randomInt(31)],
    ).join("");
  } while (state.bookings.some((b) => b.code === code));

  const booking: Booking = {
    id: randomUUID(),
    code,
    businessId: state.business.id,
    customerId: customer.id,
    serviceId: service.id,
    staffId: input.staffId,
    startTime: input.startTime,
    endTime: end,
    status: service.price === 0 ? "Confirmed" : "Pending",
    notes: input.notes,
    createdAt: new Date().toISOString(),
    totalAmount: service.price,
    requiredAmount: service.deposit || service.price,
    activity: [
      {
        id: randomUUID(),
        title: "Reservation created",
        time: new Date().toISOString(),
        actor: "customer",
      },
    ],
  };

  state.bookings.push(booking);

  const result = await workspaces.save(
    state.business.id,
    snapshot.revision,
    state,
  );

  return { snapshot: result, booking };
}
export async function changeReservation(
  snapshot: Snapshot,
  code: string,
  body: unknown,
) {
  const schema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("cancel") }).strict(),
    z
      .object({
        action: z.literal("reschedule"),
        staffId: z.string(),
        startTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/),
      })
      .strict(),
  ]);

  const input = schema.safeParse(body);

  if (!input.success) throw new HttpError(400, "Invalid reservation change");

  const booking = snapshot.state.bookings.find((b) => b.code === code);

  if (!booking) throw new HttpError(404, "Reservation not found");

  if (["Cancelled", "Completed"].includes(booking.status))
    throw new HttpError(409, "This reservation can no longer be changed");

  if (input.data.action === "cancel") booking.status = "Cancelled";
  else {
    const slot = checkSlot(
      snapshot,
      { serviceId: booking.serviceId, ...input.data },
      booking.id,
    );
    booking.staffId = input.data.staffId;
    booking.startTime = input.data.startTime;
    booking.endTime = slot.end;
    booking.status = "Rescheduled";
  }
  booking.activity.push({
    id: randomUUID(),
    title:
      input.data.action === "cancel"
        ? "Reservation cancelled"
        : "Reservation rescheduled",
    time: new Date().toISOString(),
    actor: "customer",
  });

  return workspaces.save(
    snapshot.state.business.id,
    snapshot.revision,
    snapshot.state,
  );
}
