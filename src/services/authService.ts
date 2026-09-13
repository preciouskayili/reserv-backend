import { randomInt, createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import { sendOtpEmail } from "../lib/resend.js";

interface OtpEntry {
  email: string;
  code: string;
  expiresAt: number;
  attempts: number;
}

export interface UserSession {
  id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "staff" | "customer";
  businessId: string;
}

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;
const JWT_SECRET =
  process.env.JWT_SECRET || "reserv-dev-secret-key-change-in-production";

if (process.env.NODE_ENV === "production") {
  if (
    !process.env.JWT_SECRET ||
    JWT_SECRET.length < 32 ||
    JWT_SECRET.includes("reserv-dev-secret")
  )
    throw new Error(
      "Production requires a strong JWT_SECRET (at least 32 characters).",
    );
  if (!process.env.RESEND_API_KEY)
    throw new Error("Production requires RESEND_API_KEY for sign-in.");
}

// In-memory OTP storage
const otpStore = new Map<string, OtpEntry>();

export class AuthService {
  /**
   * Generates a 6-digit OTP, stores it, and sends via Resend
   */
  async requestOtp(rawEmail: string): Promise<{
    success: boolean;
    simulated: boolean;
    email: string;
    expiresInSeconds: number;
    devCode?: string;
  }> {
    const email = rawEmail.trim().toLowerCase();

    for (const [key, entry] of otpStore) {
      if (entry.expiresAt <= Date.now()) otpStore.delete(key);
    }
    const pending = otpStore.get(email);
    if (pending && pending.expiresAt - OTP_TTL_MS + 60_000 > Date.now())
      throw new Error("Please wait a minute before requesting another code.");
    const code = randomInt(100000, 1000000).toString();
    const expiresAt = Date.now() + OTP_TTL_MS;

    otpStore.set(email, {
      email,
      code,
      expiresAt,
      attempts: 0,
    });

    let emailResult;
    try {
      emailResult = await sendOtpEmail(email, code);
    } catch (error) {
      otpStore.delete(email);
      throw error;
    }

    return {
      success: true,
      simulated: emailResult.simulated,
      email,
      expiresInSeconds: Math.floor(OTP_TTL_MS / 1000),
      devCode: process.env.NODE_ENV !== "production" ? code : undefined,
    };
  }

  /**
   * Verifies the 6-digit code and returns a signed JWT token
   */
  async verifyOtp(
    rawEmail: string,
    rawCode: string,
  ): Promise<{ token: string; user: UserSession }> {
    const email = rawEmail.trim().toLowerCase();
    const code = rawCode.trim();

    const entry = otpStore.get(email);
    if (!entry) {
      throw new Error(
        "No pending verification code found for this email. Please request a new code.",
      );
    }

    if (Date.now() > entry.expiresAt) {
      otpStore.delete(email);
      throw new Error(
        "Verification code has expired. Please request a new code.",
      );
    }

    entry.attempts += 1;
    if (entry.attempts > MAX_ATTEMPTS) {
      otpStore.delete(email);
      throw new Error("Too many failed attempts. Please request a new code.");
    }

    if (entry.code !== code) {
      throw new Error(
        "Invalid verification code. Please check your email and try again.",
      );
    }

    // Code is valid! Consume it.
    otpStore.delete(email);

    const user: UserSession = {
      id: `usr_${createHash("sha256").update(email).digest("hex")}`,
      email,
      name: email
        .split("@")[0]
        .replace(/[._]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase()),
      role: "customer",
      businessId: "",
    };

    const token = jwt.sign(user, JWT_SECRET, {
      expiresIn: "30d",
    });

    return { token, user };
  }

  /**
   * Decodes and validates a JWT session token
   */
  verifyToken(token: string): UserSession {
    try {
      const decoded = jwt.verify(token, JWT_SECRET, {
        algorithms: ["HS256"],
      }) as UserSession;
      if (
        !decoded.id ||
        !decoded.email ||
        decoded.id !==
          `usr_${createHash("sha256").update(decoded.email).digest("hex")}`
      )
        throw new Error("Invalid identity");
      return { ...decoded, role: "customer", businessId: "" };
    } catch {
      throw new Error("Invalid or expired session. Please sign in again.");
    }
  }
}

export const authService = new AuthService();
