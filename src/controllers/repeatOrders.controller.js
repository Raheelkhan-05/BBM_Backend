// controllers/repeatOrders.controller.js
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";
import crypto from "crypto";
import { isRepeatOrderManager } from "../middleware/repeatOrderAccess.js";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const nowUTC = () => new Date().toISOString();
const norm = (email) => (email || "").trim().toLowerCase();
const partyKey = (name) => String(name || "").trim().toLowerCase();

// How long an order_placed / not_interested record sits before it
// automatically pops back into Active follow-up. Split into two
// constants in case you ever want "not interested" to cool off longer
// than a placed order's natural reorder cycle.
const REPEAT_CYCLE_DAYS_ORDER_PLACED = 21;
const REPEAT_CYCLE_DAYS_NOT_INTERESTED = 21;

function addDaysISO(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

const WITH_RELATIONS =
  "*, assignee:users!repeat_order_customers_assigned_to_fkey(id, email, first_name, last_name), " +
  "assigner:users!repeat_order_customers_assigned_by_fkey(id, email, first_name, last_name), " +
  "creator:users!repeat_order_customers_created_by_fkey(id, email, first_name, last_name), " +
  "updater:users!repeat_order_customers_updated_by_fkey(id, email, first_name, last_name), " +
  "history:repeat_order_purchase_history(*), " +
  "orders_taken:repeat_order_placed(*)";

function logRO(customerId, action, changedBy, extra = {}) {
  supabaseAdmin
    .from("repeat_order_logs")
    .insert([{ customer_id: customerId, action, changed_by: changedBy, changed_at: nowUTC(), ...extra }])
    .then(({ error }) => { if (error) console.error("repeat_order_logs write error:", error.message); });
}

function withFollowupStatus(customer) {
  if (!customer) return customer;
  const now = Date.now();
  const isSnoozed = !!customer.next_followup_at && new Date(customer.next_followup_at).getTime() > now;
  const isDue = customer.status === "assigned" && !isSnoozed;
  return { ...customer, is_due: isDue, is_snoozed: customer.status === "assigned" && isSnoozed };
}

function computeRollup(historyRows) {
  const rows = historyRows || [];
  const total_lifetime_value = Math.round(rows.reduce((s, r) => s + (Number(r.bill_amount) || 0), 0) * 100) / 100;
  const total_bills_count = rows.length;
  const datedRows = rows.filter((r) => r.bill_date).sort((a, b) => (a.bill_date < b.bill_date ? 1 : -1));
  const last_purchase_date = datedRows[0]?.bill_date || null;
  const last_sales_man = datedRows[0]?.sales_man || null;
  return { total_lifetime_value, total_bills_count, last_purchase_date, last_sales_man };
}

function canActOnRecord(req, customerRow) {
  if (isRepeatOrderManager(req.user?.email)) return true;
  return !!customerRow.assigned_to && customerRow.assigned_to === req.user.id;
}

// ══════════════════════════════════════════════════════════════════════
// Fuzzy product-name matching — links a repeat order taken in-app (free
// text, sometimes shorthand or typo'd) to the real invoice line once it
// shows up in a later sales-dump upload. Dice's coefficient over
// character bigrams, with a containment boost for the common case where
// the logged text is a shorter prefix of the full catalog name (e.g.
// "TP-LD Bag" vs "TP-LD BAG 47.5X29.5 NATURAL COLOUR").
// ══════════════════════════════════════════════════════════════════════

const MATCH_SUGGEST_MIN = 0.30;
const MATCH_AUTO_CONFIRM = 0.60;

function normalizeForMatch(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

function bigrams(s) {
  const grams = [];
  for (let i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2));
  return grams;
}

function diceCoefficient(a, b) {
  if (a === b) return 1;
  const ga = bigrams(a), gb = bigrams(b);
  if (ga.length === 0 || gb.length === 0) return 0;
  const counts = new Map();
  ga.forEach((g) => counts.set(g, (counts.get(g) || 0) + 1));
  let intersect = 0;
  gb.forEach((g) => {
    const c = counts.get(g) || 0;
    if (c > 0) { intersect++; counts.set(g, c - 1); }
  });
  return (2 * intersect) / (ga.length + gb.length);
}

function productSimilarity(orderItemText, historyProductName) {
  const na = normalizeForMatch(orderItemText), nb = normalizeForMatch(historyProductName);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  let score = diceCoefficient(na, nb);
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length >= 4 && longer.includes(shorter)) score = Math.max(score, 0.8);
  return score;
}

// Called after new purchase-history rows are inserted for an EXISTING
// customer during upload. Looks for still-open order lines (unmatched
// or previously-suggested-but-not-yet-resolved) and proposes/locks in
// the best candidate among the freshly imported bills.
async function matchOrdersAgainstHistory(customerId, newHistoryRows, actorId) {
  if (!newHistoryRows?.length) return;
  const { data: openOrders } = await supabaseAdmin
    .from("repeat_order_placed")
    .select("id, order_item")
    .eq("customer_id", customerId)
    .in("match_status", ["unmatched", "suggested"]);
  if (!openOrders?.length) return;

  for (const order of openOrders) {
    let best = null;
    for (const h of newHistoryRows) {
      const score = productSimilarity(order.order_item, h.product_name);
      if (score >= MATCH_SUGGEST_MIN && (!best || score > best.score)) best = { history: h, score };
    }
    if (!best) continue;

    const newStatus = best.score >= MATCH_AUTO_CONFIRM ? "confirmed" : "suggested";
    await supabaseAdmin.from("repeat_order_placed").update({
      matched_history_id: best.history.id,
      match_score: Math.round(best.score * 100) / 100,
      match_status: newStatus,
    }).eq("id", order.id);

    logRO(customerId, newStatus === "confirmed" ? "order_auto_matched" : "order_match_suggested", actorId, {
      remark: `"${order.order_item}" ${newStatus === "confirmed" ? "matched" : "possibly matches"} bill #${(best.history.bill_no || "").trim()} — ${Math.round(best.score * 100)}% similarity`,
    });
  }
}

// ══════════════════════════════════════════════════════════════════════
// Auto-reopen sweep — lazily flips any order_placed/not_interested
// record whose reopen_at has passed back to 'assigned'. Runs inline at
// the top of every GET / list load, so the UI is always current without
// needing a cron. It's also exposed as its own endpoint
// (POST /sweep-reopen) so an external scheduled job can hit it directly
// if you want reopening to happen even when nobody has the app open.
// ══════════════════════════════════════════════════════════════════════
async function sweepDueReopens(actorId = null) {
  const nowTs = nowUTC();
  const { data: due, error } = await supabaseAdmin
    .from("repeat_order_customers")
    .select("id")
    .in("status", ["order_placed", "not_interested"])
    .not("reopen_at", "is", null)
    .lte("reopen_at", nowTs)
    .is("deleted_at", null);
  if (error || !due?.length) return 0;

  const ids = due.map((d) => d.id);
  await supabaseAdmin.from("repeat_order_customers").update({
    status: "assigned", reopen_at: null, updated_at: nowTs,
  }).in("id", ids);

  ids.forEach((id) => logRO(id, "auto_reopened", actorId, {
    remark: "Automatically reopened for the next follow-up cycle",
    status: "assigned",
  }));
  return ids.length;
}

// ── POST /api/repeat-orders/sweep-reopen (manager-only, optional — for
//    wiring up an external cron/scheduled function) ─────────────────
export const sweepReopenNow = async (req, res) => {
  try {
    const count = await sweepDueReopens(req.user.id);
    return res.json({ success: true, reopened: count });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ══════════════════════════════════════════════════════════════════════
// Excel import — Sales Register export format:
//   Credit days | Bill Date | Bill No | C/D | Party Name | City Name |
//   Party GSTIN No | Mobile-1 | Mobile-2 | ... | Product Name |
//   Product Group Name | Product Category Name | Sales Man | Bill Amount
// One row per BILL LINE ITEM. Rows are grouped by Party Name into one
// repeat-order customer record per organization.
// ══════════════════════════════════════════════════════════════════════

function normalizeKey(k) {
  return String(k || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const KEY_MAP = {
  billdate:            "bill_date",
  billno:               "bill_no",
  partyname:            "party_name",
  cityname:             "location",
  partygstinno:         "gstin",
  mobile1:              "mobile_1",
  mobile2:              "mobile_2",
  productname:          "product_name",
  productgroupname:     "product_group",
  productcategoryname:  "product_category",
  salesman:             "sales_man",
  billamount:           "bill_amount",
  creditdays:           "credit_days",
};

function findHeaderRowIndex(rawRows) {
  for (let i = 0; i < Math.min(rawRows.length, 30); i++) {
    const row = rawRows[i] || [];
    const normalized = row.map((c) => normalizeKey(c));
    const hits = normalized.filter((nk) => KEY_MAP[nk]).length;
    if (hits >= 3) return i;
  }
  return 0;
}

function excelDateToISO(val) {
  if (val == null || val === "") return null;
  if (val instanceof Date) {
    if (isNaN(val)) return null;
    const y = val.getUTCFullYear();
    const mm = String(val.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(val.getUTCDate()).padStart(2, "0");
    return `${y}-${mm}-${dd}`;
  }
  if (typeof val === "number") {
    if (!isFinite(val) || val <= 0) return null;
    const excelEpoch = Date.UTC(1899, 11, 30);
    const d = new Date(excelEpoch + Math.round(val) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  if (typeof val === "string") {
    const iso = val.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) return val.trim();
  }
  return null;
}

function parseRow(row) {
  const mapped = {};
  for (const rawKey of Object.keys(row)) {
    const nk = normalizeKey(rawKey);
    const target = KEY_MAP[nk];
    if (target) mapped[target] = row[rawKey];
  }
  if (!mapped.party_name || !mapped.bill_no || !mapped.product_name) return null;

  return {
    bill_no:          String(mapped.bill_no).trim(),
    bill_date:        excelDateToISO(mapped.bill_date),
    party_name:       String(mapped.party_name).trim(),
    location:         mapped.location ? String(mapped.location).trim() : null,
    gstin:            mapped.gstin ? String(mapped.gstin).trim() : null,
    mobile_1:         mapped.mobile_1 ? String(mapped.mobile_1).replace(/\D/g, "").slice(0, 15) : null,
    mobile_2:         mapped.mobile_2 ? String(mapped.mobile_2).replace(/\D/g, "").slice(0, 15) : null,
    product_name:     String(mapped.product_name).trim(),
    product_group:    mapped.product_group ? String(mapped.product_group).trim() : null,
    product_category: mapped.product_category ? String(mapped.product_category).trim() : null,
    sales_man:        mapped.sales_man ? String(mapped.sales_man).trim() : null,
    credit_days:      Number.isFinite(Number(mapped.credit_days)) ? Math.max(0, Math.round(Number(mapped.credit_days))) : null,
    bill_amount:      Number(mapped.bill_amount) || 0,
  };
}

// ── POST /api/repeat-orders/upload (multipart, field name "file") ──────
export const uploadRepeatOrders = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });
    const { id: userId } = req.user;

    const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];

    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
    const headerRowIndex = findHeaderRowIndex(rawRows);
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", range: headerRowIndex, raw: true });

    const partyGroups = new Map();
    const skipped = [];
    const seenBillNos = new Set();

    rows.forEach((r, i) => {
      const p = parseRow(r);
      const excelRowNum = i + headerRowIndex + 2;
      if (!p) { skipped.push(excelRowNum); return; }
      if (seenBillNos.has(p.bill_no)) return;
      seenBillNos.add(p.bill_no);

      const key = partyKey(p.party_name);
      if (!partyGroups.has(key)) {
        partyGroups.set(key, {
          party_name: p.party_name, location: p.location, gstin: p.gstin,
          mobile_1: p.mobile_1, mobile_2: p.mobile_2, items: [],
        });
      }
      const g = partyGroups.get(key);
      if (!g.location && p.location) g.location = p.location;
      if (!g.gstin && p.gstin) g.gstin = p.gstin;
      if (!g.mobile_1 && p.mobile_1) g.mobile_1 = p.mobile_1;
      if (!g.mobile_2 && p.mobile_2) g.mobile_2 = p.mobile_2;
      g.items.push({
        bill_no: p.bill_no, bill_date: p.bill_date, product_name: p.product_name,
        product_group: p.product_group, product_category: p.product_category,
        sales_man: p.sales_man, credit_days: p.credit_days, bill_amount: p.bill_amount,
      });
    });

    if (partyGroups.size === 0) {
      return res.status(400).json({ success: false, message: "No valid rows found. Check column headers." });
    }

    const partyKeys = [...partyGroups.keys()];
    const { data: existingCustomers } = await supabaseAdmin
      .from("repeat_order_customers")
      .select("id, party_name, party_name_key, location, gstin, mobile_1, mobile_2")
      .in("party_name_key", partyKeys)
      .is("deleted_at", null);
    const existingByKey = new Map((existingCustomers || []).map((c) => [c.party_name_key, c]));

    const allBillNos = [...seenBillNos];
    const alreadyImported = new Set();
    for (let i = 0; i < allBillNos.length; i += 500) {
      const chunk = allBillNos.slice(i, i + 500);
      const { data } = await supabaseAdmin.from("repeat_order_purchase_history").select("bill_no").in("bill_no", chunk);
      (data || []).forEach((r) => alreadyImported.add(r.bill_no));
    }

    let newCustomers = 0, updatedCustomers = 0, newBills = 0, duplicateBills = 0, matchesAttempted = 0;

    for (const [key, g] of partyGroups) {
      const existing = existingByKey.get(key);
      const freshItems = g.items.filter((it) => !alreadyImported.has(it.bill_no));
      duplicateBills += g.items.length - freshItems.length;

      if (!existing) {
        const { data: cust, error: custErr } = await supabaseAdmin
          .from("repeat_order_customers")
          .insert([{
            party_name: g.party_name, location: g.location, gstin: g.gstin,
            mobile_1: g.mobile_1, mobile_2: g.mobile_2, status: "unassigned",
            created_by: userId, updated_by: userId,
          }])
          .select("id").single();
        if (custErr) { console.error("customer insert failed:", custErr.message); continue; }

        if (freshItems.length) {
          const { error: histErr } = await supabaseAdmin
            .from("repeat_order_purchase_history")
            .insert(freshItems.map((it) => ({ customer_id: cust.id, uploaded_by: userId, ...it })));
          if (histErr) console.error("history insert failed:", histErr.message);
        }
        await supabaseAdmin.from("repeat_order_customers").update(computeRollup(freshItems)).eq("id", cust.id);

        logRO(cust.id, "uploaded", userId, { remark: `Created via sales dump upload — ${freshItems.length} bill(s)`, status: "unassigned" });
        newCustomers++;
        newBills += freshItems.length;
        continue;
      }

      // Existing party — append new purchase-history lines only, then
      // try to reconcile any open ("unmatched"/"suggested") orders taken
      // against those new bills. Assignment/status/follow-up are never
      // touched by an upload.
      let insertedRows = [];
      if (freshItems.length) {
        const { data: inserted, error: histErr } = await supabaseAdmin
          .from("repeat_order_purchase_history")
          .insert(freshItems.map((it) => ({ customer_id: existing.id, uploaded_by: userId, ...it })))
          .select();
        if (histErr) console.error("history insert failed:", histErr.message);
        insertedRows = inserted || [];
      }

      const patch = { updated_by: userId, updated_at: nowUTC() };
      if (!existing.location && g.location) patch.location = g.location;
      if (!existing.gstin && g.gstin) patch.gstin = g.gstin;
      if (!existing.mobile_1 && g.mobile_1) patch.mobile_1 = g.mobile_1;
      if (!existing.mobile_2 && g.mobile_2) patch.mobile_2 = g.mobile_2;

      const { data: allHistory } = await supabaseAdmin
        .from("repeat_order_purchase_history")
        .select("bill_amount, bill_date, sales_man")
        .eq("customer_id", existing.id);
      Object.assign(patch, computeRollup(allHistory || []));

      await supabaseAdmin.from("repeat_order_customers").update(patch).eq("id", existing.id);

      if (insertedRows.length) {
        logRO(existing.id, "uploaded", userId, { remark: `Synced ${insertedRows.length} new bill(s) from sales dump upload` });
        updatedCustomers++;
        newBills += insertedRows.length;
        await matchOrdersAgainstHistory(existing.id, insertedRows, userId);
        matchesAttempted++;
      }
    }

    return res.json({
      success: true,
      message: `Imported ${newCustomers} new customer(s), synced ${updatedCustomers} existing customer(s) — ${newBills} new bill(s) total. ${duplicateBills} bill(s) already on file were skipped. Checked ${matchesAttempted} customer(s) for matching repeat orders.`,
      skippedRows: skipped,
      newCustomers, updatedCustomers, newBills, duplicateBills,
    });
  } catch (err) {
    console.error("uploadRepeatOrders error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/repeat-orders ──────────────────────────────────────────
export const getRepeatOrders = async (req, res) => {
  try {
    await sweepDueReopens(null); // keep statuses current before reading

    const manager = isRepeatOrderManager(req.user?.email);
    let query = supabaseAdmin
      .from("repeat_order_customers")
      .select(WITH_RELATIONS)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false });

    if (!manager) query = query.eq("assigned_to", req.user.id);

    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, message: error.message });

    return res.json({ success: true, manager, repeatOrders: (data || []).map(withFollowupStatus) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/repeat-orders/assignable-users ─────────────────────────
export const getAssignableUsers = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("id, email, first_name, last_name")
      .order("first_name", { ascending: true });
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, users: data || [] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/repeat-orders/:id/logs ─────────────────────────────────
export const getRepeatOrderLogs = async (req, res) => {
  try {
    const { id } = req.params;

    const { data: customer, error: custErr } = await supabaseAdmin
      .from("repeat_order_customers").select("assigned_to").eq("id", id).is("deleted_at", null).single();
    if (custErr) return res.status(404).json({ success: false, message: "Record not found" });
    if (!canActOnRecord(req, customer)) {
      return res.status(403).json({ success: false, message: "This record isn't assigned to you" });
    }

    const { data, error } = await supabaseAdmin
      .from("repeat_order_logs")
      .select("*, user:users!repeat_order_logs_changed_by_fkey(id, email, first_name, last_name)")
      .eq("customer_id", id)
      .order("changed_at", { ascending: false });
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, logs: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/repeat-orders/:id/assign ───────────────────────────────
export const assignRepeatOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;
    const { assigned_to } = req.body;

    const { data: before, error: beforeErr } = await supabaseAdmin
      .from("repeat_order_customers")
      .select("assigned_to, assigned_by, assigned_at, status, reopen_at, next_followup_at")
      .eq("id", id).is("deleted_at", null).single();
    if (beforeErr) return res.status(404).json({ success: false, message: "Record not found" });

    let updates;
    if (assigned_to) {
      updates = {
        assigned_to, assigned_by: userId, assigned_at: nowUTC(),
        status: before.status === "unassigned" ? "assigned" : before.status,
      };
    } else {
      updates = { assigned_to: null, assigned_by: null, assigned_at: null, status: "unassigned", next_followup_at: null, reopen_at: null };
    }
    updates.updated_by = userId;
    updates.updated_at = nowUTC();

    const { data, error } = await supabaseAdmin
      .from("repeat_order_customers").update(updates).eq("id", id).is("deleted_at", null).select(WITH_RELATIONS).single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    logRO(id, assigned_to ? "assigned" : "unassigned", userId, {
      remark: assigned_to ? "Assigned for follow-up" : "Sent back to the unassigned pool",
      snapshot: { customer: before, order: null },
    });

    return res.json({ success: true, repeatOrder: withFollowupStatus(data) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/repeat-orders/:id/followup ─────────────────────────────
// Body: { remark, reason, next_followup_at }  (next_followup_at is a
// full ISO datetime string — date AND time — built client-side from the
// separate date/time inputs)
export const addFollowup = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;
    const { remark, reason, next_followup_at } = req.body;

    if (!reason?.trim()) return res.status(400).json({ success: false, message: "Reason is required" });
    if (!next_followup_at) return res.status(400).json({ success: false, message: "Next follow-up date & time is required" });

    const { data: before, error: beforeErr } = await supabaseAdmin
      .from("repeat_order_customers")
      .select("assigned_to, status, last_remark, last_reason, next_followup_at, reopen_at")
      .eq("id", id).is("deleted_at", null).single();
    if (beforeErr) return res.status(404).json({ success: false, message: "Record not found" });
    if (!canActOnRecord(req, before)) return res.status(403).json({ success: false, message: "This record isn't assigned to you" });

    if (before.status === "unassigned") return res.status(400).json({ success: false, message: "Assign this record before logging a follow-up" });
    if (before.status !== "assigned") {
      return res.status(400).json({
        success: false,
        message: `This record is marked "${before.status.replace("_", " ")}". Reopen it before logging a new follow-up.`,
      });
    }

    const updates = {
      last_remark: remark || null,
      last_reason: reason,
      next_followup_at,
      updated_by: userId,
      updated_at: nowUTC(),
    };

    const { data, error } = await supabaseAdmin
      .from("repeat_order_customers").update(updates).eq("id", id).is("deleted_at", null).select(WITH_RELATIONS).single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    logRO(id, "followup", userId, {
      remark, reason, next_followup_at, status: "assigned",
      snapshot: { customer: before, order: null },
    });

    return res.json({ success: true, repeatOrder: withFollowupStatus(data) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/repeat-orders/:id/take-order ───────────────────────────
// Body: { items: [{ order_item, quantity, price_discussed }], remark }
// All line items in one call are saved under the same batch_id so
// Revert Last Action undoes the whole batch together.
export const takeOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;
    const { items, remark } = req.body;

    const cleanItems = (Array.isArray(items) ? items : [])
      .map((it) => ({
        order_item: String(it.order_item || "").trim(),
        quantity: it.quantity !== undefined && it.quantity !== null && it.quantity !== "" ? Number(it.quantity) : null,
        price_discussed: it.price_discussed !== undefined && it.price_discussed !== null && it.price_discussed !== "" ? Number(it.price_discussed) : null,
      }))
      .filter((it) => it.order_item);

    if (cleanItems.length === 0) return res.status(400).json({ success: false, message: "Add at least one order item" });

    const { data: before, error: beforeErr } = await supabaseAdmin
      .from("repeat_order_customers")
      .select("assigned_to, status, last_remark, last_reason, next_followup_at, reopen_at")
      .eq("id", id).is("deleted_at", null).single();
    if (beforeErr) return res.status(404).json({ success: false, message: "Record not found" });
    if (!canActOnRecord(req, before)) return res.status(403).json({ success: false, message: "This record isn't assigned to you" });

    if (before.status === "unassigned") return res.status(400).json({ success: false, message: "Assign this record before recording an order" });
    if (before.status === "not_interested") return res.status(400).json({ success: false, message: `This record is marked "not interested". Reopen it before recording a new order.` });

    const batchId = crypto.randomUUID();
    const { data: orderRows, error: orderErr } = await supabaseAdmin
      .from("repeat_order_placed")
      .insert(cleanItems.map((it) => ({
        customer_id: id, batch_id: batchId, order_item: it.order_item,
        quantity: it.quantity, price_discussed: it.price_discussed,
        remark: remark || null, recorded_by: userId,
      })))
      .select();
    if (orderErr) return res.status(400).json({ success: false, message: orderErr.message });

    const updates = {
      status: "order_placed",
      last_remark: remark || null,
      last_reason: cleanItems.length > 1 ? `Repeat order placed (${cleanItems.length} items)` : "Repeat order placed",
      next_followup_at: null,
      reopen_at: addDaysISO(REPEAT_CYCLE_DAYS_ORDER_PLACED),
      updated_by: userId,
      updated_at: nowUTC(),
    };

    const { data, error } = await supabaseAdmin
      .from("repeat_order_customers").update(updates).eq("id", id).is("deleted_at", null).select(WITH_RELATIONS).single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    logRO(id, "order_taken", userId, {
      remark: cleanItems.map((it) => `${it.order_item}${it.quantity ? ` × ${it.quantity}` : ""}${it.price_discussed ? ` @ ₹${it.price_discussed}` : ""}`).join("; "),
      status: "order_placed",
      snapshot: { customer: before, order: { batchId, ids: (orderRows || []).map((o) => o.id) } },
    });

    return res.json({ success: true, repeatOrder: withFollowupStatus(data) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/repeat-orders/:id/orders/:orderId/match ────────────────
// Body: { action: "confirm" | "reject" } — resolves a fuzzy-matched
// suggestion raised automatically during upload.
export const resolveOrderMatch = async (req, res) => {
  try {
    const { id, orderId } = req.params;
    const { action } = req.body;
    if (!["confirm", "reject"].includes(action)) return res.status(400).json({ success: false, message: "action must be 'confirm' or 'reject'" });

    const { data: customer, error: custErr } = await supabaseAdmin
      .from("repeat_order_customers").select("assigned_to").eq("id", id).is("deleted_at", null).single();
    if (custErr) return res.status(404).json({ success: false, message: "Record not found" });
    if (!canActOnRecord(req, customer)) return res.status(403).json({ success: false, message: "This record isn't assigned to you" });

    const { data: order, error: orderErr } = await supabaseAdmin
      .from("repeat_order_placed").select("*").eq("id", orderId).eq("customer_id", id).single();
    if (orderErr || !order) return res.status(404).json({ success: false, message: "Order line not found" });

    const updates = action === "confirm"
      ? { match_status: "confirmed" }
      : { match_status: "rejected", matched_history_id: null, match_score: null };

    const { error } = await supabaseAdmin.from("repeat_order_placed").update(updates).eq("id", orderId);
    if (error) return res.status(400).json({ success: false, message: error.message });

    logRO(id, action === "confirm" ? "order_match_confirmed" : "order_match_rejected", req.user.id, {
      remark: `"${order.order_item}" match ${action === "confirm" ? "confirmed" : "dismissed"}`,
    });

    const { data: full } = await supabaseAdmin.from("repeat_order_customers").select(WITH_RELATIONS).eq("id", id).single();
    return res.json({ success: true, repeatOrder: withFollowupStatus(full) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/repeat-orders/:id/not-interested ───────────────────────
export const markNotInterested = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;
    const { remark } = req.body;

    const { data: before, error: beforeErr } = await supabaseAdmin
      .from("repeat_order_customers")
      .select("assigned_to, status, last_remark, last_reason, next_followup_at, reopen_at")
      .eq("id", id).is("deleted_at", null).single();
    if (beforeErr) return res.status(404).json({ success: false, message: "Record not found" });
    if (!canActOnRecord(req, before)) return res.status(403).json({ success: false, message: "This record isn't assigned to you" });
    if (before.status !== "assigned") return res.status(400).json({ success: false, message: `Only records currently in active follow-up can be marked not interested` });

    const updates = {
      status: "not_interested",
      last_remark: remark || "Marked not interested",
      next_followup_at: null,
      reopen_at: addDaysISO(REPEAT_CYCLE_DAYS_NOT_INTERESTED),
      updated_by: userId,
      updated_at: nowUTC(),
    };

    const { data, error } = await supabaseAdmin
      .from("repeat_order_customers").update(updates).eq("id", id).is("deleted_at", null).select(WITH_RELATIONS).single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    logRO(id, "not_interested", userId, { remark: updates.last_remark, status: "not_interested", snapshot: { customer: before, order: null } });

    return res.json({ success: true, repeatOrder: withFollowupStatus(data) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/repeat-orders/:id/reopen ───────────────────────────────
// Manual early-reopen — bypasses the automatic cycle timer.
export const reopenFollowUp = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;

    const { data: before, error: beforeErr } = await supabaseAdmin
      .from("repeat_order_customers")
      .select("assigned_to, status, last_remark, last_reason, next_followup_at, reopen_at")
      .eq("id", id).is("deleted_at", null).single();
    if (beforeErr) return res.status(404).json({ success: false, message: "Record not found" });
    if (!canActOnRecord(req, before)) return res.status(403).json({ success: false, message: "This record isn't assigned to you" });
    if (!before.assigned_to) return res.status(400).json({ success: false, message: "Assign this record to someone before reopening it" });
    if (before.status === "assigned") return res.status(400).json({ success: false, message: "This record is already active" });

    const updates = { status: "assigned", reopen_at: null, updated_by: userId, updated_at: nowUTC() };

    const { data, error } = await supabaseAdmin
      .from("repeat_order_customers").update(updates).eq("id", id).is("deleted_at", null).select(WITH_RELATIONS).single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    logRO(id, "reopened", userId, { remark: "Manually reopened for the next follow-up cycle", status: "assigned", snapshot: { customer: before, order: null } });

    return res.json({ success: true, repeatOrder: withFollowupStatus(data) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

function extractCustomerFields(body) {
  const { party_name, location, gstin, mobile_1, mobile_2 } = body;
  return {
    party_name: (party_name || "").trim(),
    location: location && String(location).trim() ? String(location).trim() : null,
    gstin: gstin && String(gstin).trim() ? String(gstin).trim() : null,
    mobile_1: mobile_1 ? String(mobile_1).replace(/\D/g, "") : null,
    mobile_2: mobile_2 ? String(mobile_2).replace(/\D/g, "") : null,
  };
}

// ── POST /api/repeat-orders ─────────────────────────────────────────
export const createRepeatOrder = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const fields = extractCustomerFields(req.body);
    const { assigned_to } = req.body;
    if (!fields.party_name) return res.status(400).json({ success: false, message: "Party name is required" });

    const { data: dupe } = await supabaseAdmin
      .from("repeat_order_customers").select("id").eq("party_name_key", partyKey(fields.party_name)).is("deleted_at", null).maybeSingle();
    if (dupe) return res.status(409).json({ success: false, message: `"${fields.party_name}" already exists in Repeat Orders` });

    const insertRow = {
      ...fields,
      status: assigned_to ? "assigned" : "unassigned",
      assigned_to: assigned_to || null,
      assigned_by: assigned_to ? userId : null,
      assigned_at: assigned_to ? nowUTC() : null,
      created_by: userId, updated_by: userId,
    };

    const { data: cust, error } = await supabaseAdmin.from("repeat_order_customers").insert([insertRow]).select("id").single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    logRO(cust.id, "created", userId, { remark: "Added manually", status: insertRow.status });

    const { data: full } = await supabaseAdmin.from("repeat_order_customers").select(WITH_RELATIONS).eq("id", cust.id).single();
    return res.status(201).json({ success: true, repeatOrder: withFollowupStatus(full) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/repeat-orders/:id ───────────────────────────────────────
export const updateRepeatOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;
    const fields = extractCustomerFields(req.body);
    if (!fields.party_name) return res.status(400).json({ success: false, message: "Party name is required" });

    const { data: before, error: fetchErr } = await supabaseAdmin
      .from("repeat_order_customers").select("*").eq("id", id).is("deleted_at", null).single();
    if (fetchErr) return res.status(404).json({ success: false, message: "Record not found" });

    const { data: dupe } = await supabaseAdmin
      .from("repeat_order_customers").select("id").eq("party_name_key", partyKey(fields.party_name)).neq("id", id).is("deleted_at", null).maybeSingle();
    if (dupe) return res.status(409).json({ success: false, message: `"${fields.party_name}" already exists in Repeat Orders` });

    const { data, error } = await supabaseAdmin
      .from("repeat_order_customers").update({ ...fields, updated_by: userId, updated_at: nowUTC() }).eq("id", id).select(WITH_RELATIONS).single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    const changedFields = {};
    Object.keys(fields).forEach((k) => { if (String(before[k] ?? "") !== String(fields[k] ?? "")) changedFields[k] = { from: before[k], to: fields[k] }; });
    logRO(id, "edited", userId, { remark: JSON.stringify(changedFields) });

    return res.json({ success: true, repeatOrder: withFollowupStatus(data) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/repeat-orders/:id ───────────────────────────────────
export const deleteRepeatOrder = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;

    const { data: customer, error: custErr } = await supabaseAdmin.from("repeat_order_customers").select("*").eq("id", id).single();
    if (custErr || !customer) return res.status(404).json({ success: false, message: "Record not found" });

    const { data: history } = await supabaseAdmin.from("repeat_order_purchase_history").select("*").eq("customer_id", id);
    const { data: ordersTaken } = await supabaseAdmin.from("repeat_order_placed").select("*").eq("customer_id", id);
    const { data: logs } = await supabaseAdmin.from("repeat_order_logs").select("*").eq("customer_id", id).order("changed_at", { ascending: true });

    const { error: auditErr } = await supabaseAdmin
      .from("repeat_order_deletion_logs")
      .insert([{ customer_id: id, deleted_by: userId, snapshot: { customer, history: history || [], ordersTaken: ordersTaken || [], logs: logs || [] } }]);
    if (auditErr) return res.status(500).json({ success: false, message: "Failed to log deletion, aborted: " + auditErr.message });

    const { error: delErr } = await supabaseAdmin.from("repeat_order_customers").delete().eq("id", id);
    if (delErr) return res.status(400).json({ success: false, message: delErr.message });

    return res.json({ success: true, message: "Repeat Order record permanently deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/repeat-orders/:id/revert-last ──────────────────────────
export const revertLastAction = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;

    const { data: customer, error: custErr } = await supabaseAdmin
      .from("repeat_order_customers").select("assigned_to").eq("id", id).is("deleted_at", null).single();
    if (custErr) return res.status(404).json({ success: false, message: "Record not found" });
    if (!canActOnRecord(req, customer)) return res.status(403).json({ success: false, message: "This record isn't assigned to you" });

    const { data: lastLog, error: logErr } = await supabaseAdmin
      .from("repeat_order_logs").select("*").eq("customer_id", id).is("reverted_at", null).not("snapshot", "is", null)
      .order("changed_at", { ascending: false }).limit(1).maybeSingle();
    if (logErr) return res.status(400).json({ success: false, message: logErr.message });
    if (!lastLog) return res.status(400).json({ success: false, message: "Nothing to revert" });

    const snap = lastLog.snapshot || {};
    const customerSnap = snap.customer || {};
    const orderSnap = snap.order || null;

    if (orderSnap?.ids?.length) {
      await supabaseAdmin.from("repeat_order_placed").delete().in("id", orderSnap.ids);
    } else if (orderSnap?.id) {
      await supabaseAdmin.from("repeat_order_placed").delete().eq("id", orderSnap.id);
    }

    const { data, error } = await supabaseAdmin
      .from("repeat_order_customers")
      .update({ ...customerSnap, updated_by: userId, updated_at: nowUTC() })
      .eq("id", id).is("deleted_at", null).select(WITH_RELATIONS).single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    await supabaseAdmin.from("repeat_order_logs").update({ reverted_at: nowUTC(), reverted_by: userId }).eq("id", lastLog.id);
    logRO(id, "reverted", userId, { remark: `Reverted "${lastLog.action.replace(/_/g, " ")}" logged ${new Date(lastLog.changed_at).toLocaleString("en-IN")}` });

    return res.json({ success: true, repeatOrder: withFollowupStatus(data) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};