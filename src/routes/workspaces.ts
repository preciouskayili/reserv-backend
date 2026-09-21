import { z } from "zod";
import { numberCountries, requestBusinessNumber, provisionBusinessNumber, publicVoice } from "../services/businessVoice.js";
import { Router } from "express";
import {
  requireAuth,
  type AuthenticatedRequest,
} from "../middleware/requireAuth.js";
import {
  initialState,
  onboardingSchema,
  HttpError,
} from "../domain/workspace.js";
import { workspaces } from "../services/workspaces.js";
const router = Router();
router.use(requireAuth);
router.get("/", async (req: AuthenticatedRequest, res) =>
  res.json({ workspaces: await workspaces.list(req.user!.id) }),
);
router.get("/check-slug", async (req: AuthenticatedRequest, res) => {
  const slug = String(req.query.slug ?? "");
  res.json(await workspaces.checkSlug(slug));
});
router.get("/voice/countries", async (_req, res) => res.json({ countries: await numberCountries() }));
router.get("/:id/voice", async (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id); await workspaces.authorize(req.user!.id, id);
  res.json({ voice: publicVoice((await workspaces.read(id)).state.business.voice) });
});
router.post("/:id/voice", async (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id); await workspaces.authorize(req.user!.id, id, true);
  const country = z.string().regex(/^[A-Z]{2}$/).safeParse(req.body.country);
  if (!country.success) throw new HttpError(400, "Choose a phone-number country.");
  const snapshot = await requestBusinessNumber(id, country.data);
  void provisionBusinessNumber(id).catch(() => console.error("Business phone setup needs review", id));
  res.status(202).json({ voice: publicVoice(snapshot.state.business.voice) });
});
router.post("/", async (req: AuthenticatedRequest, res) => {
  const parsed = onboardingSchema.safeParse(req.body);
  if (!parsed.success)
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message || "Check your business details",
    );
  if (parsed.data.voiceCountry && !(await numberCountries()).some(country => country.code === parsed.data.voiceCountry))
    throw new HttpError(400, "Choose a supported phone-number country.");
  const result = await workspaces.create(
    req.user!.id,
    initialState(parsed.data),
  );
  if (parsed.data.voiceCountry) void provisionBusinessNumber(result.state.business.id).catch(() => console.error("Business phone setup needs review", result.state.business.id));
  res.status(201).json(result);
});
router.get("/:id/state", async (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id);
  await workspaces.authorize(req.user!.id, id);
  res.json(await workspaces.read(id));
});
router.put("/:id/state", async (req: AuthenticatedRequest, res) => {
  const id = String(req.params.id);
  await workspaces.authorize(req.user!.id, id, true);
  if (!Number.isInteger(req.body.revision))
    throw new HttpError(400, "A workspace revision is required");
  const previous = await workspaces.read(id);
  // Phone assignments are controlled by the provisioning service, never by workspace JSON from a client.
  if (req.body.state?.business) req.body.state.business.voice = previous.state.business.voice;
  // Payments cannot be invented or converted into gateway successes by the workspace editor.
  const oldPayments = new Map(
    (previous.state.payments ?? []).map((p) => [p.id, p]),
  );
  for (const payment of req.body.state?.payments ?? []) {
    const old = oldPayments.get(payment.id);
    if (
      !old ||
      payment.bookingId !== old.bookingId ||
      payment.amount !== old.amount ||
      payment.method !== old.method ||
      payment.receiptId !== old.receiptId ||
      payment.provider !== old.provider ||
      payment.reference !== old.reference ||
      payment.needsReview !== old.needsReview ||
      payment.refundedAmount !== old.refundedAmount ||
      payment.disputed !== old.disputed ||
      (payment.method === "gateway" && payment.status !== old.status)
    )
      throw new HttpError(
        400,
        "Payments must be recorded through the payment flow",
      );
  }
  if ((req.body.state?.payments ?? []).length !== oldPayments.size)
    throw new HttpError(400, "Payment records cannot be removed");
  res.json(await workspaces.save(id, req.body.revision, req.body.state));
});
export default router;
