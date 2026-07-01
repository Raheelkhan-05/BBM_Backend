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
const LIFETIME_TABLES = [
  { table: "lead_logs", actorCol: "changed_by", label: "Leads" },
  { table: "prospect_logs", actorCol: "changed_by", label: "Prospects" },
  { table: "rfq_logs", actorCol: "changed_by", label: "RFQs" },
  { table: "rfq_followup_logs", actorCol: "changed_by", label: "Follow-ups" },
  { table: "sample_logs", actorCol: "updated_by", label: "Samples" },
  { table: "quotation_logs", actorCol: "updated_by", label: "Quotations" },
];

async function fetchAllActorIds(table, actorCol) {
  let all = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin.from(table).select(actorCol).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table} (lifetime): ${error.message}`);
    all = all.concat((data || []).map((r) => r[actorCol]));
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

  const counts = new Map(); // userId -> { Leads, Prospects, ... , total }
  activeUsers.forEach((u) => {
    counts.set(u.id, { name: userLabel(u) || u.email, email: u.email, total: 0 });
  });

  for (const { table, actorCol, label } of LIFETIME_TABLES) {
    const actorIds = await fetchAllActorIds(table, actorCol);
    actorIds.forEach((id) => {
      if (!id) return;
      if (!counts.has(id)) {
        const u = null; // user no longer active/known — still count under raw id
        counts.set(id, { name: `(inactive user ${id.slice(0, 8)})`, email: "", total: 0 });
      }
      const row = counts.get(id);
      row[label] = (row[label] || 0) + 1;
      row.total += 1;
    });
  }

  const rows = Array.from(counts.values()).sort((a, b) => b.total - a.total);
  return rows;
}