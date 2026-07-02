// services/pdfReport.builder.js
//
// Requires: npm install pdfkit --save
//
// Layout:
//   1. Cover page — title, generated-at, today's totals
//   2. Lifetime Contribution Summary — one table, all employees, all-time record counts
//   3. No Activity Today — single compact list (NOT one page per idle employee)
//   4. Today's Detailed Activity Log — one section per employee with
//      activity today, most recent first, full field-by-field diffs
//      (no cap — every changed field is shown)
//   5. Lifetime Activity Log — one compact, all-time list per employee:
//      date, time, action, entity type, company. No field-level detail —
//      this is a scan-the-history view, not an audit-every-field view.
//
// ── Blank-page bug fix ───────────────────────────────────────────────────
// Every block of content is measured with doc.heightOfString(...) BEFORE
// being drawn, and a manual addPage() only happens when the measured
// content genuinely won't fit — this part was already correct.
//
// The actual cause of "6 real pages showing as 12, half blank" was the
// FOOTER loop: it stamped "Page X of Y" at y = page.height - 30, which is
// *inside* PDFKit's own margin boundary (page.height - marginBottom).
// Writing there made PDFKit's own automatic pagination silently insert a
// brand-new blank page for every single existing page, independent of any
// of the manual page-break logic above. Fixed by temporarily setting
// doc.page.margins.bottom = 0 while stamping footers, which disables that
// automatic check for the duration of the loop (restored immediately after).

import PDFDocument from "pdfkit";

const COLORS = {
  dark: "#1e1b4b",
  accent: "#4338ca",
  muted: "#64748b",
  mutedDark: "#475569",   // higher-contrast muted, used for diff values
  border: "#e2e8f0",
  text: "#0f172a",
  panel: "#f8fafc",
  removed: "#b91c1c",
  added: "#15803d",
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
const BOTTOM_SAFE = 70; // generous room so our own manual breaks always fire first

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

export function buildDailyReportPdf(reportData, lifetimeSummary, lifetimeActivityLog = []) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: MARGIN, bufferPages: true, autoFirstPage: true });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    const contentWidth = pageWidth - MARGIN * 2;
    let y = MARGIN;

    function ensureSpace(height, onNewPage) {
      if (y + height > doc.page.height - BOTTOM_SAFE) {
        doc.addPage();
        y = MARGIN;
        if (onNewPage) onNewPage();
      }
    }

    // Measures text height with a known, explicit font/size — measuring
    // without setting the font first risks using whatever font was last
    // active from a previous draw call, which can silently under- or
    // over-estimate height and throw pagination off by a few points.
    function measure(text, width, font = "Helvetica", size = 8.5) {
      doc.font(font).fontSize(size);
      return doc.heightOfString(text, { width, fontSize: size });
    }

    // Solid-fill "chip" badge — full-opacity brand color, bold white
    // uppercase text, with a thin 1pt darker edge along the bottom for a
    // touch of depth. Replaces the earlier pale tinted-background style,
    // which read as washed-out rather than a clean SaaS-style pill.
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
      // Bottom edge sliver first, then the main fill on top — gives a
      // crisp 1pt shaded lip along the bottom without needing real
      // shadow support.
      doc.roundedRect(x, yTop, width, h, 3.5).fill(edge);
      doc.roundedRect(x, yTop, width, h - 1, 3.5).fill(color);
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.5).text(label.toUpperCase(), x, yTop + 4, {
        width,
        align: "center",
        characterSpacing: 0.3,
      });
    }

    // Small vector-drawn arrow (shaft + arrowhead) for the "old -> new"
    // diff separator. Drawn as actual line/fill paths rather than the
    // Unicode "→" character — PDFKit's standard fonts (Helvetica etc.)
    // only support the WinAnsi character set, which does NOT include
    // Unicode arrows, so that glyph was rendering as garbage. A vector
    // shape sidesteps font support entirely and also looks cleaner.
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
      "This report has three parts: (1) a lifetime contribution summary — distinct live records per " +
        "employee, (2) today's detailed activity log with full field-level changes, and (3) a condensed " +
        "all-time activity log per employee (date, time, action, and record) for a quick history scan.",
      MARGIN,
      y,
      { width: contentWidth }
    );

    // ══════════════════════════════════════════════════════════════
    // 2. LIFETIME CONTRIBUTION SUMMARY
    // ══════════════════════════════════════════════════════════════
    doc.addPage();
    y = MARGIN;
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
      ensureSpace(20, tableHeaderRow); // redraws the header automatically if this row starts a new page
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
    // 4. TODAY'S DETAILED ACTIVITY LOG — full diffs, no field cap
    // ══════════════════════════════════════════════════════════════
    reportData.activeToday.forEach((emp) => {
      doc.addPage();
      y = MARGIN;
      sectionHeader(emp.name, `${emp.email}  ·  ${emp.entries.length} action(s) today`);

      emp.entries.forEach((entry) => {
        const summaryText = `${entry.type} — ${entry.company}`;
        const summaryHeight = measure(summaryText, contentWidth - 240, "Helvetica", 10);

        // No cap — every changed field is shown, per your request.
        const diffLines = entry.changes;
        const lineTexts = diffLines.map((c) =>
          c.from != null && c.to != null
            ? { label: c.label, from: c.from, to: c.to, kind: "change" }
            : c.to != null
            ? { label: c.label, to: c.to, kind: "add" }
            : { label: c.label, from: c.from, kind: "remove" }
        );
        const diffHeight = lineTexts.length
          ? lineTexts.reduce((sum, l) => {
              const plain = l.kind === "change"
                ? `${l.label}: ${l.from} -> ${l.to}`
                : l.kind === "add"
                ? `${l.label}: ${l.to}`
                : `${l.label}: ${l.from} (removed)`;
              return sum + measure(plain, contentWidth - 260, "Helvetica", 8.5) + 4;
            }, 4)
          : 0;
        const rowHeight = Math.max(24, summaryHeight + 10) + diffHeight + 12;

        ensureSpace(rowHeight);

        // Timestamp
        doc.fillColor(COLORS.mutedDark).font("Helvetica").fontSize(8.5).text(entry.timeLabel, MARGIN, y, { width: 78 });

        // Entity-type badge
        const typeColor = TYPE_COLORS[entry.type] || COLORS.accent;
        drawBadge(MARGIN + 82, y - 2, 62, entry.type, typeColor);

        // Change-type badge (Created / Updated / Deleted)
        const changeColor = CHANGE_COLORS[entry.changeType] || COLORS.muted;
        drawBadge(MARGIN + 150, y - 2, 62, entry.changeType, changeColor);

        // Summary
        doc.fillColor(COLORS.text).font("Helvetica-Bold").fontSize(10).text(summaryText, MARGIN + 222, y - 1, {
          width: contentWidth - 222,
        });

        y += Math.max(16, summaryHeight + 6);

        // Field diffs — label in dark bold, "from" in a red-tinted tone,
        // "to" in a green-tinted bold tone. Higher contrast than the
        // previous all-gray rendering, and every changed field is shown.
        lineTexts.forEach((l) => {
          const labelWidth = 130;
          doc.fillColor(COLORS.text).font("Helvetica-Bold").fontSize(8.5).text(`•  ${l.label}:`, MARGIN + 232, y, {
            width: labelWidth,
          });
          const valueX = MARGIN + 232 + labelWidth;
          const valueWidth = contentWidth - 232 - labelWidth;
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
          const plain = l.kind === "change" ? `${l.label}: ${l.from} -> ${l.to}` : l.kind === "add" ? `${l.label}: ${l.to}` : `${l.label}: ${l.from}`;
          y += measure(plain, contentWidth - 260, "Helvetica", 8.5) + 4;
        });

        y += 8;
        doc.moveTo(MARGIN, y).lineTo(pageWidth - MARGIN, y).strokeColor(COLORS.border).lineWidth(0.5).stroke();
        y += 10;
      });
    });

    // ══════════════════════════════════════════════════════════════
    // 5. LIFETIME ACTIVITY LOG — condensed, all-time, per employee
    // ══════════════════════════════════════════════════════════════
    if (lifetimeActivityLog.length) {
      lifetimeActivityLog.forEach((emp) => {
        doc.addPage();
        y = MARGIN;
        const subtitle = emp.truncated
          ? `${emp.email}  ·  showing most recent ${emp.entries.length} of ${emp.totalCount} total`
          : `${emp.email}  ·  ${emp.entries.length} action(s) all-time`;
        sectionHeader(`${emp.name} — Full History`, subtitle);

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
          const companyHeight = measure(entry.company, logCols[4].width - 8, "Helvetica", 8);
          const rowH = Math.max(15, companyHeight + 4);
          ensureSpace(rowH, logHeaderRow);
          if (idx % 2 === 1) doc.rect(MARGIN, y, contentWidth, rowH).fill(COLORS.panel);

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

    // ── Footer page numbers ───────────────────────────────
    // Written LAST, after all real content exists, with the bottom
    // margin temporarily disabled so PDFKit's own auto-pagination can't
    // fire on us mid-loop — see the file header comment for the full
    // story on why this specific bug produced doubled/blank pages.
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