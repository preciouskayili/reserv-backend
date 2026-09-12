import { Resend } from "resend";

const apiKey = process.env.RESEND_API_KEY;

export const isResendConfigured = (): boolean => {
  return Boolean(apiKey && apiKey.trim().length > 0);
};

const resendClient = isResendConfigured() ? new Resend(apiKey) : null;

export async function sendOtpEmail(
  email: string,
  code: string
): Promise<{ success: boolean; simulated: boolean; id?: string }> {
  const fromEmail = process.env.EMAIL_FROM || "Reserv <onboarding@resend.dev>";

  if (!resendClient) {
    console.log(`\n======================================================`);
    console.log(`📨 [Resend Dev Simulation] Email sent to: ${email}`);
    console.log(`🔑 Verification Code: ${code}`);
    console.log(`⏱️  Expires in 10 minutes`);
    console.log(`======================================================\n`);

    return { success: true, simulated: true, id: `sim_email_${Date.now()}` };
  }

  try {
    const { data, error } = await resendClient.emails.send({
      from: fromEmail,
      to: email,
      subject: `Your Reserv verification code: ${code}`,
      html: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8">
            <style>
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #faf9f7; color: #1c1917; margin: 0; padding: 40px 20px; }
              .container { max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e7e5e4; padding: 36px; box-shadow: 0 4px 20px rgba(0,0,0,0.03); }
              .brand { font-size: 22px; font-weight: 700; color: #1c1917; letter-spacing: -0.03em; margin-bottom: 24px; }
              .title { font-size: 17px; font-weight: 600; margin-bottom: 12px; }
              .desc { font-size: 14px; color: #78716c; line-height: 1.5; margin-bottom: 28px; }
              .code-box { background: #f5f5f4; border-radius: 12px; padding: 18px; text-align: center; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #1c1917; margin-bottom: 28px; font-family: monospace; }
              .footer { font-size: 12px; color: #a8a29e; line-height: 1.5; border-top: 1px solid #f5f5f4; padding-top: 20px; }
            </style>
          </head>
          <body>
            <div class="container">
              <div class="brand">reserv.</div>
              <div class="title">Sign in with your verification code</div>
              <div class="desc">Enter the 6-digit code below to sign in to your workspace. This code will expire in 10 minutes.</div>
              <div class="code-box">${code}</div>
              <div class="footer">If you did not request this verification code, you can safely disregard this email.</div>
            </div>
          </body>
        </html>
      `,
    });

    if (error) {
      console.error("[Resend] Failed to send OTP email:", error);
      throw new Error(error.message);
    }

    return { success: true, simulated: false, id: data?.id };
  } catch (err) {
    console.error("[Resend] Error delivering email:", err);
    throw err;
  }
}
