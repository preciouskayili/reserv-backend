export function checkProductionConfig(env: NodeJS.ProcessEnv) {
  const errors: string[] = [], warnings: string[] = [];
  const requireKeys = (keys: string[]) => {
    for (const key of keys) if (!env[key]?.trim()) errors.push(`${key} is required.`);
  };
  requireKeys(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET", "RESEND_API_KEY", "CLIENT_ORIGIN", "EMAIL_FROM"]);
  if (env.JWT_SECRET && (env.JWT_SECRET.length < 32 || env.JWT_SECRET.includes("reserv-dev-secret"))) errors.push("JWT_SECRET must be a strong secret of at least 32 characters.");
  const httpsOrigin = (value: string) => {
    try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && !["localhost", "127.0.0.1"].includes(url.hostname); }
    catch { return false; }
  };
  if (env.CLIENT_ORIGIN && !env.CLIENT_ORIGIN.split(",").every(origin => httpsOrigin(origin.trim()))) errors.push("CLIENT_ORIGIN must contain only public HTTPS origins.");
  if (env.EMAIL_FROM && /@resend\.dev\b/i.test(env.EMAIL_FROM)) errors.push("EMAIL_FROM must use your verified sending domain.");
  if (env.TRUST_PROXY_HOPS && (!Number.isInteger(Number(env.TRUST_PROXY_HOPS)) || Number(env.TRUST_PROXY_HOPS) < 0)) errors.push("TRUST_PROXY_HOPS must be a nonnegative integer.");
  if (env.ENABLE_CALL_SCHEDULER === "true") requireKeys(["AETHEX_API_KEY"]);
  else warnings.push("Automatic calls are disabled. Set ENABLE_CALL_SCHEDULER=true for scheduled reminders.");
  // Inbound calls use booking tools served from the public webhook origin and authenticated with VOICE_TOOLS_SECRET.
  if (env.AETHEX_API_KEY?.trim()) {
    requireKeys(["AETHEX_WEBHOOK_SECRET", "AETHEX_PUBLIC_WEBHOOK_URL", "VOICE_TOOLS_SECRET"]);
    if (env.VOICE_TOOLS_SECRET?.trim() && env.VOICE_TOOLS_SECRET.trim().length < 32) errors.push("VOICE_TOOLS_SECRET must be a random secret of at least 32 characters.");
    if (env.VOICE_TOOLS_SECRET?.trim() && [env.JWT_SECRET, env.CRON_SECRET, env.AETHEX_WEBHOOK_SECRET].includes(env.VOICE_TOOLS_SECRET.trim())) errors.push("VOICE_TOOLS_SECRET must not reuse another secret.");
    if (env.AETHEX_PUBLIC_WEBHOOK_URL?.trim()) {
      let valid = false;
      try { const url = new URL(env.AETHEX_PUBLIC_WEBHOOK_URL.trim()); valid = url.protocol === "https:" && !url.port && url.pathname === "/api/calls/webhook" && !["localhost", "127.0.0.1"].includes(url.hostname); } catch {}
      if (!valid) errors.push("AETHEX_PUBLIC_WEBHOOK_URL must be https://YOUR_BACKEND_DOMAIN/api/calls/webhook on port 443.");
    }
  }
  for (const key of ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "AETHEX_AGENT_ID", "AETHEX_WEBHOOK_SECRET", "AETHEX_PUBLIC_WEBHOOK_URL"]) {
    if (!env[key]?.trim()) warnings.push(`${key} is missing; complete image, business-number, and call-event setup before launch.`);
  }
  if (!env.PAYSTACK_SECRET_KEY && !env.STRIPE_SECRET_KEY) warnings.push("Online checkout is disabled; only transfer receipts are available.");
  if ((env.PAYSTACK_SECRET_KEY || env.STRIPE_SECRET_KEY) && (!env.PAYMENT_RETURN_URL || !httpsOrigin(env.PAYMENT_RETURN_URL))) errors.push("Online checkout requires PAYMENT_RETURN_URL to be a public HTTPS origin.");
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) errors.push("Stripe requires STRIPE_WEBHOOK_SECRET.");
  return { errors, warnings };
}
