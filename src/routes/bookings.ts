import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  requireWorkspace,
  type WorkspaceRequest,
} from "../middleware/requireWorkspace.js";
import { workspaces } from "../services/workspaces.js";
import { createReservation } from "../services/reservations.js";
import { HttpError } from "../domain/workspace.js";
const router = Router();
router.use(requireAuth, requireWorkspace);
router.get("/", async (req: WorkspaceRequest, res) => {
  const snapshot = await workspaces.read(req.workspaceId!);
  res.json({ configured: true, bookings: snapshot.state.bookings });
});
router.get("/:id", async (req: WorkspaceRequest, res) => {
  const { state } = await workspaces.read(req.workspaceId!);
  const booking = state.bookings.find((b) => b.id === req.params.id);
  if (!booking) throw new HttpError(404, "Reservation not found");
  res.json({ booking });
});
router.post("/", async (req: WorkspaceRequest, res) =>
  res
    .status(201)
    .json(
      await createReservation(
        await workspaces.read(req.workspaceId!),
        req.body,
      ),
    ),
);
export default router;
