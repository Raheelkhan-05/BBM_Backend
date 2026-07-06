import { createClient } from "@supabase/supabase-js";
import { deriveNextAction } from "./followup-helpers.js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const nowUTC = () => new Date().toISOString();

// Same encoding EnquiryCard/utils.js expect: "[Time: HH:MM] rest of notes"
function encodeTimeInNotes(time, notes) {
  const base = (notes || "").replace(/^\[Time: \d{2}:\d{2}\]\s*/, "").trim();
  if (!time) return base || null;
  return `[Time: ${time}]${base ? " " + base : ""}`;
}

export async function syncRfqStatus(rfqId, userId) {
  if (!rfqId) return;

  const [{ data: rfq }, { data: sampleRow }, { data: quoteRow }] = await Promise.all([
    supabaseAdmin.from("rfqs").select("id, sample_required, quotation_required").eq("id", rfqId).single(),
    supabaseAdmin.from("samples").select("result, follow_up_date, follow_up_time")
      .eq("rfq_id", rfqId).is("deleted_at", null).single(),
    supabaseAdmin.from("quotations").select("result, follow_up_date, follow_up_time")
      .eq("rfq_id", rfqId).is("deleted_at", null).single(),
  ]);
  if (!rfq) return;

  const nextAction = deriveNextAction(rfq, sampleRow || null, quoteRow || null);

  // Pick whichever record (sample or quotation) is nearest, and carry
  // BOTH its date and its time — not just the date.
  const candidates = [
    sampleRow?.follow_up_date ? { date: sampleRow.follow_up_date, time: sampleRow.follow_up_time || null } : null,
    quoteRow?.follow_up_date  ? { date: quoteRow.follow_up_date,  time: quoteRow.follow_up_time  || null } : null,
  ].filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));

  const nearest = candidates[0] || null;

  await supabaseAdmin
    .from("rfqs")
    .update({ updated_by: userId, updated_at: nowUTC() })
    .eq("id", rfqId);

  if (nearest) {
    const { error } = await supabaseAdmin.from("rfq_followups").insert([{
      rfq_id: rfqId,
      contact_type: "System",
      enquiry_status: "In Progress",
      next_action: nextAction,
      followup_date: nearest.date,
      notes: encodeTimeInNotes(nearest.time, "Auto-updated from sample/quotation change"),
      created_by: userId,
    }]);
    if (error) console.error("syncRfqStatus rfq_followups insert:", error.message);
  }
}