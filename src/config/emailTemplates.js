// ── RFQ created ───────────────────────────────────────────────────────────

export const rfqCreatedSalesperson = ({ salespersonEmail, rfq }) => ({
  to: salespersonEmail,
  subject: `✅ RFQ Submitted — ${rfq.company_name} | ${rfq.product_name}`,
  html: `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
      <div style="background:#2563eb;padding:20px 24px">
        <h2 style="color:#fff;margin:0;font-size:18px">RFQ Submitted Successfully</h2>
      </div>
      <div style="padding:24px;color:#1e293b">
        <p style="margin:0 0 16px">Your RFQ has been submitted and is now visible to the Sales Coordinator.</p>
        ${rfqDetailBlock(rfq)}
        ${rfq.sample_required ? badge("🧪 Sample Required", "#ede9fe", "#5b21b6") : ""}
        ${rfq.quotation_required ? badge("📄 Quotation Required", "#dbeafe", "#1e40af") : ""}
        <p style="margin:16px 0 0;font-size:12px;color:#94a3b8">This is an automated notification from BBM CRM.</p>
      </div>
    </div>`,
});

export const rfqCreatedCoordinator = ({ coordinatorEmail, rfq, salespersonEmail }) => ({
  to: coordinatorEmail,
  subject: `🆕 New RFQ — ${rfq.company_name} | ${rfq.product_name}`,
  html: `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
      <div style="background:#7c3aed;padding:20px 24px">
        <h2 style="color:#fff;margin:0;font-size:18px">New RFQ Received</h2>
      </div>
      <div style="padding:24px;color:#1e293b">
        <p style="margin:0 0 4px">A new RFQ has been submitted by <strong>${salespersonEmail}</strong>.</p>
        ${rfqDetailBlock(rfq)}
        ${rfq.sample_required ? badge("🧪 Sample Required — Please process", "#ede9fe", "#5b21b6") : ""}
        ${rfq.quotation_required ? badge("📄 Quotation Required — Please process", "#dbeafe", "#1e40af") : ""}
        <p style="margin:16px 0 0;font-size:12px;color:#94a3b8">This is an automated notification from BBM CRM.</p>
      </div>
    </div>`,
});

// ── Sample status updated ─────────────────────────────────────────────────

export const sampleUpdatedCoordinator = ({ coordinatorEmail, sample, rfq, updaterEmail }) => ({
  to: coordinatorEmail,
  subject: `✅ Sample Status Updated — ${rfq.company_name} | ${rfq.product_name}`,
  html: `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
      <div style="background:#7c3aed;padding:20px 24px">
        <h2 style="color:#fff;margin:0;font-size:18px">Sample Status Updated (Acknowledgement)</h2>
      </div>
      <div style="padding:24px;color:#1e293b">
        <p style="margin:0 0 16px">You updated the sample status. Here's a summary:</p>
        ${rfqDetailBlock(rfq)}
        ${statusBlock("Sample Status", sample.sample_status, sample.follow_up_date)}
        <p style="margin:16px 0 0;font-size:12px;color:#94a3b8">Updated by: ${updaterEmail}</p>
      </div>
    </div>`,
});

export const sampleUpdatedSalesperson = ({ salespersonEmail, sample, rfq }) => ({
  to: salespersonEmail,
  subject: `📦 Sample Update — ${rfq.company_name} | ${rfq.product_name}`,
  html: `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
      <div style="background:#2563eb;padding:20px 24px">
        <h2 style="color:#fff;margin:0;font-size:18px">Sample Status Update</h2>
      </div>
      <div style="padding:24px;color:#1e293b">
        <p style="margin:0 0 16px">The Sales Coordinator has updated the sample status for your RFQ.</p>
        ${rfqDetailBlock(rfq)}
        ${statusBlock("Sample Status", sample.sample_status, sample.follow_up_date)}
        <p style="margin:16px 0 0;font-size:12px;color:#94a3b8">This is an automated notification from BBM CRM.</p>
      </div>
    </div>`,
});

// ── Quotation status updated ──────────────────────────────────────────────

export const quotationUpdatedCoordinator = ({ coordinatorEmail, quotation, rfq, updaterEmail }) => ({
  to: coordinatorEmail,
  subject: `✅ Quotation Status Updated — ${rfq.company_name} | ${rfq.product_name}`,
  html: `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
      <div style="background:#0f766e;padding:20px 24px">
        <h2 style="color:#fff;margin:0;font-size:18px">Quotation Status Updated (Acknowledgement)</h2>
      </div>
      <div style="padding:24px;color:#1e293b">
        <p style="margin:0 0 16px">You updated the quotation status. Here's a summary:</p>
        ${rfqDetailBlock(rfq)}
        ${statusBlock("Quotation Status", quotation.quotation_status, quotation.follow_up_date)}
        <p style="margin:16px 0 0;font-size:12px;color:#94a3b8">Updated by: ${updaterEmail}</p>
      </div>
    </div>`,
});

export const quotationUpdatedSalesperson = ({ salespersonEmail, quotation, rfq }) => ({
  to: salespersonEmail,
  subject: `📄 Quotation Update — ${rfq.company_name} | ${rfq.product_name}`,
  html: `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
      <div style="background:#2563eb;padding:20px 24px">
        <h2 style="color:#fff;margin:0;font-size:18px">Quotation Status Update</h2>
      </div>
      <div style="padding:24px;color:#1e293b">
        <p style="margin:0 0 16px">The Sales Coordinator has updated the quotation status for your RFQ.</p>
        ${rfqDetailBlock(rfq)}
        ${statusBlock("Quotation Status", quotation.quotation_status, quotation.follow_up_date)}
        <p style="margin:16px 0 0;font-size:12px;color:#94a3b8">This is an automated notification from BBM CRM.</p>
      </div>
    </div>`,
});


// ── Product created / updated / deleted (acknowledgement to Sales Coordinator) ─

export const productCreatedCoordinator = ({ coordinatorEmail, product, actorEmail }) => ({
  to: coordinatorEmail,
  subject: `✅ Product Added — ${product.product_name}`,
  html: `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
      <div style="background:#0f766e;padding:20px 24px">
        <h2 style="color:#fff;margin:0;font-size:18px">New Product Added (Acknowledgement)</h2>
      </div>
      <div style="padding:24px;color:#1e293b">
        <p style="margin:0 0 16px">A new product has been added to the catalog. Here's a summary:</p>
        ${productDetailBlock(product)}
        <p style="margin:16px 0 0;font-size:12px;color:#94a3b8">Added by: ${actorEmail || "—"}</p>
      </div>
    </div>`,
});

export const productUpdatedCoordinator = ({ coordinatorEmail, product, actorEmail }) => ({
  to: coordinatorEmail,
  subject: `✏️ Product Updated — ${product.product_name}`,
  html: `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
      <div style="background:#0f766e;padding:20px 24px">
        <h2 style="color:#fff;margin:0;font-size:18px">Product Updated (Acknowledgement)</h2>
      </div>
      <div style="padding:24px;color:#1e293b">
        <p style="margin:0 0 16px">A product in the catalog has been updated. Here's a summary:</p>
        ${productDetailBlock(product)}
        <p style="margin:16px 0 0;font-size:12px;color:#94a3b8">Updated by: ${actorEmail || "—"}</p>
      </div>
    </div>`,
});

export const productDeletedCoordinator = ({ coordinatorEmail, product, actorEmail }) => ({
  to: coordinatorEmail,
  subject: `🗑️ Product Deleted — ${product.product_name}`,
  html: `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
      <div style="background:#b91c1c;padding:20px 24px">
        <h2 style="color:#fff;margin:0;font-size:18px">Product Deleted (Acknowledgement)</h2>
      </div>
      <div style="padding:24px;color:#1e293b">
        <p style="margin:0 0 16px">A product has been removed from the catalog. Here's a summary:</p>
        ${productDetailBlock(product)}
        <p style="margin:16px 0 0;font-size:12px;color:#94a3b8">Deleted by: ${actorEmail || "—"}</p>
      </div>
    </div>`,
});

// ── Lead created (acknowledgement to Salesperson + welcome to Customer) ────

export const leadCreatedSalesperson = ({ salespersonEmail, lead }) => ({
  to: salespersonEmail,
  subject: `✅ Lead Added — ${lead.company_name}`,
  html: `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
      <div style="background:#2563eb;padding:20px 24px">
        <h2 style="color:#fff;margin:0;font-size:18px">Lead Added Successfully</h2>
      </div>
      <div style="padding:24px;color:#1e293b">
        <p style="margin:0 0 16px">Your new lead has been saved. Here's a summary:</p>
        ${leadDetailBlock(lead)}
        <p style="margin:16px 0 0;font-size:12px;color:#94a3b8">This is an automated notification from BBM CRM.</p>
      </div>
    </div>`,
});

export const leadWelcomeCustomer = ({ customerEmail, lead }) => ({
  to: customerEmail,
  subject: `Welcome, ${lead.company_name}! 🎉`,
  html: `
    <div style="font-family:sans-serif;max-width:560px;margin:auto;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
      <div style="background:#2563eb;padding:24px">
        <h2 style="color:#fff;margin:0;font-size:18px">Welcome to BBM!</h2>
      </div>
      <div style="padding:24px;color:#1e293b">
        <p style="margin:0 0 16px">
          Dear ${lead.contact_name || lead.company_name},
        </p>
        <p style="margin:0 0 16px">
          Thank you for connecting with us. We're excited to have
          <strong>${lead.company_name}</strong> onboard. Our team will be in
          touch with you shortly to understand your requirements and assist
          you further.
        </p>
        <p style="margin:0 0 16px">
          If you have any immediate questions, feel free to reach out to us
          anytime.
        </p>
        <p style="margin:16px 0 0;font-size:13px;color:#475569">— Team BBM</p>
      </div>
    </div>`,
});

// ── Additional shared HTML helpers ──────────────────────────────────────────

const productDetailBlock = (product) => `
  <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:8px;padding:12px;margin:12px 0">
    <tbody>
      ${row("Category",     product.category)}
      ${row("Sub Category", product.sub_category)}
      ${row("Product Name", product.product_name)}
    </tbody>
  </table>`;

const leadDetailBlock = (lead) => `
  <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:8px;padding:12px;margin:12px 0">
    <tbody>
      ${row("Company",        lead.company_name)}
      ${row("Contact Person",  lead.contact_name)}
      ${row("Designation",     lead.designation)}
      ${row("Mobile",          lead.mobile_number)}
      ${row("Email",           lead.email)}
      ${row("City / Zone",     [lead.city, lead.zone].filter(Boolean).join(" / "))}
      ${row("Route",           lead.route)}
      ${row("Nature of Business", lead.nature_of_business)}
      ${row("Industry",        lead.manufacturing_industry)}
      ${row("Website",         lead.company_website)}
    </tbody>
  </table>`;


// ── Shared HTML helpers ───────────────────────────────────────────────────

const row = (label, value) => value ? `
  <tr>
    <td style="padding:6px 12px 6px 0;color:#64748b;font-size:13px;white-space:nowrap">${label}</td>
    <td style="padding:6px 0;font-size:13px;color:#1e293b">${value}</td>
  </tr>` : "";

const rfqDetailBlock = (rfq) => `
  <table style="width:100%;border-collapse:collapse;background:#f8fafc;border-radius:8px;padding:12px;margin:12px 0">
    <tbody>
      ${row("Company",     rfq.company_name)}
      ${row("Category",    [rfq.product_category, rfq.product_sub_category].filter(Boolean).join(" › "))}
      ${row("Product",     rfq.product_name)}
      ${row("Description", rfq.product_description || rfq.sample_description || rfq.quotation_description)}
      ${row("Consumption", rfq.consumption_per_month ? `${rfq.consumption_per_month} ${rfq.unit || ""}` : null)}
      ${row("Supplier",    rfq.existing_supplier_brand)}
    </tbody>
  </table>`;

const statusBlock = (label, status, followUpDate) => `
  <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;margin:12px 0">
    <p style="margin:0 0 6px;font-size:13px;color:#64748b">${label}</p>
    <p style="margin:0;font-size:16px;font-weight:700;color:#166534">${status || "—"}</p>
    ${followUpDate ? `<p style="margin:6px 0 0;font-size:12px;color:#64748b">Follow-up: ${new Date(followUpDate).toLocaleDateString()}</p>` : ""}
  </div>`;

const badge = (text, bg, color) => `
  <span style="display:inline-block;background:${bg};color:${color};padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600;margin:4px 4px 4px 0">${text}</span>`;