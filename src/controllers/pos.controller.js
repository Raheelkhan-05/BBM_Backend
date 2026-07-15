// controllers/pos.controller.js
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const nowUTC = () => new Date().toISOString();
const todayISO = () => nowUTC().slice(0, 10);

const WITH_USERS =
  "*, creator:users!purchase_orders_created_by_fkey(id, email, first_name, last_name), " +
  "updater:users!purchase_orders_updated_by_fkey(id, email, first_name, last_name), " +
  "items:po_items(*)";

function logPO(poId, action, changedBy, extra = {}) {
  supabaseAdmin
    .from("po_logs")
    .insert([{ po_id: poId, action, changed_by: changedBy, changed_at: nowUTC(), ...extra }])
    .then(({ error }) => { if (error) console.error("po_logs write error:", error.message); });
}

// Recomputes item status + PO-level status/rollups from a list of po_items.
// Called after any write that touches quantities, so the DB never drifts
// from what the items actually say (same "single source of truth" spirit
// as bills' balance_amount).
function deriveFromItems(items) {
  let totalOrderQty = 0, totalDeliveredQty = 0, totalAmount = 0, deliveredAmount = 0;
  const scored = items.map(it => {
    const orderQty = Number(it.order_qty) || 0;
    const deliveredQty = Math.min(Number(it.delivered_qty) || 0, orderQty);
    const amount = Number(it.amount) || 0;
    const lineDeliveredAmount = orderQty > 0 ? (deliveredQty / orderQty) * amount : 0;

    totalOrderQty += orderQty;
    totalDeliveredQty += deliveredQty;
    totalAmount += amount;
    deliveredAmount += lineDeliveredAmount;

    const status = deliveredQty <= 0 ? "pending" : deliveredQty >= orderQty ? "received" : "partial";
    return { ...it, delivered_qty: deliveredQty, status };
  });

  const poStatus = totalDeliveredQty <= 0
    ? "pending"
    : totalDeliveredQty >= totalOrderQty
    ? "completed"
    : "partial";

  return {
    items: scored,
    rollup: {
      total_order_qty: totalOrderQty,
      total_delivered_qty: totalDeliveredQty,
      total_amount: totalAmount,
      delivered_amount: Math.round(deliveredAmount * 100) / 100,
      status: poStatus,
    },
  };
}

// Adds derived `tracking_active` (+ `tracking_active_is_manual`) flag to a PO —
// mirrors bills.withCollectionActive exactly. Manual override wins; otherwise
// auto from whether expected_delivery_date has passed and the PO isn't done.
function withTrackingActive(po) {
  if (!po) return po;
  const manual = po.tracking_active_manual;
  const isManual = manual === true || manual === false;
  const today = todayISO();

  const snoozedUntil = po.snoozed_until || null;
  const isSnoozed = snoozedUntil && snoozedUntil > today;

  const notDone = po.status !== "completed" && po.status !== "cancelled";
  const auto = notDone && po.expected_delivery_date ? po.expected_delivery_date <= today : false;

  let trackingActive, isManualFlag;
  if (isSnoozed) {
    trackingActive = false;
    isManualFlag = true;
  } else {
    trackingActive = isManual ? (manual && notDone) : auto;
    isManualFlag = isManual;
  }

  return {
    ...po,
    tracking_active: trackingActive,
    tracking_active_is_manual: isManualFlag,
    snoozed_until: snoozedUntil,
    is_snoozed: !!isSnoozed,
  };
}

// ══════════════════════════════════════════════════════════════════════
// Excel import — "Pending" export format:
//   Order Date | Order No. | Party Name | Product Name | Order Qty |
//   Delivered Qty | Amount
// One row per PRODUCT LINE ITEM; multiple rows share the same Order No.
// This is a LIVE snapshot from the source system, so re-uploading should
// SYNC delivered quantities into existing POs (not just skip duplicates
// like the bills importer does) — that's the whole point of tracking POs.
// ══════════════════════════════════════════════════════════════════════

function normalizeKey(k) {
  return String(k || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const KEY_MAP = {
  orderdate:     "order_date",
  orderno:       "order_no",
  partyname:     "party_name",
  productname:   "product_name",
  orderqty:      "order_qty",
  deliveredqty:  "delivered_qty",
  amount:        "amount",
  // optional / legacy columns, kept for future exports
  cityname:      "location",
  location:      "location",
  mobile1:       "mobile_1",
  mobile2:       "mobile_2",
  leaddays:      "lead_days",
  creditdays:    "lead_days",
};

function findHeaderRowIndex(rawRows) {
  for (let i = 0; i < Math.min(rawRows.length, 30); i++) {
    const row = rawRows[i] || [];
    const normalized = row.map(c => normalizeKey(c));
    const hits = normalized.filter(nk => KEY_MAP[nk]).length;
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
  if (!mapped.party_name || mapped.order_no == null || mapped.order_no === "" || !mapped.product_name) return null;

  return {
    order_no:      String(mapped.order_no).trim(),
    party_name:    String(mapped.party_name).trim(),
    order_date:    excelDateToISO(mapped.order_date),
    product_name:  String(mapped.product_name).trim(),
    order_qty:     Number(mapped.order_qty) || 0,
    delivered_qty: Number(mapped.delivered_qty) || 0,
    amount:        Number(mapped.amount) || 0,
    location:      mapped.location ? String(mapped.location).trim() : null,
    mobile_1:      mapped.mobile_1 ? String(mapped.mobile_1).replace(/\D/g, "").slice(0, 15) : null,
    mobile_2:      mapped.mobile_2 ? String(mapped.mobile_2).replace(/\D/g, "").slice(0, 15) : null,
    lead_days:     Number.isFinite(Number(mapped.lead_days)) ? Math.max(0, Math.round(Number(mapped.lead_days))) : 0,
  };
}

// ── POST /api/pos/upload (multipart, field name "file") ────────────────
export const uploadPOs = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });
    const { id: userId } = req.user;

    const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];

    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
    const headerRowIndex = findHeaderRowIndex(rawRows);
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", range: headerRowIndex, raw: true });

    // Group rows by Order No — each group becomes one PO with N line items.
    const groups = new Map(); // order_no -> { order_date, party_name, location, mobile_1, mobile_2, lead_days, items: [] }
    const skipped = [];

    rows.forEach((r, i) => {
      const p = parseRow(r);
      const excelRowNum = i + headerRowIndex + 2;
      if (!p || !p.order_date) { skipped.push(excelRowNum); return; }

      if (!groups.has(p.order_no)) {
        groups.set(p.order_no, {
          order_no: p.order_no,
          order_date: p.order_date,
          party_name: p.party_name,
          location: p.location,
          mobile_1: p.mobile_1,
          mobile_2: p.mobile_2,
          lead_days: p.lead_days,
          items: [],
        });
      }
      groups.get(p.order_no).items.push({
        product_name: p.product_name,
        order_qty: p.order_qty,
        delivered_qty: p.delivered_qty,
        amount: p.amount,
      });
    });

    if (groups.size === 0) {
      return res.status(400).json({ success: false, message: "No valid rows found. Check column headers." });
    }

    const orderNos = [...groups.keys()];
    const { data: existingPOs } = await supabaseAdmin
      .from("purchase_orders")
      .select("id, order_no, status")
      .in("order_no", orderNos)
      .is("deleted_at", null);
    const existingByOrderNo = new Map((existingPOs || []).map(p => [p.order_no, p]));

    let inserted = 0, updated = 0, skippedCompleted = 0;

    for (const [orderNo, g] of groups) {
      const existing = existingByOrderNo.get(orderNo);

      if (!existing) {
        // New PO — insert header + items, then compute rollups.
        const { rollup } = deriveFromItems(g.items.map(it => ({ ...it })));
        const { data: po, error: poErr } = await supabaseAdmin
          .from("purchase_orders")
          .insert([{
            order_no: g.order_no,
            party_name: g.party_name,
            order_date: g.order_date,
            lead_days: g.lead_days,
            location: g.location,
            mobile_1: g.mobile_1,
            mobile_2: g.mobile_2,
            status: rollup.status,
            total_order_qty: rollup.total_order_qty,
            total_delivered_qty: rollup.total_delivered_qty,
            total_amount: rollup.total_amount,
            delivered_amount: rollup.delivered_amount,
            created_by: userId,
            updated_by: userId,
          }])
          .select("id")
          .single();
        if (poErr) { console.error("PO insert failed:", poErr.message); continue; }

        const { error: itemsErr } = await supabaseAdmin
          .from("po_items")
          .insert(g.items.map(it => ({ po_id: po.id, ...it, status: it.delivered_qty >= it.order_qty && it.order_qty > 0 ? "received" : it.delivered_qty > 0 ? "partial" : "pending" })));
        if (itemsErr) console.error("po_items insert failed:", itemsErr.message);

        logPO(po.id, "uploaded", userId, { remark: "Created via Excel upload", status: rollup.status });
        inserted++;
        continue;
      }

      // Existing PO — SYNC delivered_qty per product line item. We don't
      // touch follow-up notes, tracking overrides, or contact info here;
      // only quantities/amounts move, driven by the source system.
      if (existing.status === "completed" || existing.status === "cancelled") {
        skippedCompleted++;
        continue;
      }

      const { data: currentItems } = await supabaseAdmin
        .from("po_items")
        .select("*")
        .eq("po_id", existing.id);

      const byProduct = new Map((currentItems || []).map(it => [it.product_name, it]));
      const mergedItems = [];
      for (const incoming of g.items) {
        const cur = byProduct.get(incoming.product_name);
        if (cur) {
          // Only move delivered_qty forward — never let a stale re-upload
          // reduce a quantity that's already been recorded as delivered.
          const newDelivered = Math.max(Number(cur.delivered_qty) || 0, incoming.delivered_qty);
          mergedItems.push({ ...cur, delivered_qty: newDelivered, order_qty: incoming.order_qty, amount: incoming.amount });
        } else {
          mergedItems.push({ po_id: existing.id, ...incoming, id: undefined });
        }
      }

      const { rollup, items: scoredItems } = deriveFromItems(mergedItems);

      // Upsert items: update existing, insert brand-new product lines.
      for (const it of scoredItems) {
        if (it.id) {
          await supabaseAdmin.from("po_items").update({
            delivered_qty: it.delivered_qty, order_qty: it.order_qty, amount: it.amount,
            status: it.status, updated_at: nowUTC(),
          }).eq("id", it.id);
        } else {
          await supabaseAdmin.from("po_items").insert([{
            po_id: existing.id, product_name: it.product_name, order_qty: it.order_qty,
            delivered_qty: it.delivered_qty, amount: it.amount, status: it.status,
          }]);
        }
      }

      await supabaseAdmin.from("purchase_orders").update({
        status: rollup.status,
        total_order_qty: rollup.total_order_qty,
        total_delivered_qty: rollup.total_delivered_qty,
        total_amount: rollup.total_amount,
        delivered_amount: rollup.delivered_amount,
        updated_by: userId,
        updated_at: nowUTC(),
      }).eq("id", existing.id);

      logPO(existing.id, "uploaded", userId, { remark: "Synced delivered quantities via Excel upload", status: rollup.status });
      updated++;
    }

    return res.json({
      success: true,
      message: `Imported ${inserted} new PO(s), synced ${updated} existing PO(s). ${skippedCompleted} already completed/cancelled were left untouched.`,
      skippedRows: skipped,
      inserted, updated, skippedCompleted,
    });
  } catch (err) {
    console.error("uploadPOs error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/pos ────────────────────────────────────────────────────
export const getPOs = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("purchase_orders")
      .select(WITH_USERS)
      .is("deleted_at", null)
      .order("order_date", { ascending: true });
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, pos: (data || []).map(withTrackingActive) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/pos/:id/logs ───────────────────────────────────────────
export const getPOLogs = async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from("po_logs")
      .select("*, user:users!po_logs_changed_by_fkey(id, email, first_name, last_name)")
      .eq("po_id", id)
      .order("changed_at", { ascending: false });
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, logs: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/pos/:id/followup ───────────────────────────────────────
// Same snooze pattern as bills: setting next_followup_date turns tracking
// off until that date, then it auto-reactivates.
export const addFollowup = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;
    const { remark, reason, next_followup_date } = req.body;

    if (!reason?.trim()) return res.status(400).json({ success: false, message: "Reason is required" });

    const { data: before, error: beforeErr } = await supabaseAdmin
      .from("purchase_orders")
      .select("status, last_remark, last_reason, next_followup_date, tracking_active_manual, snoozed_until")
      .eq("id", id).is("deleted_at", null).single();
    if (beforeErr) return res.status(404).json({ success: false, message: "PO not found" });

    const snoozeUntil = next_followup_date || null;
    const updates = {
      last_remark: remark || null,
      last_reason: reason,
      next_followup_date: snoozeUntil,
      updated_by: userId,
      updated_at: nowUTC(),
    };
    if (snoozeUntil) {
      updates.tracking_active_manual = false;
      updates.snoozed_until = snoozeUntil;
      updates.tracking_active_updated_by = userId;
      updates.tracking_active_updated_at = nowUTC();
    }

    const { data, error } = await supabaseAdmin
      .from("purchase_orders").update(updates).eq("id", id).is("deleted_at", null)
      .select(WITH_USERS).single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    logPO(id, "followup", userId, {
      remark, reason, next_followup_date: snoozeUntil,
      ...(snoozeUntil ? { status: `snoozed_until_${snoozeUntil}` } : {}),
      snapshot: { po: before, item: null },
    });

    return res.json({ success: true, po: withTrackingActive(data) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/pos/:id/delivery ───────────────────────────────────────
// Body: { item_id, delivered_qty, remark, next_followup_date }
// Records receipt against ONE line item (vendors ship line by line).
// PO status/rollups are recomputed from all items after the update.
export const recordDelivery = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;
    const { item_id, delivered_qty, remark, next_followup_date } = req.body;

    const qty = Number(delivered_qty);
    if (!item_id) return res.status(400).json({ success: false, message: "item_id is required" });
    if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ success: false, message: "Enter a valid delivered quantity" });

    const { data: item, error: itemErr } = await supabaseAdmin
      .from("po_items").select("*").eq("id", item_id).eq("po_id", id).single();
    if (itemErr || !item) return res.status(404).json({ success: false, message: "Line item not found" });
    if (qty < Number(item.delivered_qty)) {
      return res.status(400).json({ success: false, message: "Delivered quantity cannot decrease — use Revert Last Action instead" });
    }
    if (qty > Number(item.order_qty)) {
      return res.status(400).json({ success: false, message: `Cannot exceed ordered quantity of ${item.order_qty}` });
    }

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("purchase_orders").select("status, next_followup_date").eq("id", id).is("deleted_at", null).single();
    if (fetchErr) return res.status(404).json({ success: false, message: "PO not found" });

    const { data: allItems } = await supabaseAdmin.from("po_items").select("*").eq("po_id", id);
    const updatedItemsInput = (allItems || []).map(it => it.id === item_id ? { ...it, delivered_qty: qty } : it);
    const { rollup, items: scoredItems } = deriveFromItems(updatedItemsInput);
    const thisItemScored = scoredItems.find(it => it.id === item_id);

    if (rollup.status === "partial" && !next_followup_date) {
      return res.status(400).json({ success: false, message: "Partial delivery — next follow-up date is required to chase the remainder" });
    }

    await supabaseAdmin.from("po_items").update({
      delivered_qty: qty, status: thisItemScored.status, updated_at: nowUTC(),
    }).eq("id", item_id);

    const { data, error } = await supabaseAdmin
      .from("purchase_orders")
      .update({
        status: rollup.status,
        total_order_qty: rollup.total_order_qty,
        total_delivered_qty: rollup.total_delivered_qty,
        total_amount: rollup.total_amount,
        delivered_amount: rollup.delivered_amount,
        next_followup_date: rollup.status === "completed" ? null : (next_followup_date || null),
        ...(rollup.status === "completed"
          ? { tracking_active_manual: null, snoozed_until: null }
          : next_followup_date
          ? { tracking_active_manual: false, snoozed_until: next_followup_date, tracking_active_updated_by: userId, tracking_active_updated_at: nowUTC() }
          : {}),
        updated_by: userId,
        updated_at: nowUTC(),
      })
      .eq("id", id).select(WITH_USERS).single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    logPO(id, "item_delivery_recorded", userId, {
      remark, status: rollup.status, delivered_qty: qty,
      next_followup_date: rollup.status === "completed" ? null : next_followup_date || null,
      snapshot: {
        po: { status: existing.status, next_followup_date: existing.next_followup_date },
        item: { id: item.id, delivered_qty: item.delivered_qty, status: item.status },
      },
    });

    return res.json({ success: true, po: withTrackingActive(data) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/pos/:id/tracking-toggle ────────────────────────────────
export const setTrackingActive = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;
    const { active } = req.body;
    if (active !== null && typeof active !== "boolean") {
      return res.status(400).json({ success: false, message: "'active' must be true, false, or null" });
    }

    const { data: before, error: beforeErr } = await supabaseAdmin
      .from("purchase_orders")
      .select("tracking_active_manual, tracking_active_updated_by, tracking_active_updated_at")
      .eq("id", id).is("deleted_at", null).single();
    if (beforeErr) return res.status(404).json({ success: false, message: "PO not found" });

    const { data, error } = await supabaseAdmin
      .from("purchase_orders")
      .update({
        tracking_active_manual: active,
        tracking_active_updated_by: userId,
        tracking_active_updated_at: nowUTC(),
        updated_by: userId,
        updated_at: nowUTC(),
      })
      .eq("id", id).is("deleted_at", null).select(WITH_USERS).single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    logPO(id, "tracking_toggle", userId, {
      remark: active === null ? "Reset to automatic (lead-days) logic" : `Manually turned tracking ${active ? "ON" : "OFF"}`,
      snapshot: { po: before, item: null },
    });

    return res.json({ success: true, po: withTrackingActive(data) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/pos/:id/cancel ─────────────────────────────────────────
export const cancelPO = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;
    const { remark } = req.body;

    const { data: before, error: beforeErr } = await supabaseAdmin
      .from("purchase_orders").select("status").eq("id", id).is("deleted_at", null).single();
    if (beforeErr) return res.status(404).json({ success: false, message: "PO not found" });
    if (before.status === "completed") return res.status(400).json({ success: false, message: "Cannot cancel a completed PO" });

    const { data, error } = await supabaseAdmin
      .from("purchase_orders")
      .update({ status: "cancelled", updated_by: userId, updated_at: nowUTC() })
      .eq("id", id).is("deleted_at", null).select(WITH_USERS).single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    logPO(id, "cancelled", userId, { remark: remark || "PO cancelled", snapshot: { po: before, item: null } });
    return res.json({ success: true, po: withTrackingActive(data) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

function extractPOFields(body) {
  const { party_name, order_no, order_date, lead_days, location, mobile_1, mobile_2 } = body;
  const leadDaysNum = Number(lead_days);
  return {
    party_name: (party_name || "").trim(),
    order_no:   (order_no || "").trim(),
    order_date: order_date || null,
    lead_days:  Number.isFinite(leadDaysNum) && leadDaysNum >= 0 ? Math.round(leadDaysNum) : 0,
    location:   location && String(location).trim() ? String(location).trim() : null,
    mobile_1:   mobile_1 ? String(mobile_1).replace(/\D/g, "") : null,
    mobile_2:   mobile_2 ? String(mobile_2).replace(/\D/g, "") : null,
  };
}

// ── POST /api/pos ───────────────────────────────────────────────────
// Body: { ...po fields, items: [{ product_name, order_qty, amount }] }
export const createPO = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const fields = extractPOFields(req.body);
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!fields.party_name) return res.status(400).json({ success: false, message: "Party name is required" });
    if (!fields.order_no)   return res.status(400).json({ success: false, message: "Order No is required" });
    if (!fields.order_date) return res.status(400).json({ success: false, message: "Order date is required" });
    if (items.length === 0) return res.status(400).json({ success: false, message: "At least one product line item is required" });

    const { data: dupe } = await supabaseAdmin
      .from("purchase_orders").select("id").eq("order_no", fields.order_no).is("deleted_at", null).maybeSingle();
    if (dupe) return res.status(409).json({ success: false, message: `Order No "${fields.order_no}" already exists` });

    const cleanItems = items.map(it => ({
      product_name: String(it.product_name || "").trim(),
      order_qty: Number(it.order_qty) || 0,
      delivered_qty: 0,
      amount: Number(it.amount) || 0,
      status: "pending",
    })).filter(it => it.product_name);
    if (cleanItems.length === 0) return res.status(400).json({ success: false, message: "Each line item needs a product name" });

    const { rollup } = deriveFromItems(cleanItems);

    const { data: po, error } = await supabaseAdmin
      .from("purchase_orders")
      .insert([{
        ...fields, status: rollup.status,
        total_order_qty: rollup.total_order_qty, total_delivered_qty: rollup.total_delivered_qty,
        total_amount: rollup.total_amount, delivered_amount: rollup.delivered_amount,
        created_by: userId, updated_by: userId,
      }])
      .select("id").single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    const { error: itemsErr } = await supabaseAdmin
      .from("po_items").insert(cleanItems.map(it => ({ po_id: po.id, ...it })));
    if (itemsErr) return res.status(400).json({ success: false, message: itemsErr.message });

    logPO(po.id, "created", userId, { remark: "Added manually" });

    const { data: full } = await supabaseAdmin.from("purchase_orders").select(WITH_USERS).eq("id", po.id).single();
    return res.status(201).json({ success: true, po: withTrackingActive(full) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/pos/:id ────────────────────────────────────────────────
// Edits header fields only (party/order no/date/lead days/contact/location).
// Line items are managed via /delivery, not this endpoint, to keep quantity
// changes auditable through the delivery-recording flow.
export const updatePO = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;
    const fields = extractPOFields(req.body);

    if (!fields.party_name) return res.status(400).json({ success: false, message: "Party name is required" });
    if (!fields.order_no)   return res.status(400).json({ success: false, message: "Order No is required" });
    if (!fields.order_date) return res.status(400).json({ success: false, message: "Order date is required" });

    const { data: before, error: fetchErr } = await supabaseAdmin
      .from("purchase_orders").select("*").eq("id", id).is("deleted_at", null).single();
    if (fetchErr) return res.status(404).json({ success: false, message: "PO not found" });

    const { data: dupe } = await supabaseAdmin
      .from("purchase_orders").select("id").eq("order_no", fields.order_no).neq("id", id).is("deleted_at", null).maybeSingle();
    if (dupe) return res.status(409).json({ success: false, message: `Order No "${fields.order_no}" already exists` });

    const { data, error } = await supabaseAdmin
      .from("purchase_orders")
      .update({ ...fields, updated_by: userId, updated_at: nowUTC() })
      .eq("id", id).select(WITH_USERS).single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    const changedFields = {};
    Object.keys(fields).forEach(k => {
      if (String(before[k] ?? "") !== String(fields[k] ?? "")) changedFields[k] = { from: before[k], to: fields[k] };
    });
    logPO(id, "edited", userId, { remark: JSON.stringify(changedFields) });

    return res.json({ success: true, po: withTrackingActive(data) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/pos/:id ─────────────────────────────────────────────
export const deletePO = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;

    const { data: po, error: poErr } = await supabaseAdmin.from("purchase_orders").select("*").eq("id", id).single();
    if (poErr || !po) return res.status(404).json({ success: false, message: "PO not found" });

    const { data: items } = await supabaseAdmin.from("po_items").select("*").eq("po_id", id);
    const { data: history } = await supabaseAdmin.from("po_logs").select("*").eq("po_id", id).order("changed_at", { ascending: true });

    const { error: auditErr } = await supabaseAdmin
      .from("po_deletion_logs")
      .insert([{ po_id: id, deleted_by: userId, snapshot: { po, items: items || [], history: history || [] } }]);
    if (auditErr) return res.status(500).json({ success: false, message: "Failed to log deletion, aborted: " + auditErr.message });

    const { error: delErr } = await supabaseAdmin.from("purchase_orders").delete().eq("id", id);
    if (delErr) return res.status(400).json({ success: false, message: delErr.message });

    return res.json({ success: true, message: "PO permanently deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/pos/:id/revert-last ────────────────────────────────────
export const revertLastAction = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;

    const { data: lastLog, error: logErr } = await supabaseAdmin
      .from("po_logs").select("*").eq("po_id", id).is("reverted_at", null).not("snapshot", "is", null)
      .order("changed_at", { ascending: false }).limit(1).maybeSingle();
    if (logErr) return res.status(400).json({ success: false, message: logErr.message });
    if (!lastLog) return res.status(400).json({ success: false, message: "Nothing to revert" });

    const snap = lastLog.snapshot || {};
    const poSnap = snap.po || {};
    const itemSnap = snap.item || null;

    if (itemSnap) {
      await supabaseAdmin.from("po_items")
        .update({ delivered_qty: itemSnap.delivered_qty, status: itemSnap.status, updated_at: nowUTC() })
        .eq("id", itemSnap.id);
    }

    // Recompute rollups from items after the revert, so PO-level numbers
    // stay consistent even though poSnap only carries a few top fields.
    const { data: allItems } = await supabaseAdmin.from("po_items").select("*").eq("po_id", id);
    const { rollup } = deriveFromItems(allItems || []);

    const { data, error } = await supabaseAdmin
      .from("purchase_orders")
      .update({
        ...poSnap,
        total_order_qty: rollup.total_order_qty,
        total_delivered_qty: rollup.total_delivered_qty,
        total_amount: rollup.total_amount,
        delivered_amount: rollup.delivered_amount,
        updated_by: userId, updated_at: nowUTC(),
      })
      .eq("id", id).is("deleted_at", null).select(WITH_USERS).single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    await supabaseAdmin.from("po_logs").update({ reverted_at: nowUTC(), reverted_by: userId }).eq("id", lastLog.id);
    logPO(id, "reverted", userId, { remark: `Reverted "${lastLog.action.replace(/_/g, " ")}" logged ${new Date(lastLog.changed_at).toLocaleString("en-IN")}` });

    return res.json({ success: true, po: withTrackingActive(data) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};