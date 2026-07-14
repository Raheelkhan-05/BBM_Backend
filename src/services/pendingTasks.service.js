import { createClient } from "@supabase/supabase-js";
import { SAMPLE_STAGES, QUOTATION_STAGES, REJECTED_STAGE } from "../constants/stages.js";

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;
const ID_CHUNK = 200;

function todayISTDateStr() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
function fmtDateShort(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}
function fmtTimeIST(iso) {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}
function userLabel(u) {
  if (!u) return null;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name || u.email || null;
}
function extractEmbeddedTime(text) {
  if (!text) return { time: null, text: null };
  const match = text.match(/\[Time:\s*([0-9:]+)\s*\]/i);
  if (!match) return { time: null, text: text.trim() || null };
  const cleaned = text.replace(match[0], "").trim();
  return { time: match[1], text: cleaned || null };
}

const CLOSED_STATUSES = new Set(["Approved", REJECTED_STAGE]); // matches CLOSED_STAGES in samples/quotations controllers
function isTerminal(status) {
  return !!status && CLOSED_STATUSES.has(status);
}
function isRealStageLog(log, statusField) {
  if (!log[statusField]) return false;
  if (log.notes === "Auto-completed (stage skipped)") return false;
  return true;
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
async function fetchAllPaged(table, { select = "*", timeCol, since }) {
  let all = [];
  let from = 0;
  for (;;) {
    let q = supabaseAdmin.from(table).select(select).order(timeCol, { ascending: true });
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

// De-duplicate entries that were produced by the sample↔quotation notes
// sync — same text, same author, within a few seconds of each other are
// the SAME human action logged twice (once per table). Keep the earliest.
function dedupeByTextAuthorWindow(entries, windowMs = 15000) {
  const sorted = [...entries].sort((a, b) => new Date(a.at) - new Date(b.at));
  const kept = [];
  for (const e of sorted) {
    const dupe = kept.find(
      (k) => k.text === e.text && k.by === e.by && Math.abs(new Date(k.at) - new Date(e.at)) <= windowMs
    );
    if (!dupe) kept.push(e);
  }
  return kept;
}
// Same idea for follow-up date/time — sample and quotation get the same
// due-date pushed onto both tables in one syncSiblingFields call.
function dedupeByDateTimeWindow(entries, windowMs = 15000) {
  const sorted = [...entries].sort((a, b) => new Date(a.at) - new Date(b.at));
  const kept = [];
  for (const e of sorted) {
    const dupe = kept.find(
      (k) => k.date === e.date && k.time === e.time && Math.abs(new Date(k.at) - new Date(e.at)) <= windowMs
    );
    if (!dupe) kept.push(e);
  }
  return kept;
}

export async function syncPendingTaskSnapshots() {
  const today = todayISTDateStr();

  const [rfqs, samples, quotations] = await Promise.all([
    fetchAllPagedSimple(
      "rfqs",
      "id, company_name, product_name, product_category, product_sub_category, sample_required, quotation_required, sample_description, quotation_description, notes, created_by, deleted_at"
    ),
    fetchAllPagedSimple("samples", "id, rfq_id, sample_status, follow_up_date, follow_up_time, notes, updated_by, deleted_at"),
    fetchAllPagedSimple("quotations", "id, rfq_id, quotation_status, follow_up_date, follow_up_time, notes, updated_by, deleted_at"),
  ]);

  const rfqById = new Map(rfqs.filter((r) => !r.deleted_at).map((r) => [r.id, r]));
  const sampleByRfq = new Map(samples.filter((s) => !s.deleted_at).map((s) => [s.rfq_id, s]));
  const quotationByRfq = new Map(quotations.filter((q) => !q.deleted_at).map((q) => [q.rfq_id, q]));

  const { data: openSnapshots, error: openErr } = await supabaseAdmin
    .from("pending_task_snapshots").select("*").eq("status", "pending");
  if (openErr) throw new Error(openErr.message);
  const openByRfq = new Map(openSnapshots.map((s) => [s.rfq_id, s]));

  const nowIso = new Date().toISOString();
  const toInsert = [];
  for (const [rfqId, rfq] of rfqById) {
    const sample = sampleByRfq.get(rfqId);
    const quotation = quotationByRfq.get(rfqId);
    const sampleDue = rfq.sample_required && sample?.follow_up_date && sample.follow_up_date <= today && !isTerminal(sample.sample_status);
    const quotationDue = rfq.quotation_required && quotation?.follow_up_date && quotation.follow_up_date <= today && !isTerminal(quotation.quotation_status);
    if ((sampleDue || quotationDue) && !openByRfq.has(rfqId)) {
      // Baseline remark: prefer an actual note already on the sample/
      // quotation row, else fall back to what was captured at enquiry
      // creation (sample_description / quotation_description / notes on
      // the RFQ itself) — those never get copied onto samples.notes /
      // quotations.notes, so without this fallback the remark column was
      // blank until someone typed a fresh note.
      const baselineRemark =
        sample?.notes || quotation?.notes ||
        rfq.sample_description || rfq.quotation_description || rfq.notes || null;

      // Common follow-up date/time (shared column across sample+quotation)
      const baselineFollowupDate = sample?.follow_up_date || quotation?.follow_up_date || null;
      const baselineFollowupTime = sample?.follow_up_time || quotation?.follow_up_time || null;

      toInsert.push({
        rfq_id: rfqId,
        due_date: today,
        status: "pending",
        baseline_sample_status: sample?.sample_status || null,
        baseline_quotation_status: quotation?.quotation_status || null,
        baseline_remark: baselineRemark,
        baseline_followup_date: baselineFollowupDate,
        baseline_followup_time: baselineFollowupTime,
        sample_updates: [], quotation_updates: [], followup_updates: [], remarks: [],
        last_synced_at: nowIso,
      });
    }
  }
  if (toInsert.length) {
    const { error } = await supabaseAdmin.from("pending_task_snapshots").insert(toInsert);
    if (error) throw new Error(error.message);
  }

  const { data: openNow, error: openNowErr } = await supabaseAdmin
    .from("pending_task_snapshots").select("*").eq("status", "pending");
  if (openNowErr) throw new Error(openNowErr.message);
  if (!openNow.length) return;

  const openRfqIds = openNow.map((s) => s.rfq_id);
  const sampleIdsForOpen = openRfqIds.map((id) => sampleByRfq.get(id)?.id).filter(Boolean);
  const quotationIdsForOpen = openRfqIds.map((id) => quotationByRfq.get(id)?.id).filter(Boolean);
  const earliestSince = openNow.reduce((min, s) => (s.last_synced_at < min ? s.last_synced_at : min), openNow[0].last_synced_at);

  const [sampleLogsRaw, quotationLogsRaw, followupLogsRaw] = await Promise.all([
    sampleIdsForOpen.length
      ? fetchAllPaged("sample_logs", { select: "id, sample_id, sample_status, notes, follow_up_date, follow_up_time, updated_at, updated_by", timeCol: "updated_at", since: earliestSince }).then((r) => r.filter((l) => sampleIdsForOpen.includes(l.sample_id)))
      : [],
    quotationIdsForOpen.length
      ? fetchAllPaged("quotation_logs", { select: "id, quotation_id, quotation_status, notes, follow_up_date, follow_up_time, updated_at, updated_by", timeCol: "updated_at", since: earliestSince }).then((r) => r.filter((l) => quotationIdsForOpen.includes(l.quotation_id)))
      : [],
    fetchAllPaged("rfq_followup_logs", { select: "id, rfq_id, next_action, enquiry_status, notes, remark, followup_date, changed_at, changed_by", timeCol: "changed_at", since: earliestSince }).then((r) => r.filter((l) => openRfqIds.includes(l.rfq_id))),
  ]);

  const sampleLogs = sampleLogsRaw.filter((l) => isRealStageLog(l, "sample_status"));
  const quotationLogs = quotationLogsRaw.filter((l) => isRealStageLog(l, "quotation_status"));
  const followupLogs = followupLogsRaw;

  // Stage-change (not skip) logs, but WITHOUT the null-status filter — a
  // follow-up date can be pushed via a log row that's system-generated in
  // OTHER respects too, so pull follow-up candidates from the raw lists
  // and only drop the explicit auto-skip notes.
  const sampleFollowupCandidates = sampleLogsRaw.filter((l) => l.notes !== "Auto-completed (stage skipped)" && l.follow_up_date);
  const quotationFollowupCandidates = quotationLogsRaw.filter((l) => l.notes !== "Auto-completed (stage skipped)" && l.follow_up_date);

  const referencedUserIds = [
    ...sampleLogs.map((l) => l.updated_by), ...quotationLogs.map((l) => l.updated_by), ...followupLogs.map((l) => l.changed_by),
    ...sampleFollowupCandidates.map((l) => l.updated_by), ...quotationFollowupCandidates.map((l) => l.updated_by),
  ];
  const usersMap = await fetchByIds("users", "id, email, first_name, last_name", referencedUserIds);
  const who = (id) => (id ? userLabel(usersMap.get(id)) || `Unknown (${id.slice(0, 8)})` : "—");

  const sampleIdToRfq = new Map(samples.map((s) => [s.id, s.rfq_id]));
  const quotationIdToRfq = new Map(quotations.map((q) => [q.id, q.rfq_id]));

  for (const snap of openNow) {
    const sample = sampleByRfq.get(snap.rfq_id);
    const quotation = quotationByRfq.get(snap.rfq_id);
    const cutoff = new Date(snap.last_synced_at);

    const newSampleEntries = sampleLogs
      .filter((l) => sampleIdToRfq.get(l.sample_id) === snap.rfq_id && new Date(l.updated_at) > cutoff)
      .map((l) => ({ logId: l.id, status: l.sample_status, at: l.updated_at, by: who(l.updated_by) }));

    const newQuotationEntries = quotationLogs
      .filter((l) => quotationIdToRfq.get(l.quotation_id) === snap.rfq_id && new Date(l.updated_at) > cutoff)
      .map((l) => ({ logId: l.id, status: l.quotation_status, at: l.updated_at, by: who(l.updated_by) }));

    // ── Follow-up date/time — from sample_logs + quotation_logs (the
    // actual source of truth for the shared follow-up), merged with
    // rfq_followup_logs, then deduped since the sibling sync writes the
    // same date/time onto both tables.
    const followupFromSample = sampleFollowupCandidates
      .filter((l) => sampleIdToRfq.get(l.sample_id) === snap.rfq_id && new Date(l.updated_at) > cutoff)
      .map((l) => ({ date: fmtDateShort(l.follow_up_date), time: l.follow_up_time || null, at: l.updated_at, by: who(l.updated_by) }));
    const followupFromQuotation = quotationFollowupCandidates
      .filter((l) => quotationIdToRfq.get(l.quotation_id) === snap.rfq_id && new Date(l.updated_at) > cutoff)
      .map((l) => ({ date: fmtDateShort(l.follow_up_date), time: l.follow_up_time || null, at: l.updated_at, by: who(l.updated_by) }));
    const followupFromRfq = followupLogs
      .filter((l) => l.rfq_id === snap.rfq_id && new Date(l.changed_at) > cutoff && l.followup_date)
      .map((l) => {
        const { time } = extractEmbeddedTime(l.notes);
        return { date: fmtDateShort(l.followup_date), time, at: l.changed_at, by: who(l.changed_by) };
      });
    const newFollowupEntries = dedupeByDateTimeWindow([...followupFromSample, ...followupFromQuotation, ...followupFromRfq]);

    // ── Remarks — sample notes + quotation notes + followup remark,
    // deduped (sibling sync writes the same note onto both tables).
    const remarkFromSample = sampleLogs
      .filter((l) => sampleIdToRfq.get(l.sample_id) === snap.rfq_id && new Date(l.updated_at) > cutoff && l.notes)
      .map((l) => ({ text: l.notes, at: l.updated_at, by: who(l.updated_by) }));
    const remarkFromQuotation = quotationLogs
      .filter((l) => quotationIdToRfq.get(l.quotation_id) === snap.rfq_id && new Date(l.updated_at) > cutoff && l.notes)
      .map((l) => ({ text: l.notes, at: l.updated_at, by: who(l.updated_by) }));
    const remarkFromFollowup = followupLogs
      .filter((l) => l.rfq_id === snap.rfq_id && new Date(l.changed_at) > cutoff && l.remark)
      .map((l) => ({ text: l.remark, at: l.changed_at, by: who(l.changed_by) }));
    const newFollowupTextEntries = followupLogs
      .filter((l) => l.rfq_id === snap.rfq_id && new Date(l.changed_at) > cutoff)
      .map((l) => {
        const { time, text } = extractEmbeddedTime(l.notes);
        return {
          text: l.next_action || l.enquiry_status || text || "Follow-up logged",
          date: l.followup_date ? fmtDateShort(l.followup_date) : null,
          time,
          at: l.changed_at,
          by: who(l.changed_by),
        };
      });
    const newRemarks = dedupeByTextAuthorWindow([...remarkFromSample, ...remarkFromQuotation, ...remarkFromFollowup]);

    if (newSampleEntries.length || newQuotationEntries.length || newFollowupTextEntries.length || newFollowupEntries.length || newRemarks.length) {
      const patch = {
        sample_updates: [...snap.sample_updates, ...newSampleEntries],
        quotation_updates: [...snap.quotation_updates, ...newQuotationEntries],
        followup_updates: [...snap.followup_updates, ...newFollowupTextEntries, ...newFollowupEntries.map((f) => ({
          text: `Follow-up scheduled`, date: f.date, time: f.time, at: f.at, by: f.by,
        }))],
        remarks: [...snap.remarks, ...newRemarks],
        last_synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const { error } = await supabaseAdmin.from("pending_task_snapshots").update(patch).eq("id", snap.id);
      if (error) throw new Error(error.message);
      snap.sample_updates = patch.sample_updates;
      snap.quotation_updates = patch.quotation_updates;
    } else {
      await supabaseAdmin.from("pending_task_snapshots").update({ last_synced_at: new Date().toISOString() }).eq("id", snap.id);
    }

    const stillSampleDue = sample?.follow_up_date && sample.follow_up_date <= today && !isTerminal(sample.sample_status);
    const stillQuotationDue = quotation?.follow_up_date && quotation.follow_up_date <= today && !isTerminal(quotation.quotation_status);
    if (!stillSampleDue && !stillQuotationDue) {
      await supabaseAdmin.from("pending_task_snapshots")
        .update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("id", snap.id);
    }
  }
}

function enquiryLabel(rfq) {
  if (!rfq) return "—";
  const parts = [rfq.product_category, rfq.product_sub_category].filter(Boolean);
  const sub = parts.length ? ` (${parts.join(" / ")})` : "";
  return rfq.product_name ? `${rfq.product_name}${sub}` : parts.join(" / ") || "—";
}

export async function buildPendingTasksReport({ userId = null } = {}) {
  await syncPendingTaskSnapshots();

  const { data: snapshots, error } = await supabaseAdmin
    .from("pending_task_snapshots").select("*").order("due_date", { ascending: true });
  if (error) throw new Error(error.message);

  const rfqIds = snapshots.map((s) => s.rfq_id);
  const rfqsMap = await fetchByIds(
    "rfqs", "id, company_name, product_name, product_category, product_sub_category, created_by", rfqIds
  );
  const ownerIds = rfqIds.map((id) => rfqsMap.get(id)?.created_by);
  const usersMap = await fetchByIds("users", "id, email, first_name, last_name", ownerIds);
  const who = (id) => (id ? userLabel(usersMap.get(id)) || `Unknown (${id.slice(0, 8)})` : "—");

  const rows = snapshots.map((s) => {
    const rfq = rfqsMap.get(s.rfq_id);
    const ownerId = rfq?.created_by || null;

    const sampleUpdates = [...s.sample_updates].reverse();
    const quotationUpdates = [...s.quotation_updates].reverse();
    const followupUpdates = [...s.followup_updates].reverse();
    const remarks = [...s.remarks].reverse();

    // Common due date/time: baseline if never changed, else the most
    // recent follow-up update.
    const latestFollowup = followupUpdates.find((f) => f.date);
    const dueDateDisplay = latestFollowup?.date || (s.baseline_followup_date ? fmtDateShort(s.baseline_followup_date) : "—");
    const dueTimeDisplay = latestFollowup?.time || s.baseline_followup_time || null;

    return {
      rfqId: s.rfq_id,
      dueDate: s.due_date,
      dueDateFmt: fmtDateShort(s.due_date),
      status: s.status,
      company: rfq?.company_name || "Unknown company",
      enquiryDetail: enquiryLabel(rfq),
      lastSampleStage: s.baseline_sample_status || "—",
      lastQuotationStage: s.baseline_quotation_status || "—",
      newSampleStage: sampleUpdates.length
        ? sampleUpdates.map((u) => `${u.status} (Updated ${fmtTimeIST(u.at)} by ${u.by})`).join("\n")
        : "—",
      newQuotationStage: quotationUpdates.length
        ? quotationUpdates.map((u) => `${u.status} (Updated ${fmtTimeIST(u.at)} by ${u.by})`).join("\n")
        : "—",
      newFollowup: followupUpdates.length
        ? followupUpdates.map((u) => `${u.text}${u.date ? ` — next: ${u.date}${u.time ? " " + u.time : ""}` : ""} (Updated ${fmtTimeIST(u.at)} by ${u.by})`).join("\n")
        : "—",
      followupDate: dueDateDisplay,
      followupTime: dueTimeDisplay,
      // Single merged remark column — no more [Sample]/[Quotation] duplicate tags,
      // since one human note now produces exactly one line here.
      remark: remarks.length
        ? remarks.map((r) => `${r.text} (Updated ${fmtTimeIST(r.at)} by ${r.by})`).join("\n")
        : (s.baseline_remark || "—"),
      createdBy: who(ownerId),      // ← MUST be this key, not `owner`
      createdById: ownerId,          // ← MUST be this key, not `ownerId`

    };
  }).filter((r) => (userId ? r.createdById === userId : true));

  return rows;
}