// config/digestExclusions.js
//
// Emails that must NEVER receive the automated task digests
// (per-user "Your Pending Tasks", the Pending Tasks PDF, Bill & PO Dues).
// Matching is case-insensitive. Only the *recipient* is skipped — the
// person's tasks still appear in reports sent to others.

export const EXCLUDED_DIGEST_EMAILS = new Set(
  ["jay@bbmpvtltd.com"].map((e) => e.toLowerCase())
);

export function isDigestExcluded(email) {
  return !!email && EXCLUDED_DIGEST_EMAILS.has(String(email).trim().toLowerCase());
}

// Accepts a string or array of recipients, returns an array without excluded ones.
export function filterDigestRecipients(recipients) {
  const list = Array.isArray(recipients) ? recipients : [recipients];
  return list.filter((r) => r && !isDigestExcluded(r));
}