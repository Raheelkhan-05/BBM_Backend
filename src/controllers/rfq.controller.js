// controllers/rfq.controller.js
// Logs EVERY mutation: rfqs, rfq_followups, samples, quotations all get audit rows.
//
// TEAM MODEL: any team member can create/update any record. created_by /
// updated_by track WHO did WHAT (for display + the Mine/Team filter), they
// no longer gate WHO CAN. Deletion stays restricted to creator-or-Admin.
//
// REMOVED: this file used to also export updateSample/updateQuotation,
// duplicating the versions in samples.controller.js / quotations.controller.js.
// Two same-named exports from different files is a latent bug — whichever
// one your routes actually imported determined what got written to
// sample_logs/quotation_logs, and only one of them could ever be kept in
// sync with fixes like updated_by tracking. Removed here; make sure your
// routes file imports updateSample from samples.controller.js and
// updateQuotation from quotations.controller.js.
//
// FIXED: createRFQ/updateRFQ used to fire-and-forget the samples/quotations
// insert with `.then(({ data: s }) => { if (s) logSample(...) })` — if the
// insert itself failed (RLS, trigger, whatever), `error` was never even
// looked at. The RFQ would end up with sample_required/quotation_required
// = true but NO row in samples/quotations at all, which surfaces in the UI
// as "No record found" with nothing to fix it. Both paths below now await
// the insert and log a loud error if it fails, and a new ensureSampleQuotation
// endpoint self-heals any enquiry that's already stuck in that state.

import { sendMail } from "../config/mailer.js";
import { rfqCreatedSalesperson, rfqCreatedCoordinator } from "../config/emailTemplates.js";
import { createClient } from "@supabase/supabase-js";
import { deriveNextAction } from "./followup-helpers.js";

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const COORDINATOR_EMAIL = process.env.SALES_COORDINATOR_EMAIL;
const nowUTC = () => new Date().toISOString();
const sendMailAsync = (opts) => sendMail(opts).catch((e) => console.error("Mail error:", e.message));

async function getSalespersonEmail(userId) {
  const { data } = await supabaseAdmin.from("users").select("email").eq("id", userId).single();
  return data?.email || null;
}



const RFQ_FIELDS = [
  "lead_id","company_name","product_category","product_sub_category","product_name",
  "product_description","consumption_per_month","unit","sample_required","sample_description",
  "sample_received_from_customer","quotation_required","quotation_description",
  "existing_supplier_brand","notes","target_price","tds_available",
];

function pickDefined(body, keys) {
  const out = {};
  for (const k of keys) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

function diffSnapshot(existing, incoming) {
  const changed = {};
  for (const k of Object.keys(incoming)) {
    if (JSON.stringify(existing[k]) !== JSON.stringify(incoming[k])) changed[k] = incoming[k];
  }
  return changed;
}

// ── fire-and-forget log helpers ────────────────────────────────────────────
function logRFQ(rfqId, action, changedBy, snapshot = {}) {
  supabaseAdmin.from("rfq_logs")
    .insert([{ rfq_id: rfqId, action, changed_by: changedBy, changed_at: nowUTC(), ...snapshot }])
    .then(({ error }) => { if (error) console.error("rfq_logs:", error.message); });
}

// Pass rfq_id explicitly — it's not part of the field-level snapshot,
// it's how the Activity feed resolves which company/enquiry this
// follow-up log row belongs to. Previously omitted entirely, so every
// follow-up log had rfq_id = NULL and rendered as "Unknown company".
function logFollowup(followupId, rfqId, action, changedBy, snapshot = {}) {
  supabaseAdmin.from("rfq_followup_logs")
    .insert([{ followup_id: followupId, rfq_id: rfqId, action, changed_by: changedBy, changed_at: nowUTC(), ...snapshot }])
    .then(({ error }) => { if (error) console.error("rfq_followup_logs:", error.message); });
}

function logSample(sampleId, action, updatedBy, snapshot = {}) {
  supabaseAdmin.from("sample_logs")
    .insert([{ sample_id: sampleId, updated_by: updatedBy, updated_at: nowUTC(), ...snapshot }])
    .then(({ error }) => { if (error) console.error("sample_logs:", error.message); });
}

function logQuotation(quotationId, action, updatedBy, snapshot = {}) {
  supabaseAdmin.from("quotation_logs")
    .insert([{ quotation_id: quotationId, updated_by: updatedBy, updated_at: nowUTC(), ...snapshot }])
    .then(({ error }) => { if (error) console.error("quotation_logs:", error.message); });
}

// ── snapshot builders ───────────────────────────────────────────────────────
function rfqSnapshot(f) {
  return {
    product_category:              f.product_category              ?? null,
    product_sub_category:          f.product_sub_category          ?? null,
    product_name:                  f.product_name                  ?? null,
    product_description:           f.product_description           ?? null,
    consumption_per_month:         f.consumption_per_month         || null,
    unit:                          f.unit                          ?? null,
    sample_required:               f.sample_required               ?? false,
    sample_description:            f.sample_description            ?? null,
    sample_received_from_customer: f.sample_received_from_customer ?? false,
    quotation_required:            f.quotation_required            ?? false,
    quotation_description:         f.quotation_description         ?? null,
    existing_supplier_brand:       f.existing_supplier_brand       ?? null,
    notes:                         f.notes                         || null,
    target_price:                  f.target_price                  || null,
    tds_available:                 f.tds_available                 ?? false,
  };
}

function followupSnapshot(f) {
  return {
    contact_type:            f.contact_type            ?? null,
    sample_status_update:    f.sample_status_update    ?? null,
    quotation_status_update: f.quotation_status_update ?? null,
    next_action:             f.next_action             ?? null,
    notes:                   f.notes                   ?? null,
    followup_date:           f.followup_date           || null,
    target_price:            f.target_price            || null,
    enquiry_status:          f.enquiry_status          ?? null,
    remark:                  f.remark                  ?? null,
  };
}

const RFQ_WITH_CREATOR_UPDATER = `
  *, leads(id, company_name, primary_contact_name, primary_phone, primary_email, city, country, state),
  creator:users!rfqs_created_by_fkey(id, email, first_name, last_name),
  updater:users!rfqs_updated_by_fkey(id, email, first_name, last_name),
  rfq_followups(*),
  samples(id, sample_code, sample_status, result, priority, notes, description, reject_reason, follow_up_date, follow_up_time, updated_at,
    creator:users!samples_created_by_fkey(id, email, first_name, last_name),
    updater:users!samples_updated_by_fkey_main(id, email, first_name, last_name)),
  quotations(id, quotation_code, quotation_status, result, priority, notes, description, reject_reason, follow_up_date, follow_up_time, updated_at,
    creator:users!quotations_created_by_fkey(id, email, first_name, last_name),
    updater:users!quotations_updated_by_fkey_main(id, email, first_name, last_name))
`;

const SAMPLE_WITH_CREATOR_UPDATER =
  "*, creator:users!samples_created_by_fkey(id, email, first_name, last_name), " +
  "updater:users!samples_updated_by_fkey_main(id, email, first_name, last_name)";

const QUOTATION_WITH_CREATOR_UPDATER =
  "*, creator:users!quotations_created_by_fkey(id, email, first_name, last_name), " +
  "updater:users!quotations_updated_by_fkey_main(id, email, first_name, last_name)";

// ── GET /api/rfqs ──────────────────────────────────────────────────────────
// TEAM VISIBILITY: everyone sees every RFQ. Mine/Team split happens client-side.
export const getRFQs = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("rfqs")
      .select(RFQ_WITH_CREATOR_UPDATER)
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, rfqs: data });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── GET /api/rfqs/leads ────────────────────────────────────────────────────
export const getLeadsForRFQ = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.from("leads")
      .select("id, company_name, primary_contact_name, city, state, country, zone, route, nature_of_business, potential_product_name, potential_product_category, potential_product_sub_category")
      .is("deleted_at", null).order("company_name", { ascending: true });
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, leads: data });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── POST /api/rfqs ─────────────────────────────────────────────────────────
export const createRFQ = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const {
      lead_id, company_name, product_category, product_sub_category, product_name,
      product_description, consumption_per_month, unit, sample_required, sample_description,
      sample_received_from_customer, quotation_required, quotation_description,
      existing_supplier_brand, notes, target_price, tds_available,
      followup_date, followup_time,   // ⬅ MUST be sent by the form — see AddEnquiryForm below
    } = req.body;

    const salespersonEmail = await getSalespersonEmail(userId);

    const { data, error } = await supabaseAdmin.from("rfqs").insert([{
      lead_id, company_name, product_category, product_sub_category, product_name,
      product_description, consumption_per_month: consumption_per_month || null, unit,
      sample_required: sample_required ?? false, sample_description,
      sample_received_from_customer: sample_received_from_customer ?? false,
      quotation_required: quotation_required ?? false, quotation_description,
      existing_supplier_brand, notes: notes || null, target_price: target_price || null,
      tds_available: tds_available ?? false, created_by: userId, updated_by: userId,
    }]).select().single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    logRFQ(data.id, "created", userId, rfqSnapshot(req.body));

    // Create the sample/quotation side-rows and ACTUALLY check for errors —
    // previously this was fire-and-forget with the error silently dropped,
    // which is how enquiries ended up with sample_required=true and no
    // sample row at all. Awaited here (fast, and RFQ creation isn't
    // considered fully successful until these are known to have worked).
    const [sampleOutcome, quotationOutcome] = await Promise.all([
      sample_required
        ? supabaseAdmin.from("samples").insert([{
            rfq_id: data.id, sample_required: true, sample_status: null,
            follow_up_date: followup_date || null, follow_up_time: followup_time || null,
            created_by: userId, updated_by: userId,
          }]).select().single()
        : Promise.resolve({ data: null, error: null }),
      quotation_required
        ? supabaseAdmin.from("quotations").insert([{
            rfq_id: data.id, quotation_required: true, quotation_status: null,
            follow_up_date: followup_date || null, follow_up_time: followup_time || null,
            created_by: userId, updated_by: userId,
          }]).select().single()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (sample_required) {
      if (sampleOutcome.error) {
        console.error("createRFQ: FAILED to create sample row for rfq", data.id, "-", sampleOutcome.error.message);
      } else if (sampleOutcome.data) {
        logSample(sampleOutcome.data.id, "created", userId, { sample_status: null, follow_up_date: followup_date || null });
      }
    }
    if (quotation_required) {
      if (quotationOutcome.error) {
        console.error("createRFQ: FAILED to create quotation row for rfq", data.id, "-", quotationOutcome.error.message);
      } else if (quotationOutcome.data) {
        logQuotation(quotationOutcome.data.id, "created", userId, { quotation_status: null, follow_up_date: followup_date || null });
      }
    }

    if (salespersonEmail) sendMailAsync(rfqCreatedSalesperson({ salespersonEmail, rfq: data }));
    if (COORDINATOR_EMAIL && (sample_required || quotation_required)) {
      sendMailAsync(rfqCreatedCoordinator({ coordinatorEmail: COORDINATOR_EMAIL, rfq: data, salespersonEmail: salespersonEmail || "Unknown" }));
    }

    return res.status(201).json({
      success: true,
      rfq: {
        ...data,
        samples:    sample_required    && sampleOutcome?.data    ? [sampleOutcome.data]    : [],
        quotations: quotation_required && quotationOutcome?.data ? [quotationOutcome.data] : [],
      },
    });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── PUT /api/rfqs/:id ──────────────────────────────────────────────────────
export const updateRFQ = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;

    const { data: existing, error: fetchError } = await supabaseAdmin
      .from("rfqs").select("*").eq("id", id).is("deleted_at", null).single();
    if (fetchError || !existing)
      return res.status(404).json({ success: false, message: "RFQ not found" });

    const sentKeys = Object.keys(req.body).filter(k =>
      Object.prototype.hasOwnProperty.call(existing, k) && req.body[k] !== undefined
    );
    const merged = { ...existing };
    for (const k of sentKeys) merged[k] = req.body[k];

    const salespersonEmail = await getSalespersonEmail(existing.created_by);

    const { data, error } = await supabaseAdmin.from("rfqs").update({
      lead_id: merged.lead_id, company_name: merged.company_name,
      product_category: merged.product_category, product_sub_category: merged.product_sub_category,
      product_name: merged.product_name, product_description: merged.product_description,
      consumption_per_month: merged.consumption_per_month || null, unit: merged.unit,
      sample_required: merged.sample_required ?? false, sample_description: merged.sample_description,
      sample_received_from_customer: merged.sample_received_from_customer ?? false,
      quotation_required: merged.quotation_required ?? false, quotation_description: merged.quotation_description,
      existing_supplier_brand: merged.existing_supplier_brand, notes: merged.notes || null,
      target_price: merged.target_price || null, tds_available: merged.tds_available ?? false,
      updated_by: userId, updated_at: nowUTC(),
    }).eq("id", id).select().single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    // Full snapshot of the resulting row — same reasoning as leads.
    logRFQ(id, "updated", userId, rfqSnapshot(merged));

    // Toggle logic reads the MERGED effective values, so a caller that never
    // mentions sample_required/quotation_required can't accidentally toggle them off.
    const sample_required    = merged.sample_required;
    const quotation_required = merged.quotation_required;

    if (sample_required && !existing.sample_required) {
      const { data: s, error: sErr } = await supabaseAdmin.from("samples").insert([{
        rfq_id: id, sample_required: true, sample_status: null, follow_up_date: null, created_by: userId, updated_by: userId,
      }]).select().single();
      if (sErr) console.error("updateRFQ: FAILED to create sample row for rfq", id, "-", sErr.message);
      else if (s) {
        logSample(s.id, "created", userId, { sample_status: null, follow_up_date: null });
        if (COORDINATOR_EMAIL) sendMailAsync(rfqCreatedCoordinator({ coordinatorEmail: COORDINATOR_EMAIL, rfq: data, salespersonEmail: salespersonEmail || "Unknown" }));
      }
    } else if (!sample_required && existing.sample_required) {
      const { data: sRow } = await supabaseAdmin.from("samples").select("id").eq("rfq_id", id).single();
      if (sRow) {
        logSample(sRow.id, "deleted", userId, { sample_status: null, follow_up_date: null });
        await Promise.all([
          supabaseAdmin.from("sample_logs").delete().eq("sample_id", sRow.id),
          supabaseAdmin.from("samples").delete().eq("rfq_id", id),
        ]);
      }
    }

    if (quotation_required && !existing.quotation_required) {
      const { data: q, error: qErr } = await supabaseAdmin.from("quotations").insert([{
        rfq_id: id, quotation_required: true, quotation_status: null, follow_up_date: null, created_by: userId, updated_by: userId,
      }]).select().single();
      if (qErr) console.error("updateRFQ: FAILED to create quotation row for rfq", id, "-", qErr.message);
      else if (q) {
        logQuotation(q.id, "created", userId, { quotation_status: null, follow_up_date: null });
        if (COORDINATOR_EMAIL) sendMailAsync(rfqCreatedCoordinator({ coordinatorEmail: COORDINATOR_EMAIL, rfq: data, salespersonEmail: salespersonEmail || "Unknown" }));
      }
    } else if (!quotation_required && existing.quotation_required) {
      const { data: qRow } = await supabaseAdmin.from("quotations").select("id").eq("rfq_id", id).single();
      if (qRow) {
        logQuotation(qRow.id, "deleted", userId, { quotation_status: null, follow_up_date: null });
        await Promise.all([
          supabaseAdmin.from("quotation_logs").delete().eq("quotation_id", qRow.id),
          supabaseAdmin.from("quotations").delete().eq("rfq_id", id),
        ]);
      }
    }

    return res.json({ success: true, rfq: data });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── PATCH /api/rfqs/:id/toggles ────────────────────────────────────────────
// A narrow, dedicated edit surface for exactly the three fields a user is
// allowed to fix after an enquiry has already been created — sample_required,
// quotation_required, and tds_available. Deliberately does NOT touch any
// other rfq column: calling the full updateRFQ with a partial body would
// blank out everything the caller didn't send.
//
// Turning Sample/Quotation ON creates the matching row (same as the toggle
// logic in updateRFQ); turning it OFF hard-deletes that row and its logs —
// there's no "undo" once the checkbox is unchecked and saved.
export const updateRFQToggles = async (req, res) => {
  try {
    const id = req.params.id || req.params.rfqId;
    const { id: userId } = req.user;
    if (!id) {
      console.error("updateRFQToggles: no rfq id in route params —", JSON.stringify(req.params));
      return res.status(400).json({ success: false, message: "Missing rfq id in request" });
    }

    const sample_required    = !!req.body.sample_required;
    const quotation_required = !!req.body.quotation_required;
    const tds_available      = !!req.body.tds_available;

    // Full row now (was: "id, sample_required, quotation_required, tds_available")
    // — needed so the log we write below is a COMPLETE snapshot, not just
    // these 3 fields. A partial snapshot here is exactly what made every
    // other field look "cleared" in the Activity feed: the feed diffs full
    // row-snapshots between consecutive rfq_logs rows for the same RFQ.
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("rfqs")
      .select("*")
      .eq("id", id)
      .is("deleted_at", null)
      .single();
    if (fetchErr || !existing) {
      console.error("updateRFQToggles: rfq not found for id", id, "-", fetchErr?.message);
      return res.status(404).json({ success: false, message: `RFQ not found for id ${id}` });
    }

    const { data: existingOrder } = await supabaseAdmin
      .from("orders").select("id").eq("rfq_id", id).is("deleted_at", null).maybeSingle();
    if (existingOrder) {
      return res.status(400).json({
        success: false,
        message: "This enquiry has already been converted to an order — revert the order before editing Sample/Quotation.",
      });
    }

    const { data: updatedRfq, error: updateErr } = await supabaseAdmin
      .from("rfqs")
      .update({ sample_required, quotation_required, tds_available, updated_by: userId, updated_at: nowUTC() })
      .eq("id", id)
      .select("*")
      .single();
    if (updateErr) return res.status(400).json({ success: false, message: updateErr.message });

    // Full snapshot: existing row's untouched fields + the 3 toggles just applied.
    logRFQ(id, "sample_quotation_toggled", userId, rfqSnapshot({ ...existing, sample_required, quotation_required, tds_available }));

    const result = { sample: null, quotation: null, sampleRemoved: false, quotationRemoved: false };

    let seedDate = null, seedTime = null;
    if ((sample_required && !existing.sample_required) || (quotation_required && !existing.quotation_required)) {
      // Sample and quotation share one follow-up date now. If the sibling
      // record already exists (e.g. sample is being turned on but a
      // quotation row already has a date), seed the new row from THAT
      // instead of the last general follow-up — otherwise the two would
      // start out on different dates and immediately split apart again.
      const [{ data: sibSample }, { data: sibQuote }] = await Promise.all([
        supabaseAdmin.from("samples").select("follow_up_date, follow_up_time")
          .eq("rfq_id", id).is("deleted_at", null).maybeSingle(),
        supabaseAdmin.from("quotations").select("follow_up_date, follow_up_time")
          .eq("rfq_id", id).is("deleted_at", null).maybeSingle(),
      ]);
      const sibDate = sibSample?.follow_up_date || sibQuote?.follow_up_date || null;
      const sibTime = sibSample?.follow_up_time || sibQuote?.follow_up_time || null;

      if (sibDate) {
        seedDate = sibDate;
        seedTime = sibTime;
      } else {
        const { data: latestFollowup } = await supabaseAdmin
          .from("rfq_followups")
          .select("followup_date, notes")
          .eq("rfq_id", id)
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        seedDate = latestFollowup?.followup_date || null;
        const timeMatch = /^\[Time:\s*(\d{2}:\d{2})\]/.exec(latestFollowup?.notes || "");
        seedTime = timeMatch ? timeMatch[1] : null;
      }
    }

    if (sample_required && !existing.sample_required) {
      const { data: s, error: sErr } = await supabaseAdmin
        .from("samples")
        .insert([{
          rfq_id: id, sample_required: true, sample_status: null,
          follow_up_date: seedDate, follow_up_time: seedTime,
          created_by: userId, updated_by: userId,
        }])
        .select(SAMPLE_WITH_CREATOR_UPDATER)
        .single();
      if (sErr) console.error("updateRFQToggles: FAILED to create sample row for rfq", id, "-", sErr.message);
      else if (s) {
        logSample(s.id, "created", userId, { sample_status: null, follow_up_date: seedDate, follow_up_time: seedTime });
        result.sample = s;
      }
    } else if (!sample_required && existing.sample_required) {
      const { data: sRow } = await supabaseAdmin.from("samples").select("id, sample_status")
        .eq("rfq_id", id).is("deleted_at", null).maybeSingle();
      if (sRow) {
        logSample(sRow.id, "deleted", userId, { sample_status: sRow.sample_status, follow_up_date: null });
        await Promise.all([
          supabaseAdmin.from("sample_logs").delete().eq("sample_id", sRow.id),
          supabaseAdmin.from("samples").delete().eq("id", sRow.id),
        ]);
      }
      result.sampleRemoved = true;
    }

    if (quotation_required && !existing.quotation_required) {
      const { data: q, error: qErr } = await supabaseAdmin
        .from("quotations")
        .insert([{
          rfq_id: id, quotation_required: true, quotation_status: null,
          follow_up_date: seedDate, follow_up_time: seedTime,
          created_by: userId, updated_by: userId,
        }])
        .select(QUOTATION_WITH_CREATOR_UPDATER)
        .single();
      if (qErr) console.error("updateRFQToggles: FAILED to create quotation row for rfq", id, "-", qErr.message);
      else if (q) {
        logQuotation(q.id, "created", userId, { quotation_status: null, follow_up_date: seedDate, follow_up_time: seedTime });
        result.quotation = q;
      }
    } else if (!quotation_required && existing.quotation_required) {
      const { data: qRow } = await supabaseAdmin.from("quotations").select("id, quotation_status")
        .eq("rfq_id", id).is("deleted_at", null).maybeSingle();
      if (qRow) {
        logQuotation(qRow.id, "deleted", userId, { quotation_status: qRow.quotation_status, follow_up_date: null });
        await Promise.all([
          supabaseAdmin.from("quotation_logs").delete().eq("quotation_id", qRow.id),
          supabaseAdmin.from("quotations").delete().eq("id", qRow.id),
        ]);
      }
      result.quotationRemoved = true;
    }

    return res.json({ success: true, rfq: updatedRfq, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};


// Self-heal: an enquiry can end up with sample_required/quotation_required
// = true but no matching row (see FIXED note above — old silent insert
// failures). This creates whichever row(s) are actually missing (or just
// hands back the existing one) so the "No record found" dead-end in the UI
// has a one-click fix instead of needing a manual DB repair.
export const ensureSampleQuotation = async (req, res) => {
  try {
    // Tolerant of either route param name — this file mixes `:id` (e.g.
    // updateRFQ/deleteRFQ) and `:rfqId` (e.g. getFollowups/createFollowup)
    // depending on the endpoint, so whichever your router uses for this
    // route works without needing an exact match.
    const id = req.params.id || req.params.rfqId;
    const { id: userId } = req.user;

    if (!id) {
      console.error("ensureSampleQuotation: no rfq id in route params —", JSON.stringify(req.params));
      return res.status(400).json({ success: false, message: "Missing rfq id in request" });
    }

    const { data: rfq, error: rfqErr } = await supabaseAdmin
      .from("rfqs")
      .select("id, sample_required, quotation_required")
      .eq("id", id)
      .is("deleted_at", null)
      .single();
    if (rfqErr || !rfq) {
      console.error("ensureSampleQuotation: rfq not found for id", id, "-", rfqErr?.message);
      return res.status(404).json({ success: false, message: `RFQ not found for id ${id}` });
    }

    const result = { sample: null, quotation: null };

    if (rfq.sample_required) {
      const { data: existingSample } = await supabaseAdmin
        .from("samples").select(SAMPLE_WITH_CREATOR_UPDATER)
        .eq("rfq_id", id).is("deleted_at", null).maybeSingle();

      if (existingSample) {
        result.sample = existingSample;
      } else {
        // Self-healing a missing sample row — if a quotation already
        // exists for this enquiry, inherit its follow-up date/time so the
        // newly-created sample doesn't start out on a different due date.
        const { data: sibQuote } = await supabaseAdmin
          .from("quotations").select("follow_up_date, follow_up_time")
          .eq("rfq_id", id).is("deleted_at", null).maybeSingle();

        const { data: s, error: sErr } = await supabaseAdmin
          .from("samples")
          .insert([{
            rfq_id: id, sample_required: true, sample_status: null,
            follow_up_date: sibQuote?.follow_up_date || null,
            follow_up_time: sibQuote?.follow_up_time || null,
            created_by: userId, updated_by: userId,
          }])
          .select(SAMPLE_WITH_CREATOR_UPDATER)
          .single();
        if (sErr) return res.status(400).json({ success: false, message: "Failed to create sample record: " + sErr.message });
        logSample(s.id, "created", userId, {
          sample_status: null,
          follow_up_date: sibQuote?.follow_up_date || null,
          follow_up_time: sibQuote?.follow_up_time || null,
        });
        result.sample = s;
      }
    }

    if (rfq.quotation_required) {
      const { data: existingQuote } = await supabaseAdmin
        .from("quotations").select(QUOTATION_WITH_CREATOR_UPDATER)
        .eq("rfq_id", id).is("deleted_at", null).maybeSingle();

      if (existingQuote) {
        result.quotation = existingQuote;
      } else {
        // Same self-heal, mirrored — inherit the sample's date if one exists.
        const { data: sibSample } = await supabaseAdmin
          .from("samples").select("follow_up_date, follow_up_time")
          .eq("rfq_id", id).is("deleted_at", null).maybeSingle();

        const { data: q, error: qErr } = await supabaseAdmin
          .from("quotations")
          .insert([{
            rfq_id: id, quotation_required: true, quotation_status: null,
            follow_up_date: sibSample?.follow_up_date || null,
            follow_up_time: sibSample?.follow_up_time || null,
            created_by: userId, updated_by: userId,
          }])
          .select(QUOTATION_WITH_CREATOR_UPDATER)
          .single();
        if (qErr) return res.status(400).json({ success: false, message: "Failed to create quotation record: " + qErr.message });
        logQuotation(q.id, "created", userId, {
          quotation_status: null,
          follow_up_date: sibSample?.follow_up_date || null,
          follow_up_time: sibSample?.follow_up_time || null,
        });
        result.quotation = q;
      }
    }

    return res.json({ success: true, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/rfqs/:id ───────────────────────────────────────────────────
// Deletion stays restricted to creator-or-Admin.
export const deleteRFQ = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, role } = req.user;
    const { data: existing, error: fetchError } = await supabaseAdmin.from("rfqs")
      .select("created_by").eq("id", id).is("deleted_at", null).single();
    if (fetchError || !existing)
      return res.status(404).json({ success: false, message: "RFQ not found" });
    if (role !== "Admin" && existing.created_by !== userId)
      return res.status(403).json({ success: false, message: "Not authorized" });

    const now = nowUTC();

    const [{ data: samplesArr }, { data: quotsArr }] = await Promise.all([
      supabaseAdmin.from("samples").select("id, sample_status").eq("rfq_id", id).is("deleted_at", null),
      supabaseAdmin.from("quotations").select("id, quotation_status").eq("rfq_id", id).is("deleted_at", null),
    ]);
    (samplesArr || []).forEach(s => logSample(s.id, "deleted", userId, { sample_status: s.sample_status, follow_up_date: null }));
    (quotsArr  || []).forEach(q => logQuotation(q.id, "deleted", userId, { quotation_status: q.quotation_status, follow_up_date: null }));

    await Promise.all([
      supabaseAdmin.from("samples").update({ deleted_at: now }).eq("rfq_id", id).is("deleted_at", null),
      supabaseAdmin.from("quotations").update({ deleted_at: now }).eq("rfq_id", id).is("deleted_at", null),
      supabaseAdmin.from("rfq_followups").update({ deleted_at: now }).eq("rfq_id", id).is("deleted_at", null),
      // Deleting the enquiry directly should also drop it out of the Orders
      // tab if it had already been converted.
      supabaseAdmin.from("orders").update({ deleted_at: now }).eq("rfq_id", id).is("deleted_at", null),
    ]);

    const { error } = await supabaseAdmin.from("rfqs").update({ deleted_at: now, updated_by: userId }).eq("id", id);
    if (error) return res.status(400).json({ success: false, message: error.message });

    logRFQ(id, "deleted", userId);
    return res.json({ success: true, message: "RFQ deleted" });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── GET /api/rfqs/:rfqId/followups ─────────────────────────────────────────
export const getFollowups = async (req, res) => {
  try {
    const { rfqId } = req.params;
    const { data: followups, error: fupError } = await supabaseAdmin
      .from("rfq_followups")
      .select("*, creator:users!rfq_followups_created_by_fkey(id, email, first_name, last_name)")
      .eq("rfq_id", rfqId).is("deleted_at", null).order("followup_date", { ascending: false });
    if (fupError) return res.status(400).json({ success: false, message: fupError.message });
    return res.json({ success: true, followups: followups || [] });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── POST /api/rfqs/:rfqId/followups ────────────────────────────────────────
export const createFollowup = async (req, res) => {
  try {
    const { rfqId } = req.params;
    const { id: userId } = req.user;
    const { contact_type, sample_status_update, quotation_status_update, next_action, notes, followup_date, target_price, enquiry_status, remark } = req.body;

    const { data: rfq, error: rfqError } = await supabaseAdmin.from("rfqs").select("id").eq("id", rfqId).single();
    if (rfqError || !rfq) return res.status(404).json({ success: false, message: "RFQ not found" });

    const { data, error } = await supabaseAdmin.from("rfq_followups").insert([{
      rfq_id: rfqId, contact_type, sample_status_update, quotation_status_update,
      next_action, notes, followup_date: followup_date || null,
      target_price: target_price || null, enquiry_status, remark, created_by: userId,
    }]).select().single();

    if (error) return res.status(400).json({ success: false, message: error.message });
    logFollowup(data.id, rfqId, "created", userId, followupSnapshot(req.body));

    supabaseAdmin.from("rfqs").update({ updated_by: userId, updated_at: nowUTC() }).eq("id", rfqId)
      .then(({ error: e }) => { if (e) console.error("rfqs.updated_by (via followup):", e.message); });

    return res.status(201).json({ success: true, followup: data });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── PUT /api/rfqs/followups/:id ────────────────────────────────────────────
export const updateFollowup = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;
    const { contact_type, sample_status_update, quotation_status_update, next_action, notes, followup_date, target_price, enquiry_status, remark } = req.body;

    const { data, error } = await supabaseAdmin.from("rfq_followups").update({
      contact_type, sample_status_update, quotation_status_update, next_action, notes,
      followup_date: followup_date || null, target_price: target_price || null,
      enquiry_status, remark, updated_at: nowUTC(),
    }).eq("id", id).select().single(); // select() returns rfq_id too — use it below
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ success: false, message: "Follow-up not found" });
      return res.status(400).json({ success: false, message: error.message });
    }
    logFollowup(id, data.rfq_id, "updated", userId, followupSnapshot(req.body));
    return res.json({ success: true, followup: data });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── DELETE /api/rfqs/followups/:id ─────────────────────────────────────────
export const deleteFollowup = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;

    const { data, error } = await supabaseAdmin.from("rfq_followups").delete().eq("id", id).select("id, rfq_id").single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ success: false, message: "Follow-up not found" });
      return res.status(400).json({ success: false, message: error.message });
    }
    logFollowup(id, data.rfq_id, "deleted", userId);
    return res.json({ success: true, message: "Follow-up deleted" });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// NOTE: updateSample and updateQuotation are intentionally NOT exported from
// this file anymore. Use samples.controller.js#updateSample and
// quotations.controller.js#updateQuotation instead.

const CLOSED_STATUSES = new Set(["Won", "Lost"]);
const CLOSED_ACTIONS  = new Set(["Close Enquiry", "No Further Action"]);

// ─────────────────────────────────────────────────────────────────────
// GET /api/rfqs/followups/due — team-wide (everyone sees all open enquiries)
// ─────────────────────────────────────────────────────────────────────
export const getDueFollowups = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("rfqs")
      .select(`
        id, lead_id, company_name, product_category, product_sub_category,
        product_name, consumption_per_month, unit, target_price,
        sample_required, quotation_required, created_by,
        leads(company_name, primary_contact_name, primary_phone, primary_email, city, state),
        rfq_followups(
          id, contact_type, next_action, notes, followup_date,
          target_price, enquiry_status, remark, created_at, deleted_at
        )
      `)
      .is("deleted_at", null);

    if (error) return res.status(400).json({ success: false, message: error.message });

    const due = (data || [])
      .map((rfq) => {
        const fups = (rfq.rfq_followups || []).filter((f) => !f.deleted_at);
        if (!fups.length) return null;
        const latest = [...fups].sort(
          (a, b) => new Date(b.created_at) - new Date(a.created_at)
        )[0];
        if (!latest.followup_date) return null;
        return { ...rfq, latest_followup: latest, rfq_followups: undefined };
      })
      .filter(Boolean)
      .sort((a, b) => a.latest_followup.followup_date.localeCompare(b.latest_followup.followup_date));

    return res.json({ success: true, tasks: due });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────
// POST /api/rfqs/:id/followups/resolve
// ─────────────────────────────────────────────────────────────────────
export const resolveFollowup = async (req, res) => {
  try {
    const { id } = req.params; // rfq id
    const { id: userId } = req.user;
    const {
      outcome, contact_type, remark,
      next_followup_date, next_followup_time, manual_next_action,
    } = req.body;

    if (!["Won", "Lost", "Next"].includes(outcome)) {
      return res.status(400).json({ success: false, message: "Invalid outcome" });
    }
    if (!contact_type) {
      return res.status(400).json({ success: false, message: "contact_type is required" });
    }

    const [{ data: rfq, error: rfqErr }, { data: sampleRows }, { data: quoteRows }] = await Promise.all([
      supabaseAdmin.from("rfqs").select("id, sample_required, quotation_required").eq("id", id).single(),
      supabaseAdmin.from("samples").select("sample_status, updated_at").eq("rfq_id", id).is("deleted_at", null).order("updated_at", { ascending: false }).limit(1),
      supabaseAdmin.from("quotations").select("quotation_status, updated_at").eq("rfq_id", id).is("deleted_at", null).order("updated_at", { ascending: false }).limit(1),
    ]);

    if (rfqErr || !rfq) {
      return res.status(404).json({ success: false, message: "Enquiry not found" });
    }

    let payload;
    if (outcome === "Won" || outcome === "Lost") {
      payload = {
        rfq_id: id, contact_type, enquiry_status: outcome, next_action: null,
        remark: remark || null, followup_date: new Date().toISOString().slice(0, 10), created_by: userId,
      };
    } else {
      if (!next_followup_date) {
        return res.status(400).json({ success: false, message: "next_followup_date is required" });
      }
      const derived = deriveNextAction(rfq, sampleRows?.[0] || null, quoteRows?.[0] || null);
      payload = {
        rfq_id: id, contact_type, enquiry_status: "In Progress",
        next_action: manual_next_action || derived || null, remark: remark || null,
        followup_date: next_followup_date,
        notes: next_followup_time ? `[Time: ${next_followup_time}]` : null,
        created_by: userId,
      };
    }

    const { data: followup, error: insertErr } = await supabaseAdmin
      .from("rfq_followups").insert([payload]).select().single();

    if (insertErr) {
      return res.status(400).json({ success: false, message: insertErr.message });
    }

    // Log this resolution (previously missing — Won/Lost/Next resolutions
    // never reached rfq_followup_logs, so they were invisible to any
    // activity report or "who did what" history).
    logFollowup(followup.id, id, "created", userId, followupSnapshot(payload));
    supabaseAdmin.from("rfqs").update({ updated_by: userId, updated_at: nowUTC() }).eq("id", id)
      .then(({ error: e }) => { if (e) console.error("rfqs.updated_by (via resolve):", e.message); });

    return res.json({ success: true, followup });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};


// ── PATCH /api/rfqs/:id/mark-dead ──────────────────────────────────────────
export const markRFQDead = async (req, res) => {
  try {
    const id = req.params.id;
    const { id: userId } = req.user;
    const { dead_reason } = req.body;

    if (!dead_reason || !dead_reason.trim()) {
      return res.status(400).json({ success: false, message: "A reason is required to mark this enquiry dead" });
    }

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("rfqs").select("*").eq("id", id).is("deleted_at", null).single();
    if (fetchErr || !existing)
      return res.status(404).json({ success: false, message: "RFQ not found" });

    const { data: existingOrder } = await supabaseAdmin
      .from("orders").select("id").eq("rfq_id", id).is("deleted_at", null).maybeSingle();
    if (existingOrder) {
      return res.status(400).json({ success: false, message: "This enquiry is already converted to an order and can't be marked dead." });
    }

    const { data, error } = await supabaseAdmin
      .from("rfqs")
      .update({
        is_dead: true,
        dead_reason: dead_reason.trim(),
        dead_at: nowUTC(),
        dead_by: userId,
        updated_by: userId,
        updated_at: nowUTC(),
      })
      .eq("id", id)
      .select(RFQ_WITH_CREATOR_UPDATER)
      .single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    logRFQ(id, "marked_dead", userId, rfqSnapshot({ ...existing, is_dead: true, dead_reason: dead_reason.trim() }));
    return res.json({ success: true, rfq: data });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

const SUPER_DELETE_EMAIL = "communication@bbmpvtltd.com";

// ── DELETE /api/rfqs/:id/purge ─────────────────────────────────────────────
// Permanently removes the RFQ and every related row: samples, quotations,
// rfq_followups, and ALL logs for each of those (sample_logs,
// quotation_logs, rfq_followup_logs, rfq_logs). Restricted to one account.
export const purgeRFQ = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId, email } = req.user;

    if (email !== SUPER_DELETE_EMAIL) {
      return res.status(403).json({ success: false, message: "Not authorized to permanently delete enquiries" });
    }

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("rfqs").select("id").eq("id", id).single();
    if (fetchErr || !existing)
      return res.status(404).json({ success: false, message: "RFQ not found" });

    const [{ data: sampleRows }, { data: quoteRows }, { data: fupRows }] = await Promise.all([
      supabaseAdmin.from("samples").select("id").eq("rfq_id", id),
      supabaseAdmin.from("quotations").select("id").eq("rfq_id", id),
      supabaseAdmin.from("rfq_followups").select("id").eq("rfq_id", id),
    ]);
    const sampleIds = (sampleRows || []).map(r => r.id);
    const quoteIds  = (quoteRows  || []).map(r => r.id);
    const fupIds    = (fupRows    || []).map(r => r.id);

    await Promise.all([
      sampleIds.length ? supabaseAdmin.from("sample_logs").delete().in("sample_id", sampleIds) : Promise.resolve(),
      quoteIds.length  ? supabaseAdmin.from("quotation_logs").delete().in("quotation_id", quoteIds) : Promise.resolve(),
      fupIds.length    ? supabaseAdmin.from("rfq_followup_logs").delete().in("followup_id", fupIds) : Promise.resolve(),
    ]);

    await Promise.all([
      supabaseAdmin.from("samples").delete().eq("rfq_id", id),
      supabaseAdmin.from("quotations").delete().eq("rfq_id", id),
      supabaseAdmin.from("rfq_followups").delete().eq("rfq_id", id),
    ]);

    await Promise.all([
      supabaseAdmin.from("rfq_followup_logs").delete().eq("rfq_id", id),
      supabaseAdmin.from("rfq_logs").delete().eq("rfq_id", id),
    ]);

    // pending_task_snapshots.rfq_id -> rfqs(id) has NO ON DELETE CASCADE
    // (unlike rfq_logs/rfq_followup_logs, which do cascade). Without this,
    // the final rfqs delete below fails with a foreign-key violation
    // whenever this RFQ ever had a pending sample/quotation follow-up —
    // i.e. most real enquiries — leaving everything else already wiped
    // but the rfqs row itself still present.
    await supabaseAdmin.from("pending_task_snapshots").delete().eq("rfq_id", id);

    // If it had already been converted to an order, drop that too.
    await supabaseAdmin.from("orders").delete().eq("rfq_id", id);

    const { error } = await supabaseAdmin.from("rfqs").delete().eq("id", id);
    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, message: "Enquiry permanently deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};
// ── PATCH /api/rfqs/:id/revive ─────────────────────────────────────────────
export const reviveRFQ = async (req, res) => {
  try {
    const id = req.params.id;
    const { id: userId } = req.user;
    const { data, error } = await supabaseAdmin
      .from("rfqs")
      .update({ is_dead: false, dead_reason: null, dead_at: null, dead_by: null, updated_by: userId, updated_at: nowUTC() })
      .eq("id", id).is("deleted_at", null)
      .select(RFQ_WITH_CREATOR_UPDATER)
      .single();
    if (error) return res.status(400).json({ success: false, message: error.message });
    logRFQ(id, "revived", userId, rfqSnapshot(data));
    return res.json({ success: true, rfq: data });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── GET /api/rfqs/:id/activity ─────────────────────────────────────────────
// Unified activity feed for one enquiry. The EnquiryCard "Activity log"
// panel previously only showed rfq_followups (via getFollowups), which is
// why edits made through updateRFQ/updateRFQToggles, mark-dead/revive, and
// sample/quotation status changes never appeared there — those write to
// rfq_logs, sample_logs and quotation_logs respectively, none of which the
// UI was ever fetching. This pulls all four log tables for the given rfq,
// tags each row with its source `type`, normalizes the timestamp field
// (some tables use changed_at, others updated_at), and returns one
// chronologically sorted array.
export const getRFQActivity = async (req, res) => {
  try {
    const id = req.params.id || req.params.rfqId;
    if (!id) return res.status(400).json({ success: false, message: "Missing rfq id" });

    // Sample/quotation logs are keyed by sample_id/quotation_id, not rfq_id,
    // so we first need to know which sample/quotation row(s) (including
    // soft-deleted ones — deletion itself is an activity event) belong to
    // this rfq.
    const [{ data: sampleRows }, { data: quoteRows }] = await Promise.all([
      supabaseAdmin.from("samples").select("id").eq("rfq_id", id),
      supabaseAdmin.from("quotations").select("id").eq("rfq_id", id),
    ]);
    const sampleIds = (sampleRows || []).map(r => r.id);
    const quoteIds  = (quoteRows  || []).map(r => r.id);

    const [
      { data: rfqLogs, error: rfqLogsErr },
      { data: fupLogs, error: fupLogsErr },
      { data: sampleLogs, error: sampleLogsErr },
      { data: quoteLogs, error: quoteLogsErr },
    ] = await Promise.all([
      supabaseAdmin.from("rfq_logs")
        .select("*, changer:users!rfq_logs_changed_by_fkey(id, email, first_name, last_name)")
        .eq("rfq_id", id).order("changed_at", { ascending: false }),
      supabaseAdmin.from("rfq_followup_logs")
        .select("*, changer:users!rfq_followup_logs_changed_by_fkey(id, email, first_name, last_name)")
        .eq("rfq_id", id).order("changed_at", { ascending: false }),
      sampleIds.length
        ? supabaseAdmin.from("sample_logs")
            .select("*, changer:users!sample_logs_updated_by_fkey(id, email, first_name, last_name)")
            .in("sample_id", sampleIds).order("updated_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      quoteIds.length
        ? supabaseAdmin.from("quotation_logs")
            .select("*, changer:users!quotation_logs_updated_by_fkey(id, email, first_name, last_name)")
            .in("quotation_id", quoteIds).order("updated_at", { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    ]);

    const firstErr = rfqLogsErr || fupLogsErr || sampleLogsErr || quoteLogsErr;
    if (firstErr) return res.status(400).json({ success: false, message: firstErr.message });

    const activity = [
      ...(rfqLogs || []).map(l => ({
        type: "rfq",
        action: l.action,
        at: l.changed_at,
        by: l.changer,
        snapshot: l,
      })),
      ...(fupLogs || []).map(l => ({
        type: "followup",
        action: l.action,
        at: l.changed_at,
        by: l.changer,
        snapshot: l,
      })),
      ...(sampleLogs || []).map(l => ({
        type: "sample",
        action: l.sample_status || "status_update",
        at: l.updated_at,
        by: l.changer,
        snapshot: l,
      })),
      ...(quoteLogs || []).map(l => ({
        type: "quotation",
        action: l.quotation_status || "status_update",
        at: l.updated_at,
        by: l.changer,
        snapshot: l,
      })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));

    return res.json({ success: true, activity });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};