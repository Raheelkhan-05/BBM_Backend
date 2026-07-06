// services/pdfReport.builder.js
//
// Requires: npm install pdfkit --save
//
// Layout:
//   1. Cover page
//   2. Table of Contents — clickable jump-links to every major section and
//      every employee/person sub-section, with page numbers printed
//      alongside as a plain-text fallback.
//   3. Lifetime Contribution Summary
//   4. No Activity Today
//   5. Today's Detailed Activity Log — one sub-section per employee
//   6. Lifetime Activity Log — one sub-section per employee
//   7. Status Updates — Prospect / Enquiry / Sample / Quotation logs,
//      each grouped by employee, plus a Current Status Snapshot table
//   7.5 Payment (Bill Dues) — overview stats, lifetime per-employee
//      summary, today's bill activity per employee, and an outstanding
//      bills snapshot table.
//   8. Company Index — every company name that appears anywhere in the
//      report, alphabetized, with links to every place it shows up
//      across different people and sections.
//
// ── Navigation ─────────────────────────────────────────────────────────
// Real PDF bookmarks (the sidebar panel in Acrobat/Preview/Chrome's PDF
// viewer/etc.) via doc.outline — this is the most reliable, well-tested
// native navigation PDFKit supports, and is the primary way to jump
// around this document.
//
// The Table of Contents and Company Index pages ALSO have clickable
// in-page links (via doc.addNamedDestination + the `goTo` text option),
// but since this was generated without the ability to render and
// interactively test the PDF, every linked entry also prints its page
// number as plain text right next to it — so navigation works by manual
// lookup even in the unlikely case a particular viewer doesn't honor the
// click target.
//
// ── Text-overlap bug fix ──────────────────────────────────────────────
// The "Today's Detailed Activity Log" summary line was measured with the
// regular Helvetica font but rendered in Helvetica-Bold — bold glyphs are
// wider, so real text wrapped onto more lines than the height budget
// accounted for, and the next block of content started drawing before
// the summary had finished, overlapping it. Same class of bug existed in
// the field-diff line-height estimate (measured as one concatenated
// string; actually rendered as separate label/value columns side by
// side, which wrap independently). Both are fixed below by measuring
// each piece with the exact font/size/width it's actually drawn with.
//
// ── Blank-page bug fix (carried forward) ────────────────────────────────
// Footer stamping is done last, with doc.page.margins.bottom temporarily
// zeroed, so PDFKit's own auto-pagination can't insert stray blank pages
// — see the footer loop at the bottom of this file for the full story.

import PDFDocument from "pdfkit";

const COLORS = {
  dark: "#1e1b4b",
  accent: "#4338ca",
  muted: "#64748b",
  mutedDark: "#475569",
  border: "#e2e8f0",
  text: "#0f172a",
  panel: "#f8fafc",
  removed: "#b91c1c",
  added: "#15803d",
  link: "#2563eb",
};

const TYPE_COLORS = {
  Lead: "#4338ca",
  Prospect: "#6366f1",
  RFQ: "#6d28d9",
  "Follow-up": "#0f766e",
  Sample: "#be123c",
  Quotation: "#15803d",
};

const CHANGE_COLORS = {
  Created: "#15803d",
  Updated: "#2563eb",
  Deleted: "#be123c",
  // Payment (Bill Dues) action types
  Payment: "#0d9488",
  Edited: "#2563eb",
};

const MARGIN = 40;
const BOTTOM_SAFE = 70;

function fmtDate(iso) {
  const d = new Date(iso);
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

// Currency formatter for the Payment (Bill Dues) section.
function fmtINR(n) {
  const num = Number(n) || 0;
  return `Rs. ${num.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Deterministic, PDF-safe destination name from arbitrary label parts.
function destName(...parts) {
  return parts
    .join("_")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .slice(0, 150);
}

export function buildDailyReportPdf(reportData, lifetimeSummary, lifetimeActivityLog = [], statusReport = null, billsReport = null) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true, autoFirstPage: true });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - MARGIN * 2;
    let y = MARGIN;

    // company -> [{ sectionLabel, personLabel, dest, page }]
    // Populated as every section below is drawn; rendered as the Company
    // Index at the very end, once every occurrence is known.
    const companyIndex = new Map();
    function indexCompany(company, sectionLabel, personLabel, dest) {
      if (!company || company === "Unknown company" || company === "Unknown party") return;
      if (!companyIndex.has(company)) companyIndex.set(company, []);
      const list = companyIndex.get(company);
      if (!list.some((e) => e.sectionLabel === sectionLabel && e.personLabel === personLabel)) {
        list.push({ sectionLabel, personLabel, dest, page: doc.bufferedPageRange().count });
      }
    }

    function ensureSpace(height, onNewPage) {
      if (y + height > doc.page.height - BOTTOM_SAFE) {
        doc.addPage();
        y = MARGIN;
        if (onNewPage) onNewPage();
      }
    }

    function measure(text, width, font = "Helvetica", size = 8.5) {
      doc.font(font).fontSize(size);
      return doc.heightOfString(text, { width, fontSize: size });
    }

    // ── Idle-gap highlighting ────────────────────────────────────────
    // If more than 20 minutes elapsed since the previous (chronologically
    // older) record for the same employee, and this record falls within
    // 8:00 AM–6:00 PM IST, the row gets a light red highlight. Outside
    // that window (evenings/nights), no highlight regardless of gap size
    // — a long overnight gap is expected and not worth flagging.
    const IDLE_GAP_MINUTES = 20;
    const BUSINESS_START_HOUR = 8;
    const BUSINESS_END_HOUR = 18; // 6:00 PM, exclusive
    const HIGHLIGHT_COLOR = "#fee2e2"; // light red

    function istHourDecimal(timestamp) {
      const d = new Date(timestamp);
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(d);
      const h = parseInt(parts.find((p) => p.type === "hour").value, 10);
      const m = parseInt(parts.find((p) => p.type === "minute").value, 10);
      return h + m / 60;
    }

    function isWithinBusinessHours(timestamp) {
      const hd = istHourDecimal(timestamp);
      return hd >= BUSINESS_START_HOUR && hd < BUSINESS_END_HOUR;
    }

    // entries[idx] is the current record, entries[idx + 1] is the next
    // OLDER one (since every entries array here is sorted newest-first).
    function hasIdleGapBefore(entries, idx) {
      const current = entries[idx];
      const older = entries[idx + 1];
      if (!older) return false; // oldest record in the list — no prior baseline
      if (!isWithinBusinessHours(current.timestamp)) return false;
      const gapMinutes = Math.abs(new Date(current.timestamp) - new Date(older.timestamp)) / 60000;
      return gapMinutes > IDLE_GAP_MINUTES;
    }

    function darken(hex, amount = 0.22) {
      const n = hex.replace("#", "");
      const r = Math.max(0, Math.round(parseInt(n.slice(0, 2), 16) * (1 - amount)));
      const g = Math.max(0, Math.round(parseInt(n.slice(2, 4), 16) * (1 - amount)));
      const b = Math.max(0, Math.round(parseInt(n.slice(4, 6), 16) * (1 - amount)));
      return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    }

    function drawBadge(x, yTop, width, label, color) {
      const h = 15;
      const edge = darken(color);
      doc.roundedRect(x, yTop, width, h, 3.5).fill(edge);
      doc.roundedRect(x, yTop, width, h - 1, 3.5).fill(color);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.5).text(label.toUpperCase(), x, yTop + 4, {
        width,
        align: "center",
        characterSpacing: 0.3,
      });
    }

    function drawArrow(x, yTop, color = COLORS.mutedDark) {
      const midY = yTop + 6;
      const shaftLen = 9;
      doc.save();
      doc.strokeColor(color).lineWidth(1.2);
      doc.moveTo(x, midY).lineTo(x + shaftLen, midY).stroke();
      doc.moveTo(x + shaftLen - 3, midY - 2.5).lineTo(x + shaftLen + 1, midY).lineTo(x + shaftLen - 3, midY + 2.5).stroke();
      doc.restore();
    }

    function sectionHeader(title, subtitle) {
      ensureSpace(46);
      doc.rect(MARGIN, y, contentWidth, 36).fill(COLORS.dark);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(13).text(title, MARGIN + 12, y + 9);
      if (subtitle) {
        doc.fillColor("#c7d2fe").font("Helvetica").fontSize(8).text(subtitle, MARGIN + 12, y + 9, {
          width: contentWidth - 24,
          align: "right",
        });
      }
      y += 46;
      doc.fillColor(COLORS.text);
    }

    // A clickable line of text jumping to an internal destination, with
    // the page number printed on the right as a manual-lookup fallback.
    function linkLine(text, dest, opts = {}) {
      const font = opts.font || "Helvetica";
      const size = opts.size || 9.5;
      const indent = opts.indent || 0;
      const h = measure(text, contentWidth - indent - 50, font, size);
      ensureSpace(h + 4, opts.onNewPage);
      doc.fillColor(COLORS.link).font(font).fontSize(size).text(text, MARGIN + indent, y, {
        width: contentWidth - indent - 50,
        goTo: dest,
        underline: true,
      });
      y += h + 4;
    }

    // ══════════════════════════════════════════════════════════════
    // 1. COVER
    // ══════════════════════════════════════════════════════════════
    doc.rect(0, 0, pageWidth, 130).fill(COLORS.dark);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(11).text("BRAND BRIGADE MARKETING", MARGIN, 34, {
      characterSpacing: 1.4,
    });
    doc.fontSize(23).text("Daily Activity Report", MARGIN, 56);
    doc.font("Helvetica").fontSize(10.5).fillColor("#c7d2fe").text(
      `Generated ${fmtDate(reportData.generatedAt)}  ·  Includes all records up to the report generation time`,
      MARGIN,
      92
    );
    y = 160;

    const statBoxW = (contentWidth - 24) / 3;
    const stats = [
      { label: "Total actions today", value: String(reportData.totalActions) },
      { label: "Employees active today", value: String(reportData.activeToday.length) },
      { label: "Employees with no activity", value: String(reportData.noActivityToday.length) },
    ];
    stats.forEach((s, i) => {
      const bx = MARGIN + i * (statBoxW + 12);
      doc.roundedRect(bx, y, statBoxW, 58, 6).fillAndStroke(COLORS.panel, COLORS.border);
      doc.fillColor(COLORS.accent).font("Helvetica-Bold").fontSize(20).text(s.value, bx + 14, y + 10);
      doc.fillColor(COLORS.mutedDark).font("Helvetica").fontSize(8.5).text(s.label.toUpperCase(), bx + 14, y + 38, {
        width: statBoxW - 24,
        characterSpacing: 0.3,
      });
    });
    y += 80;

    doc.font("Helvetica").fontSize(9.5).fillColor(COLORS.mutedDark).text(
      "See the Table of Contents on the next page for clickable navigation to any employee's section, " +
        "or jump straight to the Company Index at the end to find every mention of a specific company " +
        "across every person and section.",
      MARGIN,
      y,
      { width: contentWidth }
    );

    doc.outline.addItem("Cover");

    // ══════════════════════════════════════════════════════════════
    // 2. TABLE OF CONTENTS
    // ══════════════════════════════════════════════════════════════
    doc.addPage();
    y = MARGIN;
    sectionHeader("Table of Contents", "Click any line to jump there — page numbers shown for manual lookup too");
    const tocOutline = doc.outline.addItem("Table of Contents");

    function tocSectionTitle(title, dest) {
      ensureSpace(24);
      doc.fillColor(COLORS.text).font("Helvetica-Bold").fontSize(11).text(title, MARGIN, y, {
        width: contentWidth - 50,
        goTo: dest,
        underline: true,
      });
      y += 20;
    }

    tocSectionTitle("Lifetime Contribution Summary", destName("section", "lifetime_summary"));
    if (reportData.noActivityToday.length) {
      tocSectionTitle("No Activity Today", destName("section", "no_activity"));
    }

    tocSectionTitle("Today's Detailed Activity Log", destName("section", "today_root"));
    reportData.activeToday.forEach((emp) => {
      linkLine(`${emp.name}  (${emp.entries.length} action(s))`, destName("today", emp.email), { indent: 16, size: 9 });
    });

    y += 6;
    tocSectionTitle("Lifetime Activity Log", destName("section", "lifetime_activity_root"));
    lifetimeActivityLog.forEach((emp) => {
      linkLine(`${emp.name}  (${emp.entries.length} of ${emp.totalCount})`, destName("lifetime", emp.email), { indent: 16, size: 9 });
    });

    if (statusReport) {
      y += 6;
      tocSectionTitle("Prospect Status Log", destName("section", "prospect_root"));
      statusReport.prospectStatusLog.forEach((g) => {
        linkLine(`${g.name}  (${g.entries.length} update(s))`, destName("prospect", g.name), { indent: 16, size: 9 });
      });

      y += 6;
      tocSectionTitle("Enquiry Status Log", destName("section", "enquiry_root"));
      statusReport.enquiryStatusLog.forEach((g) => {
        linkLine(`${g.name}  (${g.entries.length} update(s))`, destName("enquiry", g.name), { indent: 16, size: 9 });
      });

      y += 6;
      tocSectionTitle("Sample Status Log", destName("section", "sample_root"));
      statusReport.sampleStatusLog.forEach((g) => {
        linkLine(`${g.name}  (${g.entries.length} update(s))`, destName("sample", g.name), { indent: 16, size: 9 });
      });

      y += 6;
      tocSectionTitle("Quotation Status Log", destName("section", "quotation_root"));
      statusReport.quotationStatusLog.forEach((g) => {
        linkLine(`${g.name}  (${g.entries.length} update(s))`, destName("quotation", g.name), { indent: 16, size: 9 });
      });

      y += 6;
      tocSectionTitle("Current Status Snapshot", destName("section", "current_snapshot"));
    }

    if (billsReport) {
      y += 6;
      tocSectionTitle("Payment (Bill Dues) — Overview", destName("section", "bills_overview"));

      y += 6;
      tocSectionTitle("Payment — Lifetime Summary", destName("section", "bills_lifetime"));

      y += 6;
      tocSectionTitle("Payment — Today's Activity", destName("section", "bills_today_root"));
      billsReport.todayActivity.forEach((emp) => {
        linkLine(`${emp.name}  (${emp.entries.length} action(s))`, destName("billstoday", emp.email), { indent: 16, size: 9 });
      });

      y += 6;
      tocSectionTitle("Payment — Outstanding Snapshot", destName("section", "bills_snapshot"));
    }

    y += 6;
    tocSectionTitle("Company Index", destName("section", "company_index"));

    // ══════════════════════════════════════════════════════════════
    // 3. LIFETIME CONTRIBUTION SUMMARY
    // ══════════════════════════════════════════════════════════════
    doc.addPage();
    y = MARGIN;
    doc.addNamedDestination(destName("section", "lifetime_summary"));
    doc.outline.addItem("Lifetime Contribution Summary");
    sectionHeader("Lifetime Contribution Summary", "All-time, distinct live records per employee");

    const cols = [
      { key: "name", label: "Employee", width: contentWidth * 0.26 },
      { key: "Leads", label: "Leads", width: contentWidth * 0.115 },
      { key: "Prospects", label: "Prospects", width: contentWidth * 0.125 },
      { key: "RFQs", label: "RFQs", width: contentWidth * 0.105 },
      { key: "Follow-ups", label: "Follow-ups", width: contentWidth * 0.125 },
      { key: "Samples", label: "Samples", width: contentWidth * 0.115 },
      { key: "Quotations", label: "Quotations", width: contentWidth * 0.125 },
      { key: "total", label: "Total", width: contentWidth * 0.11 },
    ];

    function tableHeaderRow() {
      doc.rect(MARGIN, y, contentWidth, 22).fill(COLORS.accent);
      let cx = MARGIN;
      cols.forEach((c) => {
        doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8.5).text(c.label, cx + 6, y + 6, {
          width: c.width - 10,
          align: c.key === "name" ? "left" : "center",
        });
        cx += c.width;
      });
      y += 22;
    }

    tableHeaderRow();
    lifetimeSummary.forEach((row, idx) => {
      ensureSpace(20, tableHeaderRow);
      if (idx % 2 === 1) doc.rect(MARGIN, y, contentWidth, 18).fill(COLORS.panel);
      let cx = MARGIN;
      cols.forEach((c) => {
        const val = c.key === "name" ? row.name : String(row[c.key] || 0);
        doc.fillColor(COLORS.text).font(c.key === "total" ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).text(
          val,
          cx + 6,
          y + 4,
          { width: c.width - 10, align: c.key === "name" ? "left" : "center" }
        );
        cx += c.width;
      });
      y += 18;
    });

    // ══════════════════════════════════════════════════════════════
    // 4. NO ACTIVITY TODAY
    // ══════════════════════════════════════════════════════════════
    if (reportData.noActivityToday.length) {
      doc.addPage();
      y = MARGIN;
      doc.addNamedDestination(destName("section", "no_activity"));
      doc.outline.addItem("No Activity Today");
      sectionHeader("No Activity Today", `${reportData.noActivityToday.length} employee(s)`);
      reportData.noActivityToday.forEach((emp, idx) => {
        ensureSpace(18);
        if (idx % 2 === 1) doc.rect(MARGIN, y, contentWidth, 16).fill(COLORS.panel);
        doc.fillColor(COLORS.text).font("Helvetica").fontSize(9.5).text(`${emp.name}  (${emp.email})`, MARGIN + 6, y + 3);
        y += 16;
      });
    }

    // ══════════════════════════════════════════════════════════════
    // 5. TODAY'S DETAILED ACTIVITY LOG — full diffs, no field cap
    // ══════════════════════════════════════════════════════════════
    let todayOutlineParent = null;
    reportData.activeToday.forEach((emp) => {
      doc.addPage();
      y = MARGIN;
      const dest = destName("today", emp.email);
      doc.addNamedDestination(dest);
      if (!todayOutlineParent) todayOutlineParent = doc.outline.addItem("Today's Detailed Activity Log");
      todayOutlineParent.addItem(emp.name);
      if (!doc.__todayRootMarked) {
        doc.addNamedDestination(destName("section", "today_root"));
        doc.__todayRootMarked = true;
      }

      sectionHeader(emp.name, `${emp.email}  ·  ${emp.entries.length} action(s) today`);
      doc.fillColor(COLORS.mutedDark).font("Helvetica-Oblique").fontSize(7.5).text(
        "Light red row = 20+ minute gap since the previous action, during business hours (8am–6pm IST)",
        MARGIN,
        y,
        { width: contentWidth }
      );
      y += 14;

      emp.entries.forEach((entry, idx) => {
        indexCompany(entry.company, "Today's Activity", emp.name, dest);

        const summaryText = `${entry.type} — ${entry.company}`;
        // FIX: measure with the SAME font (Helvetica-Bold) and width used
        // for the actual render below — previously measured in regular
        // Helvetica while rendered Bold, undersizing the height budget
        // and causing the next block to overlap this text.
        const summaryHeight = measure(summaryText, contentWidth - 222, "Helvetica-Bold", 10);

        const diffLines = entry.changes;
        const lineTexts = diffLines.map((c) =>
          c.from != null && c.to != null
            ? { label: c.label, from: c.from, to: c.to, kind: "change" }
            : c.to != null
            ? { label: c.label, to: c.to, kind: "add" }
            : { label: c.label, from: c.from, kind: "remove" }
        );

        // FIX: height estimated by measuring the ACTUAL rendered pieces
        // (label column + value column(s), each at their real width and
        // font) and taking the max per line — previously estimated from
        // one concatenated plain-text string, which doesn't reflect how
        // a long "from"/"to" value actually wraps in its narrower column.
        const labelWidth = 130;
        const valueWidth = contentWidth - 232 - labelWidth;
        function diffLineHeight(l) {
          const labelH = measure(`•  ${l.label}:`, labelWidth, "Helvetica-Bold", 8.5);
          if (l.kind === "change") {
            const half = valueWidth / 2;
            const fromH = measure(String(l.from), half - 14, "Helvetica", 8.5);
            const toH = measure(String(l.to), half, "Helvetica-Bold", 8.5);
            return Math.max(labelH, fromH, toH);
          } else if (l.kind === "add") {
            return Math.max(labelH, measure(String(l.to), valueWidth, "Helvetica-Bold", 8.5));
          }
          return Math.max(labelH, measure(`${l.from} (removed)`, valueWidth, "Helvetica", 8.5));
        }

        // FIX: the estimate and the actual draw increments below now use
        // the exact same named constants — previously they used
        // independently-chosen numbers (e.g. estimate: max(24, h+10),
        // actual: max(16, h+6); estimate tail: +12, actual tail: 8+10=18)
        // that didn't quite match, letting the real content drift a few
        // points past what was budgeted. That drift is what was causing
        // the idle-gap highlight box (and, over several entries, the
        // start of the next record) to creep out of alignment.
        const HEADER_MIN = 24;
        const HEADER_GAP = 10;
        const DIVIDER_GAP_BEFORE = 8;
        const DIVIDER_GAP_AFTER = 10;

        const headerBlockHeight = Math.max(HEADER_MIN, summaryHeight + HEADER_GAP);
        const diffHeight = lineTexts.reduce((sum, l) => sum + diffLineHeight(l) + 4, 0);
        const rowHeight = headerBlockHeight + diffHeight + DIVIDER_GAP_BEFORE + DIVIDER_GAP_AFTER;

        ensureSpace(rowHeight);

        if (hasIdleGapBefore(emp.entries, idx)) {
          doc.rect(MARGIN - 4, y - 4, contentWidth + 8, rowHeight + 4).fill(HIGHLIGHT_COLOR);
        }

        doc.fillColor(COLORS.mutedDark).font("Helvetica").fontSize(8.5).text(entry.timeLabel, MARGIN, y, { width: 78 });

        const typeColor = TYPE_COLORS[entry.type] || COLORS.accent;
        drawBadge(MARGIN + 82, y - 2, 62, entry.type, typeColor);

        const changeColor = CHANGE_COLORS[entry.changeType] || COLORS.muted;
        drawBadge(MARGIN + 150, y - 2, 62, entry.changeType, changeColor);

        doc.fillColor(COLORS.text).font("Helvetica-Bold").fontSize(10).text(summaryText, MARGIN + 222, y - 1, {
          width: contentWidth - 222,
        });

        y += headerBlockHeight;

        lineTexts.forEach((l) => {
          doc.fillColor(COLORS.text).font("Helvetica-Bold").fontSize(8.5).text(`•  ${l.label}:`, MARGIN + 232, y, {
            width: labelWidth,
          });
          const valueX = MARGIN + 232 + labelWidth;
          if (l.kind === "change") {
            const half = valueWidth / 2;
            doc.fillColor(COLORS.removed).font("Helvetica").fontSize(8.5).text(String(l.from), valueX, y, {
              width: half - 14,
            });
            drawArrow(valueX + half - 12, y);
            doc.fillColor(COLORS.added).font("Helvetica-Bold").text(String(l.to), valueX + half, y, {
              width: half,
            });
          } else if (l.kind === "add") {
            doc.fillColor(COLORS.added).font("Helvetica-Bold").text(String(l.to), valueX, y, { width: valueWidth });
          } else {
            doc.fillColor(COLORS.removed).font("Helvetica").text(`${l.from} (removed)`, valueX, y, { width: valueWidth });
          }
          y += diffLineHeight(l) + 4;
        });

        y += DIVIDER_GAP_BEFORE;
        doc.moveTo(MARGIN, y).lineTo(pageWidth - MARGIN, y).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        y += DIVIDER_GAP_AFTER;
      });
    });

    // ══════════════════════════════════════════════════════════════
    // 6. LIFETIME ACTIVITY LOG — condensed, all-time, per employee
    // ══════════════════════════════════════════════════════════════
    let lifetimeOutlineParent = null;
    if (lifetimeActivityLog.length) {
      lifetimeActivityLog.forEach((emp) => {
        doc.addPage();
        y = MARGIN;
        const dest = destName("lifetime", emp.email);
        doc.addNamedDestination(dest);
        if (!lifetimeOutlineParent) {
          doc.addNamedDestination(destName("section", "lifetime_activity_root"));
          lifetimeOutlineParent = doc.outline.addItem("Lifetime Activity Log");
        }
        lifetimeOutlineParent.addItem(emp.name);

        const subtitle = emp.truncated
          ? `${emp.email}  ·  showing most recent ${emp.entries.length} of ${emp.totalCount} total`
          : `${emp.email}  ·  ${emp.entries.length} action(s) all-time`;
        sectionHeader(`${emp.name} — Full History`, subtitle);
        doc.fillColor(COLORS.mutedDark).font("Helvetica-Oblique").fontSize(7.5).text(
          "Light red row = 20+ minute gap since the previous action, during business hours (8am–6pm IST)",
          MARGIN,
          y,
          { width: contentWidth }
        );
        y += 14;

        const logCols = [
          { key: "date", label: "Date", width: 62 },
          { key: "time", label: "Time", width: 46 },
          { key: "type", label: "Type", width: 66 },
          { key: "action", label: "Action", width: 60 },
          { key: "company", label: "Company", width: contentWidth - 62 - 46 - 66 - 60 },
        ];
        function logHeaderRow() {
          doc.rect(MARGIN, y, contentWidth, 18).fill(COLORS.accent);
          let cx = MARGIN;
          logCols.forEach((c) => {
            doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.5).text(c.label, cx + 5, y + 5, { width: c.width - 8 });
            cx += c.width;
          });
          y += 18;
        }
        logHeaderRow();

        emp.entries.forEach((entry, idx) => {
          indexCompany(entry.company, "Lifetime Activity", emp.name, dest);
          const companyHeight = measure(entry.company, logCols[4].width - 8, "Helvetica", 8);
          const rowH = Math.max(15, companyHeight + 4);
          ensureSpace(rowH, logHeaderRow);
          if (hasIdleGapBefore(emp.entries, idx)) {
            doc.rect(MARGIN, y, contentWidth, rowH).fill(HIGHLIGHT_COLOR);
          } else if (idx % 2 === 1) {
            doc.rect(MARGIN, y, contentWidth, rowH).fill(COLORS.panel);
          }

          let cx = MARGIN;
          doc.fillColor(COLORS.mutedDark).font("Helvetica").fontSize(8).text(entry.dateLabel, cx + 5, y + 3, { width: logCols[0].width - 8 });
          cx += logCols[0].width;
          doc.fillColor(COLORS.mutedDark).text(entry.timeLabel, cx + 5, y + 3, { width: logCols[1].width - 8 });
          cx += logCols[1].width;

          const typeColor = TYPE_COLORS[entry.type] || COLORS.accent;
          doc.fillColor(typeColor).font("Helvetica-Bold").fontSize(7.5).text(entry.type, cx + 5, y + 3, { width: logCols[2].width - 8 });
          cx += logCols[2].width;

          const changeColor = CHANGE_COLORS[entry.changeType] || COLORS.muted;
          doc.fillColor(changeColor).font("Helvetica-Bold").fontSize(7.5).text(entry.changeType, cx + 5, y + 3, { width: logCols[3].width - 8 });
          cx += logCols[3].width;

          doc.fillColor(COLORS.text).font("Helvetica").fontSize(8).text(entry.company, cx + 5, y + 3, { width: logCols[4].width - 8 });

          y += rowH;
        });

        if (emp.truncated) {
          y += 6;
          ensureSpace(16);
          doc.fillColor(COLORS.mutedDark).font("Helvetica-Oblique").fontSize(8).text(
            `…and ${emp.totalCount - emp.entries.length} earlier entries not shown here (full history available in-app).`,
            MARGIN,
            y,
            { width: contentWidth }
          );
        }
      });
    }

    // ══════════════════════════════════════════════════════════════
    // 7. STATUS UPDATES — Prospect / Enquiry / Sample / Quotation logs,
    //    grouped by employee, plus a current-status snapshot table.
    // ══════════════════════════════════════════════════════════════
    if (statusReport) {
      const STATUS_SECTION_COLORS = {
        Prospect: TYPE_COLORS.Prospect,
        Enquiry: TYPE_COLORS.RFQ,
        Sample: TYPE_COLORS.Sample,
        Quotation: TYPE_COLORS.Quotation,
      };

      // FIX: bullet-line width now matches exactly between the height
      // estimate and the actual render (both use `bulletWidth`) —
      // previously these used different widths (safe direction, but
      // inconsistent and imprecise).
      function drawStatusEntry(sectionColor, badgeLabel, timeLabel, dateLabel, company, lines, onNewPage) {
        const bulletWidth = contentWidth - 40;
        const headerWidth = contentWidth - 150;
        const HEADER_MIN = 20;
        const HEADER_GAP = 8;
        const DIVIDER_GAP_BEFORE = 8;
        const DIVIDER_GAP_AFTER = 10;

        const headerHeight = measure(company, headerWidth, "Helvetica-Bold", 10);
        const headerBlockHeight = Math.max(HEADER_MIN, headerHeight + HEADER_GAP);
        const linesHeight = lines.reduce((sum, l) => sum + measure(l, bulletWidth, "Helvetica", 8.5) + 3, 0);
        const rowHeight = headerBlockHeight + linesHeight + DIVIDER_GAP_BEFORE + DIVIDER_GAP_AFTER;

        ensureSpace(rowHeight, onNewPage);

        doc.fillColor(COLORS.mutedDark).font("Helvetica").fontSize(8).text(timeLabel, MARGIN, y, { width: 70 });
        doc.fillColor(COLORS.mutedDark).text(dateLabel, MARGIN, y + 10, { width: 70 });

        drawBadge(MARGIN + 74, y - 2, 68, badgeLabel, sectionColor);

        doc.fillColor(COLORS.text).font("Helvetica-Bold").fontSize(10).text(company, MARGIN + 150, y - 1, {
          width: headerWidth,
        });

        y += headerBlockHeight;

        lines.forEach((l) => {
          doc.fillColor(COLORS.mutedDark).font("Helvetica").fontSize(8.5).text(`•  ${l}`, MARGIN + 20, y, {
            width: bulletWidth,
          });
          y += measure(l, bulletWidth, "Helvetica", 8.5) + 3;
        });

        y += DIVIDER_GAP_BEFORE;
        doc.moveTo(MARGIN, y).lineTo(pageWidth - MARGIN, y).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        y += DIVIDER_GAP_AFTER;
      }

      function statusGroupHeader(label, count, onNewPage) {
        ensureSpace(26, onNewPage);
        doc.rect(MARGIN, y, contentWidth, 20).fill(COLORS.panel);
        doc.moveTo(MARGIN, y).lineTo(MARGIN, y + 20).lineWidth(3).strokeColor(COLORS.accent).stroke();
        doc.fillColor(COLORS.dark).font("Helvetica-Bold").fontSize(9.5).text(
          `${label}  (${count})`,
          MARGIN + 10,
          y + 5,
          { width: contentWidth - 20 }
        );
        y += 26;
      }

      function renderGroupedStatusLog(title, rootDestKey, groups, sectionColor, badgeLabel, buildLines, indexLabel) {
        if (!groups.length) return;
        let parent = null;
        groups.forEach((group) => {
          doc.addPage();
          y = MARGIN;
          const dest = destName(indexLabel, group.name);
          doc.addNamedDestination(dest);
          if (!parent) {
            doc.addNamedDestination(destName("section", rootDestKey));
            parent = doc.outline.addItem(title);
          }
          parent.addItem(group.name);

          sectionHeader(`${title} — ${group.name}`, `${group.entries.length} update(s) · grouped by status, nearest due date first`);

          group.statusGroups.forEach((sg) => {
            // Reprints "Status (cont'd)" if a page break lands inside
            // this status group — either at the header itself or partway
            // through its entries — so a reader landing mid-group still
            // knows what they're looking at.
            const reprintHeader = () => statusGroupHeader(`${sg.status} (cont'd)`, sg.count);
            statusGroupHeader(sg.status, sg.count, reprintHeader);

            sg.entries.forEach((entry) => {
              indexCompany(entry.company, title, group.name, dest);
              drawStatusEntry(sectionColor, badgeLabel, entry.timeLabel, entry.dateLabel, entry.company, buildLines(entry), reprintHeader);
            });
          });
        });
      }

      renderGroupedStatusLog("Prospect Status Log", "prospect_root", statusReport.prospectStatusLog, STATUS_SECTION_COLORS.Prospect, "PROSPECT", (entry) => {
        const lines = [`Status: ${entry.status}`];
        if (entry.nextAction) lines.push(`Next Action: ${entry.nextAction}`);
        if (entry.nextActionDate) {
          lines.push(`Next Action Date: ${entry.nextActionDate}${entry.nextActionTime ? ` at ${entry.nextActionTime}` : ""}`);
        } else if (entry.nextActionTime) {
          lines.push(`Next Action Time: ${entry.nextActionTime}`);
        }
        if (entry.remark) lines.push(`Remark: ${entry.remark}`);
        return lines;
      }, "prospect");

      renderGroupedStatusLog("Enquiry Status Log", "enquiry_root", statusReport.enquiryStatusLog, STATUS_SECTION_COLORS.Enquiry, "ENQUIRY", (entry) => {
        const lines = [`Status: ${entry.status}`];
        if (entry.enquiryStatus) lines.push(`Enquiry Result: ${entry.enquiryStatus}`);
        if (entry.contactType) lines.push(`Contact Type: ${entry.contactType}`);
        if (entry.nextActionDate) {
          lines.push(`Next Action Date: ${entry.nextActionDate}${entry.nextActionTime ? ` at ${entry.nextActionTime}` : ""}`);
        } else if (entry.nextActionTime) {
          lines.push(`Next Action Time: ${entry.nextActionTime}`);
        }
        if (entry.note) lines.push(`Note: ${entry.note}`);
        return lines;
      }, "enquiry");

      renderGroupedStatusLog("Sample Status Log", "sample_root", statusReport.sampleStatusLog, STATUS_SECTION_COLORS.Sample, "SAMPLE", (entry) => {
        const lines = [`Stage: ${entry.stage}`, `Result: ${entry.result}`, `Priority: ${entry.priority}`];
        if (entry.notes) lines.push(`Notes: ${entry.notes}`);
        if (entry.followUp) lines.push(`Next Follow-up: ${entry.followUp}`);
        return lines;
      }, "sample");

      renderGroupedStatusLog("Quotation Status Log", "quotation_root", statusReport.quotationStatusLog, STATUS_SECTION_COLORS.Quotation, "QUOTATION", (entry) => {
        const lines = [`Stage: ${entry.stage}`, `Result: ${entry.result}`, `Priority: ${entry.priority}`];
        if (entry.notes) lines.push(`Notes: ${entry.notes}`);
        if (entry.followUp) lines.push(`Next Follow-up: ${entry.followUp}`);
        return lines;
      }, "quotation");

      if (statusReport.currentStatusTable.length) {
        doc.addPage();
        y = MARGIN;
        doc.addNamedDestination(destName("section", "current_snapshot"));
        doc.outline.addItem("Current Status Snapshot");
        sectionHeader("Current Status Snapshot", `${statusReport.currentStatusTable.length} active enquiry(ies) · company-wise`);

        const snapCols = [
          { key: "company", label: "Company", width: contentWidth * 0.24 },
          { key: "enquiryStatus", label: "Enquiry Status", width: contentWidth * 0.16 },
          { key: "sampleStatus", label: "Sample Status", width: contentWidth * 0.14 },
          { key: "quotationStatus", label: "Quotation Status", width: contentWidth * 0.14 },
          { key: "createdBy", label: "Created By", width: contentWidth * 0.16 },
          { key: "updatedBy", label: "Last Updated By", width: contentWidth * 0.16 },
        ];
        function snapHeaderRow() {
          doc.rect(MARGIN, y, contentWidth, 20).fill(COLORS.accent);
          let cx = MARGIN;
          snapCols.forEach((c) => {
            doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.5).text(c.label, cx + 5, y + 6, { width: c.width - 8 });
            cx += c.width;
          });
          y += 20;
        }
        snapHeaderRow();

        statusReport.currentStatusTable.forEach((row, idx) => {
          const rowH = Math.max(
            15,
            snapCols.reduce((m, c) => Math.max(m, measure(String(row[c.key]), c.width - 8, "Helvetica", 7.5)), 0) + 6
          );
          ensureSpace(rowH, snapHeaderRow);
          if (idx % 2 === 1) doc.rect(MARGIN, y, contentWidth, rowH).fill(COLORS.panel);
          let cx = MARGIN;
          snapCols.forEach((c) => {
            doc.fillColor(COLORS.text).font(c.key === "company" ? "Helvetica-Bold" : "Helvetica").fontSize(7.5).text(
              String(row[c.key]),
              cx + 5,
              y + 3,
              { width: c.width - 8 }
            );
            cx += c.width;
          });
          y += rowH;
        });
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 7.5 PAYMENT (BILL DUES) — overview stats, lifetime per-employee
    //     summary, today's bill activity per employee, and an
    //     outstanding-bills snapshot table.
    // ══════════════════════════════════════════════════════════════
    if (billsReport) {
      const BILL_TYPE_COLOR = "#b45309";

      // ── 7.5a Overview ────────────────────────────────────────────
      doc.addPage();
      y = MARGIN;
      doc.addNamedDestination(destName("section", "bills_overview"));
      doc.outline.addItem("Payment (Bill Dues)");
      sectionHeader("Payment (Bill Dues) — Overview", `${billsReport.totalActionsToday} action(s) today`);

      const billStats = [
        { label: "Outstanding Balance", value: fmtINR(billsReport.totalOutstanding) },
        { label: "Total Collected (All-time)", value: fmtINR(billsReport.totalCollectedAllTime) },
        { label: "Remaining Bills", value: String(billsReport.remainingCount) },
        { label: "Completed Bills", value: String(billsReport.completedCount) },
        { label: "Overdue Bills", value: String(billsReport.overdueCount) },
        { label: "Due Today", value: String(billsReport.dueTodayCount) },
      ];
      const billBoxW = (contentWidth - 24) / 3;
      billStats.forEach((s, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const bx = MARGIN + col * (billBoxW + 12);
        const by = y + row * 66;
        doc.roundedRect(bx, by, billBoxW, 58, 6).fillAndStroke(COLORS.panel, COLORS.border);
        doc.fillColor(COLORS.accent).font("Helvetica-Bold").fontSize(14).text(s.value, bx + 14, by + 10, { width: billBoxW - 24 });
        doc.fillColor(COLORS.mutedDark).font("Helvetica").fontSize(8).text(s.label.toUpperCase(), bx + 14, by + 38, {
          width: billBoxW - 24,
          characterSpacing: 0.3,
        });
      });
      y += 66 * 2 + 10;

      doc.font("Helvetica").fontSize(9).fillColor(COLORS.mutedDark).text(
        "See the Lifetime Summary and Outstanding Snapshot below for a per-employee breakdown and a full list of unpaid bills, sorted most-overdue-first.",
        MARGIN,
        y,
        { width: contentWidth }
      );

      // ── 7.5b Lifetime Summary ────────────────────────────────────
      doc.addPage();
      y = MARGIN;
      doc.addNamedDestination(destName("section", "bills_lifetime"));
      doc.outline.addItem("Payment — Lifetime Summary");
      sectionHeader("Payment (Bill Dues) — Lifetime Summary", "All-time, per employee");

      const billCols = [
        { key: "name", label: "Employee", width: contentWidth * 0.4 },
        { key: "billsAdded", label: "Bills Added", width: contentWidth * 0.25 },
        { key: "totalCollected", label: "Total Collected", width: contentWidth * 0.35 },
      ];
      function billTableHeaderRow() {
        doc.rect(MARGIN, y, contentWidth, 22).fill(COLORS.accent);
        let cx = MARGIN;
        billCols.forEach((c) => {
          doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8.5).text(c.label, cx + 6, y + 6, {
            width: c.width - 10,
            align: c.key === "name" ? "left" : "center",
          });
          cx += c.width;
        });
        y += 22;
      }
      billTableHeaderRow();

      if (!billsReport.lifetimeSummary.length) {
        ensureSpace(18);
        doc.fillColor(COLORS.mutedDark).font("Helvetica-Oblique").fontSize(9).text("No bill activity recorded yet.", MARGIN, y + 4);
        y += 18;
      } else {
        billsReport.lifetimeSummary.forEach((row, idx) => {
          ensureSpace(20, billTableHeaderRow);
          if (idx % 2 === 1) doc.rect(MARGIN, y, contentWidth, 18).fill(COLORS.panel);
          let cx = MARGIN;
          billCols.forEach((c) => {
            const val = c.key === "name" ? row.name : c.key === "totalCollected" ? fmtINR(row.totalCollected) : String(row[c.key] || 0);
            doc.fillColor(COLORS.text).font(c.key === "totalCollected" ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).text(
              val,
              cx + 6,
              y + 4,
              { width: c.width - 10, align: c.key === "name" ? "left" : "center" }
            );
            cx += c.width;
          });
          y += 18;
        });
      }

      // ── 7.5c Today's Bill Activity, per employee ──────────────────
      let billsTodayOutlineParent = null;
      billsReport.todayActivity.forEach((emp) => {
        doc.addPage();
        y = MARGIN;
        const dest = destName("billstoday", emp.email);
        doc.addNamedDestination(dest);
        if (!billsTodayOutlineParent) {
          doc.addNamedDestination(destName("section", "bills_today_root"));
          billsTodayOutlineParent = doc.outline.addItem("Payment — Today's Activity");
        }
        billsTodayOutlineParent.addItem(emp.name);

        sectionHeader(`${emp.name} — Bill Activity Today`, `${emp.email}  ·  ${emp.entries.length} action(s) today`);
        y += 4;

        emp.entries.forEach((entry) => {
          indexCompany(entry.company, "Payment — Today's Activity", emp.name, dest);

          const summaryText = entry.company;
          const summaryHeight = measure(summaryText, contentWidth - 170, "Helvetica-Bold", 10);

          const hasDiff = entry.changes && entry.changes.length > 0;
          const lineTexts = hasDiff
            ? entry.changes.map((c) =>
                c.from != null && c.to != null
                  ? { label: c.label, from: c.from, to: c.to, kind: "change" }
                  : c.to != null
                  ? { label: c.label, to: c.to, kind: "add" }
                  : { label: c.label, from: c.from, kind: "remove" }
              )
            : (entry.lines || []).map((l) => ({ plain: l }));

          const HEADER_MIN = 22;
          const HEADER_GAP = 8;
          const DIVIDER_GAP_BEFORE = 8;
          const DIVIDER_GAP_AFTER = 10;
          const headerBlockHeight = Math.max(HEADER_MIN, summaryHeight + HEADER_GAP);

          const labelWidth = 130;
          const valueWidth = contentWidth - 40 - labelWidth;
          const bulletWidth = contentWidth - 40;

          function lineHeight(l) {
            if (l.plain !== undefined) return measure(`•  ${l.plain}`, bulletWidth, "Helvetica", 8.5);
            const labelH = measure(`•  ${l.label}:`, labelWidth, "Helvetica-Bold", 8.5);
            if (l.kind === "change") {
              const half = valueWidth / 2;
              const fromH = measure(String(l.from), half - 14, "Helvetica", 8.5);
              const toH = measure(String(l.to), half, "Helvetica-Bold", 8.5);
              return Math.max(labelH, fromH, toH);
            } else if (l.kind === "add") {
              return Math.max(labelH, measure(String(l.to), valueWidth, "Helvetica-Bold", 8.5));
            }
            return Math.max(labelH, measure(`${l.from} (removed)`, valueWidth, "Helvetica", 8.5));
          }

          const bodyHeight = lineTexts.reduce((sum, l) => sum + lineHeight(l) + 4, 0);
          const rowHeight = headerBlockHeight + bodyHeight + DIVIDER_GAP_BEFORE + DIVIDER_GAP_AFTER;

          ensureSpace(rowHeight);

          doc.fillColor(COLORS.mutedDark).font("Helvetica").fontSize(8.5).text(entry.timeLabel, MARGIN, y, { width: 78 });

          const changeColor = CHANGE_COLORS[entry.changeType] || BILL_TYPE_COLOR;
          drawBadge(MARGIN + 82, y - 2, 78, entry.changeType, changeColor);

          doc.fillColor(COLORS.text).font("Helvetica-Bold").fontSize(10).text(summaryText, MARGIN + 170, y - 1, {
            width: contentWidth - 170,
          });

          y += headerBlockHeight;

          lineTexts.forEach((l) => {
            if (l.plain !== undefined) {
              doc.fillColor(COLORS.mutedDark).font("Helvetica").fontSize(8.5).text(`•  ${l.plain}`, MARGIN + 20, y, {
                width: bulletWidth,
              });
              y += lineHeight(l) + 4;
              return;
            }
            doc.fillColor(COLORS.text).font("Helvetica-Bold").fontSize(8.5).text(`•  ${l.label}:`, MARGIN + 20, y, {
              width: labelWidth,
            });
            const valueX = MARGIN + 20 + labelWidth;
            if (l.kind === "change") {
              const half = valueWidth / 2;
              doc.fillColor(COLORS.removed).font("Helvetica").fontSize(8.5).text(String(l.from), valueX, y, {
                width: half - 14,
              });
              drawArrow(valueX + half - 12, y);
              doc.fillColor(COLORS.added).font("Helvetica-Bold").text(String(l.to), valueX + half, y, { width: half });
            } else if (l.kind === "add") {
              doc.fillColor(COLORS.added).font("Helvetica-Bold").text(String(l.to), valueX, y, { width: valueWidth });
            } else {
              doc.fillColor(COLORS.removed).font("Helvetica").text(`${l.from} (removed)`, valueX, y, { width: valueWidth });
            }
            y += lineHeight(l) + 4;
          });

          y += DIVIDER_GAP_BEFORE;
          doc.moveTo(MARGIN, y).lineTo(pageWidth - MARGIN, y).strokeColor(COLORS.border).lineWidth(0.5).stroke();
          y += DIVIDER_GAP_AFTER;
        });
      });

      // ── 7.5d Outstanding Bills Snapshot ────────────────────────────
      if (billsReport.outstandingSnapshot.length) {
        doc.addPage();
        y = MARGIN;
        doc.addNamedDestination(destName("section", "bills_snapshot"));
        doc.outline.addItem("Payment — Outstanding Snapshot");
        sectionHeader("Payment (Bill Dues) — Outstanding Snapshot", `${billsReport.outstandingSnapshot.length} bill(s) · most overdue first`);

        const snapCols2 = [
          { key: "party", label: "Party", width: contentWidth * 0.22 },
          { key: "billNo", label: "Bill No", width: contentWidth * 0.1 },
          { key: "location", label: "Location", width: contentWidth * 0.13 },
          { key: "balance", label: "Balance", width: contentWidth * 0.13 },
          { key: "due", label: "Due", width: contentWidth * 0.12 },
          { key: "nextFollowup", label: "Next Follow-up", width: contentWidth * 0.15 },
          { key: "updatedBy", label: "Updated By", width: contentWidth * 0.15 },
        ];
        function snap2HeaderRow() {
          doc.rect(MARGIN, y, contentWidth, 20).fill(COLORS.accent);
          let cx = MARGIN;
          snapCols2.forEach((c) => {
            doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.5).text(c.label, cx + 5, y + 6, { width: c.width - 8 });
            cx += c.width;
          });
          y += 20;
        }
        snap2HeaderRow();

        billsReport.outstandingSnapshot.forEach((row, idx) => {
          indexCompany(row.party, "Payment — Outstanding Snapshot", "Current Snapshot", destName("section", "bills_snapshot"));
          const rowH = Math.max(
            15,
            snapCols2.reduce((m, c) => Math.max(m, measure(String(row[c.key]), c.width - 8, "Helvetica", 7.5)), 0) + 6
          );
          ensureSpace(rowH, snap2HeaderRow);
          const isOverdue = row.daysOutstanding > 0;
          if (isOverdue) doc.rect(MARGIN, y, contentWidth, rowH).fill(HIGHLIGHT_COLOR);
          else if (idx % 2 === 1) doc.rect(MARGIN, y, contentWidth, rowH).fill(COLORS.panel);
          let cx = MARGIN;
          snapCols2.forEach((c) => {
            doc.fillColor(COLORS.text).font(c.key === "party" ? "Helvetica-Bold" : "Helvetica").fontSize(7.5).text(
              String(row[c.key]),
              cx + 5,
              y + 3,
              { width: c.width - 8 }
            );
            cx += c.width;
          });
          y += rowH;
        });

        y += 8;
        ensureSpace(14);
        doc.fillColor(COLORS.mutedDark).font("Helvetica-Oblique").fontSize(7.5).text(
          "Light red row = currently overdue (past bill date, unpaid)",
          MARGIN,
          y,
          { width: contentWidth }
        );
      }
    }

    // ══════════════════════════════════════════════════════════════
    // 8. COMPANY INDEX — every company, every place it appears,
    //    across every person and section, alphabetized.
    // ══════════════════════════════════════════════════════════════
    if (companyIndex.size) {
      doc.addPage();
      y = MARGIN;
      doc.addNamedDestination(destName("section", "company_index"));
      doc.outline.addItem("Company Index");
      sectionHeader("Company Index", `${companyIndex.size} compan(y/ies) · alphabetical`);

      const sortedCompanies = [...companyIndex.keys()].sort((a, b) => a.localeCompare(b));

      sortedCompanies.forEach((company) => {
        const occurrences = companyIndex.get(company);
        const headerHeight = measure(company, contentWidth, "Helvetica-Bold", 10.5);
        ensureSpace(headerHeight + 8);
        doc.fillColor(COLORS.text).font("Helvetica-Bold").fontSize(10.5).text(company, MARGIN, y, { width: contentWidth });
        y += headerHeight + 4;

        occurrences.forEach((occ) => {
          const label = `${occ.sectionLabel} — ${occ.personLabel}  (page ${occ.page})`;
          const h = measure(label, contentWidth - 20, "Helvetica", 8.5);
          ensureSpace(h + 3);
          doc.fillColor(COLORS.link).font("Helvetica").fontSize(8.5).text(label, MARGIN + 16, y, {
            width: contentWidth - 20,
            goTo: occ.dest,
            underline: true,
          });
          y += h + 3;
        });

        y += 6;
      });
    }

    // ── Footer page numbers ───────────────────────────────
    // Written LAST, after all real content exists, with the bottom
    // margin temporarily disabled so PDFKit's own auto-pagination can't
    // fire on us mid-loop (this is what caused doubled/blank pages
    // earlier — see git history / prior comments for the full story).
    const range = doc.bufferedPageRange();
    const realBottomMargin = doc.page.margins.bottom;
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;
      doc.fontSize(8).fillColor(COLORS.mutedDark).text(
        `BBM CRM — Daily Activity Report — Page ${i + 1} of ${range.count}`,
        MARGIN,
        doc.page.height - 30,
        { width: contentWidth, align: "center", lineBreak: false }
      );
      doc.page.margins.bottom = realBottomMargin;
    }

    doc.end();
  });
}