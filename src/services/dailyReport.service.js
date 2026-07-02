// services/dailyReport.service.js
//
// v3 — adds:
//   • Field-level change detection (Created / Updated / Deleted, with
//     old → new values per field) by diffing each log row against the
//     previous log row for the same entity (looking back through full
//     history, not just today).
//   • A lifetime (all-time) contribution summary per employee, separate
//     from today's detail, so the report can show both "what happened
//     today" and "total work done so far".
//
// Carries forward the v2 fixes: no embedded joins for attribution
// (explicit id → user lookups), full active-user roster always included,
// and paginated queries so nothing silently truncates at 1000 rows.

import { createClient } from "@supabase/supabase-js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;
const ID_CHUNK = 200;

function startOfTodayIST() {
  const now = new Date();
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  istNow.setUTCHours(0, 0, 0, 0);
  return new Date(istNow.getTime() - IST_OFFSET_MS).toISOString();
}

function fmtTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short",
  });
}

function fmtDateShort(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function userLabel(u) {
  if (!u) return null;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name || u.email || null;
}

export function fieldLabel(f) {
  return f
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function fmtVal(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  const s = String(v);
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

// ── Generic paginated select (avoids Supabase's implicit 1000-row cap) ──
async function fetchAllPaged(table, { select = "*", timeCol, since }) {
  let all = [];
  let from = 0;
  for (;;) {
    let q = supabaseAdmin.from(table).select(select).order(timeCol, { ascending: false });
    if (since) q = q.gte(timeCol, since);
    const { data, error } = await q.range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

async function fetchByIds(table, select, ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return new Map();
  const map = new Map();
  for (let i = 0; i < uniqueIds.length; i += ID_CHUNK) {
    const chunk = uniqueIds.slice(i, i + ID_CHUNK);
    const { data, error } = await supabaseAdmin.from(table).select(select).in("id", chunk);
    if (error) throw new Error(`${table} lookup: ${error.message}`);
    (data || []).forEach((row) => map.set(row.id, row));
  }
  return map;
}

// ── Field-level diff engine ─────────────────────────────────────────────
// For each entity touched today, pulls its FULL log history (all time,
// ascending), walks it in order, and diffs each row against the one
// before it. Returns a Map keyed by the log row's own `id` →
// { changeType: "Created"|"Updated"|"Deleted", changes: [{field, from, to}] }
async function computeChangeInfo({ table, idCol, timeCol, diffFields, hasActionCol, todayRows }) {
  const resultMap = new Map();
  const ids = [...new Set(todayRows.map((r) => r[idCol]).filter(Boolean))];
  if (!ids.length) return resultMap;

  let historyRows = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    let from = 0;
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from(table)
        .select("*")
        .in(idCol, chunk)
        .order(timeCol, { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw new Error(`${table} history: ${error.message}`);
      historyRows = historyRows.concat(data || []);
      if (!data || data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }

  const groups = new Map();
  historyRows.forEach((r) => {
    const key = r[idCol];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });

  groups.forEach((rows) => {
    let prev = null;
    rows.forEach((row) => {
      const changes = [];
      let changeType;

      if (hasActionCol && row.action === "created") {
        changeType = "Created";
        diffFields.forEach((f) => {
          if (row[f] !== null && row[f] !== undefined && row[f] !== "") {
            changes.push({ field: f, to: row[f] });
          }
        });
      } else if (hasActionCol && row.action === "deleted") {
        changeType = "Deleted";
        diffFields.forEach((f) => {
          if (row[f] !== null && row[f] !== undefined && row[f] !== "") {
            changes.push({ field: f, from: row[f] });
          }
        });
      } else {
        changeType = prev ? "Updated" : "Created";
        diffFields.forEach((f) => {
          const oldVal = prev ? prev[f] : undefined;
          const newVal = row[f];
          const oldStr = oldVal === undefined || oldVal === null ? "" : String(oldVal);
          const newStr = newVal === undefined || newVal === null ? "" : String(newVal);
          if (oldStr !== newStr) {
            changes.push({ field: f, from: oldVal ?? null, to: newVal ?? null });
          }
        });
      }

      resultMap.set(row.id, { changeType, changes });
      prev = row;
    });
  });

  return resultMap;
}

// ── Diff field sets per table (matches your schema, metadata columns excluded) ──
const DIFF_FIELDS = {
  lead_logs: [
    "company_name", "country", "state", "city", "zone", "route",
    "primary_contact_name", "primary_designation", "primary_phone", "primary_email",
    "secondary_contact_name", "secondary_designation", "secondary_phone", "secondary_email",
    "nature_of_business", "manufacturing_industry", "company_website", "gst_number",
    "linkedin_profile", "potential_product_category", "potential_product_sub_category",
    "potential_product_name",
  ],
  prospect_logs: [
    "company_name", "industry", "country", "state", "city", "zone", "route", "source",
    "next_action", "next_action_date", "feedback", "prospect_status",
    "contact_email", "contact_phone", "contact_name", "contact_designation",
  ],
  rfq_logs: [
    "product_category", "product_sub_category", "product_name", "product_description",
    "consumption_per_month", "unit", "sample_required", "sample_description",
    "sample_received_from_customer", "quotation_required", "quotation_description",
    "existing_supplier_brand", "notes", "target_price", "tds_available",
  ],
  rfq_followup_logs: [
    "contact_type", "sample_status_update", "quotation_status_update", "next_action",
    "notes", "followup_date", "target_price", "enquiry_status", "remark",
  ],
  sample_logs: [
    "sample_status", "follow_up_date", "result", "priority", "description",
    "reject_reason", "follow_up_time", "notes",
  ],
  quotation_logs: [
    "quotation_status", "follow_up_date", "result", "priority", "description",
    "reject_reason", "follow_up_time", "notes",
  ],
};

// ── Today's detail report ───────────────────────────────────────────────
export async function buildDailyReportData() {
  const since = startOfTodayIST();

  const { data: activeUsers, error: usersErr } = await supabaseAdmin
    .from("users")
    .select("id, email, first_name, last_name")
    .eq("is_active", true);
  if (usersErr) throw new Error(`users: ${usersErr.message}`);

  const [leadLogs, prospectLogs, rfqLogs, followupLogs, sampleLogs, quotationLogs] = await Promise.all([
    fetchAllPaged("lead_logs", { timeCol: "changed_at", since }),
    fetchAllPaged("prospect_logs", { timeCol: "changed_at", since }),
    fetchAllPaged("rfq_logs", { timeCol: "changed_at", since }),
    fetchAllPaged("rfq_followup_logs", { timeCol: "changed_at", since }),
    fetchAllPaged("sample_logs", { timeCol: "updated_at", since }),
    fetchAllPaged("quotation_logs", { timeCol: "updated_at", since }),
  ]);

  // Company-name resolution (tables that don't store it directly)
  const sampleIds = sampleLogs.map((r) => r.sample_id);
  const quotationIds = quotationLogs.map((r) => r.quotation_id);
  const samplesMap = await fetchByIds("samples", "id, rfq_id", sampleIds);
  const quotationsMap = await fetchByIds("quotations", "id, rfq_id", quotationIds);
  const rfqIdsNeeded = [
    ...rfqLogs.map((r) => r.rfq_id),
    ...followupLogs.map((r) => r.rfq_id),
    ...[...samplesMap.values()].map((s) => s.rfq_id),
    ...[...quotationsMap.values()].map((q) => q.rfq_id),
  ];
  const rfqsMap = await fetchByIds("rfqs", "id, company_name", rfqIdsNeeded);

  // User resolution — explicit lookup, no embeds
  const referencedUserIds = [
    ...leadLogs.map((r) => r.changed_by),
    ...prospectLogs.map((r) => r.changed_by),
    ...rfqLogs.map((r) => r.changed_by),
    ...followupLogs.map((r) => r.changed_by),
    ...sampleLogs.map((r) => r.updated_by),
    ...quotationLogs.map((r) => r.updated_by),
  ];
  const usersMap = await fetchByIds("users", "id, email, first_name, last_name", referencedUserIds);
  activeUsers.forEach((u) => usersMap.set(u.id, u));

  // Field-level diffs, computed against each entity's full history
  const [leadDiffs, prospectDiffs, rfqDiffs, followupDiffs, sampleDiffs, quotationDiffs] = await Promise.all([
    computeChangeInfo({ table: "lead_logs", idCol: "lead_id", timeCol: "changed_at", diffFields: DIFF_FIELDS.lead_logs, hasActionCol: true, todayRows: leadLogs }),
    computeChangeInfo({ table: "prospect_logs", idCol: "prospect_id", timeCol: "changed_at", diffFields: DIFF_FIELDS.prospect_logs, hasActionCol: true, todayRows: prospectLogs }),
    computeChangeInfo({ table: "rfq_logs", idCol: "rfq_id", timeCol: "changed_at", diffFields: DIFF_FIELDS.rfq_logs, hasActionCol: true, todayRows: rfqLogs }),
    computeChangeInfo({ table: "rfq_followup_logs", idCol: "followup_id", timeCol: "changed_at", diffFields: DIFF_FIELDS.rfq_followup_logs, hasActionCol: true, todayRows: followupLogs }),
    computeChangeInfo({ table: "sample_logs", idCol: "sample_id", timeCol: "updated_at", diffFields: DIFF_FIELDS.sample_logs, hasActionCol: false, todayRows: sampleLogs }),
    computeChangeInfo({ table: "quotation_logs", idCol: "quotation_id", timeCol: "updated_at", diffFields: DIFF_FIELDS.quotation_logs, hasActionCol: false, todayRows: quotationLogs }),
  ]);

  function makeEntry(userId, timestamp, type, company, changeInfo) {
    const u = usersMap.get(userId);
    const changeType = changeInfo?.changeType || "Updated";
    const changes = (changeInfo?.changes || []).map((c) => ({
      label: fieldLabel(c.field),
      from: c.from !== undefined ? fmtVal(c.from) : null,
      to: c.to !== undefined ? fmtVal(c.to) : null,
    }));
    return {
      userId: userId || null,
      email: u?.email || (userId ? `(deleted user ${userId.slice(0, 8)})` : "(no user recorded)"),
      name: userLabel(u) || (userId ? u?.email || `Unknown (${userId.slice(0, 8)})` : "Unattributed"),
      timestamp,
      timeLabel: fmtTime(timestamp),
      type,
      company: company || "Unknown company",
      changeType,
      changes,
    };
  }

  const entries = [];

  leadLogs.forEach((r) => entries.push(makeEntry(r.changed_by, r.changed_at, "Lead", r.company_name, leadDiffs.get(r.id))));
  prospectLogs.forEach((r) => entries.push(makeEntry(r.changed_by, r.changed_at, "Prospect", r.company_name, prospectDiffs.get(r.id))));
  rfqLogs.forEach((r) => entries.push(makeEntry(r.changed_by, r.changed_at, "RFQ", rfqsMap.get(r.rfq_id)?.company_name, rfqDiffs.get(r.id))));
  followupLogs.forEach((r) => entries.push(makeEntry(r.changed_by, r.changed_at, "Follow-up", rfqsMap.get(r.rfq_id)?.company_name, followupDiffs.get(r.id))));
  sampleLogs.forEach((r) => {
    const rfqId = samplesMap.get(r.sample_id)?.rfq_id;
    entries.push(makeEntry(r.updated_by, r.updated_at, "Sample", rfqsMap.get(rfqId)?.company_name, sampleDiffs.get(r.id)));
  });
  quotationLogs.forEach((r) => {
    const rfqId = quotationsMap.get(r.quotation_id)?.rfq_id;
    entries.push(makeEntry(r.updated_by, r.updated_at, "Quotation", rfqsMap.get(rfqId)?.company_name, quotationDiffs.get(r.id)));
  });

  // Group by resolved user — seed every active employee so none go missing
  const buckets = new Map();
  activeUsers.forEach((u) => {
    buckets.set(u.id, { userId: u.id, email: u.email, name: userLabel(u) || u.email, entries: [] });
  });
  entries.forEach((e) => {
    const key = e.userId || `unattributed:${e.email}`;
    if (!buckets.has(key)) buckets.set(key, { userId: e.userId, email: e.email, name: e.name, entries: [] });
    buckets.get(key).entries.push(e);
  });

  const allEmployees = Array.from(buckets.values()).map((emp) => ({
    ...emp,
    entries: emp.entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
  }));

  // Split: employees with activity today vs. none — avoids one blank page per idle employee
  const activeToday = allEmployees
    .filter((e) => e.entries.length > 0)
    .sort((a, b) => new Date(b.entries[0].timestamp) - new Date(a.entries[0].timestamp));
  const noActivityToday = allEmployees
    .filter((e) => e.entries.length === 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    rangeStart: since,
    totalActions: entries.length,
    activeToday,
    noActivityToday,
  };
}


// ── Lifetime (all-time) contribution summary ────────────────────────────
//
// v4 — rewritten to count DISTINCT LIVE RECORDS by created_by, straight
// from the live tables, instead of counting log-table ACTIONS (creates +
// every subsequent update). The action-based approach was producing
// inflated, hard-to-reconcile numbers for two reasons:
//
//   1. A single record updated multiple times generated multiple log
//      rows, all attributed to whoever made each update — so "Prospects: 40"
//      could mean far fewer than 40 actual prospects, just more edits.
//   2. A prospect that gets converted to a lead was counted as BOTH a
//      "Prospect" (from its prospect_logs history) AND a "Lead" (from its
//      lead_logs history) — double-counting the same underlying record.
//
// This version fixes both: it counts each live (non-deleted) record
// exactly once, attributed to created_by, and — per spec — a converted
// prospect is counted only under Leads, not under Prospects at all.
// This also means the numbers here now match exactly what you'd count by
// hand in the Pipeline UI.

async function fetchAllPagedSimple(table, select) {
  let all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin.from(table).select(select).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}

export async function buildLifetimeSummary() {
  const { data: activeUsers, error: usersErr } = await supabaseAdmin
    .from("users")
    .select("id, email, first_name, last_name")
    .eq("is_active", true);
  if (usersErr) throw new Error(`users: ${usersErr.message}`);

  const counts = new Map(); // userId -> { name, email, Leads, Prospects, ..., total, known }
  activeUsers.forEach((u) => {
    counts.set(u.id, { name: userLabel(u) || u.email, email: u.email, total: 0, known: true });
  });

  function bump(userId, label) {
    if (!userId) return;
    if (!counts.has(userId)) {
      // Record created by a user not in the current active roster
      // (deactivated or otherwise unknown). Tracked as known:false so it
      // can be excluded from the final output below, per your request
      // not to show "(inactive user ...)" rows in the report.
      counts.set(userId, { name: `(inactive user ${userId.slice(0, 8)})`, email: "", total: 0, known: false });
    }
    const row = counts.get(userId);
    row[label] = (row[label] || 0) + 1;
    row.total += 1;
  }

  const [leadsRows, prospectsRows, rfqsRows, followupsRows, samplesRows, quotationsRows] = await Promise.all([
    fetchAllPagedSimple("leads", "id, created_by, deleted_at, prospect_id"),
    fetchAllPagedSimple("prospects", "id, created_by, deleted_at"),
    fetchAllPagedSimple("rfqs", "id, created_by, deleted_at"),
    fetchAllPagedSimple("rfq_followups", "id, created_by, deleted_at"),
    fetchAllPagedSimple("samples", "id, created_by, deleted_at"),
    fetchAllPagedSimple("quotations", "id, created_by, deleted_at"),
  ]);

  const aliveLeads = leadsRows.filter((l) => !l.deleted_at);

  // Every prospect_id that currently has a live lead pointing at it —
  // these are "converted" and must NOT also be counted as a Prospect.
  const convertedProspectIds = new Set(aliveLeads.filter((l) => l.prospect_id).map((l) => l.prospect_id));

  aliveLeads.forEach((l) => bump(l.created_by, "Leads"));

  prospectsRows
    .filter((p) => !p.deleted_at && !convertedProspectIds.has(p.id))
    .forEach((p) => bump(p.created_by, "Prospects"));

  rfqsRows.filter((r) => !r.deleted_at).forEach((r) => bump(r.created_by, "RFQs"));
  followupsRows.filter((f) => !f.deleted_at).forEach((f) => bump(f.created_by, "Follow-ups"));
  samplesRows.filter((s) => !s.deleted_at).forEach((s) => bump(s.created_by, "Samples"));
  quotationsRows.filter((q) => !q.deleted_at).forEach((q) => bump(q.created_by, "Quotations"));

  const rows = Array.from(counts.values())
    .filter((r) => r.known)
    .sort((a, b) => b.total - a.total);
  return rows;
}


// ── Lifetime Activity Log — condensed, all-time, per employee ───────────
//
// Unlike buildDailyReportData (today only, with full field-level diffs),
// this pulls each employee's ENTIRE history across all six log tables,
// but keeps every entry to a single condensed line — date, time, action,
// entity type, and company — with NO field-by-field diff detail. That
// level of detail belongs in the "today" section; here the point is a
// scannable record of "what has this person done, over all time."
//
// A per-employee cap keeps the PDF from becoming unmanageable for anyone
// with months/years of history — the most recent N are shown, with a
// note if older entries were left out.
const LIFETIME_LOG_CAP_PER_EMPLOYEE = 300;

// For tables without an `action` column (sample_logs, quotation_logs):
// classify the first log row per entity as "Created", everything after
// as "Updated" — same logic as the daily diff engine, but without doing
// the (expensive, unnecessary here) full field-by-field diff.
function classifyByFirstInGroup(rows, idCol, timeCol) {
  const groups = new Map();
  rows.forEach((r) => {
    const key = r[idCol];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  const map = new Map();
  groups.forEach((grp) => {
    const sorted = [...grp].sort((a, b) => new Date(a[timeCol]) - new Date(b[timeCol]));
    sorted.forEach((r, i) => map.set(r.id, i === 0 ? "Created" : "Updated"));
  });
  return map;
}

function actionLabel(action) {
  if (!action) return "Updated";
  return action.charAt(0).toUpperCase() + action.slice(1);
}

export async function buildLifetimeActivityLog() {
  const { data: activeUsers, error: usersErr } = await supabaseAdmin
    .from("users")
    .select("id, email, first_name, last_name")
    .eq("is_active", true);
  if (usersErr) throw new Error(`users: ${usersErr.message}`);

  const [leadLogs, prospectLogs, rfqLogs, followupLogs, sampleLogs, quotationLogs] = await Promise.all([
    fetchAllPaged("lead_logs",         { select: "id, lead_id, action, changed_by, changed_at, company_name", timeCol: "changed_at" }),
    fetchAllPaged("prospect_logs",     { select: "id, prospect_id, action, changed_by, changed_at, company_name", timeCol: "changed_at" }),
    fetchAllPaged("rfq_logs",          { select: "id, rfq_id, action, changed_by, changed_at", timeCol: "changed_at" }),
    fetchAllPaged("rfq_followup_logs", { select: "id, followup_id, rfq_id, action, changed_by, changed_at", timeCol: "changed_at" }),
    fetchAllPaged("sample_logs",       { select: "id, sample_id, updated_by, updated_at", timeCol: "updated_at" }),
    fetchAllPaged("quotation_logs",    { select: "id, quotation_id, updated_by, updated_at", timeCol: "updated_at" }),
  ]);

  // Company-name resolution — only resolves for records that still
  // currently exist; anything since deleted shows as "Unknown company"
  // since there's nothing left to look up (the action itself still shows).
  const sampleIds = sampleLogs.map((r) => r.sample_id);
  const quotationIds = quotationLogs.map((r) => r.quotation_id);
  const samplesMap = await fetchByIds("samples", "id, rfq_id", sampleIds);
  const quotationsMap = await fetchByIds("quotations", "id, rfq_id", quotationIds);
  const rfqIdsNeeded = [
    ...rfqLogs.map((r) => r.rfq_id),
    ...followupLogs.map((r) => r.rfq_id),
    ...[...samplesMap.values()].map((s) => s.rfq_id),
    ...[...quotationsMap.values()].map((q) => q.rfq_id),
  ];
  const rfqsMap = await fetchByIds("rfqs", "id, company_name", rfqIdsNeeded);

  const referencedUserIds = [
    ...leadLogs.map((r) => r.changed_by),
    ...prospectLogs.map((r) => r.changed_by),
    ...rfqLogs.map((r) => r.changed_by),
    ...followupLogs.map((r) => r.changed_by),
    ...sampleLogs.map((r) => r.updated_by),
    ...quotationLogs.map((r) => r.updated_by),
  ];
  const usersMap = await fetchByIds("users", "id, email, first_name, last_name", referencedUserIds);
  activeUsers.forEach((u) => usersMap.set(u.id, u));

  const sampleChangeMap    = classifyByFirstInGroup(sampleLogs, "sample_id", "updated_at");
  const quotationChangeMap = classifyByFirstInGroup(quotationLogs, "quotation_id", "updated_at");

  function makeEntry(userId, timestamp, type, company, changeType) {
    return {
      userId: userId || null,
      timestamp,
      dateLabel: fmtDateShort(timestamp),
      timeLabel: fmtTime(timestamp).split(", ").pop() || fmtTime(timestamp), // just the time portion
      type,
      changeType,
      company: company || "Unknown company",
    };
  }

  const entries = [];
  leadLogs.forEach((r) => entries.push(makeEntry(r.changed_by, r.changed_at, "Lead", r.company_name, actionLabel(r.action))));
  prospectLogs.forEach((r) => entries.push(makeEntry(r.changed_by, r.changed_at, "Prospect", r.company_name, actionLabel(r.action))));
  rfqLogs.forEach((r) => entries.push(makeEntry(r.changed_by, r.changed_at, "RFQ", rfqsMap.get(r.rfq_id)?.company_name, actionLabel(r.action))));
  followupLogs.forEach((r) => entries.push(makeEntry(r.changed_by, r.changed_at, "Follow-up", rfqsMap.get(r.rfq_id)?.company_name, actionLabel(r.action))));
  sampleLogs.forEach((r) => {
    const rfqId = samplesMap.get(r.sample_id)?.rfq_id;
    entries.push(makeEntry(r.updated_by, r.updated_at, "Sample", rfqsMap.get(rfqId)?.company_name, sampleChangeMap.get(r.id) || "Updated"));
  });
  quotationLogs.forEach((r) => {
    const rfqId = quotationsMap.get(r.quotation_id)?.rfq_id;
    entries.push(makeEntry(r.updated_by, r.updated_at, "Quotation", rfqsMap.get(rfqId)?.company_name, quotationChangeMap.get(r.id) || "Updated"));
  });

  const buckets = new Map();
  activeUsers.forEach((u) => {
    buckets.set(u.id, { userId: u.id, name: userLabel(u) || u.email, email: u.email, entries: [] });
  });
  entries.forEach((e) => {
    if (!e.userId || !buckets.has(e.userId)) return; // skip unattributed / inactive users
    buckets.get(e.userId).entries.push(e);
  });

  const employees = Array.from(buckets.values())
    .map((emp) => {
      const sorted = emp.entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      const totalCount = sorted.length;
      const capped = sorted.slice(0, LIFETIME_LOG_CAP_PER_EMPLOYEE);
      return { ...emp, entries: capped, totalCount, truncated: totalCount > capped.length };
    })
    .filter((emp) => emp.entries.length > 0)
    .sort((a, b) => b.totalCount - a.totalCount);

  return employees;
}