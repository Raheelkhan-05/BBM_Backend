// services/userDigestReport.service.js
//
// Daily per-user "Start of Day" digest — one email per active user listing
// every open task assigned to them (Leads without an enquiry yet, then
// Enquiries with sample/quotation status, then Repeat Order follow-ups),
// ordered overdue → due today → upcoming. Bill Dues and PO Dues aren't
// owned by a single user, so those go in a separate admin digest to
// info@bbmpvtltd.com and account@bbmpvtltd.com.
//
// Everything here is computed fresh from the live tables on every run —
// there's no snapshot/incremental state (unlike pendingTasks.service.js),
// so re-running it any time of day always reflects the current DB state,
// and the daily cron trigger is all that's needed to keep it "refreshed".

import { createClient } from "@supabase/supabase-js";
import { REJECTED_STAGE } from "../constants/stages.js";
import { fmtINR } from "./dailyReport.service.js";
import { sendMailWithRetry } from "../config/mailer.js";

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const PAGE_SIZE = 1000;

// ── ASSUMPTION 1 ─────────────────────────────────────────────────────
// leads.status is free text with no CHECK constraint (unlike rfqs, which
// has a proper is_dead boolean). Until RK confirms the real "dead" marker
// for prospect-stage leads, treat any status containing "dead" as dead.
function isDeadLead(lead) {
  return !!lead.status && /dead/i.test(lead.status);
}

// ── ASSUMPTION 2 ─────────────────────────────────────────────────────
// purchase_orders.status has no CHECK constraint in the schema. Treating
// anything other than these as still-open/needing follow-up.
const PO_CLOSED_STATUSES = new Set(["completed", "received", "closed", "delivered"]);
function isPoOpen(po) {
  return !PO_CLOSED_STATUSES.has((po.status || "").toLowerCase());
}

// Repeat order customers with status 'order_placed' are locked (a second
// order can't be logged for the same company until the record is
// reopened — see repeatOrderLifecycle.service.js) and 'not_interested' is
// a closed state, same idea as a dead lead/enquiry. Neither needs a
// follow-up chase, so both are excluded from this digest entirely.
const CLOSED_REPEAT_ORDER_STATUSES = new Set(["order_placed", "not_interested","unassigned"]);

// Mirrors CLOSED_STATUSES in pendingTasks.service.js
const CLOSED_STAGE_VALUES = new Set(["Approved", REJECTED_STAGE]);
function isTerminalStage(status) {
  return !!status && CLOSED_STAGE_VALUES.has(status);
}

function todayISTDateStr() {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
// For timestamptz columns (repeat_order_customers.next_followup_at /
// reopen_at) — converts to a plain YYYY-MM-DD IST calendar-date string so
// it can be compared/sorted exactly like the `date`-typed due columns
// elsewhere (bills.next_followup_date, leads.next_action_date, etc).
function dateOnlyIST(iso) {
  if (!iso) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(iso));
}
function fmtDateShort(dateStr) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.slice(0, 10).split("-");
  return `${d}-${m}-${y}`;
}
function userLabel(u) {
  if (!u) return null;
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ").trim();
  return name || u.email || null;
}

// Due-date strings are all "YYYY-MM-DD", so plain lexical comparison
// already gives correct chronological ordering.
function dueBucket(dateStr, today) {
  if (!dateStr) return "No Date";
  if (dateStr < today) return "Overdue";
  if (dateStr === today) return "Due Today";
  return "Upcoming";
}
function sortByDueDateAsc(rows, dateKey) {
  return [...rows].sort((a, b) => {
    const da = a[dateKey], db = b[dateKey];
    if (da && db) return da.localeCompare(db);
    if (da && !db) return -1;
    if (!da && db) return 1;
    return 0;
  });
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

// ══════════════════════════════════════════════════════════════════════
// 1. LEADS — no enquiry yet, user-owned via leads.created_by
// ══════════════════════════════════════════════════════════════════════
export async function buildLeadTasksByUser() {
  const [leads, rfqs] = await Promise.all([
    fetchAllPagedSimple(
      "leads",
      "id, company_name, city, state, status, primary_contact_name, primary_designation, primary_phone, primary_email, " +
        "secondary_contact_name, secondary_phone, secondary_email, next_action, next_action_date, feedback, " +
        "created_by, deleted_at"
    ),
    fetchAllPagedSimple("rfqs", "lead_id, deleted_at"),
  ]);

  const leadIdsWithRfq = new Set(rfqs.filter((r) => !r.deleted_at).map((r) => r.lead_id));
  const openLeads = leads.filter((l) => !l.deleted_at && !isDeadLead(l) && !leadIdsWithRfq.has(l.id));

  const byUser = new Map();
  openLeads.forEach((l) => {
    if (!l.created_by) return;
    const task = {
      leadId: l.id,
      company: l.company_name || "Unknown company",
      location: [l.city, l.state].filter(Boolean).join(", ") || "—",
      contactName: l.primary_contact_name || l.secondary_contact_name || "—",
      contactDesignation: l.primary_designation || "—",
      contactPhone: l.primary_phone || l.secondary_phone || "—",
      contactEmail: l.primary_email || l.secondary_email || "—",
      status: l.status || "—",
      nextAction: l.next_action || "—",
      remark: l.feedback || "—",
      dueDateRaw: l.next_action_date || null,
      dueDateFmt: fmtDateShort(l.next_action_date) || "Not scheduled",
      bucket: dueBucket(l.next_action_date, todayISTDateStr()),
    };
    if (!byUser.has(l.created_by)) byUser.set(l.created_by, []);
    byUser.get(l.created_by).push(task);
  });

  byUser.forEach((tasks, userId) => byUser.set(userId, sortByDueDateAsc(tasks, "dueDateRaw")));
  return byUser;
}

// ══════════════════════════════════════════════════════════════════════
// 2. ENQUIRIES — sample/quotation status, user-owned via rfqs.created_by.
//    Also covers "plain" enquiries (neither sample nor quotation required)
//    via their latest rfq_followups entry, so an enquiry with only a
//    plain follow-up scheduled doesn't silently disappear from the digest.
// ══════════════════════════════════════════════════════════════════════
export async function buildEnquiryTasksByUser() {
  const today = todayISTDateStr();

  const [rfqs, samples, quotations, followups] = await Promise.all([
    fetchAllPagedSimple(
      "rfqs",
      "id, lead_id, company_name, product_name, product_category, product_sub_category, " +
        "sample_required, quotation_required, created_by, is_dead, deleted_at"
    ),
    fetchAllPagedSimple("samples", "id, rfq_id, sample_status, follow_up_date, follow_up_time, notes, deleted_at"),
    fetchAllPagedSimple("quotations", "id, rfq_id, quotation_status, follow_up_date, follow_up_time, notes, deleted_at"),
    fetchAllPagedSimple(
      "rfq_followups",
      "id, rfq_id, contact_type, next_action, notes, remark, enquiry_status, followup_date, created_at, deleted_at"
    ),
  ]);

  const sampleByRfq = new Map(samples.filter((s) => !s.deleted_at).map((s) => [s.rfq_id, s]));
  const quotationByRfq = new Map(quotations.filter((q) => !q.deleted_at).map((q) => [q.rfq_id, q]));

  const latestFollowupByRfq = new Map();
  followups.filter((f) => !f.deleted_at).forEach((f) => {
    const existing = latestFollowupByRfq.get(f.rfq_id);
    if (!existing || new Date(f.created_at) > new Date(existing.created_at)) latestFollowupByRfq.set(f.rfq_id, f);
  });

  function productLabel(rfq) {
    const parts = [rfq.product_category, rfq.product_sub_category].filter(Boolean);
    return rfq.product_name ? `${rfq.product_name}${parts.length ? ` (${parts.join(" / ")})` : ""}` : parts.join(" / ") || "—";
  }

  const byUser = new Map();
  rfqs
    .filter((r) => !r.deleted_at && !r.is_dead && r.created_by)
    .forEach((rfq) => {
      const sample = rfq.sample_required ? sampleByRfq.get(rfq.id) : null;
      const quotation = rfq.quotation_required ? quotationByRfq.get(rfq.id) : null;

      // Only counts as "pending" once a follow-up date has actually been
      // scheduled — mirrors the same convention pendingTasks.service.js
      // uses (a required-but-not-yet-touched sample/quotation has no
      // follow_up_date, so there's nothing to notify about yet).
      const sampleDue = sample && sample.follow_up_date && !isTerminalStage(sample.sample_status);
      const quotationDue = quotation && quotation.follow_up_date && !isTerminalStage(quotation.quotation_status);

      let task;
      if (sampleDue || quotationDue) {
        const dueDateRaw = [sampleDue && sample.follow_up_date, quotationDue && quotation.follow_up_date]
          .filter(Boolean).sort()[0];
        task = {
          rfqId: rfq.id,
          isPlain: false,
          company: rfq.company_name || "Unknown company",
          product: productLabel(rfq),
          sampleRequired: !!rfq.sample_required,
          sampleStatus: sample?.sample_status || (rfq.sample_required ? "Not started" : "—"),
          sampleRemark: sample?.notes || "—",
          sampleFollowUp: fmtDateShort(sample?.follow_up_date) || "—",
          quotationRequired: !!rfq.quotation_required,
          quotationStatus: quotation?.quotation_status || (rfq.quotation_required ? "Not started" : "—"),
          quotationRemark: quotation?.notes || "—",
          quotationFollowUp: fmtDateShort(quotation?.follow_up_date) || "—",
          dueDateRaw,
          dueDateFmt: fmtDateShort(dueDateRaw) || "Not scheduled",
          bucket: dueBucket(dueDateRaw, today),
        };
      } else if (!rfq.sample_required && !rfq.quotation_required) {
        // Plain enquiry — only a rfq_followups trail, no sample/quotation.
        const fup = latestFollowupByRfq.get(rfq.id);
        if (!fup || !fup.followup_date) return; // nothing scheduled, nothing to notify
        task = {
          rfqId: rfq.id,
          isPlain: true,
          company: rfq.company_name || "Unknown company",
          product: productLabel(rfq),
          status: fup.enquiry_status || fup.next_action || "—",
          remark: fup.remark || fup.notes || "—",
          dueDateRaw: fup.followup_date,
          dueDateFmt: fmtDateShort(fup.followup_date) || "Not scheduled",
          bucket: dueBucket(fup.followup_date, today),
        };
      } else {
        return; // sample/quotation required but nothing scheduled yet
      }

      if (!byUser.has(rfq.created_by)) byUser.set(rfq.created_by, []);
      byUser.get(rfq.created_by).push(task);
    });

  byUser.forEach((tasks, userId) => byUser.set(userId, sortByDueDateAsc(tasks, "dueDateRaw")));
  return byUser;
}

// ══════════════════════════════════════════════════════════════════════
// 3. BILL DUES — not user-owned → info@ / account@. Respects the
//    collection_active_manual / snoozed_until pause mechanism, same as
//    withCollectionActive on the collections/billing side.
// ══════════════════════════════════════════════════════════════════════
function isCollectionActive(bill, today) {
  if (bill.collection_active_manual === false) {
    return !!bill.snoozed_until && bill.snoozed_until <= today; // only "wakes up" once snooze expires
  }
  return true; // null or true = active
}

export async function buildBillDuesDigest() {
  const today = todayISTDateStr();

  const [bills, pendingCheques] = await Promise.all([
    fetchAllPagedSimple(
      "bills",
      "id, party_name, bill_no, bill_date, balance_amount, status, location, mobile_1, mobile_2, " +
        "next_followup_date, last_reason, collection_active_manual, snoozed_until, deleted_at"
    ),
    fetchAllPagedSimple("bill_cheques", "bill_id, amount, cheque_no, bank_name, cheque_date, status"),
  ]);

  const chequeByBill = new Map();
  pendingCheques.filter((c) => c.status === "pending").forEach((c) => chequeByBill.set(c.bill_id, c));

  const tasks = bills
    .filter((b) => !b.deleted_at && b.status === "remaining" && isCollectionActive(b, today))
    .map((b) => {
      const cheque = chequeByBill.get(b.id);
      return {
        billId: b.id,
        party: b.party_name,
        billNo: b.bill_no,
        billDateFmt: fmtDateShort(b.bill_date),
        location: b.location || "—",
        mobile: b.mobile_1 || b.mobile_2 || "—",
        balanceFmt: fmtINR(b.balance_amount),
        lastReason: b.last_reason || "—",
        pendingCheque: cheque ? `${fmtINR(cheque.amount)} — ${cheque.bank_name || "—"} (dated ${fmtDateShort(cheque.cheque_date)})` : null,
        dueDateRaw: b.next_followup_date || null,
        dueDateFmt: fmtDateShort(b.next_followup_date) || "Not scheduled",
        bucket: dueBucket(b.next_followup_date, today),
      };
    });

  return sortByDueDateAsc(tasks, "dueDateRaw");
}

// ══════════════════════════════════════════════════════════════════════
// 4. PURCHASE ORDER DUES — not user-owned → info@ / account@. Respects
//    tracking_active_manual / snoozed_until, the PO-side equivalent of
//    the bills collection-active pattern.
// ══════════════════════════════════════════════════════════════════════
function isTrackingActive(po, today) {
  if (po.tracking_active_manual === false) {
    return !!po.snoozed_until && po.snoozed_until <= today;
  }
  return true;
}

export async function buildPurchaseOrderDuesDigest() {
  const today = todayISTDateStr();

  const pos = await fetchAllPagedSimple(
    "purchase_orders",
    "id, order_no, party_name, order_date, expected_delivery_date, status, location, mobile_1, mobile_2, " +
      "total_order_qty, total_delivered_qty, total_amount, delivered_amount, last_remark, last_reason, " +
      "next_followup_date, tracking_active_manual, snoozed_until, deleted_at"
  );

  const tasks = pos
    .filter((p) => !p.deleted_at && isPoOpen(p) && isTrackingActive(p, today))
    .map((p) => {
      const dueDateRaw = p.next_followup_date || p.expected_delivery_date || null;
      const pendingQty = Number(p.total_order_qty || 0) - Number(p.total_delivered_qty || 0);
      const pendingAmount = Number(p.total_amount || 0) - Number(p.delivered_amount || 0);
      return {
        poId: p.id,
        party: p.party_name,
        orderNo: p.order_no,
        orderDateFmt: fmtDateShort(p.order_date),
        expectedDeliveryFmt: fmtDateShort(p.expected_delivery_date),
        status: p.status || "—",
        location: p.location || "—",
        mobile: p.mobile_1 || p.mobile_2 || "—",
        pendingQty,
        pendingAmountFmt: fmtINR(pendingAmount),
        lastRemark: p.last_remark || p.last_reason || "—",
        dueDateRaw,
        dueDateFmt: fmtDateShort(dueDateRaw) || "Not scheduled",
        bucket: dueBucket(dueDateRaw, today),
      };
    });

  return sortByDueDateAsc(tasks, "dueDateRaw");
}

// ══════════════════════════════════════════════════════════════════════
// 5. REPEAT ORDERS — assigned-user owned via assigned_to. Excludes
//    'not_interested' (closed, needs no chase) and 'order_placed' (locked
//    until reopened — see repeatOrderLifecycle.service.js for the reopen
//    flow and the 21-day auto-reopen). Neither state has anything pending
//    for the salesperson to do right now, so both are left out entirely.
// ══════════════════════════════════════════════════════════════════════
export async function buildRepeatOrderTasksByUser() {
  const today = todayISTDateStr();

  const customers = await fetchAllPagedSimple(
    "repeat_order_customers",
    "id, party_name, location, gstin, mobile_1, mobile_2, assigned_to, status, last_remark, last_reason, " +
      "total_lifetime_value, total_bills_count, last_purchase_date, last_sales_man, next_followup_at, deleted_at"
  );

  const byUser = new Map();
  customers
    .filter((c) => !c.deleted_at && c.assigned_to && !CLOSED_REPEAT_ORDER_STATUSES.has(c.status))
    .forEach((c) => {
      const dueDateRaw = dateOnlyIST(c.next_followup_at);
      const task = {
        customerId: c.id,
        party: c.party_name,
        location: c.location || "—",
        gstin: c.gstin || "—",
        mobile: c.mobile_1 || c.mobile_2 || "—",
        status: c.status,
        lastRemark: c.last_remark || c.last_reason || "—",
        lifetimeValueFmt: fmtINR(c.total_lifetime_value),
        billsCount: c.total_bills_count || 0,
        lastPurchaseFmt: fmtDateShort(c.last_purchase_date) || "—",
        lastSalesMan: c.last_sales_man || "—",
        dueDateRaw,
        dueDateFmt: fmtDateShort(dueDateRaw) || "Not scheduled",
        bucket: dueBucket(dueDateRaw, today),
      };
      if (!byUser.has(c.assigned_to)) byUser.set(c.assigned_to, []);
      byUser.get(c.assigned_to).push(task);
    });

  byUser.forEach((tasks, userId) => byUser.set(userId, sortByDueDateAsc(tasks, "dueDateRaw")));
  return byUser;
}

// ══════════════════════════════════════════════════════════════════════
// HTML rendering
// ══════════════════════════════════════════════════════════════════════
const BUCKET_COLORS = { Overdue: "#dc2626", "Due Today": "#d97706", Upcoming: "#16a34a", "No Date": "#64748b" };
function bucketBadge(bucket) {
  const color = BUCKET_COLORS[bucket] || "#64748b";
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;color:#fff;background:${color}">${bucket}</span>`;
}
function sectionHeader(title, count) {
  return `<h2 style="font-family:sans-serif;font-size:16px;color:#1e293b;border-bottom:2px solid #e2e8f0;padding-bottom:6px;margin:28px 0 12px">${title} (${count})</h2>`;
}
function cardWrap(title, bucket, bodyHtml) {
  return `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;margin-bottom:10px;font-family:sans-serif;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
      <strong style="font-size:14px;color:#0f172a;">${title}</strong>${bucketBadge(bucket)}
    </div>
    <div style="font-size:12.5px;color:#475569;line-height:1.6;">${bodyHtml}</div></div>`;
}

function leadTaskCard(t) {
  return cardWrap(t.company, t.bucket,
    `Location: ${t.location} &nbsp;|&nbsp; Status: ${t.status}<br/>
     Contact: ${t.contactName} (${t.contactDesignation}) — ${t.contactPhone} — ${t.contactEmail}<br/>
     Next Action: ${t.nextAction} &nbsp;|&nbsp; Follow-up: ${t.dueDateFmt}<br/>
     Remark: ${t.remark}`);
}
function enquiryTaskCard(t) {
  if (t.isPlain) {
    return cardWrap(t.company, t.bucket,
      `Product: ${t.product} &nbsp;|&nbsp; Follow-up: ${t.dueDateFmt}<br/>
       Status: ${t.status}<br/>
       Remark: ${t.remark}`);
  }
  return cardWrap(t.company, t.bucket,
    `Product: ${t.product} &nbsp;|&nbsp; Follow-up: ${t.dueDateFmt}<br/>
     ${t.sampleRequired ? `Sample: ${t.sampleStatus} — ${t.sampleRemark} (Follow-up: ${t.sampleFollowUp})<br/>` : ""}
     ${t.quotationRequired ? `Quotation: ${t.quotationStatus} — ${t.quotationRemark} (Follow-up: ${t.quotationFollowUp})<br/>` : ""}`);
}
function repeatOrderTaskCard(t) {
  return cardWrap(t.party, t.bucket,
    `Location: ${t.location} &nbsp;|&nbsp; Status: ${t.status} &nbsp;|&nbsp; Follow-up: ${t.dueDateFmt}<br/>
     GSTIN: ${t.gstin} &nbsp;|&nbsp; Mobile: ${t.mobile}<br/>
     Lifetime Value: ${t.lifetimeValueFmt} (${t.billsCount} bills) &nbsp;|&nbsp; Last Purchase: ${t.lastPurchaseFmt} &nbsp;|&nbsp; Last Salesman: ${t.lastSalesMan}<br/>
     Remark: ${t.lastRemark}`);
}
function billTaskCard(t) {
  return cardWrap(`${t.party} (#${t.billNo})`, t.bucket,
    `Bill Date: ${t.billDateFmt} &nbsp;|&nbsp; Balance: ${t.balanceFmt} &nbsp;|&nbsp; Follow-up: ${t.dueDateFmt}<br/>
     Location: ${t.location} &nbsp;|&nbsp; Mobile: ${t.mobile}<br/>
     ${t.pendingCheque ? `Pending Cheque: ${t.pendingCheque}<br/>` : ""}
     Last Remark: ${t.lastReason}`);
}
function poTaskCard(t) {
  return cardWrap(`${t.party} (${t.orderNo})`, t.bucket,
    `Order Date: ${t.orderDateFmt} &nbsp;|&nbsp; Expected Delivery: ${t.expectedDeliveryFmt} &nbsp;|&nbsp; Follow-up: ${t.dueDateFmt}<br/>
     Status: ${t.status} &nbsp;|&nbsp; Pending Qty: ${t.pendingQty} &nbsp;|&nbsp; Pending Amount: ${t.pendingAmountFmt}<br/>
     Location: ${t.location} &nbsp;|&nbsp; Mobile: ${t.mobile}<br/>
     Last Remark: ${t.lastRemark}`);
}

function buildUserDigestHtml(userName, { leadTasks = [], enquiryTasks = [], repeatOrderTasks = [] }) {
  const total = leadTasks.length + enquiryTasks.length + repeatOrderTasks.length;
  let html = `<div style="max-width:640px;margin:0 auto;">
    <p style="font-family:sans-serif;font-size:14px;color:#0f172a;">Good morning ${userName}, here's your pending task list for today (${total} total).</p>`;
  if (leadTasks.length) { html += sectionHeader("Leads — Pending Follow-up", leadTasks.length); html += leadTasks.map(leadTaskCard).join(""); }
  if (enquiryTasks.length) { html += sectionHeader("Enquiries — Sample / Quotation", enquiryTasks.length); html += enquiryTasks.map(enquiryTaskCard).join(""); }
  if (repeatOrderTasks.length) { html += sectionHeader("Repeat Orders — Pending Follow-up", repeatOrderTasks.length); html += repeatOrderTasks.map(repeatOrderTaskCard).join(""); }
  html += `</div>`;
  return html;
}
function buildAdminDigestHtml({ billTasks = [], poTasks = [] }) {
  const total = billTasks.length + poTasks.length;
  let html = `<div style="max-width:640px;margin:0 auto;">
    <p style="font-family:sans-serif;font-size:14px;color:#0f172a;">Today's outstanding Bill &amp; PO dues (${total} total).</p>`;
  if (billTasks.length) { html += sectionHeader("Bill Dues", billTasks.length); html += billTasks.map(billTaskCard).join(""); }
  if (poTasks.length) { html += sectionHeader("Purchase Order Dues", poTasks.length); html += poTasks.map(poTaskCard).join(""); }
  html += `</div>`;
  return html;
}

// ══════════════════════════════════════════════════════════════════════
// Orchestration — call this from the daily cron endpoint
// ══════════════════════════════════════════════════════════════════════
export async function sendDailyUserDigests() {
  const { data: activeUsers, error } = await supabaseAdmin
    .from("users").select("id, email, first_name, last_name").eq("is_active", true);
  if (error) throw new Error(`users: ${error.message}`);

  const [leadsByUser, enquiriesByUser, repeatOrdersByUser] = await Promise.all([
    buildLeadTasksByUser(),
    buildEnquiryTasksByUser(),
    buildRepeatOrderTasksByUser(),
  ]);

  const results = [];
  for (const u of activeUsers) {
    const leadTasks = leadsByUser.get(u.id) || [];
    const enquiryTasks = enquiriesByUser.get(u.id) || [];
    const repeatOrderTasks = repeatOrdersByUser.get(u.id) || [];
    if (!leadTasks.length && !enquiryTasks.length && !repeatOrderTasks.length) continue;

    const html = buildUserDigestHtml(userLabel(u) || u.email, { leadTasks, enquiryTasks, repeatOrderTasks });
    const result = await sendMailWithRetry({
      to: u.email,
      subject: `[BBM] Your Pending Tasks — ${fmtDateShort(todayISTDateStr())}`,
      html,
    });
    results.push({ userId: u.id, email: u.email, success: result.success });
  }

  const [billTasks, poTasks] = await Promise.all([buildBillDuesDigest(), buildPurchaseOrderDuesDigest()]);
  if (billTasks.length || poTasks.length) {
    const adminResult = await sendMailWithRetry({
      to: ["info@bbmpvtltd.com", "account@bbmpvtltd.com", "communication@bbmpvtltd.com"],
      subject: `[BBM] Bill & PO Dues — ${fmtDateShort(todayISTDateStr())}`,
      html: buildAdminDigestHtml({ billTasks, poTasks }),
    });
    results.push({ admin: true, success: adminResult.success });
  }

  return results;
}