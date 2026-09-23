import { rateLimit } from "express-rate-limit";

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Call and phone-setup screens poll while work is in progress.
  limit: 1800,
  skip: req => req.path === "/health",
  standardHeaders: true,
  legacyHeaders: false,
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Please try again later." },
});
