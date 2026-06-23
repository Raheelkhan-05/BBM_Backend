// controllers/prospectHistory.controller.js
//
// GET /api/prospects/:id/history?include=core|logs|all
//
// Two-phase loading for faster perceived performance:
//   ?include=core  → prospect + leads + rfqs + followups + samples + quotations (NO logs)
//   ?include=logs  → full data including all log tables
//   ?include=all   → same as logs (default, backwards-compatible)
//
// The frontend hits `core` first for a fast first paint, then fetches `logs`
// in the background while the user is already reading the Overview tab.

import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export const getProspectHistory = async (req, res) => {
  try {
    const { role } = req.user;
    if (role !== "Admin")
      return res.status(403).json({ success: false, message: "Admin only" });

    const { id: prospectId } = req.params;
    const includeLogs = req.query.include !== "core"; // default: include logs

    // ── 1. Prospect (always fetched) ─────────────────────────────────
    const { data: prospect, error: pErr } = await supabaseAdmin
      .from("prospects")
      .select("*, users!prospects_created_by_fkey(id, email)")
      .eq("id", prospectId)
      .single();

    if (pErr || !prospect)
      return res.status(404).json({ success: false, message: "Prospect not found" });

    // ── 2. Prospect logs + Leads in parallel ─────────────────────────
    const [
      { data: prospectLogs = [] },
      { data: leads = [], error: lErr },
    ] = await Promise.all([
      includeLogs
        ? supabaseAdmin
            .from("prospect_logs")
            .select("*, users!prospect_logs_changed_by_fkey(id, email)")
            .eq("prospect_id", prospectId)
            .order("changed_at", { ascending: false })
        : Promise.resolve({ data: [] }),
      supabaseAdmin
        .from("leads")
        .select("*, users!leads_created_by_fkey(id, email)")
        .eq("prospect_id", prospectId)
        .order("created_at", { ascending: false }),
    ]);

    if (lErr) return res.status(400).json({ success: false, message: lErr.message });

    if (!leads.length) {
      return res.json({
        success: true,
        data: { prospect, prospectLogs, leads: [] },
      });
    }

    const leadIds = leads.map((l) => l.id);

    // ── 3. Lead logs + RFQs in parallel ──────────────────────────────
    const [
      { data: leadLogs = [] },
      { data: rfqs = [], error: rErr },
    ] = await Promise.all([
      includeLogs
        ? supabaseAdmin
            .from("lead_logs")
            .select("*, users!lead_logs_changed_by_fkey(id, email)")
            .in("lead_id", leadIds)
            .order("changed_at", { ascending: false })
        : Promise.resolve({ data: [] }),
      supabaseAdmin
        .from("rfqs")
        .select("*, users!rfqs_created_by_fkey(id, email)")
        .in("lead_id", leadIds)
        .order("created_at", { ascending: false }),
    ]);

    if (rErr) return res.status(400).json({ success: false, message: rErr.message });

    if (!rfqs.length) {
      const enrichedLeads = leads.map((lead) => ({
        ...lead,
        logs: leadLogs.filter((l) => l.lead_id === lead.id),
        rfqs: [],
      }));
      return res.json({
        success: true,
        data: { prospect, prospectLogs, leads: enrichedLeads },
      });
    }

    const rfqIds = rfqs.map((r) => r.id);

    // ── 4. Everything under RFQs in one parallel wave ─────────────────
    const [
      { data: rfqLogs = [] },
      { data: followups = [] },
      { data: samples = [] },
      { data: quotations = [] },
    ] = await Promise.all([
      includeLogs
        ? supabaseAdmin
            .from("rfq_logs")
            .select("*, users!rfq_logs_changed_by_fkey(id, email)")
            .in("rfq_id", rfqIds)
            .order("changed_at", { ascending: false })
        : Promise.resolve({ data: [] }),
      supabaseAdmin
        .from("rfq_followups")
        .select("*, users!rfq_followups_created_by_fkey(id, email)")
        .in("rfq_id", rfqIds)
        .order("followup_date", { ascending: false }),
      supabaseAdmin
        .from("samples")
        .select("*, users!samples_created_by_fkey(id, email)")
        .in("rfq_id", rfqIds),
      supabaseAdmin
        .from("quotations")
        .select("*, users!quotations_created_by_fkey(id, email)")
        .in("rfq_id", rfqIds),
    ]);

    // ── 5. Logs for followups / samples / quotations (skipped for core) ──
    let followupLogs = [], sampleLogs = [], quotationLogs = [];

    if (includeLogs) {
      const followupIds = followups.map((f) => f.id);
      const sampleIds   = samples.map((s) => s.id);
      const quotIds     = quotations.map((q) => q.id);

      [
        { data: followupLogs  },
        { data: sampleLogs    },
        { data: quotationLogs },
      ] = await Promise.all([
        followupIds.length
          ? supabaseAdmin
              .from("rfq_followup_logs")
              .select("*, users!rfq_followup_logs_changed_by_fkey(id, email)")
              .in("followup_id", followupIds)
              .order("changed_at", { ascending: false })
          : Promise.resolve({ data: [] }),
        sampleIds.length
          ? supabaseAdmin
              .from("sample_logs")
              .select("*, users!sample_logs_updated_by_fkey(id, email)")
              .in("sample_id", sampleIds)
              .order("updated_at", { ascending: false })
          : Promise.resolve({ data: [] }),
        quotIds.length
          ? supabaseAdmin
              .from("quotation_logs")
              .select("*, users!quotation_logs_updated_by_fkey(id, email)")
              .in("quotation_id", quotIds)
              .order("updated_at", { ascending: false })
          : Promise.resolve({ data: [] }),
      ]);
    }

    // ── 6. Assemble nested structure ──────────────────────────────────
    const enrichedRFQs = rfqs.map((rfq) => ({
      ...rfq,
      logs: rfqLogs.filter((l) => l.rfq_id === rfq.id),
      followups: followups
        .filter((f) => f.rfq_id === rfq.id)
        .map((f) => ({
          ...f,
          logs: followupLogs.filter((l) => l.followup_id === f.id),
        })),
      samples: samples
        .filter((s) => s.rfq_id === rfq.id)
        .map((s) => ({
          ...s,
          logs: sampleLogs.filter((l) => l.sample_id === s.id),
        })),
      quotations: quotations
        .filter((q) => q.rfq_id === rfq.id)
        .map((q) => ({
          ...q,
          logs: quotationLogs.filter((l) => l.quotation_id === q.id),
        })),
    }));

    const enrichedLeads = leads.map((lead) => ({
      ...lead,
      logs: leadLogs.filter((l) => l.lead_id === lead.id),
      rfqs: enrichedRFQs.filter((r) => r.lead_id === lead.id),
    }));

    return res.json({
      success: true,
      data: { prospect, prospectLogs, leads: enrichedLeads },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};