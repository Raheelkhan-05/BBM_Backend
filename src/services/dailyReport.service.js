// services/dailyReport.service.js

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

  const dateOnly = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    return `${dateOnly[3]}-${dateOnly[2]}-${dateOnly[1]}`;
  }

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

      // "migrated_*" actions (from the prospect→lead backfill) are
      // treated the same as their base action for diffing purposes —
      // stripped of the prefix just for the label shown to the reader.
      const baseAction = (row.action || "").replace(/^migrated_/, "");

      if (hasActionCol && baseAction === "created") {
        changeType = row.action?.startsWith("migrated_") ? "Migrated" : "Created";
        diffFields.forEach((f) => {
          if (row[f] !== null && row[f] !== undefined && row[f] !== "") {
            pushFieldChange(changes, f, "created", undefined, row[f]);
          }
        });
      } else if (hasActionCol && baseAction === "deleted") {
        changeType = "Deleted";
        diffFields.forEach((f) => {
          if (row[f] !== null && row[f] !== undefined && row[f] !== "") {
            pushFieldChange(changes, f, "deleted", row[f], undefined);
          }
        });
      } else {
        changeType = prev ? "Updated" : (row.action?.startsWith("migrated_") ? "Migrated" : "Created");
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

// ── Diff field sets per table ───────────────────────────────────────────
// `prospects`/`prospect_logs` are retired from active reporting — every
// record (prospect-stage or lead-stage) now lives in `leads`/`lead_logs`.
// The prospect-stage fields (source/next_action/next_action_date/feedback/
// status) were added onto `leads`/`lead_logs` directly (see migration),
// so lead_logs' diff set now covers the full lifecycle of a record.
const DIFF_FIELDS = {
  lead_logs: [
    "company_name", "country", "state", "city", "zone", "route",
    "primary_contact_name", "primary_designation", "primary_phone", "primary_email",
    "secondary_contact_name", "secondary_designation", "secondary_phone", "secondary_email",
    "nature_of_business", "manufacturing_industry", "company_website", "gst_number",
    "linkedin_profile", "potential_product_category", "potential_product_sub_category",
    "potential_product_name",
    "source", "next_action", "next_action_date", "feedback", "status",
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

  const [leadLogs, rfqLogs, followupLogs, sampleLogs, quotationLogs] = await Promise.all([
    fetchAllPaged("lead_logs", { timeCol: "changed_at", since }),
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
    ...rfqLogs.map((r) => r.changed_by),
    ...followupLogs.map((r) => r.changed_by),
    ...sampleLogs.map((r) => r.updated_by),
    ...quotationLogs.map((r) => r.updated_by),
  ];
  const usersMap = await fetchByIds("users", "id, email, first_name, last_name", referencedUserIds);
  activeUsers.forEach((u) => usersMap.set(u.id, u));

  // Field-level diffs, computed against each entity's full history
  const [leadDiffs, rfqDiffs, followupDiffs, sampleDiffs, quotationDiffs] = await Promise.all([
    computeChangeInfo({ table: "lead_logs", idCol: "lead_id", timeCol: "changed_at", diffFields: DIFF_FIELDS.lead_logs, hasActionCol: true, todayRows: leadLogs }),
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

  // "Lead" here covers the whole record lifecycle — prospect-stage and
  // lead-stage alike, since there's only one entity/table now. Reporting
  // itself doesn't need to distinguish stage at this level (the field
  // diffs already show whether next_action/source/etc. or contact/product
  // fields were what changed).
  leadLogs.forEach((r) => entries.push(makeEntry(r.changed_by, r.changed_at, "Lead", r.company_name, leadDiffs.get(r.id))));
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

// ── Lifetime Contribution Summary ───────────────────────────────────────
// Single entity now: every live `leads` row is counted once, split into
// "Leads (with enquiry)" vs "Prospect-stage (no enquiry yet)" — this
// replaces the old separate Leads/Prospects columns that used to come
// from two different tables.
export async function buildLifetimeSummary() {
  const { data: activeUsers, error: usersErr } = await supabaseAdmin
    .from("users")
    .select("id, email, first_name, last_name")
    .eq("is_active", true);
  if (usersErr) throw new Error(`users: ${usersErr.message}`);

  const counts = new Map();
  activeUsers.forEach((u) => {
    counts.set(u.id, { name: userLabel(u) || u.email, email: u.email, total: 0, known: true });
  });

  function bump(userId, label) {
    if (!userId) return;
    if (!counts.has(userId)) {
      counts.set(userId, { name: `(inactive user ${userId.slice(0, 8)})`, email: "", total: 0, known: false });
    }
    const row = counts.get(userId);
    row[label] = (row[label] || 0) + 1;
    row.total += 1;
  }

  const [leadsRows, rfqsRows, followupsRows, samplesRows, quotationsRows] = await Promise.all([
    fetchAllPagedSimple("leads", "id, created_by, deleted_at"),
    fetchAllPagedSimple("rfqs", "id, created_by, deleted_at, lead_id"),
    fetchAllPagedSimple("rfq_followups", "id, created_by, deleted_at"),
    fetchAllPagedSimple("samples", "id, created_by, deleted_at"),
    fetchAllPagedSimple("quotations", "id, created_by, deleted_at"),
  ]);

  const aliveLeads = leadsRows.filter((l) => !l.deleted_at);
  const aliveRfqs = rfqsRows.filter((r) => !r.deleted_at);
  const leadIdsWithRfq = new Set(aliveRfqs.map((r) => r.lead_id));

  aliveLeads.forEach((l) => {
    bump(l.created_by, leadIdsWithRfq.has(l.id) ? "Leads" : "Prospects");
  });

  aliveRfqs.forEach((r) => bump(r.created_by, "RFQs"));
  followupsRows.filter((f) => !f.deleted_at).forEach((f) => bump(f.created_by, "Follow-ups"));
  samplesRows.filter((s) => !s.deleted_at).forEach((s) => bump(s.created_by, "Samples"));
  quotationsRows.filter((q) => !q.deleted_at).forEach((q) => bump(q.created_by, "Quotations"));

  const rows = Array.from(counts.values())
    .filter((r) => r.known)
    .sort((a, b) => b.total - a.total);
  return rows;
}

const LIFETIME_LOG_CAP_PER_EMPLOYEE = 300;

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
  const base = action.replace(/^migrated_/, "");
  const label = base.charAt(0).toUpperCase() + base.slice(1);
  return action.startsWith("migrated_") ? `Migrated (${label})` : label;
}

export async function buildLifetimeActivityLog() {
  const { data: activeUsers, error: usersErr } = await supabaseAdmin
    .from("users")
    .select("id, email, first_name, last_name")
    .eq("is_active", true);
  if (usersErr) throw new Error(`users: ${usersErr.message}`);

  const [leadLogs, rfqLogs, followupLogs, sampleLogs, quotationLogs] = await Promise.all([
    fetchAllPaged("lead_logs",         { select: "id, lead_id, action, changed_by, changed_at, company_name", timeCol: "changed_at" }),
    fetchAllPaged("rfq_logs",          { select: "id, rfq_id, action, changed_by, changed_at", timeCol: "changed_at" }),
    fetchAllPaged("rfq_followup_logs", { select: "id, followup_id, rfq_id, action, changed_by, changed_at", timeCol: "changed_at" }),
    fetchAllPaged("sample_logs",       { select: "id, sample_id, updated_by, updated_at", timeCol: "updated_at" }),
    fetchAllPaged("quotation_logs",    { select: "id, quotation_id, updated_by, updated_at", timeCol: "updated_at" }),
  ]);

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
      timeLabel: fmtTime(timestamp).split(", ").pop() || fmtTime(timestamp),
      type,
      changeType,
      company: company || "Unknown company",
    };
  }

  const entries = [];
  leadLogs.forEach((r) => entries.push(makeEntry(r.changed_by, r.changed_at, "Lead", r.company_name, actionLabel(r.action))));
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
    if (!e.userId || !buckets.has(e.userId)) return;
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

async function fetchAllPagedSelect(table, select, timeCol) {
  return fetchAllPaged(table, { select, timeCol });
}

function timeOnly(iso) {
  const full = fmtTime(iso);
  return full.split(", ").pop() || full;
}

// ── Status report ────────────────────────────────────────────────────
// "Lead Stage Log" replaces the old "Prospect Status Log" — it's sourced
// from lead_logs' own next_action/next_action_date/feedback/status
// columns (added via migration) instead of the retired prospects table.
// Only lead_logs rows where a stage field actually changed are included,
// so this stays focused on follow-up/status activity rather than
// duplicating every contact-info edit already visible in the main
// activity log.
export async function buildStatusReport() {
  const [leadStageRows, followupRows, sampleLogRows, quotationLogRows] = await Promise.all([
    fetchAllPagedSelect(
      "lead_logs",
      "id, lead_id, action, changed_by, changed_at, company_name, status, next_action, next_action_date, feedback",
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

  // Only rows that actually carry a stage signal — a next_action, a
  // scheduled date, or feedback/remark — count as "stage activity". A
  // lead_logs row that's purely a contact-info/product edit (no stage
  // fields touched) is already covered by the main Today's/Lifetime logs.
  const liveLeadStageRows = leadStageRows.filter(
    (r) => r.next_action || r.next_action_date || r.feedback || r.status
  );
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
    ...liveLeadStageRows.map((r) => r.changed_by),
    ...liveFollowupRows.map((r) => r.created_by),
    ...sampleLogRows.map((r) => r.updated_by),
    ...quotationLogRows.map((r) => r.updated_by),
  ];
  const usersMap = await fetchByIds("users", "id, email, first_name, last_name", referencedUserIds);
  function who(id) {
    if (!id) return "Unattributed";
    return userLabel(usersMap.get(id)) || `Unknown (${id.slice(0, 8)})`;
  }

  // ── Lead Stage Log (was: Prospect Status Log) ───────────────────────
  const leadStageLog = liveLeadStageRows
    .map((r) => {
      const { time, text: remark } = extractEmbeddedTime(r.feedback);
      const status = r.status || "—";
      return {
        timestamp: r.changed_at,
        dateLabel: fmtDateShort(r.changed_at),
        timeLabel: timeOnly(r.changed_at),
        company: r.company_name || "Unknown company",
        status,
        statusGroup: status,
        dueDateRaw: r.next_action_date || null,
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
      const status = r.next_action || r.enquiry_status || "—";
      return {
        timestamp: r.created_at,
        dateLabel: fmtDateShort(r.created_at),
        timeLabel: timeOnly(r.created_at),
        company: rfqsMap.get(r.rfq_id)?.company_name || "Unknown company",
        status,
        statusGroup: status,
        dueDateRaw: r.followup_date || null,
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
      const stage = r.sample_status || "—";
      return {
        timestamp: r.updated_at,
        dateLabel: fmtDateShort(r.updated_at),
        timeLabel: timeOnly(r.updated_at),
        company: rfqsMap.get(rfqId)?.company_name || "Unknown company",
        stage,
        statusGroup: stage,
        dueDateRaw: r.follow_up_date || null,
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
      const stage = r.quotation_status || "—";
      return {
        timestamp: r.updated_at,
        dateLabel: fmtDateShort(r.updated_at),
        timeLabel: timeOnly(r.updated_at),
        company: rfqsMap.get(rfqId)?.company_name || "Unknown company",
        stage,
        statusGroup: stage,
        dueDateRaw: r.follow_up_date || null,
        result: r.result || "—",
        priority: r.priority || "—",
        notes: r.notes || null,
        followUp: buildFollowUp(r.follow_up_date, r.follow_up_time),
        updatedBy: who(r.updated_by),
      };
    })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // ── Current status snapshot — built from LIVE tables for accuracy ───
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

  function sortByNearestDue(entries) {
    return [...entries].sort((a, b) => {
      if (a.dueDateRaw && b.dueDateRaw) {
        const diff = new Date(a.dueDateRaw) - new Date(b.dueDateRaw);
        if (diff !== 0) return diff;
        return new Date(b.timestamp) - new Date(a.timestamp);
      }
      if (a.dueDateRaw && !b.dueDateRaw) return -1;
      if (!a.dueDateRaw && b.dueDateRaw) return 1;
      return new Date(b.timestamp) - new Date(a.timestamp);
    });
  }

  function groupByUpdaterWithStatus(entries) {
    const buckets = new Map();
    entries.forEach((e) => {
      const key = e.updatedBy || "Unattributed";
      if (!buckets.has(key)) buckets.set(key, { name: key, entries: [] });
      buckets.get(key).entries.push(e);
    });

    return Array.from(buckets.values())
      .map((b) => {
        const entriesByTime = [...b.entries].sort((a, c) => new Date(c.timestamp) - new Date(a.timestamp));

        const statusMap = new Map();
        b.entries.forEach((e) => {
          const key = e.statusGroup || "—";
          if (!statusMap.has(key)) statusMap.set(key, []);
          statusMap.get(key).push(e);
        });

        const statusGroups = Array.from(statusMap.entries())
          .map(([status, list]) => {
            const sorted = sortByNearestDue(list);
            return {
              status,
              entries: sorted,
              count: sorted.length,
              nearestDue: sorted.find((e) => e.dueDateRaw)?.dueDateRaw || null,
            };
          })
          .sort((a, c) => {
            if (a.nearestDue && c.nearestDue) return new Date(a.nearestDue) - new Date(c.nearestDue);
            if (a.nearestDue && !c.nearestDue) return -1;
            if (!a.nearestDue && c.nearestDue) return 1;
            return a.status.localeCompare(c.status);
          });

        return { name: b.name, entries: entriesByTime, statusGroups };
      })
      .sort((a, b) => new Date(b.entries[0].timestamp) - new Date(a.entries[0].timestamp));
  }

  return {
    leadStageLog: groupByUpdaterWithStatus(leadStageLog),
    enquiryStatusLog: groupByUpdaterWithStatus(enquiryStatusLog),
    sampleStatusLog: groupByUpdaterWithStatus(sampleStatusLog),
    quotationStatusLog: groupByUpdaterWithStatus(quotationStatusLog),
    currentStatusTable,
  };
}

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

function parseEditedBillDiff(remark) {
  if (!remark) return [];
  try {
    const obj = JSON.parse(remark);
    return Object.entries(obj).map(([field, v]) => ({ field, from: v?.from, to: v?.to }));
  } catch {
    return [];
  }
}

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

  const todayLogs = await fetchAllPaged("bill_logs", { timeCol: "changed_at", since });
  const billIds = [...new Set(todayLogs.map((l) => l.bill_id).filter(Boolean))];
  const billsMap = await fetchByIds(
    "bills",
    "id, party_name, bill_no, bill_date, bill_amount, balance_amount, location, mobile_1, mobile_2",
    billIds
  );

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

// ── Company Timeline — full history for one lead, chronological ────────
// Walks lead → its rfqs → each rfq's followups/samples/quotations → order
// (if converted), merging every log source into one flat, time-sorted
// feed. This is the "prospect → lead → enquiry → order" view.
export async function buildCompanyTimeline(leadId) {
  const { data: lead, error: leadErr } = await supabaseAdmin
    .from("leads")
    .select("*, creator:users!leads_created_by_fkey(id, email, first_name, last_name), updater:users!leads_updated_by_fkey(id, email, first_name, last_name)")
    .eq("id", leadId)
    .single();
  if (leadErr || !lead) throw new Error("Lead not found");

  const [leadLogs, rfqs] = await Promise.all([
    supabaseAdmin.from("lead_logs").select("*").eq("lead_id", leadId).order("changed_at", { ascending: true }).then(r => r.data || []),
    supabaseAdmin.from("rfqs").select("*").eq("lead_id", leadId).order("created_at", { ascending: true }).then(r => r.data || []),
  ]);

  const rfqIds = rfqs.map((r) => r.id);

  const [rfqLogs, followups, followupLogs, samples, sampleLogs, quotations, quotationLogs, orders] = await Promise.all([
    rfqIds.length ? supabaseAdmin.from("rfq_logs").select("*").in("rfq_id", rfqIds).order("changed_at", { ascending: true }).then(r => r.data || []) : [],
    rfqIds.length ? supabaseAdmin.from("rfq_followups").select("*").in("rfq_id", rfqIds).order("created_at", { ascending: true }).then(r => r.data || []) : [],
    rfqIds.length ? supabaseAdmin.from("rfq_followup_logs").select("*").in("rfq_id", rfqIds).order("changed_at", { ascending: true }).then(r => r.data || []) : [],
    rfqIds.length ? supabaseAdmin.from("samples").select("*").in("rfq_id", rfqIds).then(r => r.data || []) : [],
    rfqIds.length ? supabaseAdmin.from("samples").select("id").in("rfq_id", rfqIds).then(async (r) => {
      const sIds = (r.data || []).map((s) => s.id);
      if (!sIds.length) return [];
      const { data } = await supabaseAdmin.from("sample_logs").select("*").in("sample_id", sIds).order("updated_at", { ascending: true });
      return data || [];
    }) : [],
    rfqIds.length ? supabaseAdmin.from("quotations").select("*").in("rfq_id", rfqIds).then(r => r.data || []) : [],
    rfqIds.length ? supabaseAdmin.from("quotations").select("id").in("rfq_id", rfqIds).then(async (r) => {
      const qIds = (r.data || []).map((q) => q.id);
      if (!qIds.length) return [];
      const { data } = await supabaseAdmin.from("quotation_logs").select("*").in("quotation_id", qIds).order("updated_at", { ascending: true });
      return data || [];
    }) : [],
    supabaseAdmin.from("orders").select("*").eq("lead_id", leadId).then(r => r.data || []),
  ]);

  const referencedUserIds = [
    ...leadLogs.map((r) => r.changed_by),
    ...rfqLogs.map((r) => r.changed_by),
    ...followupLogs.map((r) => r.changed_by),
    ...sampleLogs.map((r) => r.updated_by),
    ...quotationLogs.map((r) => r.updated_by),
    ...orders.map((r) => r.converted_by),
  ];
  const usersMap = await fetchByIds("users", "id, email, first_name, last_name", referencedUserIds);
  function who(id) {
    if (!id) return "Unattributed";
    return userLabel(usersMap.get(id)) || `Unknown (${id.slice(0, 8)})`;
  }

  const rfqById = new Map(rfqs.map((r) => [r.id, r]));
  const sampleById = new Map(samples.map((s) => [s.id, s]));
  const quotationById = new Map(quotations.map((q) => [q.id, q]));

  const timeline = [];

  leadLogs.forEach((r) => {
    const { time, text: remark } = extractEmbeddedTime(r.feedback);
    timeline.push({
      timestamp: r.changed_at,
      source: "Lead",
      action: actionLabelForTimeline(r.action),
      by: who(r.changed_by),
      summary: r.status ? `Status: ${r.status}` : (r.next_action ? `Next action: ${r.next_action}` : "Details updated"),
      detail: remark,
    });
  });

  rfqLogs.forEach((r) => {
    const rfq = rfqById.get(r.rfq_id);
    timeline.push({
      timestamp: r.changed_at,
      source: "Enquiry",
      action: actionLabelForTimeline(r.action),
      by: who(r.changed_by),
      summary: `${rfq?.product_name || rfq?.product_category || "Enquiry"}`,
      detail: r.product_description || null,
    });
  });

  followupLogs.forEach((r) => {
    timeline.push({
      timestamp: r.changed_at,
      source: "Follow-up",
      action: actionLabelForTimeline(r.action),
      by: who(r.changed_by),
      summary: r.enquiry_status ? `Status: ${r.enquiry_status}` : (r.next_action || "Follow-up logged"),
      detail: r.remark || null,
    });
  });

  sampleLogs.forEach((r) => {
    timeline.push({
      timestamp: r.updated_at,
      source: "Sample",
      action: "Updated",
      by: who(r.updated_by),
      summary: `Status: ${r.sample_status || "—"}${r.result ? ` (${r.result})` : ""}`,
      detail: r.notes || null,
    });
  });

  quotationLogs.forEach((r) => {
    timeline.push({
      timestamp: r.updated_at,
      source: "Quotation",
      action: "Updated",
      by: who(r.updated_by),
      summary: `Status: ${r.quotation_status || "—"}${r.result ? ` (${r.result})` : ""}`,
      detail: r.notes || null,
    });
  });

  orders.forEach((o) => {
    timeline.push({
      timestamp: o.converted_at,
      source: "Order",
      action: o.deleted_at ? "Reverted" : "Converted",
      by: who(o.converted_by),
      summary: o.deleted_at ? "Order reverted" : "Converted to order",
      detail: null,
    });
  });

  timeline.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  return {
    lead,
    stage: rfqs.length > 0 ? "Lead" : "Prospect",
    rfqs: rfqs.map((r) => ({
      ...r,
      hasOrder: orders.some((o) => o.rfq_id === r.id && !o.deleted_at),
    })),
    timeline,
  };
}

function actionLabelForTimeline(action) {
  if (!action) return "Updated";
  const base = action.replace(/^migrated_/, "");
  const label = base.charAt(0).toUpperCase() + base.slice(1);
  return action.startsWith("migrated_") ? `Migrated (${label})` : label;
}

// ── Company search — for the admin page's lead picker ────────────────────
export async function searchCompanies(query) {
  let q = supabaseAdmin
    .from("leads")
    .select("id, company_name, city, state, status, created_at")
    .is("deleted_at", null)
    .order("company_name", { ascending: true })
    .limit(30);
  if (query) q = q.ilike("company_name", `%${query}%`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

// ── Live Activity Feed — every log, every employee, all-time, newest
// first. Unlike buildDailyReportData (bounded to today) or
// buildLifetimeActivityLog (grouped per-employee, capped), this is one
// flat, paginated, cross-employee feed — the "everything that just
// happened" view.
export async function buildActivityFeed({ limit = 30, offset = 0, employeeId = null } = {}) {
  const [leadLogs, rfqLogs, followupLogs, sampleLogs, quotationLogs] = await Promise.all([
    fetchAllPaged("lead_logs", { timeCol: "changed_at" }),
    fetchAllPaged("rfq_logs", { timeCol: "changed_at" }),
    fetchAllPaged("rfq_followup_logs", { timeCol: "changed_at" }),
    fetchAllPaged("sample_logs", { timeCol: "updated_at" }),
    fetchAllPaged("quotation_logs", { timeCol: "updated_at" }),
  ]);

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
    ...rfqLogs.map((r) => r.changed_by),
    ...followupLogs.map((r) => r.changed_by),
    ...sampleLogs.map((r) => r.updated_by),
    ...quotationLogs.map((r) => r.updated_by),
  ];
  const usersMap = await fetchByIds("users", "id, email, first_name, last_name", referencedUserIds);

  const [leadDiffs, rfqDiffs, followupDiffs, sampleDiffs, quotationDiffs] = await Promise.all([
    computeChangeInfo({ table: "lead_logs", idCol: "lead_id", timeCol: "changed_at", diffFields: DIFF_FIELDS.lead_logs, hasActionCol: true, todayRows: leadLogs }),
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
      email: u?.email || null,
      name: userLabel(u) || (userId ? `Unknown (${userId.slice(0, 8)})` : "Unattributed"),
      timestamp,
      type,
      company: company || "Unknown company",
      changeType,
      changes,
    };
  }

  let entries = [];
  leadLogs.forEach((r) => entries.push(makeEntry(r.changed_by, r.changed_at, "Lead", r.company_name, leadDiffs.get(r.id))));
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

  if (employeeId) entries = entries.filter((e) => e.userId === employeeId);
  entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const page = entries.slice(offset, offset + limit);
  return { entries: page, total: entries.length, hasMore: offset + limit < entries.length };
}

// ── All-time, per-employee, WITH full diffs (like buildDailyReportData
// but unbounded) — powers the "By Employee" tab, full history not
// capped/condensed the way buildLifetimeActivityLog is.
export async function buildAllTimeByEmployee() {
  const { data: activeUsers, error: usersErr } = await supabaseAdmin
    .from("users").select("id, email, first_name, last_name").eq("is_active", true);
  if (usersErr) throw new Error(`users: ${usersErr.message}`);

  const { entries } = await buildActivityFeed({ limit: 1_000_000, offset: 0 });

  const buckets = new Map();
  activeUsers.forEach((u) => {
    buckets.set(u.id, { userId: u.id, name: userLabel(u) || u.email, email: u.email, entries: [] });
  });
  entries.forEach((e) => {
    if (!e.userId || !buckets.has(e.userId)) return;
    buckets.get(e.userId).entries.push(e);
  });

  return Array.from(buckets.values())
    .filter((emp) => emp.entries.length > 0)
    .sort((a, b) => new Date(b.entries[0].timestamp) - new Date(a.entries[0].timestamp));
}