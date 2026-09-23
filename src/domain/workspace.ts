import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppState } from "./model.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const text = z.string().max(5000);
const imageUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => value.startsWith("https://"), "Choose a secure image URL");
const businessIcon = z.enum([
  "store",
  "factory",
  "warehouse",
  "office",
  "cottage",
  "community",
  "estate",
  "hospital",
  "bank",
  "pavilion",
  "flower",
  "scissors",
  "sparkles",
]);
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timestamp = z
  .string()
  .refine((v) => Number.isFinite(Date.parse(v)), "Invalid date");
const activity = z.object({
  id,
  title: text,
  detail: text.optional(),
  time: timestamp,
  actor: z.enum(["owner", "customer", "agent"]),
});
export const stateSchema = z.object({
  business: z.object({
    voice: z
      .object({
        country: z.string().regex(/^[A-Z]{2}$/),
        status: z.enum([
          "queued",
          "provisioning",
          "active",
          "failed",
          "needs_review",
        ]),
        number: text.optional(),
        agentId: text.optional(),
        twilioSid: text.optional(),
        aethexNumberId: text.optional(),
        selectedNumber: text.optional(),
        purchaseStarted: z.boolean().optional(),
        agentStarted: z.boolean().optional(),
        lockToken: text.optional(),
        lockUntil: timestamp.optional(),
        error: text.optional(),
        agentConfig: z.string().max(64).optional(),
      })
      .optional(),
    logoUrl: imageUrl.optional(),
    icon: businessIcon.optional(),
    id,
    name: z.string().trim().min(2).max(100),
    slug: z
      .string()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .min(3)
      .max(60),
    owner: text,
    category: text,
    description: text,
    phone: text,
    address: text,
    hours: z
      .array(
        z
          .object({
            day: z.string(),
            open: clock,
            close: clock,
            closed: z.boolean(),
          })
          .refine(
            (v) => v.closed || v.close > v.open,
            "Closing time must follow opening time",
          ),
      )
      .length(7),
    bookingPolicy: text,
    cancellationPolicy: text,
    depositPolicy: text,
    faqs: z.array(z.object({ question: text, answer: text })).max(30),
    rules: z.object({
      minNoticeMinutes: z.number().int().min(0).max(43200),
      maxAdvanceDays: z.number().int().min(1).max(365),
      slotMinutes: z.number().int().min(5).max(240),
    }),
  }),
  staff: z
    .array(
      z.object({
        id,
        name: z.string().trim().min(1).max(100),
        role: text,
        initials: z.string().max(10),
        avatarUrl: imageUrl.optional(),
      }),
    )
    .max(200),
  services: z
    .array(
      z
        .object({
          id,
          name: z.string().trim().min(1).max(150),
          description: text,
          duration: z.number().int().min(5).max(1440),
          price: z.number().min(0).max(100000000),
          deposit: z.number().min(0),
          staffIds: z.array(id),
          active: z.boolean(),
        })
        .refine((v) => v.deposit <= v.price, "Deposit exceeds price"),
    )
    .max(500),
  customers: z
    .array(z.object({ id, name: text, phone: text, notes: text }))
    .max(20000),
  bookings: z
    .array(
      z.object({
        id,
        code: z.string().regex(/^[A-Z0-9]{12}$/),
        businessId: id,
        customerId: id,
        serviceId: id,
        staffId: id,
        startTime: timestamp,
        endTime: timestamp,
        status: z.enum([
          "Confirmed",
          "Pending",
          "Needs confirmation",
          "Cancelled",
          "Completed",
          "Rescheduled",
        ]),
        notes: text,
        createdAt: timestamp,
        reminder: text.optional(),
        totalAmount: z.number().min(0),
        requiredAmount: z.number().min(0),
        activity: z.array(activity).max(1000),
      }),
    )
    .max(20000),
  payments: z
    .array(
      z.object({
        id,
        bookingId: id,
        amount: z.number().positive(),
        method: z.enum(["gateway", "transfer"]),
        provider: z.enum(["paystack", "stripe"]).optional(),
        reference: text.optional(),
        needsReview: z.boolean().optional(),
        refundedAmount: z.number().min(0).optional(),
        disputed: z.boolean().optional(),
        status: z.enum(["review", "approved", "rejected"]),
        createdAt: timestamp,
        reviewedAt: timestamp.optional(),
        rejectionReason: text.optional(),
        receiptId: id.optional(),
        receiptName: text.optional(),
      }),
    )
    .default([]),
  agentActivity: z.array(
    z.object({
      id,
      title: text,
      detail: text,
      time: timestamp,
      kind: z.enum(["confirmed", "rescheduled", "created"]),
    }),
  ),
  settings: z.object({
    ownerStaffId: id.optional(),
    reminders: z.boolean(),
    confirmations: z.boolean(),
    owner: text,
    calls: z
      .object({
        enabled: z.boolean(),
        reminderMinutes: z.number().int().min(5).max(43200),
        unpaidEnabled: z.boolean(),
        unpaidIntervalMinutes: z.number().int().min(5).max(43200),
      })
      .optional(),
  }),
  loaded: z.boolean().default(true),
});

export function validateState(input: unknown, workspaceId: string): AppState {
  const result = stateSchema.safeParse(input);
  if (!result.success)
    throw new HttpError(
      400,
      result.error.issues[0]?.message || "Invalid workspace data",
    );
  const state = result.data;
  if (state.business.id !== workspaceId)
    throw new HttpError(400, "Workspace identity cannot be changed");
  for (const rows of [
    state.staff,
    state.services,
    state.customers,
    state.bookings,
    state.payments,
  ]) {
    if (new Set(rows.map((r) => r.id)).size !== rows.length)
      throw new HttpError(400, "Duplicate record identifiers");
  }
  const staff = new Set(state.staff.map((r) => r.id)),
    customers = new Set(state.customers.map((r) => r.id)),
    services = new Set(state.services.map((r) => r.id)),
    bookings = new Set(state.bookings.map((r) => r.id));
  if (state.services.some((s) => s.staffIds.some((id) => !staff.has(id))))
    throw new HttpError(400, "Service specialist is missing");
  for (const b of state.bookings) {
    if (
      b.businessId !== workspaceId ||
      !staff.has(b.staffId) ||
      !customers.has(b.customerId) ||
      !services.has(b.serviceId) ||
      Date.parse(b.endTime) <= Date.parse(b.startTime) ||
      b.requiredAmount > b.totalAmount
    )
      throw new HttpError(400, "Invalid reservation references or time");
  }
  const active = state.bookings
    .filter((b) => !["Cancelled", "Completed"].includes(b.status))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  const ends = new Map<string, number>();
  for (const b of active) {
    if ((ends.get(b.staffId) ?? 0) > Date.parse(b.startTime))
      throw new HttpError(
        409,
        "That specialist already has a reservation at this time",
      );
    ends.set(b.staffId, Date.parse(b.endTime));
  }
  if (state.payments.some((p) => !bookings.has(p.bookingId)))
    throw new HttpError(400, "Payment reservation is missing");
  return state;
}

export const onboardingSchema = z
  .object({
    voiceCountry: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    avatarUrl: imageUrl.optional(),
    logoUrl: imageUrl.optional(),
    icon: businessIcon.optional(),
    name: z.string().trim().min(2).max(100),
    slug: z
      .string()
      .trim()
      .min(2)
      .max(60)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    owner: z.string().trim().min(2).max(100),
    category: z.string().trim().min(2).max(100),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[\d\s()-]{10,20}$/),
    address: z.string().trim().min(5).max(300),
    serviceName: z.string().trim().min(2).max(150),
    duration: z.number().int().min(5).max(1440),
    price: z.number().min(0).max(100000000),
  })
  .strict();

export function initialState(
  data: z.infer<typeof onboardingSchema>,
  workspaceId = randomUUID(),
): AppState {
  const staffId = randomUUID();
  const slug =
    data.slug?.trim() ||
    data.name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") ||
    "studio";
  return {
    business: {
      id: workspaceId,
      name: data.name,
      voice: data.voiceCountry
        ? { country: data.voiceCountry, status: "queued" }
        : undefined,
      slug: slug.length < 3 ? `${slug}-studio` : slug,
      logoUrl: data.logoUrl,
      icon: data.icon ?? "store",
      owner: data.owner,
      category: data.category,
      phone: data.phone,
      address: data.address,
      description: "",
      hours: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ].map((day, i) => ({
        day,
        open: "09:00",
        close: "17:00",
        closed: i > 4,
      })),
      bookingPolicy: "Please arrive a few minutes before your appointment.",
      cancellationPolicy: "Contact us if your plans change.",
      depositPolicy: "Payment instructions will be provided by the business.",
      faqs: [],
      rules: { minNoticeMinutes: 60, maxAdvanceDays: 30, slotMinutes: 15 },
    },
    staff: [
      {
        id: staffId,
        avatarUrl: data.avatarUrl,
        name: data.owner,
        role: "Owner",
        initials: data.owner
          .split(" ")
          .map((n) => n[0])
          .slice(0, 2)
          .join(""),
      },
    ],
    services: [
      {
        id: randomUUID(),
        name: data.serviceName,
        description: "",
        duration: data.duration,
        price: data.price,
        deposit: 0,
        staffIds: [staffId],
        active: true,
      },
    ],
    customers: [],
    bookings: [],
    payments: [],
    agentActivity: [],
    settings: {
      ownerStaffId: staffId,
      reminders: false,
      confirmations: false,
      owner: data.owner,
      calls: {
        enabled: false,
        reminderMinutes: 120,
        unpaidEnabled: false,
        unpaidIntervalMinutes: 1440,
      },
    },
    loaded: true,
  };
}
