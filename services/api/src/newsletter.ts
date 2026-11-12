/**
 * The public newsletter sign-up (/newsletter): who signed up, kept until
 * they're in the Mailchimp audience. Pure parts here, so they're tested.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const NEWSLETTER_PK = 'NEWSLETTER';
export const signupSk = (email: string) =>
  `SUB#${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
/** Per-address and per-network limits, so the form can't be used to flood an inbox. */
export const SIGNUP_AGAIN_AFTER_SECONDS = 10 * 60;
export const SIGNUPS_PER_IP_PER_HOUR = 10;

export const SignupBody = z
  .object({
    email: z.email('Enter a valid email address').max(254),
    firstName: z.string().trim().max(60).optional(),
    consent: z.literal(true, 'Tick the box to say you’d like the newsletter'),
    /** A field people never see; bots fill it in. */
    website: z.string().max(0).optional(),
  })
  .strict();

export interface Signup {
  email: string;
  firstName?: string;
  createdAt: string;
  /** `waiting`: Mailchimp wasn't connected yet; the hourly sync adds them. */
  status: 'waiting' | 'added';
  mailchimpStatus?: string;
  addedAt?: string;
}
