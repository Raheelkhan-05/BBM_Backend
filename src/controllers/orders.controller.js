// controllers/orders.controller.js
//
// An "order" is a durable, timestamped record that a specific enquiry (rfq)
// has been converted from a tracked sample/quotation task into a completed
// order. Converting no longer requires the sample/quotation to already be
// Approved — hitting "Convert to Order" auto-approves whichever required
// part isn't Approved yet (clearing its follow-up date/time, since Approved
// items don't need one), logs that as a real update in sample_logs/
// quotation_logs, then creates the order. If a required part's row is
// missing entirely (see the createRFQ/updateRFQ "FIXED" notes in
// rfq.controller.js), it's created pre-Approved rather than blocking.

import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const nowUTC = () => new Date().toISOString();

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

const ORDER_WITH_DETAILS = `
  *,
  converter:users!orders_converted_by_fkey(id, email, first_name, last_name),
  rfqs(
    id, lead_id, company_name,
    product_category, product_sub_category, product_name, product_description,
    consumption_per_month, unit, existing_supplier_brand, notes, target_price, tds_available,
    sample_required, sample_description,
    quotation_required, quotation_description,
    leads(
      id, company_name, country, state, city, zone, route,
      nature_of_business, manufacturing_industry, company_website, gst_number,
      primary_contact_name, primary_designation, primary_phone, primary_email,
      secondary_contact_name, secondary_designation, secondary_phone, secondary_email
    ),
    samples(id, sample_code, sample_status, result, priority, notes, follow_up_date, follow_up_time, updated_at,
      updater:users!samples_updated_by_fkey_main(id, email, first_name, last_name)),
    quotations(id, quotation_code, quotation_status, result, priority, notes, follow_up_date, follow_up_time, updated_at,
      updater:users!quotations_updated_by_fkey_main(id, email, first_name, last_name))
  )
`;

// ── GET /api/orders ────────────────────────────────────────────────────────
// Team-wide (same visibility model as leads/rfqs) — newest conversions first.
export const getOrders = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select(ORDER_WITH_DETAILS)
      .is("deleted_at", null)
      .order("converted_at", { ascending: false });
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, orders: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── POST /api/orders  { rfq_id } ───────────────────────────────────────────
export const createOrder = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const { rfq_id } = req.body;
    if (!rfq_id) return res.status(400).json({ success: false, message: "rfq_id is required" });

    const { data: rfq, error: rfqErr } = await supabaseAdmin
      .from("rfqs")
      .select("id, lead_id, sample_required, quotation_required")
      .eq("id", rfq_id)
      .is("deleted_at", null)
      .single();
    if (rfqErr || !rfq) return res.status(404).json({ success: false, message: "Enquiry not found" });

    if (!rfq.sample_required && !rfq.quotation_required) {
      return res.status(400).json({ success: false, message: "This enquiry has no sample or quotation to convert" });
    }

    // Idempotent: if it's already converted (and not reverted), just hand
    // back the existing order instead of touching anything again.
    const { data: existingOrder } = await supabaseAdmin
      .from("orders")
      .select(ORDER_WITH_DETAILS)
      .eq("rfq_id", rfq_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (existingOrder) return res.json({ success: true, order: existingOrder, already: true });

    // IMPORTANT: fetch the sample/quotation row directly, filtered to
    // non-deleted and ordered by most-recently-created, rather than through
    // an unfiltered/unordered embed on the rfq. If more than one row ever
    // exists for this rfq (a duplicate from an old bug, or a soft-deleted
    // leftover), an unordered embed can silently pick the wrong one — which
    // is exactly what caused approvals to "revert" after a refresh: the
    // row that got updated wasn't the same one being displayed back.
    const [{ data: sampleRows }, { data: quoteRows }] = await Promise.all([
      rfq.sample_required
        ? supabaseAdmin.from("samples").select("id, result, sample_status")
            .eq("rfq_id", rfq_id).is("deleted_at", null)
            .order("created_at", { ascending: false }).limit(1)
        : Promise.resolve({ data: [] }),
      rfq.quotation_required
        ? supabaseAdmin.from("quotations").select("id, result, quotation_status")
            .eq("rfq_id", rfq_id).is("deleted_at", null)
            .order("created_at", { ascending: false }).limit(1)
        : Promise.resolve({ data: [] }),
    ]);
    const sampleRow = sampleRows?.[0] || null;
    const quoteRow  = quoteRows?.[0]  || null;

    // Auto-approve whichever required part isn't Approved yet — converting
    // to an order IS the approval action now, not a check that gates it.
    if (rfq.sample_required) {
      if (sampleRow) {
        if (sampleRow.result !== "Approved") {
          const { data: verifiedSample, error: sErr } = await supabaseAdmin
            .from("samples")
            .update({
              result: "Approved", follow_up_date: null, follow_up_time: null,
              updated_by: userId, updated_at: nowUTC(),
            })
            .eq("id", sampleRow.id)
            .select("id, result")
            .single();
          if (sErr) return res.status(400).json({ success: false, message: "Failed to approve sample: " + sErr.message });
          // Belt-and-braces: confirm the write actually stuck before moving on.
          if (!verifiedSample || verifiedSample.result !== "Approved") {
            console.error("createOrder: sample update did not persist as expected for id", sampleRow.id, verifiedSample);
            return res.status(500).json({ success: false, message: "Sample approval did not save — please try again." });
          }
          logSample(sampleRow.id, "updated", userId, {
            sample_status: sampleRow.sample_status, result: "Approved", follow_up_date: null,
            notes: "Auto-approved on convert to order",
          });
        }
      } else {
        // Self-heal: sample_required is true but the row was never created
        // (see rfq.controller.js's FIXED notes) — create it pre-Approved.
        const { data: newSample, error: sErr } = await supabaseAdmin.from("samples").insert([{
          rfq_id, sample_required: true, sample_status: null, result: "Approved",
          created_by: userId, updated_by: userId,
        }]).select("id").single();
        if (sErr) return res.status(400).json({ success: false, message: "Failed to create/approve sample: " + sErr.message });
        logSample(newSample.id, "created", userId, { result: "Approved", notes: "Auto-created & approved on convert to order" });
      }
    }

    if (rfq.quotation_required) {
      if (quoteRow) {
        if (quoteRow.result !== "Approved") {
          const { data: verifiedQuote, error: qErr } = await supabaseAdmin
            .from("quotations")
            .update({
              result: "Approved", quotation_status: "Approved", follow_up_date: null, follow_up_time: null,
              updated_by: userId, updated_at: nowUTC(),
            })
            .eq("id", quoteRow.id)
            .select("id, result")
            .single();
          if (qErr) return res.status(400).json({ success: false, message: "Failed to approve quotation: " + qErr.message });
          if (!verifiedQuote || verifiedQuote.result !== "Approved") {
            console.error("createOrder: quotation update did not persist as expected for id", quoteRow.id, verifiedQuote);
            return res.status(500).json({ success: false, message: "Quotation approval did not save — please try again." });
          }
          logQuotation(quoteRow.id, "updated", userId, {
            quotation_status: quoteRow.quotation_status, result: "Approved", follow_up_date: null,
            notes: "Auto-approved on convert to order",
          });
        }
      } else {
        const { data: newQuote, error: qErr } = await supabaseAdmin.from("quotations").insert([{
          rfq_id, quotation_required: true, quotation_status: "Approved", result: "Approved",
          created_by: userId, updated_by: userId,
        }]).select("id").single();
        if (qErr) return res.status(400).json({ success: false, message: "Failed to create/approve quotation: " + qErr.message });
        logQuotation(newQuote.id, "created", userId, { result: "Approved", notes: "Auto-created & approved on convert to order" });
      }
    }

    const { data: created, error: insertErr } = await supabaseAdmin
      .from("orders")
      .insert([{ rfq_id, lead_id: rfq.lead_id, converted_by: userId, converted_at: nowUTC() }])
      .select(ORDER_WITH_DETAILS)
      .single();
    if (insertErr) return res.status(400).json({ success: false, message: insertErr.message });

    return res.status(201).json({ success: true, order: created });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/orders/:id ──────────────────────────────────────────────────
// Reverts a conversion — soft delete only, so history in `orders` is kept.
// The enquiry becomes eligible for Tasks/re-conversion again once its
// sample/quotation status changes (Approved statuses aren't reset here).
export const revertOrder = async (req, res) => {
  try {
    // Tolerant of whatever the route param got named when this was wired up.
    const id = req.params.id || req.params.orderId;
    if (!id) {
      console.error("revertOrder: no order id in route params —", JSON.stringify(req.params));
      return res.status(400).json({ success: false, message: "Missing order id in request" });
    }
    const { data, error } = await supabaseAdmin
      .from("orders")
      .update({ deleted_at: nowUTC() })
      .eq("id", id)
      .is("deleted_at", null)
      .select("id")
      .single();
    if (error) {
      if (error.code === "PGRST116") {
        console.error("revertOrder: order not found for id", id);
        return res.status(404).json({ success: false, message: `Order not found for id ${id}` });
      }
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.json({ success: true, message: "Order reverted to Tasks" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};