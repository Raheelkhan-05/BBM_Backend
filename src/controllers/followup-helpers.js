// followup-helpers.js
// Shared logic for deriving the "next action" label for an enquiry,
// based on its current sample/quotation status, instead of a manual pick.
//
// Used by: rfqs.controller.js (when creating a followup from the
// Follow-ups menu "Schedule Next Follow-up" action).

// Maps a sample_status -> what the salesperson should do next
const SAMPLE_NEXT_ACTION = {
  "Pending":                  "Sample to be Submitted",
  "Sent to Customer":         "Sample to be Tried",
  "Received from Customer":   "Collect Sample Feedback",
  "Approved":                 "Order Confirmation",
  "Rejected":                 "Close Enquiry",
};

// Maps a quotation_status -> what the salesperson should do next
const QUOTATION_NEXT_ACTION = {
  "Pending":                  "Quotation to be Submitted",
  "In Preparation":           "Quotation to be Submitted",
  "Sent to Customer":         "Collect Quotation Feedback",
  "Under Review":             "Price Negotiation",
  "Accepted":                 "Order Confirmation",
  "Rejected":                 "Close Enquiry",
};

/**
 * Derive the next_action label for an rfq, based on its latest
 * sample/quotation status. If the rfq has neither sample_required
 * nor quotation_required, returns null — caller should fall back
 * to a manual select in that case.
 *
 * @param {object} rfq - rfq row, must include sample_required, quotation_required
 * @param {object|null} latestSample - latest samples row for this rfq (or null)
 * @param {object|null} latestQuotation - latest quotations row for this rfq (or null)
 * @returns {string|null}
 */
export function deriveNextAction(rfq, latestSample, latestQuotation) {
  const needsSample = !!rfq?.sample_required;
  const needsQuote = !!rfq?.quotation_required;

  if (!needsSample && !needsQuote) return null; // plain enquiry — manual select instead

  // If both are required, prioritise whichever is least advanced /
  // surface the quotation action once sample is resolved, since
  // quotation usually follows sample approval in this business flow.
  const sampleAction = needsSample
    ? (SAMPLE_NEXT_ACTION[latestSample?.sample_status] || "Sample to be Submitted")
    : null;
  const quoteAction = needsQuote
    ? (QUOTATION_NEXT_ACTION[latestQuotation?.quotation_status] || "Quotation to be Submitted")
    : null;

  if (sampleAction && quoteAction) {
    // If sample isn't resolved yet (no terminal state), surface sample action first.
    const sampleResolved = ["Approved", "Rejected"].includes(latestSample?.sample_status);
    return sampleResolved ? quoteAction : sampleAction;
  }
  return sampleAction || quoteAction;
}

export const CLOSED_SAMPLE_STATUSES = new Set(["Approved", "Rejected"]);
export const CLOSED_QUOTATION_STATUSES = new Set(["Accepted", "Rejected"]);