import nodemailer from 'nodemailer';

export type SendEmailRequest = {
  to: string | string[];
  subject: string;
  text: string;
  html?: string;
};

/**
 * Outbound mail through SendGrid SMTP (Twilio).
 * Same shape as ARC: SMTP_USER_NAME, SMTP_PASSWORD, SMTP_SENDER_EMAIL.
 */
export const sendEmail = async (emailRequest: SendEmailRequest) => {
  const transporter = nodemailer.createTransport({
    host: 'smtp.sendgrid.net',
    port: 587,
    auth: {
      user: process.env.SMTP_USER_NAME,
      pass: process.env.SMTP_PASSWORD,
    },
  });

  return await transporter.sendMail({
    from: `"Finora Flow" <${process.env.SMTP_SENDER_EMAIL}>`,
    to: emailRequest.to,
    subject: emailRequest.subject,
    text: emailRequest.text,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
        <div style="text-align: center; margin-bottom: 20px;">
          <p style="font-size: 20px; font-weight: 700; color: #1B3A4B; margin: 0;">Finora Flow</p>
        </div>
        <div style="background-color: #f9f9f9; padding: 20px; border-radius: 8px; border: 1px solid #eee;">
          ${
            emailRequest.html
              ? emailRequest.html
              : `<p style="font-size: 16px; line-height: 1.5; white-space: pre-wrap; margin: 0;">${emailRequest.text}</p>`
          }
        </div>
        <p style="font-size: 12px; color: #777; text-align: center; margin-top: 30px;">
          &copy; ${new Date().getFullYear()} Finora Flow. All rights reserved.
        </p>
      </div>
    `,
  });
};
