// controllers/purge.controller.js
//
// PERMANENT (hard) delete endpoints — distinct from the existing
// soft-delete (deleted_at) flows used elsewhere in the app. These
// physically remove rows and their log history. Restricted to a single
// email address, enforced server-side (never trust a frontend-only gate
// for something this destructive).
//
// ── Cascade rules, per your explicit spec ───────────────────────────────
//
//  Delete PROSPECT → hard-deletes the prospect, its lead (if any), that
//    lead's enquiries (RFQs), and every sample/quotation/follow-up under
//    those enquiries — plus all corresponding log rows. Nothing survives.
//
//  Delete LEAD → hard-deletes the lead itself, plus its enquiries (RFQs)
//    and everything under them (samples, quotations, follow-ups, logs).
//    The ORIGINATING PROSPECT (if this lead was converted from one) is
//    retained untouched — it simply becomes an unconverted prospect again.
//
//  Delete ENQUIRY (RFQ) → hard-deletes that RFQ, its samples, quotations,
//    follow-ups, and all their logs. Sibling enquiries, the lead, and the
//    prospect are untouched.
//
//  Delete SAMPLE → hard-deletes just that sample + its sample_logs.
//  Delete QUOTATION → hard-deletes just that quotation + its quotation_logs.
//
// ── Why the deletion order below matters ────────────────────────────────
// Per your schema:
//   - lead_logs, prospect_logs, rfq_logs, rfq_followup_logs all have
//     ON DELETE CASCADE back to their parent — deleting the parent row
//     purges those logs automatically, no manual step needed.
//   - sample_logs, quotation_logs, samples, quotations, and rfq_followups
//     do NOT cascade (no ON DELETE clause = RESTRICT) — those must be
//     deleted manually, in child-before-parent order, or the parent
//     delete will fail with a foreign-key violation.

import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const HEAD_EMAIL = "communication@bbmpvtltd.com";

function requireHead(req, res) {
  if (req.user?.email !== HEAD_EMAIL) {
    res.status(403).json({ success: false, message: "Not authorized for permanent deletion" });
    return false;
  }
  return true;
}

// Deletes every sample/quotation/follow-up (+ their logs) under the given
// RFQ ids. Does NOT touch the rfqs rows themselves — callers decide
// whether the RFQ row survives (lead-purge keeps children gone but the
// caller still deletes the rfqs afterward per spec) or is deleted too.
async function purgeRfqChildren(rfqIds) {
  const ids = (rfqIds || []).filter(Boolean);
  if (!ids.length) return;

  const [{ data: sampleRows, error: sErr }, { data: quotationRows, error: qErr }] = await Promise.all([
    supabaseAdmin.from("samples").select("id").in("rfq_id", ids),
    supabaseAdmin.from("quotations").select("id").in("rfq_id", ids),
  ]);
  if (sErr) throw new Error(`fetch samples: ${sErr.message}`);
  if (qErr) throw new Error(`fetch quotations: ${qErr.message}`);

  const sampleIds    = (sampleRows || []).map((s) => s.id);
  const quotationIds = (quotationRows || []).map((q) => q.id);

  // 1. Logs that don't cascade — must go before their parent rows.
  await Promise.all([
    sampleIds.length
      ? supabaseAdmin.from("sample_logs").delete().in("sample_id", sampleIds)
      : Promise.resolve(),
    quotationIds.length
      ? supabaseAdmin.from("quotation_logs").delete().in("quotation_id", quotationIds)
      : Promise.resolve(),
  ]);

  // 2. samples / quotations / rfq_followups all RESTRICT against rfqs —
  //    must be gone before the rfqs row can be deleted.
  //    (rfq_followup_logs cascade automatically here, via both their
  //    followup_id AND rfq_id foreign keys.)
  await Promise.all([
    sampleIds.length
      ? supabaseAdmin.from("samples").delete().in("id", sampleIds)
      : Promise.resolve(),
    quotationIds.length
      ? supabaseAdmin.from("quotations").delete().in("id", quotationIds)
      : Promise.resolve(),
    supabaseAdmin.from("rfq_followups").delete().in("rfq_id", ids),
  ]);
}

// ── DELETE /api/purge/samples/:id ───────────────────────────────────────
export const purgeSample = async (req, res) => {
  if (!requireHead(req, res)) return;
  try {
    const { id } = req.params;
    await supabaseAdmin.from("sample_logs").delete().eq("sample_id", id);
    const { error } = await supabaseAdmin.from("samples").delete().eq("id", id);
    if (error) return res.status(400).json({ success: false, message: error.message });
    console.log(`[purge] Sample ${id} permanently deleted by ${req.user.email}`);
    return res.json({ success: true, message: "Sample permanently deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/purge/quotations/:id ────────────────────────────────────
export const purgeQuotation = async (req, res) => {
  if (!requireHead(req, res)) return;
  try {
    const { id } = req.params;
    await supabaseAdmin.from("quotation_logs").delete().eq("quotation_id", id);
    const { error } = await supabaseAdmin.from("quotations").delete().eq("id", id);
    if (error) return res.status(400).json({ success: false, message: error.message });
    console.log(`[purge] Quotation ${id} permanently deleted by ${req.user.email}`);
    return res.json({ success: true, message: "Quotation permanently deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/purge/rfqs/:id ──────────────────────────────────────────
// Deletes the enquiry itself + everything under it. Lead, prospect, and
// sibling enquiries are untouched.
export const purgeEnquiry = async (req, res) => {
  if (!requireHead(req, res)) return;
  try {
    const { id } = req.params;
    const { data: rfq, error: fetchErr } = await supabaseAdmin
      .from("rfqs").select("id").eq("id", id).single();
    if (fetchErr || !rfq) return res.status(404).json({ success: false, message: "Enquiry not found" });

    await purgeRfqChildren([id]);
    // rfq_logs + any stray rfq_followup_logs cascade automatically here.
    const { error } = await supabaseAdmin.from("rfqs").delete().eq("id", id);
    if (error) return res.status(400).json({ success: false, message: error.message });

    console.log(`[purge] Enquiry ${id} permanently deleted by ${req.user.email}`);
    return res.json({ success: true, message: "Enquiry permanently deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/purge/leads/:id ─────────────────────────────────────────
// Deletes the LEAD ITSELF, plus every enquiry (and everything under them)
// belonging to it. The originating PROSPECT (if this lead was converted
// from one) is left completely untouched — leads has no FK requiring
// cleanup on the prospects side, so the prospect record simply remains as
// prospect data, no longer linked to any lead.
export const purgeLead = async (req, res) => {
  if (!requireHead(req, res)) return;
  try {
    const { id } = req.params;
    const { data: lead, error: leadErr } = await supabaseAdmin
      .from("leads").select("id").eq("id", id).single();
    if (leadErr || !lead) return res.status(404).json({ success: false, message: "Lead not found" });

    const { data: rfqRows, error: rfqFetchErr } = await supabaseAdmin
      .from("rfqs").select("id").eq("lead_id", id);
    if (rfqFetchErr) return res.status(400).json({ success: false, message: rfqFetchErr.message });

    const rfqIds = (rfqRows || []).map((r) => r.id);
    if (rfqIds.length) {
      await purgeRfqChildren(rfqIds);
      // rfq_logs + rfq_followup_logs cascade automatically as these rows go.
      const { error } = await supabaseAdmin.from("rfqs").delete().in("id", rfqIds);
      if (error) return res.status(400).json({ success: false, message: error.message });
    }

    // Now the lead itself. lead_logs cascades automatically (ON DELETE
    // CASCADE via lead_logs_lead_id_fkey). The lead's prospect_id (if any)
    // is not touched here — deleting a lead has no effect on its
    // originating prospects row.
    const { error: leadDelErr } = await supabaseAdmin.from("leads").delete().eq("id", id);
    if (leadDelErr) return res.status(400).json({ success: false, message: leadDelErr.message });

    console.log(`[purge] Lead ${id} + ${rfqIds.length} enquiry(ies) permanently deleted by ${req.user.email} (originating prospect, if any, retained)`);
    return res.json({
      success: true,
      message: `Lead and ${rfqIds.length} enquiry(ies) permanently deleted. Any originating prospect record was retained.`,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/purge/prospects/:id ─────────────────────────────────────
// Deletes the prospect, its lead (if converted), that lead's enquiries,
// and everything under them. Nothing survives.
export const purgeProspect = async (req, res) => {
  if (!requireHead(req, res)) return;
  try {
    const { id } = req.params;
    const { data: prospect, error: pErr } = await supabaseAdmin
      .from("prospects").select("id").eq("id", id).single();
    if (pErr || !prospect) return res.status(404).json({ success: false, message: "Prospect not found" });

    const { data: leadRows, error: leadFetchErr } = await supabaseAdmin
      .from("leads").select("id").eq("prospect_id", id);
    if (leadFetchErr) return res.status(400).json({ success: false, message: leadFetchErr.message });
    const leadIds = (leadRows || []).map((l) => l.id);

    if (leadIds.length) {
      const { data: rfqRows, error: rfqFetchErr } = await supabaseAdmin
        .from("rfqs").select("id").in("lead_id", leadIds);
      if (rfqFetchErr) return res.status(400).json({ success: false, message: rfqFetchErr.message });
      const rfqIds = (rfqRows || []).map((r) => r.id);

      if (rfqIds.length) {
        await purgeRfqChildren(rfqIds);
        const { error: rfqDelErr } = await supabaseAdmin.from("rfqs").delete().in("id", rfqIds);
        if (rfqDelErr) return res.status(400).json({ success: false, message: rfqDelErr.message });
      }

      // leads has no self-cascade from prospects (prospect_id is
      // ON DELETE SET NULL, which would ORPHAN the lead rather than
      // remove it) — so the lead must be deleted explicitly here.
      // lead_logs cascades automatically once the lead row goes.
      const { error: leadDelErr } = await supabaseAdmin.from("leads").delete().in("id", leadIds);
      if (leadDelErr) return res.status(400).json({ success: false, message: leadDelErr.message });
    }

    // prospect_logs cascades automatically once the prospect row goes.
    const { error } = await supabaseAdmin.from("prospects").delete().eq("id", id);
    if (error) return res.status(400).json({ success: false, message: error.message });

    console.log(`[purge] Prospect ${id} + ${leadIds.length} lead(s) permanently deleted by ${req.user.email}`);
    return res.json({ success: true, message: "Prospect and all related records permanently deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};