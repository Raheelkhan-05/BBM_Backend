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
// (handles exports with letterhead/title rows above the real header).
function findHeaderRowIndex(rawRows) {
  for (let i = 0; i < Math.min(rawRows.length, 30); i++) {
    const row = rawRows[i] || [];
    const normalized = row.map(c => normalizeKey(c));
    const hits = normalized.filter(nk => KEY_MAP[nk]).length;
    if (hits >= 2) return i;
  }
  return 0;
}

function normalizeKey(k) {
  return String(k || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* ── Column mapping for the "New Sales Dump" format ─────────────────────
   New export columns:
   Bill Date | Bill No | C/D | Party Name | City Name | Party GSTIN No |
   Mobile-1 | Mobile-2 | Discount Amount | P & F Charges Amount |
   Freight Amount | Assessable Amount | GST columns... |
   Product Name | Product Group Name | Product Category Name | Sales Man |
   Bill Amount

   KEY DIFFERENCE from old format:
   - Mobile-1 and Mobile-2 are now present in this export (were absent before)
   - One row per product line item per bill — Bill Amount is the total bill
     value repeated on every line. We deduplicate by Bill No (first row wins).
   - No "Balance Amt" column — balance_amount starts equal to bill_amount.

   Legacy column names are kept so old-format files still work.
*/
const KEY_MAP = {
  // New format columns
  partyname:            "party_name",
  billno:               "bill_no",
  billdate:             "bill_date",
  billamount:           "bill_amount",
  cityname:             "location",
  mobile1:              "mobile_1",
  mobile2:              "mobile_2",
  partygstinno:         "party_gstin",
  cd:                   "cd_type",
  // Legacy / old-format columns (kept for backward compatibility)
  location:             "location",
  duedays:              "due_days",
  balanceamtcumulative: "balance_amount",
  balanceamt:           "balance_amount",
  balanceamount:        "balance_amount",
};

function excelSerialToISO(serial) {
  // Excel epoch is 1899-12-30 (accounts for Excel's leap-year bug)
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

  // Primary path (raw: true + cellDates: true): XLSX gives us a JS Date object.
  // getUTC* is correct here — XLSX sets the time portion to midnight UTC so
  // local-timezone offsets won't shift the date by a day.
  if (val instanceof Date) {
    if (isNaN(val)) return null;
    const y  = val.getUTCFullYear();
    const mm = String(val.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(val.getUTCDate()).padStart(2, "0");
    return `${y}-${mm}-${dd}`;
  }

  // Fallback: raw numeric Excel serial (e.g. 46114).
  // Only reached if cellDates was somehow not applied to this cell.
  if (typeof val === "number") {
    if (!isFinite(val) || val <= 0) return null;
    return excelSerialToISO(val);
  }

  // String fallback for manually-typed dates stored as text in Excel.
  // We only accept unambiguous ISO format (YYYY-MM-DD) to avoid
  // DD/MM vs MM/DD ambiguity that caused the "2026-14-04" bug.
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

  if (!mapped.party_name || !mapped.bill_no) return null;

  const billAmount = Number(mapped.bill_amount) || 0;

  return {
    party_name:     String(mapped.party_name).trim(),
    bill_no:        String(mapped.bill_no).trim(),
    bill_date:      excelDateToISO(mapped.bill_date),
    bill_amount:    billAmount,
    // New format has no Balance Amt column — full bill is outstanding on import.
    // Old format's balance_amount is preserved when the column exists.
    balance_amount: mapped.balance_amount !== undefined
      ? (Number(mapped.balance_amount) || 0)
      : billAmount,
    location: mapped.location ? String(mapped.location).trim() : null,
    // Trim to 15 chars to handle spaced phone numbers like "99989 70939"
    mobile_1: mapped.mobile_1 ? String(mapped.mobile_1).replace(/\D/g, "").slice(0, 15) : null,
    mobile_2: mapped.mobile_2 ? String(mapped.mobile_2).replace(/\D/g, "").slice(0, 15) : null,
  };
}

// ── POST /api/bills/upload (multipart, field name "file") ──────────────
export const uploadBills = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });
    const { id: userId } = req.user;

    // cellDates: true  — date serial numbers become JS Date objects instead of numbers.
    // raw: true (on sheet_to_json) — keeps those Date objects as-is.
    //   ⚠️  raw: false would make XLSX format dates into locale strings like
    //   "04/14/2026" (MM/DD/YYYY), which our regex would misread as DD/MM/YYYY
    //   and produce an invalid "2026-14-04". Always use raw: true for the data
    //   pass; only the header-detection pass needs raw: false so header text
    //   comes back as readable strings.
    const wb = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];

    // First pass: raw: false so header cell text is readable for KEY_MAP matching
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false });
    const headerRowIndex = findHeaderRowIndex(rawRows);

    // Second pass: raw: true so date cells are JS Date objects, not formatted strings
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", range: headerRowIndex, raw: true });

    // ── Deduplication ──────────────────────────────────────────────────
    // The new Sales Dump format has ONE ROW PER PRODUCT LINE ITEM per bill.
    // E.g. a bill with 3 products appears as 3 rows, all with the same
    // Bill No and Bill Amount (the bill total, not a per-product subtotal).
    // We keep only the FIRST row per Bill No and discard the rest.
    const seenBillNos = new Set();
    const parsed = [];
    const skipped = [];

    rows.forEach((r, i) => {
      const p = parseRow(r);
      const excelRowNum = i + headerRowIndex + 2; // 1-based, accounting for header

      if (!p || !p.bill_date) {
        skipped.push(excelRowNum);
        return;
      }

      if (seenBillNos.has(p.bill_no)) {
        // Duplicate line-item row for an already-seen bill — skip silently.
        return;
      }

      seenBillNos.add(p.bill_no);
      parsed.push(p);
    });

    if (parsed.length === 0) {
      return res.status(400).json({ success: false, message: "No valid rows found. Check column headers." });
    }

    // ── Database insert: 2 queries total, regardless of file size ─────────
    //
    // OLD approach: 1 SELECT + 1 INSERT per bill = up to 234 round-trips for
    // a 117-bill file, each one paying full network latency to Supabase.
    //
    // NEW approach:
    //   Query 1 — fetch every existing bill_no in one IN() query  (~5 ms)
    //   Query 2 — batch-insert all new bills in one call           (~10 ms)
    //   + one fire-and-forget INSERT for bill_logs (non-blocking)

    const allBillNos = parsed.map(b => b.bill_no);

    const { data: existingRows } = await supabaseAdmin
      .from("bills")
      .select("bill_no")
      .in("bill_no", allBillNos)
      .is("deleted_at", null);

    const existingSet = new Set((existingRows || []).map(r => r.bill_no));

    const toInsert = parsed
      .filter(b => !existingSet.has(b.bill_no))
      .map(b => ({ ...b, status: "remaining", created_by: userId, updated_by: userId }));

    const results = {
      inserted: 0,
      skippedExisting: existingSet.size,
    };

    if (toInsert.length > 0) {
      const { data: created, error } = await supabaseAdmin
        .from("bills")
        .insert(toInsert)
        .select("id");

      if (error) throw new Error("Batch insert failed: " + error.message);

      results.inserted = created?.length ?? 0;

      // Fire-and-forget: log all inserted bills without blocking the response
      if (created?.length) {
        supabaseAdmin.from("bill_logs").insert(
          created.map(b => ({
            bill_id: b.id,
            action: "uploaded",
            changed_by: userId,
            changed_at: nowUTC(),
            remark: "Created via Excel upload",
          }))
        ).then(({ error: logErr }) => {
          if (logErr) console.error("bill_logs batch write error:", logErr.message);
        });
      }
    }

    return res.json({
      success: true,
      message: `Imported ${results.inserted} new bill(s). ${results.skippedExisting} already existed in system.`,
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
// Body: { amount, remark, next_followup_date }
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

    const newBalance   = Math.max(0, Number(existing.balance_amount) - amount);
    const newCollected = Number(existing.payment_collected || 0) + amount;
    const newStatus    = newBalance <= 0 ? "completed" : "remaining";

    if (newStatus === "remaining" && !nextFollowup) {
      return res.status(400).json({ success: false, message: "Next follow-up date is required for partial payments" });
    }

    const { data, error } = await supabaseAdmin
      .from("bills")
      .update({
        balance_amount:     newBalance,
        payment_collected:  newCollected,
        status:             newStatus,
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
      balance_after:     newBalance,
      status:            newStatus,
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
    party_name:     (party_name || "").trim(),
    bill_no:        (bill_no || "").trim(),
    bill_date:      bill_date || null,
    bill_amount:    Number(bill_amount) || 0,
    balance_amount: balance_amount !== undefined && balance_amount !== ""
      ? Number(balance_amount)
      : Number(bill_amount) || 0,
    location:  location && String(location).trim() ? String(location).trim() : null,
    mobile_1:  mobile_1 ? String(mobile_1).replace(/\D/g, "") : null,
    mobile_2:  mobile_2 ? String(mobile_2).replace(/\D/g, "") : null,
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
        bill_id:    id,
        deleted_by: userId,
        snapshot:   { bill, history: history || [] },
      }]);
    if (auditErr) {
      return res.status(500).json({ success: false, message: "Failed to log deletion, aborted: " + auditErr.message });
    }

    const { error: delErr } = await supabaseAdmin.from("bills").delete().eq("id", id);
    if (delErr) return res.status(400).json({ success: false, message: delErr.message });

    return res.json({ success: true, message: "Bill permanently deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};