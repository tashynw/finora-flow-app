import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { admin } from 'better-auth/plugins';
import { sendEmail } from '../mail/email.js';
import { prisma } from '../prisma/client.js';
import { ac, finoraRoles } from './permissions.js';

/**
 * Finora roles stored on user.role.
 * Better Auth may keep one name, or several joined with commas.
 */
export const FINORA_ROLES = [
  'requester',
  'approver',
  'payment_coordinator',
  'finance',
  'administrator',
  'operations',
  'auditor',
] as const;

export type FinoraRole = (typeof FINORA_ROLES)[number];

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  session: {
    expiresIn: 60 * 60 * 24,
    updateAge: 60 * 60 * 12,
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: 'Reset your password',
        text: `Reset your password: ${url}`,
        html: `
          <p style="font-size: 16px; line-height: 1.5; margin: 0 0 16px 0;">
            We got a request to reset your password. If it wasn't you, ignore this email and nothing changes.
          </p>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 16px 0;">
            <tr>
              <td style="border-radius: 6px; background: #1B3A4B;">
                <a href="${url}"
                   style="display: inline-block; padding: 10px 16px; font-size: 14px; font-weight: 500; line-height: 20px; color: #ffffff; text-decoration: none; border-radius: 6px;">
                  Reset password
                </a>
              </td>
            </tr>
          </table>
          <p style="font-size: 14px; line-height: 1.5; margin: 0 0 6px 0; color: #374151;">
            Button not working? Copy and paste this link into your browser:
          </p>
          <p style="font-size: 14px; line-height: 1.5; margin: 0;">
            <a href="${url}" style="color: #185FA5; word-break: break-all;">${url}</a>
          </p>
        `,
      });
    },
    onPasswordReset: async ({ user }) => {
      await prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: 'Verify your email',
        text: `Verify your email address: ${url}`,
        html: `
          <p style="font-size: 16px; line-height: 1.5; margin: 0 0 16px 0;">
            Welcome to Finora Flow.
          </p>
          <p style="font-size: 16px; line-height: 1.5; margin: 0 0 16px 0;">
            Verify your email to finish setting up your account.
          </p>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 16px 0;">
            <tr>
              <td style="border-radius: 6px; background: #1B3A4B;">
                <a href="${url}"
                   style="display: inline-block; padding: 10px 16px; font-size: 14px; font-weight: 500; line-height: 20px; color: #ffffff; text-decoration: none; border-radius: 6px;">
                  Verify email
                </a>
              </td>
            </tr>
          </table>
          <p style="font-size: 14px; line-height: 1.5; margin: 0 0 6px 0; color: #374151;">
            Button not working? Copy and paste this link into your browser:
          </p>
          <p style="font-size: 14px; line-height: 1.5; margin: 0;">
            <a href="${url}" style="color: #185FA5; word-break: break-all;">${url}</a>
          </p>
        `,
      });
    },
  },
  plugins: [
    admin({
      ac,
      roles: finoraRoles,
      defaultRole: 'requester',
      adminRoles: ['administrator'],
    }),
  ],
  user: {
    additionalFields: {
      role: {
        type: 'string',
        input: false,
      },
      departmentId: {
        type: 'string',
        required: false,
        input: false,
      },
      jobTitle: {
        type: 'string',
        required: false,
        input: false,
      },
      outOfOfficeUntil: {
        type: 'date',
        required: false,
        input: false,
      },
      delegateToId: {
        type: 'string',
        required: false,
        input: false,
      },
      archivedAt: {
        type: 'date',
        required: false,
        input: false,
      },
      archivedReason: {
        type: 'string',
        required: false,
        input: false,
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
