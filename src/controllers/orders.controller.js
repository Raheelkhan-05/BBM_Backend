// controllers/orders.controller.js
//
// An "order" is a durable, timestamped record that a specific enquiry (rfq)
// has been converted from a tracked sample/quotation task into a completed
// order. Conversion is only allowed once every part the enquiry actually
// requires (sample and/or quotation) has result === "Approved" — the same
// rule the Pipeline UI uses to enable its "Convert to Order" button, just
// re-validated server-side so it can't be bypassed by a stale client.

import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const nowUTC = () => new Date().toISOString();

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
      .select("id, lead_id, sample_required, quotation_required, samples(result), quotations(result)")
      .eq("id", rfq_id)
      .is("deleted_at", null)
      .single();
    if (rfqErr || !rfq) return res.status(404).json({ success: false, message: "Enquiry not found" });

    const sampleOk = !rfq.sample_required    || rfq.samples?.[0]?.result    === "Approved";
    const quoteOk  = !rfq.quotation_required || rfq.quotations?.[0]?.result === "Approved";
    if ((!rfq.sample_required && !rfq.quotation_required) || !sampleOk || !quoteOk) {
      return res.status(400).json({
        success: false,
        message: "Every required sample/quotation must be Approved before converting to an order",
      });
    }

    // Idempotent: if it's already converted (and not reverted), just hand
    // back the existing order instead of erroring on a double-click.
    const { data: existingOrder } = await supabaseAdmin
      .from("orders")
      .select(ORDER_WITH_DETAILS)
      .eq("rfq_id", rfq_id)
      .is("deleted_at", null)
      .maybeSingle();
    if (existingOrder) return res.json({ success: true, order: existingOrder, already: true });

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
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from("orders")
      .update({ deleted_at: nowUTC() })
      .eq("id", id)
      .is("deleted_at", null)
      .select("id")
      .single();
    if (error) {
      if (error.code === "PGRST116") return res.status(404).json({ success: false, message: "Order not found" });
      return res.status(400).json({ success: false, message: error.message });
    }
    return res.json({ success: true, message: "Order reverted to Tasks" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};