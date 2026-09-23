import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { authService } from "../services/authService.js";
import { authLimiter } from "../middleware/rateLimit.js";

const router = Router();
router.use("/otp", authLimiter);

const sendOtpSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
});

const verifyOtpSchema = z.object({
  email: z.string().email("Please enter a valid email address"),
  code: z.string().length(6, "Verification code must be 6 digits"),
});

/**
 * POST /api/auth/otp/send
 * Dispatches an OTP verification code via Resend
 */
router.post("/otp/send", async (req: Request, res: Response) => {
  try {
    const parse = sendOtpSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({
        error: "Validation error",
        message: parse.error.issues[0]?.message || "Invalid email",
      });
    }

    const { email } = parse.data;
    const result = await authService.requestOtp(email);

    return res.json({
      success: true,
      message: result.simulated
        ? "Verification code generated (simulated in console)."
        : `Verification code sent to ${email}`,
      email: result.email,
      expiresInSeconds: result.expiresInSeconds,
      simulated: result.simulated,
      devCode: result.devCode,
    });
  } catch (error) {
    console.error("[Auth API] Send OTP error:", error);
    return res.status(500).json({
      error: "Failed to send code",
      message: error instanceof Error ? error.message : "Internal error",
    });
  }
});

/**
 * POST /api/auth/otp/verify
 * Validates OTP code and returns JWT session
 */
router.post("/otp/verify", async (req: Request, res: Response) => {
  try {
    const parse = verifyOtpSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({
        error: "Validation error",
        message: parse.error.issues[0]?.message || "Invalid request",
      });
    }

    const { email, code } = parse.data;
    const { token, user } = await authService.verifyOtp(email, code);

    return res.json({
      success: true,
      token,
      user,
      message: "Signed in successfully",
    });
  } catch (error) {
    return res.status(401).json({
      error: "Verification failed",
      message: error instanceof Error ? error.message : "Invalid code",
    });
  }
});

/**
 * GET /api/auth/me
 * Returns current authenticated user from Bearer token
 */
router.get("/me", (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ error: "Unauthorized", message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const user = authService.verifyToken(token);
    return res.json({ user });
  } catch (error) {
    return res.status(401).json({
      error: "Invalid session",
      message: error instanceof Error ? error.message : "Expired token",
    });
  }
});

export default router;
