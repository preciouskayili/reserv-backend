import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import express, { type ErrorRequestHandler } from "express";
import multer from "multer";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import { apiLimiter } from "./middleware/rateLimit.js";
import uploadRouter from "./routes/upload.js";
import callsRouter from "./routes/calls.js";
import publicRouter from "./routes/public.js";
import workspaceRouter from "./routes/workspaces.js";
import { HttpError } from "./domain/workspace.js";
import bookingsRouter from "./routes/bookings.js";
import authRouter from "./routes/auth.js";
import { isSupabaseConfigured } from "./lib/supabase.js";
import { isAethexConfigured } from "./lib/aethex.js";
import { isResendConfigured } from "./lib/resend.js";
import {
  startCallScheduler,
  stopCallScheduler,
} from "./services/callScheduler.js";

if (process.env.NODE_ENV === "production" && !isSupabaseConfigured())
  throw new Error("Production requires Supabase persistence.");

const app = express();
const port = process.env.PORT || 4100;

if (process.env.TRUST_PROXY_HOPS)
  app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS));
app.use(helmet());
app.use(compression());
app.use(morgan("dev"));
// In development, watch .env file for changes so swapping CLIENT_ORIGIN or secrets takes effect immediately
if (process.env.NODE_ENV !== "production") {
  const envFilePath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envFilePath)) {
    fs.watch(envFilePath, () => {
      try {
        const parsed = dotenv.parse(fs.readFileSync(envFilePath));
        for (const [k, v] of Object.entries(parsed)) {
          process.env[k] = v;
        }
        console.log(
          `[Config] Reloaded .env (CLIENT_ORIGIN: ${process.env.CLIENT_ORIGIN || "not set"})`
        );
      } catch (err) {
        console.warn("[Config] Could not reload .env:", err);
      }
    });
  }
}

/**
 * Returns allowed origins parsed directly from CLIENT_ORIGIN in .env.
 * Supports a single URL or comma-separated URLs (e.g. CLIENT_ORIGIN=http://localhost:3003).
 */
const getAllowedOrigins = (): string[] => {
  const raw = process.env.CLIENT_ORIGIN;
  if (!raw) return ["http://localhost:3000"];
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
};

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow non-browser requests with no origin header (like curl, mobile, server-to-server)
      if (!origin) return callback(null, true);

      const allowed = getAllowedOrigins();

      // Support wildcard if explicitly set in .env
      if (allowed.includes("*") || allowed.includes(origin)) {
        return callback(null, true);
      }

      return callback(null, false);
    },
    credentials: true,
  }),
);
app.use(express.json({ limit: "5mb" }));
app.use(apiLimiter);

// Health check with service integration diagnostics
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "reserv-backend",
    timestamp: new Date().toISOString(),
    integrations: {
      supabase: isSupabaseConfigured()
        ? "configured"
        : "demo_mode (env missing)",
      aethex: isAethexConfigured() ? "configured" : "demo_mode (env missing)",
      resend: isResendConfigured() ? "configured" : "demo_mode (env missing)",
    },
  });
});

// Mount feature routers
app.use("/api/auth", authRouter);
app.use("/api/workspaces", workspaceRouter);
app.use("/api/public", publicRouter);
app.use("/api/upload", uploadRouter);
app.use("/api/calls", callsRouter);
app.use("/api/bookings", bookingsRouter);

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  const status =
    error instanceof multer.MulterError
      ? error.code === "LIMIT_FILE_SIZE"
        ? 413
        : 400
      : error.status === 400 || error.status === 413
        ? error.status
        : 500;
  res.status(status).json({
    error:
      status === 413
        ? "File or request is too large"
        : status === 400
          ? "Invalid request"
          : "Request failed",
  });
};
app.use(errorHandler);

const server = app.listen(port, () => {
  console.log(`\n==============================================`);
  console.log(`🚀 Reserv Backend running on http://localhost:${port}`);
  console.log(
    `   - Supabase DB:  ${isSupabaseConfigured() ? "✅ Configured" : "⚠️  Fallback demo mode"}`,
  );
  console.log(
    `   - Aethex Calls: ${isAethexConfigured() ? "✅ Configured" : "⚠️  Simulation demo mode"}`,
  );
  console.log(
    `   - Resend OTP:   ${isResendConfigured() ? "✅ Configured" : "⚠️  Simulation console mode"}`,
  );
  console.log(`==============================================\n`);

  // Initialize automated background node-cron call runner
  startCallScheduler();
});

// Graceful shutdown on termination signals
const handleShutdown = (signal: string) => {
  console.log(`\n[Server] Received ${signal}. Terminating gracefully...`);
  stopCallScheduler();
  server.close(() => {
    console.log("[Server] HTTP server closed.");
    process.exit(0);
  });
};

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));
