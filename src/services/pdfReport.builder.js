// services/pdfReport.builder.js
//
// Requires: npm install pdfkit --save
//
// Layout:
//   1. Cover page — title, generated-at, today's totals
//   2. Lifetime Contribution Summary — one table, all employees, all-time totals
//   3. No Activity Today — single compact list (NOT one page per idle employee)
//   4. One section per employee who had activity today, most recent first,
//      each action shown with a Created/Updated/Deleted badge and, where
//      available, a field-by-field "old → new" diff list.
//
// Pagination fix: every block of content is measured with
// doc.heightOfString(...) BEFORE it's drawn, and we manually addPage()
// only when the measured height won't fit in the remaining space. This
// keeps PDFKit's own automatic page-break (which triggers independently
// of manual positioning once wrapped text nears the bottom margin) from
// ever firing, which is what was producing stray blank pages.

import PDFDocument from "pdfkit";

const COLORS = {
  dark: "#1e1b4b",
  accent: "#4338ca",
  muted: "#64748b",
  border: "#e2e8f0",
  text: "#0f172a",
  panel: "#f8fafc",
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
};

const MARGIN = 40;
const BOTTOM_SAFE = 70; // leave generous room so PDFKit never auto-breaks on us

function fmtDate(iso) {
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function buildDailyReportPdf(reportData, lifetimeSummary) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true, autoFirstPage: true });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - MARGIN * 2;
    let y = MARGIN;

    function ensureSpace(height) {
      if (y + height > doc.page.height - BOTTOM_SAFE) {
        doc.addPage();
        y = MARGIN;
      }
    }

    function sectionHeader(title, subtitle) {
      ensureSpace(46);
      doc.rect(MARGIN, y, contentWidth, 36).fill(COLORS.dark);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(13).text(title, MARGIN + 12, y + 9);
      if (subtitle) {
        doc.fillColor("#c7d2fe").font("Helvetica").fontSize(9).text(subtitle, MARGIN + 12, y + 9, {
          width: contentWidth - 24,
          align: "right",
        });
      }
      y += 46;
      doc.fillColor(COLORS.text);
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
      `Generated ${fmtDate(reportData.generatedAt)}  ·  Covers today, 00:00 IST → now`,
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
      doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8.5).text(s.label.toUpperCase(), bx + 14, y + 38, {
        width: statBoxW - 24,
        characterSpacing: 0.3,
      });
    });
    y += 80;

    doc.font("Helvetica").fontSize(9.5).fillColor(COLORS.muted).text(
      "This report has two parts: (1) a lifetime contribution summary across all employees, and " +
        "(2) today's detailed activity log, grouped by employee, most recent action first, with " +
        "field-level changes shown where a record was created, updated, or removed.",
      MARGIN,
      y,
      { width: contentWidth }
    );

    // ══════════════════════════════════════════════════════════════
    // 2. LIFETIME CONTRIBUTION SUMMARY
    // ══════════════════════════════════════════════════════════════
    doc.addPage();
    y = MARGIN;
    sectionHeader("Lifetime Contribution Summary", "All-time, across all employees");

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
      ensureSpace(24);
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
      ensureSpace(20);
      if (y === MARGIN + 46) tableHeaderRow(); // re-draw header if we just paged
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
    // 3. NO ACTIVITY TODAY — one compact shared list, not one page each
    // ══════════════════════════════════════════════════════════════
    if (reportData.noActivityToday.length) {
      doc.addPage();
      y = MARGIN;
      sectionHeader("No Activity Today", `${reportData.noActivityToday.length} employee(s)`);
      reportData.noActivityToday.forEach((emp, idx) => {
        ensureSpace(18);
        if (idx % 2 === 1) doc.rect(MARGIN, y, contentWidth, 16).fill(COLORS.panel);
        doc.fillColor(COLORS.text).font("Helvetica").fontSize(9.5).text(`${emp.name}  (${emp.email})`, MARGIN + 6, y + 3);
        y += 16;
      });
    }

    // ══════════════════════════════════════════════════════════════
    // 4. PER-EMPLOYEE DETAIL — only employees with activity today
    // ══════════════════════════════════════════════════════════════
    reportData.activeToday.forEach((emp) => {
      doc.addPage();
      y = MARGIN;
      sectionHeader(emp.name, `${emp.email}  ·  ${emp.entries.length} action(s) today`);

      emp.entries.forEach((entry) => {
        // Measure summary + diff block height before drawing
        const summaryText = `${entry.type} — ${entry.company}`;
        const summaryHeight = doc.heightOfString(summaryText, { width: contentWidth - 240, fontSize: 10 });
        const diffLines = entry.changes.slice(0, 8); // cap so one entity edit doesn't blow out a page
        const diffHeight = diffLines.length
          ? diffLines.reduce((sum, c) => {
              const line = c.from != null && c.to != null
                ? `${c.label}: ${c.from} → ${c.to}`
                : c.to != null
                ? `${c.label}: ${c.to}`
                : `${c.label}: ${c.from}`;
              return sum + doc.heightOfString(line, { width: contentWidth - 70, fontSize: 8.5 }) + 3;
            }, 6)
          : 0;
        const rowHeight = Math.max(24, summaryHeight + 10) + diffHeight + 10;

        ensureSpace(rowHeight);
        const rowTop = y;

        // Timestamp
        doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8.5).text(entry.timeLabel, MARGIN, y, { width: 78 });

        // Entity-type badge
        const typeColor = TYPE_COLORS[entry.type] || COLORS.accent;
        doc.roundedRect(MARGIN + 82, y - 2, 62, 14, 3).fillAndStroke(typeColor + "18", typeColor);
        doc.fillColor(typeColor).font("Helvetica-Bold").fontSize(7.5).text(entry.type.toUpperCase(), MARGIN + 82, y + 1, {
          width: 62,
          align: "center",
        });

        // Change-type badge (Created / Updated / Deleted)
        const changeColor = CHANGE_COLORS[entry.changeType] || COLORS.muted;
        doc.roundedRect(MARGIN + 150, y - 2, 62, 14, 3).fillAndStroke(changeColor + "18", changeColor);
        doc.fillColor(changeColor).font("Helvetica-Bold").fontSize(7.5).text(entry.changeType.toUpperCase(), MARGIN + 150, y + 1, {
          width: 62,
          align: "center",
        });

        // Summary
        doc.fillColor(COLORS.text).font("Helvetica").fontSize(10).text(summaryText, MARGIN + 222, y - 1, {
          width: contentWidth - 222,
        });

        y += Math.max(16, summaryHeight + 6);

        // Field diffs
        if (diffLines.length) {
          diffLines.forEach((c) => {
            const line =
              c.from != null && c.to != null
                ? `${c.label}: ${c.from}  →  ${c.to}`
                : c.to != null
                ? `${c.label}: ${c.to}`
                : `${c.label}: ${c.from} (removed)`;
            doc.fillColor(COLORS.muted).font("Helvetica").fontSize(8.5).text(`•  ${line}`, MARGIN + 232, y, {
              width: contentWidth - 232,
            });
            y += doc.heightOfString(`•  ${line}`, { width: contentWidth - 232, fontSize: 8.5 }) + 3;
          });
          if (entry.changes.length > diffLines.length) {
            doc
              .fillColor(COLORS.muted)
              .font("Helvetica-Oblique")
              .fontSize(8)
              .text(`…and ${entry.changes.length - diffLines.length} more field(s) changed`, MARGIN + 232, y);
            y += 12;
          }
        }

        y += 6;
        doc.moveTo(MARGIN, y).lineTo(pageWidth - MARGIN, y).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        y += 10;
      });
    });

    // ── Footer page numbers ───────────────────────────────
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).fillColor(COLORS.muted).text(
        `BBM CRM — Daily Activity Report — Page ${i + 1} of ${range.count}`,
        MARGIN,
        doc.page.height - 30,
        { width: contentWidth, align: "center" }
      );
    }

    doc.end();
  });
}