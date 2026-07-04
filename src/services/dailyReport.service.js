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
// v4 — adds:
//   • buildBillsReport() — a self-contained "Payment (Bill Dues)" report
//     block (today's bill activity, lifetime per-employee summary, and a
//     current-outstanding snapshot), sourced from bills / bill_logs /
//     bill_deletion_logs. This is a separate feature from the
//     prospects/leads pipeline, so it gets its own data shape, built to
//     slot into pdfReport.builder.js using the same visual language.
//
// v5 — buildBillsReport(): "Created"/"uploaded" bill entries now show
//   every core field (Party Name, Bill No, Bill Date, Bill Amount,
//   Balance Amount, Location, Mobile-1, Mobile-2) as green "added" diff
//   lines — same visual treatment as an "edited" bill's from→to diff —
//   instead of a single generic "New bill added" remark line. bill_logs
//   doesn't snapshot field values on creation (unlike lead_logs/
//   prospect_logs), so these are read straight off the live bill row via
//   an expanded billsMap select.
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

// Several MAIN tables (prospects, leads, rfqs, samples, quotations,
// rfq_followups) store created_at/updated_at as Postgres "timestamp
// WITHOUT time zone" — unlike every *_logs table, which correctly uses
// "timestamp WITH time zone". Values from a tz-less column come back from
// Supabase with no "Z"/offset suffix at all, and JS's Date constructor
// can then ambiguously treat that as local time instead of UTC depending
// on the runtime's own timezone — this was the exact cause of follow-up
// times showing hours off (e.g. a 10:48 AM IST action displaying as
// 5:17 AM). Forcing an explicit "Z" whenever no timezone marker is
// present makes the interpretation unambiguous regardless of runtime tz.
function toUtcDate(raw) {
  if (!raw) return null;
  const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(raw);
  return new Date(hasTz ? raw : `${raw}Z`);
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = toUtcDate(iso);
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return `${get("day")}-${get("month")}-${get("year")}, ${get("hour")}:${get("minute")}`;
}

function fmtDateShort(iso) {
  if (!iso) return "";
  const d = toUtcDate(iso);
  if (!d) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return `${get("day")}-${get("month")}-${get("year")}`;
}

// Follow-ups (and, by convention, some other flows) embed the time-of-day
// as a "[Time: HH:MM]" tag inside the notes text, since there's no
// dedicated time column on rfq_followups for it. This pulls that tag out
// and returns both the extracted time and the remaining clean text.
function extractEmbeddedTime(text) {
  if (!text) return { time: null, text: null };
  const match = text.match(/\[Time:\s*([0-9:]+)\s*\]/i);
  if (!match) return { time: null, text: text.trim() || null };
  const cleaned = text.replace(match[0], "").trim();
  return { time: match[1], text: cleaned || null };
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
  let s = String(v);

  // Plain date-only values (next_action_date, followup_date, etc. come
  // through here as raw "YYYY-MM-DD") — reformat to DD-MM-YYYY generically,
  // regardless of which field this is, so a date never shows up raw.
  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return `${dateOnly[3]}-${dateOnly[2]}-${dateOnly[1]}`;
  }

  // Some notes/remark fields embed a "[Time: HH:MM]" tag representing the
  // next action's time (see extractEmbeddedTime below) — reformat it into
  // readable text instead of showing the raw bracket tag as-is in a diff
  // line. (This is now a fallback: computeChangeInfo below splits this
  // out into its own dedicated "Next Action Time" field wherever possible
  // — this branch only fires if a tag somehow ends up on a field that
  // wasn't split, so nothing raw ever leaks through either way.)
  const timeMatch = s.match(/\[Time:\s*([0-9:]+)\s*\]/i);
  if (timeMatch) {
    const cleaned = s.replace(timeMatch[0], "").trim();
    s = cleaned ? `${cleaned} (Time: ${timeMatch[1]})` : `Time: ${timeMatch[1]}`;
  }
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

// feedback (prospects) and notes (rfq_followups/samples/quotations) can
// carry an embedded "[Time: HH:MM]" tag representing the next action's
// scheduled time. Rather than leaving that tag merged into the text
// field's own diff line, this splits it out into its own dedicated
// "next_action_time" entry — so it shows as a proper "Next Action Time:
// HH:MM" line, not buried inside "Feedback: ...".
function pushFieldChange(changes, field, kind, fromVal, toVal) {
  if (field === "feedback" || field === "notes") {
    const toInfo = kind !== "deleted" ? extractEmbeddedTime(toVal) : { time: null, text: null };
    const fromInfo = kind !== "created" ? extractEmbeddedTime(fromVal) : { time: null, text: null };

    if (kind === "created") {
      if (toInfo.text) changes.push({ field, to: toInfo.text });
    } else if (kind === "deleted") {
      if (fromInfo.text) changes.push({ field, from: fromInfo.text });
    } else {
      if ((fromInfo.text || "") !== (toInfo.text || "")) {
        changes.push({ field, from: fromInfo.text, to: toInfo.text });
      }
    }

    const time = toInfo.time || fromInfo.time;
    if (time) changes.push({ field: "next_action_time", to: time });
    return;
  }

  if (kind === "created") changes.push({ field, to: toVal });
  else if (kind === "deleted") changes.push({ field, from: fromVal });
  else changes.push({ field, from: fromVal, to: toVal });
}

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
            pushFieldChange(changes, f, "created", undefined, row[f]);
          }
        });
      } else if (hasActionCol && row.action === "deleted") {
        changeType = "Deleted";
        diffFields.forEach((f) => {
          if (row[f] !== null && row[f] !== undefined && row[f] !== "") {
            pushFieldChange(changes, f, "deleted", row[f], undefined);
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
            pushFieldChange(changes, f, prev ? "updated" : "created", oldVal ?? null, newVal ?? null);
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


// ── Status Report — Prospect / Enquiry / Sample / Quotation status
//    history + company-wise current snapshot ──────────────────────────
//
// Four chronological logs, each sorted newest-updated-first, showing WHO
// last touched each record, plus a company-wise CURRENT STATUS SNAPSHOT
// table built from the live tables for accuracy.
//
//   • Prospect status log  — from prospect_logs: prospect_status,
//     next_action, next_action_date, and the feedback field (which the
//     app treats as a free-text remark, and which can carry an embedded
//     "[Time: HH:MM]" tag the same way follow-up notes do).
//   • Enquiry status log   — from rfq_followups: contact_type (how the
//     next contact will happen), next_action (shown as "Status", per your
//     description), next_action's date (followup_date) and time (pulled
//     out of the notes' embedded "[Time: HH:MM]" tag), enquiry_status,
//     and the cleaned note text.
//   • Sample / Quotation status logs — from sample_logs / quotation_logs:
//     stage, result, priority, notes, next follow-up date+time.
//
// All four are sourced from tables/columns that are properly
// "timestamp with time zone" EXCEPT rfq_followups.created_at, which is
// "timestamp without time zone" — routed through toUtcDate()/fmtTime()
// above so its display is correct regardless of runtime timezone.

async function fetchAllPagedSelect(table, select, timeCol) {
  return fetchAllPaged(table, { select, timeCol });
}

function timeOnly(iso) {
  const full = fmtTime(iso);
  return full.split(", ").pop() || full;
}

export async function buildStatusReport() {
  const [prospectLogRows, followupRows, sampleLogRows, quotationLogRows] = await Promise.all([
    fetchAllPagedSelect(
      "prospect_logs",
      "id, prospect_id, action, changed_by, changed_at, company_name, prospect_status, next_action, next_action_date, feedback",
      "changed_at"
    ),
    fetchAllPagedSelect(
      "rfq_followups",
      "id, rfq_id, contact_type, next_action, notes, remark, enquiry_status, followup_date, created_by, created_at, deleted_at",
      "created_at"
    ),
    fetchAllPagedSelect(
      "sample_logs",
      "id, sample_id, sample_status, result, priority, notes, follow_up_date, follow_up_time, updated_by, updated_at",
      "updated_at"
    ),
    fetchAllPagedSelect(
      "quotation_logs",
      "id, quotation_id, quotation_status, result, priority, notes, follow_up_date, follow_up_time, updated_by, updated_at",
      "updated_at"
    ),
  ]);

  const liveFollowupRows = followupRows.filter((r) => !r.deleted_at);

  // Company-name resolution
  const sampleIds = sampleLogRows.map((r) => r.sample_id);
  const quotationIds = quotationLogRows.map((r) => r.quotation_id);
  const samplesMap = await fetchByIds("samples", "id, rfq_id", sampleIds);
  const quotationsMap = await fetchByIds("quotations", "id, rfq_id", quotationIds);
  const rfqIdsNeeded = [
    ...liveFollowupRows.map((r) => r.rfq_id),
    ...[...samplesMap.values()].map((s) => s.rfq_id),
    ...[...quotationsMap.values()].map((q) => q.rfq_id),
  ];
  const rfqsMap = await fetchByIds("rfqs", "id, company_name", rfqIdsNeeded);

  // User resolution
  const referencedUserIds = [
    ...prospectLogRows.map((r) => r.changed_by),
    ...liveFollowupRows.map((r) => r.created_by),
    ...sampleLogRows.map((r) => r.updated_by),
    ...quotationLogRows.map((r) => r.updated_by),
  ];
  const usersMap = await fetchByIds("users", "id, email, first_name, last_name", referencedUserIds);
  function who(id) {
    if (!id) return "Unattributed";
    return userLabel(usersMap.get(id)) || `Unknown (${id.slice(0, 8)})`;
  }

  // ── Prospect Status Log ────────────────────────────────────────────
  const prospectStatusLog = prospectLogRows
    .map((r) => {
      const { time, text: remark } = extractEmbeddedTime(r.feedback);
      return {
        timestamp: r.changed_at,
        dateLabel: fmtDateShort(r.changed_at),
        timeLabel: timeOnly(r.changed_at),
        company: r.company_name || "Unknown company",
        status: r.prospect_status || "—",
        nextAction: r.next_action || null,
        nextActionDate: r.next_action_date ? fmtDateShort(r.next_action_date) : null,
        nextActionTime: time,
        remark,
        updatedBy: who(r.changed_by),
      };
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // ── Enquiry Status Log ─────────────────────────────────────────────
  const enquiryStatusLog = liveFollowupRows
    .map((r) => {
      const { time: embeddedTime, text: cleanedNote } = extractEmbeddedTime(r.notes);
      return {
        timestamp: r.created_at,
        dateLabel: fmtDateShort(r.created_at),
        timeLabel: timeOnly(r.created_at),
        company: rfqsMap.get(r.rfq_id)?.company_name || "Unknown company",
        status: r.next_action || r.enquiry_status || "—",
        enquiryStatus: r.enquiry_status || null,
        contactType: r.contact_type || null,
        nextActionDate: r.followup_date ? fmtDateShort(r.followup_date) : null,
        nextActionTime: embeddedTime,
        note: cleanedNote || r.remark || null,
        updatedBy: who(r.created_by),
      };
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  function buildFollowUp(dateVal, timeVal) {
    if (!dateVal) return null;
    return timeVal ? `${fmtDateShort(dateVal)} at ${timeVal}` : fmtDateShort(dateVal);
  }

  // ── Sample Status Log ───────────────────────────────────────────────
  const sampleStatusLog = sampleLogRows
    .map((r) => {
      const rfqId = samplesMap.get(r.sample_id)?.rfq_id;
      return {
        timestamp: r.updated_at,
        dateLabel: fmtDateShort(r.updated_at),
        timeLabel: timeOnly(r.updated_at),
        company: rfqsMap.get(rfqId)?.company_name || "Unknown company",
        stage: r.sample_status || "—",
        result: r.result || "—",
        priority: r.priority || "—",
        notes: r.notes || null,
        followUp: buildFollowUp(r.follow_up_date, r.follow_up_time),
        updatedBy: who(r.updated_by),
      };
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // ── Quotation Status Log ────────────────────────────────────────────
  const quotationStatusLog = quotationLogRows
    .map((r) => {
      const rfqId = quotationsMap.get(r.quotation_id)?.rfq_id;
      return {
        timestamp: r.updated_at,
        dateLabel: fmtDateShort(r.updated_at),
        timeLabel: timeOnly(r.updated_at),
        company: rfqsMap.get(rfqId)?.company_name || "Unknown company",
        stage: r.quotation_status || "—",
        result: r.result || "—",
        priority: r.priority || "—",
        notes: r.notes || null,
        followUp: buildFollowUp(r.follow_up_date, r.follow_up_time),
        updatedBy: who(r.updated_by),
      };
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // ── Current status snapshot — built from LIVE tables for accuracy,
  //    now including who created/last-updated the enquiry itself ───────
  const [rfqsLive, samplesLive, quotationsLive, followupsLive] = await Promise.all([
    fetchAllPagedSimple("rfqs", "id, company_name, sample_required, quotation_required, created_by, updated_by, deleted_at"),
    fetchAllPagedSimple("samples", "id, rfq_id, sample_status, deleted_at"),
    fetchAllPagedSimple("quotations", "id, rfq_id, quotation_status, deleted_at"),
    fetchAllPagedSimple("rfq_followups", "id, rfq_id, next_action, enquiry_status, created_at, deleted_at"),
  ]);

  const aliveRfqs = rfqsLive.filter((r) => !r.deleted_at);

  const rfqOwnerIds = [...new Set(aliveRfqs.flatMap((r) => [r.created_by, r.updated_by]).filter(Boolean))];
  const rfqOwnersMap = await fetchByIds("users", "id, email, first_name, last_name", rfqOwnerIds);
  function ownerLabel(id) {
    if (!id) return "—";
    return userLabel(rfqOwnersMap.get(id)) || `Unknown (${id.slice(0, 8)})`;
  }

  const sampleByRfq = new Map();
  samplesLive.filter((s) => !s.deleted_at).forEach((s) => sampleByRfq.set(s.rfq_id, s));

  const quotationByRfq = new Map();
  quotationsLive.filter((q) => !q.deleted_at).forEach((q) => quotationByRfq.set(q.rfq_id, q));

  const latestFollowupByRfq = new Map();
  followupsLive.filter((f) => !f.deleted_at).forEach((f) => {
    const existing = latestFollowupByRfq.get(f.rfq_id);
    if (!existing || new Date(f.created_at) > new Date(existing.created_at)) latestFollowupByRfq.set(f.rfq_id, f);
  });

  const currentStatusTable = aliveRfqs
    .map((rfq) => {
      const fup = latestFollowupByRfq.get(rfq.id);
      const sample = sampleByRfq.get(rfq.id);
      const quotation = quotationByRfq.get(rfq.id);
      return {
        company: rfq.company_name || "Unknown company",
        enquiryStatus: fup?.enquiry_status || fup?.next_action || "—",
        sampleStatus: rfq.sample_required ? (sample?.sample_status || "Pending") : "—",
        quotationStatus: rfq.quotation_required ? (quotation?.quotation_status || "Pending") : "—",
        createdBy: ownerLabel(rfq.created_by),
        updatedBy: ownerLabel(rfq.updated_by),
      };
    })
    .sort((a, b) => a.company.localeCompare(b.company));

  // ── Group everything by the user who did it, per your request ────────
  // Each of the four logs above is also split into per-employee buckets
  // (most-recently-active employee first, each employee's own entries
  // newest-first) so the report can present "who did what" grouped by
  // person instead of one long mixed list.
  function groupByUpdater(entries) {
    const buckets = new Map();
    entries.forEach((e) => {
      const key = e.updatedBy || "Unattributed";
      if (!buckets.has(key)) buckets.set(key, { name: key, entries: [] });
      buckets.get(key).entries.push(e);
    });
    return Array.from(buckets.values())
      .map((b) => ({ ...b, entries: b.entries.sort((a, c) => new Date(c.timestamp) - new Date(a.timestamp)) }))
      .sort((a, b) => new Date(b.entries[0].timestamp) - new Date(a.entries[0].timestamp));
  }

  return {
    prospectStatusLog: groupByUpdater(prospectStatusLog),
    enquiryStatusLog: groupByUpdater(enquiryStatusLog),
    sampleStatusLog: groupByUpdater(sampleStatusLog),
    quotationStatusLog: groupByUpdater(quotationStatusLog),
    currentStatusTable,
  };
}


// ── Payment (Bill Dues) Report ──────────────────────────────────────────
//
// Bills live in bills / bill_logs / bill_deletion_logs — a separate
// feature from the prospects/leads pipeline, with its own action set
// (created, uploaded, followup, payment_collected, edited, deleted). This
// builds a self-contained report block in the same shape as the sections
// above (today's activity per employee, a lifetime per-employee summary,
// and a current-outstanding snapshot table) so pdfReport.builder.js can
// render it with identical formatting.
//
// v2: "Created"/"uploaded" entries now show every core bill field as a
// green "added" line (Party Name, Bill No, Bill Date, Bill Amount,
// Balance Amount, Location, Mobile-1, Mobile-2) instead of a single
// generic remark — bill_logs itself doesn't snapshot field values on
// creation (unlike lead_logs/prospect_logs), so these are read straight
// off the live bill row via an expanded billsMap select.

function daysOutstanding(billDateStr) {
  if (!billDateStr) return null;
  const [y, m, d] = billDateStr.split("-").map(Number);
  const billUTC = Date.UTC(y, m - 1, d);
  const nowIST = new Date(Date.now() + IST_OFFSET_MS);
  const todayUTC = Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate());
  return Math.round((todayUTC - billUTC) / 86400000);
}

function billDueLabel(billDateStr) {
  const days = daysOutstanding(billDateStr);
  if (days === null) return "—";
  if (days > 0) return `${days}d overdue`;
  if (days === 0) return "Due today";
  return `in ${Math.abs(days)}d`;
}

export function fmtINR(n) {
  const num = Number(n) || 0;
  return `Rs. ${num.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const BILL_ACTION_LABELS = {
  created: "Created",
  uploaded: "Created",
  followup: "Follow-up",
  payment_collected: "Payment",
  edited: "Edited",
  deleted: "Deleted",
};

function billActionLabel(action) {
  return BILL_ACTION_LABELS[action] || (action ? action.charAt(0).toUpperCase() + action.slice(1) : "Updated");
}

// bill_logs "edited" rows store their diff pre-computed as a JSON string
// in `remark` (see updateBill in bills.controller.js) — parse it back
// into the same {field,from,to} shape the other diff engines use, so it
// renders through the identical diff-line UI as the rest of the report.
function parseEditedBillDiff(remark) {
  if (!remark) return [];
  try {
    const obj = JSON.parse(remark);
    return Object.entries(obj).map(([field, v]) => ({ field, from: v?.from, to: v?.to }));
  } catch {
    return [];
  }
}

// Every core field on the live bill row, shown as green "added" lines —
// used for "created"/"uploaded" entries, which don't have a stored diff
// to work from the way "edited" entries do.
const BILL_CREATE_FIELDS = [
  { key: "party_name", label: "Party Name" },
  { key: "bill_no", label: "Bill No" },
  { key: "bill_date", label: "Bill Date", isDate: true },
  { key: "bill_amount", label: "Bill Amount", isMoney: true },
  { key: "balance_amount", label: "Balance Amount", isMoney: true },
  { key: "location", label: "Location" },
  { key: "mobile_1", label: "Mobile-1" },
  { key: "mobile_2", label: "Mobile-2" },
];

function billCreateChanges(bill) {
  if (!bill) return [];
  const changes = [];
  BILL_CREATE_FIELDS.forEach(({ key, label, isDate, isMoney }) => {
    const raw = bill[key];
    if (raw === null || raw === undefined || raw === "") return;
    const val = isDate ? fmtDateShort(raw) : isMoney ? fmtINR(raw) : fmtVal(raw);
    changes.push({ label, to: val });
  });
  return changes;
}

// For non-"edited", non-creation actions, bill_logs doesn't carry a diff
// — it carries a handful of descriptive columns instead (reason, remark,
// payment amount, balance after, etc). These render as plain bullet
// lines rather than from/to diff pairs.
function buildBillLines(log) {
  const lines = [];
  if (log.action === "followup") {
    if (log.reason) lines.push(`Reason: ${log.reason}`);
    if (log.next_followup_date) lines.push(`Next Follow-up: ${fmtDateShort(log.next_followup_date)}`);
    if (log.remark) lines.push(`Remark: ${log.remark}`);
  } else if (log.action === "payment_collected") {
    lines.push(`Collected: ${fmtINR(log.payment_collected)}`);
    lines.push(`Balance After: ${fmtINR(log.balance_after)}`);
    if (log.status) lines.push(`Status: ${log.status === "completed" ? "Completed" : "Remaining"}`);
    if (log.next_followup_date) lines.push(`Next Follow-up: ${fmtDateShort(log.next_followup_date)}`);
    if (log.remark) lines.push(`Remark: ${log.remark}`);
  } else if (log.action === "deleted") {
    lines.push(log.remark || "Bill permanently deleted");
  }
  return lines;
}

export async function buildBillsReport() {
  const since = startOfTodayIST();

  const { data: activeUsers, error: usersErr } = await supabaseAdmin
    .from("users")
    .select("id, email, first_name, last_name")
    .eq("is_active", true);
  if (usersErr) throw new Error(`users: ${usersErr.message}`);

  // ── Live bills — totals + outstanding snapshot ───────────────────────
  const liveBills = await fetchAllPagedSimple(
    "bills",
    "id, party_name, bill_no, bill_date, bill_amount, balance_amount, status, location, " +
      "mobile_1, mobile_2, next_followup_date, last_reason, payment_collected, created_by, updated_by, deleted_at"
  );
  const aliveBills = liveBills.filter((b) => !b.deleted_at);
  const remainingBills = aliveBills.filter((b) => b.status === "remaining");
  const completedBills = aliveBills.filter((b) => b.status === "completed");
  const overdueBills = remainingBills.filter((b) => daysOutstanding(b.bill_date) > 0);
  const dueTodayBills = remainingBills.filter((b) => daysOutstanding(b.bill_date) === 0);

  const totalOutstanding = remainingBills.reduce((s, b) => s + Number(b.balance_amount || 0), 0);
  const totalCollectedAllTime = aliveBills.reduce((s, b) => s + Number(b.payment_collected || 0), 0);

  const billOwnerIds = [...new Set(aliveBills.flatMap((b) => [b.created_by, b.updated_by]).filter(Boolean))];
  const billOwnersMap = await fetchByIds("users", "id, email, first_name, last_name", billOwnerIds);
  function billOwnerLabel(id) {
    if (!id) return "—";
    return userLabel(billOwnersMap.get(id)) || `Unknown (${id.slice(0, 8)})`;
  }

  const outstandingSnapshot = remainingBills
    .map((b) => ({
      party: b.party_name,
      billNo: b.bill_no,
      billDate: fmtDateShort(b.bill_date),
      location: b.location || "—",
      balance: fmtINR(b.balance_amount),
      due: billDueLabel(b.bill_date),
      daysOutstanding: daysOutstanding(b.bill_date) ?? -9999,
      nextFollowup: b.next_followup_date ? fmtDateShort(b.next_followup_date) : "—",
      lastReason: b.last_reason || "—",
      createdBy: billOwnerLabel(b.created_by),
      updatedBy: billOwnerLabel(b.updated_by),
    }))
    .sort((a, b) => b.daysOutstanding - a.daysOutstanding);

  // ── Lifetime per-employee bill summary ────────────────────────────────
  const lifetimeCounts = new Map();
  activeUsers.forEach((u) => {
    lifetimeCounts.set(u.id, { name: userLabel(u) || u.email, email: u.email, billsAdded: 0, totalCollected: 0, known: true });
  });
  function ensureRow(userId) {
    if (!lifetimeCounts.has(userId)) {
      lifetimeCounts.set(userId, {
        name: `(inactive user ${userId.slice(0, 8)})`,
        email: "",
        billsAdded: 0,
        totalCollected: 0,
        known: false,
      });
    }
    return lifetimeCounts.get(userId);
  }
  aliveBills.forEach((b) => {
    if (!b.created_by) return;
    ensureRow(b.created_by).billsAdded += 1;
  });

  // Payment collection is attributed to whoever recorded each payment log
  // row (changed_by on the "payment_collected" bill_logs entry), not to
  // the bill's creator — the person collecting cash is often different
  // from whoever originally added the bill.
  const allBillLogsForPayments = await fetchAllPagedSimple("bill_logs", "id, changed_by, action, payment_collected");
  allBillLogsForPayments
    .filter((l) => l.action === "payment_collected" && l.changed_by)
    .forEach((l) => {
      ensureRow(l.changed_by).totalCollected += Number(l.payment_collected || 0);
    });

  const lifetimeSummary = Array.from(lifetimeCounts.values())
    .filter((r) => r.known)
    .filter((r) => r.billsAdded > 0 || r.totalCollected > 0)
    .sort((a, b) => b.totalCollected - a.totalCollected);

  // ── Today's bill activity ─────────────────────────────────────────────
  const todayLogs = await fetchAllPaged("bill_logs", { timeCol: "changed_at", since });
  const billIds = [...new Set(todayLogs.map((l) => l.bill_id).filter(Boolean))];
  // Expanded select — needed so "created"/"uploaded" entries can show
  // every field the bill was created with (see billCreateChanges above),
  // not just party_name/bill_no.
  const billsMap = await fetchByIds(
    "bills",
    "id, party_name, bill_no, bill_date, bill_amount, balance_amount, location, mobile_1, mobile_2",
    billIds
  );

  // Today's permanent deletions — bill_deletion_logs has no changed_at
  // column (it's deleted_at/deleted_by), and it's the only surviving
  // record once a bill + its bill_logs are cascade-deleted, so it's the
  // sole source for "a bill was deleted today".
  const todayDeletions = await fetchAllPaged("bill_deletion_logs", {
    select: "id, bill_id, deleted_by, deleted_at, snapshot",
    timeCol: "deleted_at",
    since,
  });

  const referencedUserIds = [
    ...todayLogs.map((l) => l.changed_by),
    ...todayDeletions.map((d) => d.deleted_by),
  ];
  const usersMap = await fetchByIds("users", "id, email, first_name, last_name", referencedUserIds);
  activeUsers.forEach((u) => usersMap.set(u.id, u));

  function makeBillEntry(userId, timestamp, action, party, lines, changes) {
    const u = usersMap.get(userId);
    return {
      userId: userId || null,
      email: u?.email || (userId ? `(deleted user ${userId.slice(0, 8)})` : "(no user recorded)"),
      name: userLabel(u) || (userId ? u?.email || `Unknown (${userId.slice(0, 8)})` : "Unattributed"),
      timestamp,
      timeLabel: fmtTime(timestamp),
      changeType: billActionLabel(action),
      company: party || "Unknown party",
      lines: lines || [],
      changes: changes || [],
    };
  }

  const billEntries = [];
  todayLogs.forEach((log) => {
    const bill = billsMap.get(log.bill_id);
    const party = bill ? `${bill.party_name} (#${bill.bill_no})` : "Unknown party";

    if (log.action === "edited") {
      const changes = parseEditedBillDiff(log.remark).map((c) => ({
        label: fieldLabel(c.field),
        from: c.from !== undefined ? fmtVal(c.from) : null,
        to: c.to !== undefined ? fmtVal(c.to) : null,
      }));
      billEntries.push(makeBillEntry(log.changed_by, log.changed_at, log.action, party, [], changes));
    } else if (log.action === "created" || log.action === "uploaded") {
      // Show every field the bill was created with, as green "added"
      // lines — same visual treatment as an edit's diff, just all "to"
      // with no "from". Falls back to the old single-line remark only in
      // the unexpected case the bill itself can no longer be found.
      const changes = bill
        ? billCreateChanges(bill)
        : [{ label: "Note", to: log.remark || "New bill added" }];
      billEntries.push(makeBillEntry(log.changed_by, log.changed_at, log.action, party, [], changes));
    } else {
      billEntries.push(makeBillEntry(log.changed_by, log.changed_at, log.action, party, buildBillLines(log), []));
    }
  });
  todayDeletions.forEach((d) => {
    const party = d.snapshot?.bill ? `${d.snapshot.bill.party_name} (#${d.snapshot.bill.bill_no})` : "Unknown party";
    billEntries.push(makeBillEntry(d.deleted_by, d.deleted_at, "deleted", party, ["Bill permanently deleted"], []));
  });

  const buckets = new Map();
  activeUsers.forEach((u) => {
    buckets.set(u.id, { userId: u.id, email: u.email, name: userLabel(u) || u.email, entries: [] });
  });
  billEntries.forEach((e) => {
    const key = e.userId || `unattributed:${e.email}`;
    if (!buckets.has(key)) buckets.set(key, { userId: e.userId, email: e.email, name: e.name, entries: [] });
    buckets.get(key).entries.push(e);
  });

  const allEmployees = Array.from(buckets.values()).map((emp) => ({
    ...emp,
    entries: emp.entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
  }));

  const todayActivity = allEmployees
    .filter((e) => e.entries.length > 0)
    .sort((a, b) => new Date(b.entries[0].timestamp) - new Date(a.entries[0].timestamp));

  return {
    totalOutstanding,
    totalCollectedAllTime,
    remainingCount: remainingBills.length,
    completedCount: completedBills.length,
    overdueCount: overdueBills.length,
    dueTodayCount: dueTodayBills.length,
    totalActionsToday: billEntries.length,
    todayActivity,
    lifetimeSummary,
    outstandingSnapshot,
  };
}