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
router.post("/", async (req: AuthenticatedRequest, res) => {
  const parsed = onboardingSchema.safeParse(req.body);
  if (!parsed.success)
    throw new HttpError(
      400,
      parsed.error.issues[0]?.message || "Check your business details",
    );
  const result = await workspaces.create(
    req.user!.id,
    initialState(parsed.data),
  );
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
