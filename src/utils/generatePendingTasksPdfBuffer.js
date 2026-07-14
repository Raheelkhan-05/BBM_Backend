import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

// Same table/columns/styling as the client-side exportPendingTasksPdf,
// kept in sync intentionally — if you change one, change the other.
export function generatePendingTasksPdfBuffer(rows, selectedUser = null) {
  const filtered = selectedUser ? rows.filter((r) => r.createdById === selectedUser) : rows;

  const columns = [
    "Company / Enquiry", "Status", "Last Sample Stage", "Last Quotation Stage",
    "New Sample Stage", "New Quotation Stage", "New Follow-up", "Remark",
  ];
  const body = filtered.map((r) => [
    `${r.company}\n${r.enquiryDetail}\n(Due: ${r.dueDateFmt})`,
    r.statusLabel,
    r.lastSampleStage, r.lastQuotationStage,
    r.newSampleStage, r.newQuotationStage,
    r.newFollowup, r.remark,
  ]);

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(30, 41, 59);
  doc.text("Pending Tasks — Today & Overdue", 24, 36);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text(`Employee filter: ${selectedUser || "All Employees"}`, 24, 54);
  doc.text(`Total tasks: ${filtered.length}`, 771, 54, { align: "right" });

  autoTable(doc, {
    startY: 66,
    margin: { left: 24, right: 24 },
    head: [columns],
    body,
    styles: { font: "helvetica", fontSize: 7.5, cellPadding: 4, overflow: "linebreak", valign: "top", lineColor: [226, 232, 240], lineWidth: 0.5, textColor: [51, 65, 85] },
    headStyles: { fillColor: [79, 70, 229], textColor: [255, 255, 255], fontStyle: "bold", fontSize: 8 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    theme: "grid",
  });

  // arraybuffer → Node Buffer, needed for nodemailer attachments
  const arrayBuffer = doc.output("arraybuffer");
  return Buffer.from(arrayBuffer);
}