import { Router, type Request, type Response } from "express";
import { db } from "../services/dbService.js";
import { isSupabaseConfigured } from "../lib/supabase.js";

const router = Router();

/**
 * GET /api/bookings
 * Returns bookings from database or memory cache
 */
router.get("/", async (_req: Request, res: Response) => {
  try {
    const bookings = await db.listBookings();
    return res.json({
      configured: isSupabaseConfigured(),
      bookings,
    });
  } catch (error) {
    console.error("[Bookings API] Error:", error);
    return res.status(500).json({
      error: "Failed to fetch bookings",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * GET /api/bookings/:identifier
 * Find booking by ID or unique booking code
 */
router.get("/:identifier", async (req: Request, res: Response) => {
  try {
    const identifier = String(req.params.identifier);
    const booking = await db.getBooking(identifier);

    if (!booking) {
      return res.status(404).json({ error: "Booking not found" });
    }

    return res.json({ booking });
  } catch (error) {
    console.error("[Bookings API] Error:", error);
    return res.status(500).json({ error: "Failed to fetch booking" });
  }
});

/**
 * POST /api/bookings
 * Create new booking
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      id,
      code,
      businessId,
      customerId,
      serviceId,
      staffId,
      startTime,
      endTime,
      status,
      notes,
      totalAmount,
      requiredAmount,
    } = req.body;

    const newBooking = {
      id: id || crypto.randomUUID(),
      code: code || Math.random().toString(36).substring(2, 8).toUpperCase(),
      business_id: businessId || "bloom",
      customer_id: customerId,
      service_id: serviceId,
      staff_id: staffId,
      start_time: startTime,
      end_time: endTime,
      status: status || "Pending",
      notes: notes || "",
      total_amount: totalAmount || 0,
      required_amount: requiredAmount || 0,
      created_at: new Date().toISOString(),
    };

    const saved = await db.createBooking(newBooking);

    // Record activity
    await db.addBookingActivity({
      id: crypto.randomUUID(),
      bookingId: saved.id,
      title: "Reservation created",
      actor: "customer",
    });

    return res.status(201).json({ booking: saved });
  } catch (error) {
    console.error("[Bookings API] Create error:", error);
    return res.status(500).json({
      error: "Failed to create booking",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

/**
 * PATCH /api/bookings/:identifier
 * Update booking status, notes, or details
 */
router.patch("/:identifier", async (req: Request, res: Response) => {
  try {
    const identifier = String(req.params.identifier);
    const updates = req.body;

    const updated = await db.updateBooking(identifier, updates);
    if (!updated) {
      return res.status(404).json({ error: "Booking not found" });
    }

    if (updates.status) {
      await db.addBookingActivity({
        id: crypto.randomUUID(),
        bookingId: updated.id,
        title: `Reservation ${updates.status.toLowerCase()}`,
        actor: "owner",
      });
    }

    return res.json({ booking: updated });
  } catch (error) {
    console.error("[Bookings API] Update error:", error);
    return res.status(500).json({
      error: "Failed to update booking",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

export default router;
