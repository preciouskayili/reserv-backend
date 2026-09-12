import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import compression from "compression";
import { apiLimiter } from "./middleware/rateLimit.js";
import uploadRouter from "./routes/upload.js";
import callsRouter from "./routes/calls.js";
import bookingsRouter from "./routes/bookings.js";
import authRouter from "./routes/auth.js";
import { isSupabaseConfigured } from "./lib/supabase.js";
import { isAethexConfigured } from "./lib/aethex.js";
import { isResendConfigured } from "./lib/resend.js";
import {
  startCallScheduler,
  stopCallScheduler,
} from "./services/callScheduler.js";

const app = express();
const port = process.env.PORT || 4100;

app.use(helmet());
app.use(compression());
app.use(morgan("dev"));
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || "http://localhost:3000",
    credentials: true,
  }),
);
app.use(express.json());
app.use(apiLimiter);

// Health check with service integration diagnostics
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "reserv-backend",
    timestamp: new Date().toISOString(),
    integrations: {
      supabase: isSupabaseConfigured()
        ? "connected"
        : "demo_mode (env missing)",
      aethex: isAethexConfigured() ? "connected" : "demo_mode (env missing)",
      resend: isResendConfigured() ? "connected" : "demo_mode (env missing)",
    },
  });
});

// Mount feature routers
app.use("/api/auth", authRouter);
app.use("/api/upload", uploadRouter);
app.use("/api/calls", callsRouter);
app.use("/api/bookings", bookingsRouter);

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

// Graceful shutdown on Railway termination signals
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
