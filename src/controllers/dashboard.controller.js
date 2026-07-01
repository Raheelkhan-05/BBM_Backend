// controllers/dashboard.controller.js
//
// Single endpoint that replaces 8 separate dashboard fetches.
// All queries run in parallel server-side (same region as DB → ~1ms latency).
// Browser makes ONE round trip instead of eight.

import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const getDashboard = async (req, res) => {
  try {
    const { id: userId, role } = req.user;
    const isAdmin = role === "Admin";
    const isSP    = role === "Salesperson";
    const isSC    = role === "SalesCoordinator";

    // ── Build all queries that apply to this role ──────────────────────────
    // Each entry: [key, promise]
    // We only run queries the role actually needs — no wasted DB work.
    const tasks = [];

    // Leads — Admin sees all, Salesperson + SalesCoordinator see own
    if (isAdmin || isSP || isSC) {
      let q = supabaseAdmin
        .from("leads")
        .select(
          "id, company_name, city, nature_of_business, created_at, created_by"
        )
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (!isAdmin) q = q.eq("created_by", userId);
      tasks.push(["leads", q]);
    }

    // RFQs — lighter select; followups as a separate slim query
    if (isAdmin || isSP || isSC) {
      let q = supabaseAdmin
        .from("rfqs")
        .select(
          "id, company_name, product_name, product_category, sample_required, created_at, created_by"
        )
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (!isAdmin) q = q.eq("created_by", userId);
      tasks.push(["rfqs", q]);

      let fq = supabaseAdmin
        .from("rfq_followups")
        .select("id, rfq_id, enquiry_status, created_at")
        .is("deleted_at", null);
      tasks.push(["rfq_followups", fq]);
    }

    // Products — all roles, minimal columns
    tasks.push([
      "products",
      supabaseAdmin
        .from("products")
        .select("id, category, sub_category")
        .order("category"),
    ]);

    // Routes — Admin + Salesperson
    if (isAdmin || isSP) {
      tasks.push([
        "routes",
        supabaseAdmin
          .from("routes")
          .select("id, city")
          .order("city"),
      ]);
    }

    // Samples — Admin sees all, SalesCoordinator sees own
    if (isAdmin || isSC) {
      let q = supabaseAdmin
        .from("samples")
        .select("id, sample_status, follow_up_date, created_at, created_by")
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (isSC) q = q.eq("created_by", userId);
      tasks.push(["samples", q]);
    }

    // Quotations — Admin sees all, SalesCoordinator sees own
    if (isAdmin || isSC) {
      let q = supabaseAdmin
        .from("quotations")
        .select("id, quotation_status, follow_up_date, created_at, created_by")
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (isSC) q = q.eq("created_by", userId);
      tasks.push(["quotations", q]);
    }

    // Users — Admin only
    if (isAdmin) {
      tasks.push([
        "users",
        supabaseAdmin
          .from("users")
          .select("id, email, role"),
      ]);
    }

    // Prospects — Admin + Salesperson + SalesCoordinator (own only for non-Admin)
    if (isAdmin || isSP || isSC) {
      let q = supabaseAdmin
        .from("prospects")
        .select(
          "id, company_name, city, industry, source, next_action, next_action_date, created_at, created_by"
        )
        .is("deleted_at", null)
        .order("created_at", { ascending: false });
      if (!isAdmin) q = q.eq("created_by", userId);
      tasks.push(["prospects", q]);
    }

    // ── Run everything in parallel ─────────────────────────────────────────
    const results = await Promise.all(
      tasks.map(async ([key, query]) => {
        const { data, error } = await query;
        if (error) {
          console.error(`Dashboard query failed [${key}]:`, error.message);
          return [key, []]; // graceful degradation — don't fail the whole dashboard
        }
        return [key, data ?? []];
      })
    );

    // ── Shape into the same object the frontend already expects ───────────
    const payload = Object.fromEntries(results);

    return res.json({ success: true, ...payload });
  } catch (err) {
    console.error("getDashboard error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};