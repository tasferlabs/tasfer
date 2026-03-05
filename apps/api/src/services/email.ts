import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_SERVER_NAME,
  port: parseInt(process.env.MAIL_PORT || "587"),
  secure: false,
  requireTLS: true,
  auth: {
    user: process.env.MAIL_USERNAME,
    pass: process.env.MAIL_PASSWORD,
  },
});

const FROM_ADDRESS = process.env.MAIL_FROM || process.env.MAIL_USERNAME || "hi@cypher.md";
const FROM_NAME = process.env.MAIL_FROM_NAME || "Cypher";

export async function sendVerificationEmail(email: string, code: string) {
  await transporter.sendMail({
    to: email,
    from: { address: FROM_ADDRESS, name: FROM_NAME },
    subject: `${code} is your verification code`,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background-color: #ffffff; color: #1a1a1a;">
        <h2 style="margin: 0 0 8px; font-size: 20px; font-weight: 600; color: #1a1a1a;">Verify your email</h2>
        <p style="margin: 0 0 24px; color: #555555; font-size: 14px;">Enter this code to verify your email address:</p>
        <div style="background-color: #f4f4f5; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 32px; font-weight: 700; letter-spacing: 6px; font-family: monospace; color: #1a1a1a;">${code}</span>
        </div>
        <p style="margin: 0; color: #777777; font-size: 12px;">This code expires in 10 minutes. If you didn't create an account, you can ignore this email.</p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail(email: string, token: string) {
  const appUrl = process.env.APP_URL || "http://localhost:5173";
  const resetUrl = `${appUrl}/reset-password?token=${token}`;

  await transporter.sendMail({
    to: email,
    from: { address: FROM_ADDRESS, name: FROM_NAME },
    subject: "Reset your password",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background-color: #ffffff; color: #1a1a1a;">
        <h2 style="margin: 0 0 8px; font-size: 20px; font-weight: 600; color: #1a1a1a;">Reset your password</h2>
        <p style="margin: 0 0 24px; color: #555555; font-size: 14px;">Click the button below to reset your password:</p>
        <div style="text-align: center; margin-bottom: 24px;">
          <a href="${resetUrl}" style="display: inline-block; background-color: #1a1a1a; color: #ffffff; text-decoration: none; padding: 12px 32px; border-radius: 8px; font-size: 14px; font-weight: 600;">Reset password</a>
        </div>
        <p style="margin: 0 0 8px; color: #777777; font-size: 12px;">Or copy and paste this link into your browser:</p>
        <p style="margin: 0 0 16px; color: #555555; font-size: 12px; word-break: break-all;">${resetUrl}</p>
        <p style="margin: 0; color: #777777; font-size: 12px;">This link expires in 10 minutes. If you didn't request a password reset, you can ignore this email.</p>
      </div>
    `,
  });
}

export async function sendEmailChangeVerification(email: string, token: string) {
  const appUrl = process.env.APP_URL || "http://localhost:5173";
  const verifyUrl = `${appUrl}/verify-email-change?token=${token}`;

  await transporter.sendMail({
    to: email,
    from: { address: FROM_ADDRESS, name: FROM_NAME },
    subject: "Confirm your new email address",
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background-color: #ffffff; color: #1a1a1a;">
        <h2 style="margin: 0 0 8px; font-size: 20px; font-weight: 600; color: #1a1a1a;">Confirm your new email</h2>
        <p style="margin: 0 0 24px; color: #555555; font-size: 14px;">Click the button below to confirm your email change:</p>
        <div style="text-align: center; margin-bottom: 24px;">
          <a href="${verifyUrl}" style="display: inline-block; background-color: #1a1a1a; color: #ffffff; text-decoration: none; padding: 12px 32px; border-radius: 8px; font-size: 14px; font-weight: 600;">Confirm email change</a>
        </div>
        <p style="margin: 0 0 8px; color: #777777; font-size: 12px;">Or copy and paste this link into your browser:</p>
        <p style="margin: 0 0 16px; color: #555555; font-size: 12px; word-break: break-all;">${verifyUrl}</p>
        <p style="margin: 0; color: #777777; font-size: 12px;">This link expires in 10 minutes. If you didn't request this change, you can ignore this email.</p>
      </div>
    `,
  });
}
