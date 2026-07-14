// Shared logic for deriving the "next action" label for an enquiry,
// based on its current sample/quotation status, instead of a manual pick.
//
// Used by: rfqs.controller.js (when creating a followup from the
// Follow-ups menu "Schedule Next Follow-up" action), and by
// rfq-status-sync.js (auto follow-up on sample/quotation update).

import { SAMPLE_STAGES, QUOTATION_STAGES, REJECTED_STAGE } from "../constants/stages.js";

// Maps a sample_status -> what the salesperson should do next.
// Keys are the REAL stage names from constants/stages.js — do not
// hardcode strings here without checking SAMPLE_STAGES first.
const SAMPLE_NEXT_ACTION = {
  "Sample to be Submitted to Client": "Sample to be Collected from Client",
  "Sample to be Collected from Client": "Provided by buyer",
  "Provided by buyer":            "Submit Sample to Office",
  "Submitted to office":          "Submit Sample to Supplier",
  "Submitted to supplier":        "Follow up with Supplier",
  "Sample under development":     "Follow up on Development",
  "Received from supplier":       "Submit Sample to Client",
  "Sample submitted to client":   "Collect Client Feedback",
  "Under trial":                  "Follow up on Trial Result",
  "Approved with minor changes":  "Confirm Revised Sample",
  "Approved":                     "Order Confirmation",
  [REJECTED_STAGE]:               "Close Enquiry",
};

// Maps a quotation_status -> what the salesperson should do next.
// Keys are the REAL stage names from constants/stages.js.
const QUOTATION_NEXT_ACTION = {
  "Quotation Inquired to Customer": "Submit Quotation",
  "Quotation to be Submitted":    "Submit Quotation",
  "Quotation Submitted":          "Collect Quotation Feedback",
  "Under review":                 "Follow up on Review",
  "Quotation to be Negotiated":   "Price Negotiation",
  "Price accepted":               "Order Confirmation",
  "Approved":                     "Order Confirmation",
  [REJECTED_STAGE]:               "Close Enquiry",
};

// Fallback for "no sample/quotation row yet" — i.e. status is
// null/undefined because nothing has been logged for this rfq.
const SAMPLE_NOT_STARTED_ACTION = SAMPLE_NEXT_ACTION[SAMPLE_STAGES[0]];
const QUOTATION_NOT_STARTED_ACTION = QUOTATION_NEXT_ACTION[QUOTATION_STAGES[0]];

// Terminal statuses, derived from the real stage lists rather than
// re-typed by hand, so they can never drift out of sync with them.
export const CLOSED_SAMPLE_STATUSES = new Set([
  SAMPLE_STAGES[SAMPLE_STAGES.length - 1], // "Approved"
  REJECTED_STAGE,
]);
export const CLOSED_QUOTATION_STATUSES = new Set([
  QUOTATION_STAGES[QUOTATION_STAGES.length - 1], // "Approved"
  REJECTED_STAGE,
]);

/**
 * Derive the next_action label for an rfq, based on its latest
 * sample/quotation status. If the rfq has neither sample_required
 * nor quotation_required, returns null — caller should fall back
 * to a manual select in that case.
 *
 * @param {object} rfq - rfq row, must include sample_required, quotation_required
 * @param {object|null} latestSample - latest samples row for this rfq (must include sample_status)
 * @param {object|null} latestQuotation - latest quotations row for this rfq (must include quotation_status)
 * @returns {string|null}
 */
export function deriveNextAction(rfq, latestSample, latestQuotation) {
  const needsSample = !!rfq?.sample_required;
  const needsQuote = !!rfq?.quotation_required;

  if (!needsSample && !needsQuote) return null; // plain enquiry — manual select instead

  const sampleAction = needsSample
    ? (SAMPLE_NEXT_ACTION[latestSample?.sample_status] || SAMPLE_NOT_STARTED_ACTION)
    : null;
  const quoteAction = needsQuote
    ? (QUOTATION_NEXT_ACTION[latestQuotation?.quotation_status] || QUOTATION_NOT_STARTED_ACTION)
    : null;

  if (sampleAction && quoteAction) {
    // If sample isn't resolved yet (no terminal state), surface sample action first.
    const sampleResolved = CLOSED_SAMPLE_STATUSES.has(latestSample?.sample_status);
    return sampleResolved ? quoteAction : sampleAction;
  }
  return sampleAction || quoteAction;
}