// controllers/bills.controller.js
import { createClient } from "@supabase/supabase-js";
import * as XLSX from "xlsx";

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const nowUTC = () => new Date().toISOString();

const WITH_USERS =
  "*, creator:users!bills_created_by_fkey(id, email, first_name, last_name), " +
  "updater:users!bills_updated_by_fkey(id, email, first_name, last_name)";

function logBill(billId, action, changedBy, extra = {}) {
  supabaseAdmin
    .from("bill_logs")
    .insert([{ bill_id: billId, action, changed_by: changedBy, changed_at: nowUTC(), ...extra }])
    .then(({ error }) => { if (error) console.error("bill_logs write error:", error.message); });
}

// Scans the raw sheet for the row that actually contains our known headers
// (handles exports with letterhead/title rows above the real header, like
// the "Sales Register (With GST & Expense)" format).
function findHeaderRowIndex(rawRows) {
  for (let i = 0; i < Math.min(rawRows.length, 30); i++) {
    const row = rawRows[i] || [];
    const normalized = row.map(c => normalizeKey(c));
    const hits = normalized.filter(nk => KEY_MAP[nk]).length;
    if (hits >= 2) return i; // at least 2 recognizable columns = real header row
  }
  return 0; // fallback: assume row 1 is the header, as before
}

/* ── Excel column mapping ──────────────────────────────────────
   Expected headers (case/space tolerant):
   Party Name | Bill No | Bill Date | Due Days | Bill Amount |
   Balance Amt. (Cumulative) | Mobile-1 | Mobile-2
*/
function normalizeKey(k) {
  return String(k || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const KEY_MAP = {
  partyname: "party_name",
  billno: "bill_no",
  billdate: "bill_date",
  duedays: "due_days",
  billamount: "bill_amount",
  balanceamtcumulative: "balance_amount",
  balanceamt: "balance_amount",
  balanceamount: "balance_amount",
  mobile1: "mobile_1",
  mobile2: "mobile_2",
  location: "location",
  cityname: "location", // Sales Register export uses "City Name" — map it to location
  partygstinno: "party_gstin",
  cd: "cd_type",
};

// Converts an Excel serial date number to YYYY-MM-DD without relying on
// XLSX.SSF (which can be undefined at runtime depending on how the "xlsx"
// package is imported/bundled — SSF is not reliably exposed as a named export).
function excelSerialToISO(serial) {
  // Excel's epoch is 1899-12-30 (accounts for Excel's leap-year bug for 1900)
  const excelEpoch = Date.UTC(1899, 11, 30);
  const ms = excelEpoch + Math.round(serial) * 86400000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

function excelDateToISO(val) {
  if (val == null || val === "") return null;
  if (typeof val === "number") {
    if (!isFinite(val) || val <= 0) return null;
    return excelSerialToISO(val);
  }
  const s = String(val).trim();
  // try dd/mm/yyyy or dd-mm-yyyy
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = "20" + y;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const parsed = new Date(s);
  if (!isNaN(parsed)) return parsed.toISOString().slice(0, 10);
  return null;
}


function parseRow(row) {
  const mapped = {};
  for (const rawKey of Object.keys(row)) {
    const nk = normalizeKey(rawKey);
    const target = KEY_MAP[nk];
    if (target) mapped[target] = row[rawKey];
  }
  if (!mapped.party_name || !mapped.bill_no) return null;

  const billAmount = Number(mapped.bill_amount) || 0;

  return {
    party_name: String(mapped.party_name).trim(),
    bill_no: String(mapped.bill_no).trim(),
    bill_date: excelDateToISO(mapped.bill_date),
    bill_amount: billAmount,
    // No "Balance Amt" column in the Sales Register export — treat the
    // whole bill amount as outstanding on first import.
    balance_amount: mapped.balance_amount !== undefined
      ? (Number(mapped.balance_amount) || 0)
      : billAmount,
    location: mapped.location ? String(mapped.location).trim() : null,
    mobile_1: mapped.mobile_1 ? String(mapped.mobile_1).replace(/\D/g, "") : null,
    mobile_2: mapped.mobile_2 ? String(mapped.mobile_2).replace(/\D/g, "") : null,
  };
}

// ── POST /api/bills/upload (multipart, field name "file") ──────
export const uploadBills = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });
    const { id: userId } = req.user;

    const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];

    // First pass: raw array-of-arrays so we can locate the real header row
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
    const headerRowIndex = findHeaderRowIndex(rawRows);

    // Second pass: parse as objects using the detected header row
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", range: headerRowIndex });

    const parsed = [];
    const skipped = [];
    rows.forEach((r, i) => {
      const p = parseRow(r);
      if (!p || !p.bill_date) skipped.push(i + headerRowIndex + 2); // real excel row number incl. skipped header rows
      else parsed.push(p);
    });

    if (parsed.length === 0) {
      return res.status(400).json({ success: false, message: "No valid rows found. Check column headers." });
    }

    // Existing bill numbers are left completely untouched — re-uploading
    // only ever adds brand-new bills, never edits or overwrites one that's
    // already in the system (status, balance, follow-up history, etc. stay as-is).
    const results = { inserted: 0, skippedExisting: 0 };

    for (const bill of parsed) {
      const { data: existing } = await supabaseAdmin
        .from("bills")
        .select("id")
        .eq("bill_no", bill.bill_no)
        .is("deleted_at", null)
        .maybeSingle();

      if (existing) {
        results.skippedExisting++;
        continue;
      }

      const { data: created, error } = await supabaseAdmin
        .from("bills")
        .insert([{ ...bill, status: "remaining", created_by: userId, updated_by: userId }])
        .select("id")
        .single();
      if (!error && created) {
        results.inserted++;
        logBill(created.id, "uploaded", userId, { remark: "Created via Excel upload" });
      }
    }

    return res.json({
      success: true,
      message: `Imported ${results.inserted} new bill(s). Already ${results.skippedExisting} existing bill(s) in system.`,
      skippedRows: skipped,
      ...results,
    });
  } catch (err) {
    console.error("uploadBills error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/bills ──────────────────────────────────────────────
export const getBills = async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from("bills")
      .select(WITH_USERS)
      .is("deleted_at", null)
      .order("bill_date", { ascending: true });
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, bills: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/bills/:id/logs ──────────────────────────────────────
export const getBillLogs = async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from("bill_logs")
      .select("*, user:users!bill_logs_changed_by_fkey(id, email, first_name, last_name)")
      .eq("bill_id", id)
      .order("changed_at", { ascending: false });
    if (error) return res.status(400).json({ success: false, message: error.message });
    return res.json({ success: true, logs: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/bills/:id/followup ──────────────────────────────────
// Body: { remark, reason, next_followup_date }
export const addFollowup = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;
    const { remark, reason, next_followup_date } = req.body;

    if (!reason?.trim()) return res.status(400).json({ success: false, message: "Reason is required" });

    const { data, error } = await supabaseAdmin
      .from("bills")
      .update({
        last_remark: remark || null,
        last_reason: reason,
        next_followup_date: next_followup_date || null,
        updated_by: userId,
        updated_at: nowUTC(),
      })
      .eq("id", id)
      .is("deleted_at", null)
      .select(WITH_USERS)
      .single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    logBill(id, "followup", userId, { remark, reason, next_followup_date: next_followup_date || null });
    return res.json({ success: true, bill: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/bills/:id/payment ────────────────────────────────────
// Body: { amount, remark }
// controllers/bills.controller.js — replace collectPayment

export const collectPayment = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;
    const amount = Number(req.body.amount);
    const remark = req.body.remark || null;
    const nextFollowup = req.body.next_followup_date || null;

    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: "Enter a valid amount" });

    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from("bills")
      .select("balance_amount, payment_collected")
      .eq("id", id)
      .is("deleted_at", null)
      .single();
    if (fetchErr) return res.status(404).json({ success: false, message: "Bill not found" });

    if (amount > Number(existing.balance_amount)) {
      return res.status(400).json({ success: false, message: "Amount exceeds balance" });
    }

    const newBalance = Math.max(0, Number(existing.balance_amount) - amount);
    const newCollected = Number(existing.payment_collected || 0) + amount;
    const newStatus = newBalance <= 0 ? "completed" : "remaining";

    // Partial payment (balance remains) requires a next follow-up date —
    // enforced server-side, not just in the UI.
    if (newStatus === "remaining" && !nextFollowup) {
      return res.status(400).json({ success: false, message: "Next follow-up date is required for partial payments" });
    }

    const { data, error } = await supabaseAdmin
      .from("bills")
      .update({
        balance_amount: newBalance,
        payment_collected: newCollected,
        status: newStatus,
        next_followup_date: newStatus === "completed" ? null : nextFollowup,
        updated_by: userId,
        updated_at: nowUTC(),
      })
      .eq("id", id)
      .select(WITH_USERS)
      .single();

    if (error) return res.status(400).json({ success: false, message: error.message });

    logBill(id, "payment_collected", userId, {
      remark,
      payment_collected: amount,
      balance_after: newBalance,
      status: newStatus,
      next_followup_date: newStatus === "remaining" ? nextFollowup : null,
    });

    return res.json({ success: true, bill: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};


function extractBillFields(body) {
  const {
    party_name, bill_no, bill_date,
    bill_amount, balance_amount, location, mobile_1, mobile_2,
  } = body;
  return {
    party_name: (party_name || "").trim(),
    bill_no: (bill_no || "").trim(),
    bill_date: bill_date || null,
    bill_amount: Number(bill_amount) || 0,
    balance_amount: balance_amount !== undefined && balance_amount !== ""
      ? Number(balance_amount)
      : Number(bill_amount) || 0,
    location: location && String(location).trim() ? String(location).trim() : null,
    mobile_1: mobile_1 ? String(mobile_1).replace(/\D/g, "") : null,
    mobile_2: mobile_2 ? String(mobile_2).replace(/\D/g, "") : null,
  };
}

// ── POST /api/bills ──────────────────────────────────────────────
export const createBill = async (req, res) => {
  try {
    const { id: userId } = req.user;
    const fields = extractBillFields(req.body);

    if (!fields.party_name) return res.status(400).json({ success: false, message: "Party name is required" });
    if (!fields.bill_no)    return res.status(400).json({ success: false, message: "Bill No is required" });
    if (!fields.bill_date)  return res.status(400).json({ success: false, message: "Bill Date is required" });

    // Prevent accidental duplicate bill numbers among active (non-deleted) bills
    const { data: dupe } = await supabaseAdmin
      .from("bills")
      .select("id")
      .eq("bill_no", fields.bill_no)
      .is("deleted_at", null)
      .maybeSingle();
    if (dupe) return res.status(409).json({ success: false, message: `Bill No "${fields.bill_no}" already exists` });

    const { data, error } = await supabaseAdmin
      .from("bills")
      .insert([{ ...fields, status: "remaining", created_by: userId, updated_by: userId }])
      .select(WITH_USERS)
      .single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    logBill(data.id, "created", userId, { remark: "Added manually" });
    return res.status(201).json({ success: true, bill: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── PUT /api/bills/:id ────────────────────────────────────────────
// Full edit of a bill's core fields. Logs an "edited" entry with before/after.
export const updateBill = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;
    const fields = extractBillFields(req.body);

    if (!fields.party_name) return res.status(400).json({ success: false, message: "Party name is required" });
    if (!fields.bill_no)    return res.status(400).json({ success: false, message: "Bill No is required" });
    if (!fields.bill_date)  return res.status(400).json({ success: false, message: "Bill Date is required" });

    const { data: before, error: fetchErr } = await supabaseAdmin
      .from("bills")
      .select("*")
      .eq("id", id)
      .is("deleted_at", null)
      .single();
    if (fetchErr) return res.status(404).json({ success: false, message: "Bill not found" });

    // Bill No uniqueness check (excluding this record)
    const { data: dupe } = await supabaseAdmin
      .from("bills")
      .select("id")
      .eq("bill_no", fields.bill_no)
      .neq("id", id)
      .is("deleted_at", null)
      .maybeSingle();
    if (dupe) return res.status(409).json({ success: false, message: `Bill No "${fields.bill_no}" already exists` });

    const { data, error } = await supabaseAdmin
      .from("bills")
      .update({ ...fields, updated_by: userId, updated_at: nowUTC() })
      .eq("id", id)
      .select(WITH_USERS)
      .single();
    if (error) return res.status(400).json({ success: false, message: error.message });

    // Track exactly what changed, not just that "something" changed
    const changedFields = {};
    Object.keys(fields).forEach(k => {
      if (String(before[k] ?? "") !== String(fields[k] ?? "")) {
        changedFields[k] = { from: before[k], to: fields[k] };
      }
    });

    logBill(id, "edited", userId, { remark: JSON.stringify(changedFields) });
    return res.json({ success: true, bill: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ── DELETE /api/bills/:id ───────────────────────────────────────────
// Permanent hard delete. Before removing, snapshots the bill + its full
// follow-up/payment history into bill_deletion_logs (a table with no FK
// to bills, so it survives the cascade). bill_logs rows are cascade-deleted
// along with the bill itself — that's intentional, this is a *complete*
// permanent delete, not a soft one. The snapshot is what "properly logged"
// deletion means here.
export const deleteBill = async (req, res) => {
  try {
    const { id } = req.params;
    const { id: userId } = req.user;

    const { data: bill, error: billErr } = await supabaseAdmin
      .from("bills")
      .select("*")
      .eq("id", id)
      .single();
    if (billErr || !bill) return res.status(404).json({ success: false, message: "Bill not found" });

    const { data: history } = await supabaseAdmin
      .from("bill_logs")
      .select("*")
      .eq("bill_id", id)
      .order("changed_at", { ascending: true });

    const { error: auditErr } = await supabaseAdmin
      .from("bill_deletion_logs")
      .insert([{
        bill_id: id,
        deleted_by: userId,
        snapshot: { bill, history: history || [] },
      }]);
    if (auditErr) {
      // Don't proceed with a permanent delete if we failed to record the audit trail
      return res.status(500).json({ success: false, message: "Failed to log deletion, aborted: " + auditErr.message });
    }

    const { error: delErr } = await supabaseAdmin.from("bills").delete().eq("id", id);
    if (delErr) return res.status(400).json({ success: false, message: delErr.message });

    return res.json({ success: true, message: "Bill permanently deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};