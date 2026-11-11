/**
 * Password policy and login lockout settings.
 */

import crypto from 'crypto';

export const passwordPolicy = {
  minLength: () => Math.max(8, parseInt(process.env.PASSWORD_MIN_LENGTH || '12')),
  maxFailedLogins: () => Math.max(1, parseInt(process.env.MAX_FAILED_LOGINS || '5')),
  lockoutMinutes: () => Math.max(1, parseInt(process.env.LOCKOUT_MINUTES || '15')),
};

/** Returns the reasons a password is rejected (empty when acceptable). */
export function checkPassword(password: unknown, email?: string): string[] {
  if (typeof password !== 'string') return ['Password is required'];
  const problems: string[] = [];
  const min = passwordPolicy.minLength();
  if (password.length < min) problems.push(`at least ${min} characters`);
  if (password.length > 200) problems.push('at most 200 characters');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) problems.push('at least 3 of: lowercase, uppercase, digit, symbol');
  if (email && password.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length >= 3) {
    problems.push('must not contain your user name');
  }
  return problems.length ? [`Password must have ${problems.join('; ')}`] : [];
}

/** Random password that satisfies the policy (for admin resets / new users). */
export function generateTemporaryPassword(): string {
  const base = crypto.randomBytes(12).toString('base64url');
  return `${base}-Aa9!`;
}
