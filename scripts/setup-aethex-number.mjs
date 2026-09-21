import "dotenv/config";

// Administrative setup only. This does not purchase numbers, place calls, or change inbound routing.
const apply = process.argv.includes("--register");
const apiKey = process.env.AETHEX_API_KEY?.trim();
const agentId = process.env.AETHEX_AGENT_ID?.trim();
const phone = process.env.AETHEX_FROM_NUMBER?.trim();
const sid = process.env.TWILIO_ACCOUNT_SID?.trim();
const token = process.env.TWILIO_AUTH_TOKEN?.trim();
let accountId = process.env.AETHEX_TWILIO_ACCOUNT_ID?.trim();
async function request(path, method = "GET", body) {
  const response = await fetch(`https://api.aethexai.com/api/v1${path}`, {
    method,
    headers: { "X-API-Key": apiKey, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    // Provider error bodies can echo credentials; deliberately omit them.
    throw new Error(
      `Aethex ${method} ${path.split("?")[0]} returned HTTP ${response.status}. Check credentials, API scopes and the Aethex dashboard. Re-run the check before retrying registration.`,
    );
  }
  return response.json();
}
async function list(path) {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    const result = await request(`${path}?limit=100&offset=${offset}`);
    if (!Array.isArray(result.data))
      throw new Error(`Unexpected Aethex response for ${path}`);
    rows.push(...result.data);
    if (result.data.length < 100) return rows;
  }
}
try {
  if (!apiKey) throw new Error("Add AETHEX_API_KEY to backend/.env.");
  const [accounts, numbers] = await Promise.all([
    list("/twilio-accounts"),
    list("/phone-numbers"),
  ]);
  console.log(
    `Connected Twilio accounts: ${accounts.length}; registered numbers: ${numbers.length}.`,
  );
  if (!agentId)
    throw new Error("Set AETHEX_AGENT_ID to the Reserv voice agent ID.");
  await request(`/agents/${encodeURIComponent(agentId)}`);
  console.log("Configured agent is accessible.");
  if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone))
    throw new Error(
      "Set AETHEX_FROM_NUMBER to an existing voice-capable Twilio number, including its country code.",
    );
  let number = numbers.find((n) => n.phone_number === phone);
  if (number && number.provider !== "twilio")
    throw new Error(
      "This number uses another provider; do not re-register it as Twilio.",
    );
  if (number) {
    console.log(
      `Selected number is registered; outbound ${number.outbound_enabled ? "enabled" : "disabled"}.`,
    );
  } else {
    if (accountId && !accounts.some((a) => a.id === accountId))
      throw new Error(
        "AETHEX_TWILIO_ACCOUNT_ID is not an active connected account.",
      );
    if (!accountId && sid)
      accountId = accounts.find(
        (a) => a.account_sid?.toLowerCase() === sid.toLowerCase(),
      )?.id;
    if (!accountId && (!/^AC[0-9a-f]{32}$/i.test(sid || "") || !token))
      throw new Error(
        "Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN locally, or provide an existing AETHEX_TWILIO_ACCOUNT_ID. Do not paste credentials into chat.",
      );
    if (!apply) {
      console.log(
        "Ready to connect the account and register this existing number. Run pnpm aethex:register to apply.",
      );
      process.exit(0);
    }
    if (!accountId) {
      const account = await request("/twilio-accounts", "POST", {
        account_sid: sid,
        auth_token: token,
        friendly_name: "Reserv platform",
      });
      accountId = account.id;
      if (!accountId)
        throw new Error(
          "Aethex did not return the connected account ID. Check the dashboard before retrying.",
        );
    }
    // Omit agent_id: a shared outbound number must not route every business's inbound calls to one agent.
    number = await request("/phone-numbers/twilio/register", "POST", {
      phone_number: phone,
      twilio_account_id: accountId,
      friendly_name: "Reserv outbound reminders",
    });
  }
  if (!apply) {
    console.log("Read-only check complete. No settings changed.");
    process.exit(0);
  }
  if (!number?.id)
    throw new Error(
      "Missing phone registration ID. Check the dashboard before retrying.",
    );
  if (!number.outbound_enabled)
    await request(`/phone-numbers/${encodeURIComponent(number.id)}`, "PATCH", {
      outbound_enabled: true,
    });
  const verified = await request(
    `/phone-numbers/${encodeURIComponent(number.id)}`,
  );
  if (
    verified.phone_number !== phone ||
    !verified.outbound_enabled ||
    verified.status !== "active"
  )
    throw new Error(
      "Registration is not active for outbound calls yet. Check the dashboard.",
    );
  console.log(
    "Existing number is registered and outbound calling is enabled. Restart the backend to load AETHEX_FROM_NUMBER. No calls were placed; inbound routing was left unchanged.",
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Aethex number setup failed.",
  );
  process.exitCode = 1;
}
