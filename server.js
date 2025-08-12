// server.js
// Wattly Bill Audit + Proposal (Render-ready)
// Node/Express + express-fileupload + pdf-parse + pdfkit

const express = require("express");
const fileUpload = require("express-fileupload");
const pdfParse = require("pdf-parse");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = process.env.PORT || 3000;
const BIND = "0.0.0.0";

// ---------- Middleware ----------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  fileUpload({
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
    useTempFiles: false,
    abortOnLimit: true,
  })
);

// ---------- Generic helpers ----------
function firstMatch(text, regex) {
  const m = text.match(regex);
  return m ? (m[1] ?? m[0]).toString().trim() : null;
}

function findMoney(text, labels = []) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (labels.length) {
    const labelRegex = new RegExp(labels.join("|"), "i");
    for (let i = 0; i < lines.length; i++) {
      if (labelRegex.test(lines[i])) {
        for (let j = i; j < Math.min(i + 3, lines.length); j++) {
          const m = lines[j].match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/);
          if (m) return parseFloat(m[1].replace(/,/g, ""));
        }
      }
    }
  }
  // fallback: largest number that looks like money
  let max = null;
  const moneyAll = text.match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/g) || [];
  for (const s of moneyAll) {
    const v = parseFloat(s.replace(/[$,\s]/g, ""));
    if (!isNaN(v) && (max === null || v > max)) max = v;
  }
  return max;
}

function guessUtility(text) {
  if (/con\s*ed(ison)?/i.test(text)) return "Con Edison";
  if (/pge\b|pacific gas/i.test(text)) return "PG&E";
  if (/national grid/i.test(text)) return "National Grid";
  if (/duke energy/i.test(text)) return "Duke Energy";
  if (/sdge|san diego gas/i.test(text)) return "SDG&E";
  if (/southern california edison|sce/i.test(text)) return "SCE";
  return firstMatch(text, /^([A-Z][A-Za-z&.\s]{3,40})\s+(Bill|Invoice|Statement)/m) || "Unknown Utility";
}

function parseDates(text) {
  const m1 = text.match(
    /Billing period.*?(\b[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})\s*(?:to|-|–)\s*(\b[A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/i
  );
  if (m1) return { start: m1[1], end: m1[2] };

  const m2 = text.match(
    /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*(?:to|-|–)\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i
  );
  if (m2) return { start: m2[1], end: m2[2] };

  return { start: null, end: null };
}

function parseUsage(text) {
  const gasTherms =
    firstMatch(text, /Total\s+Gas\s+Use\s+(\d+)\s*therms?/i) ||
    firstMatch(text, /Usage\s*[:\-]?\s*(\d+)\s*therms?/i);
  const kwh = firstMatch(text, /(\d{2,6})\s*kWh\b/i);
  const ccf = firstMatch(text, /(\d{2,7})\s*ccf\b/i);

  return {
    gas_therms: gasTherms ? parseInt(gasTherms, 10) : null,
    electricity_kwh: kwh ? parseInt(kwh, 10) : null,
    gas_ccf: ccf ? parseInt(ccf, 10) : null,
  };
}

function parseAccount(text) {
  return (
    firstMatch(text, /Account\s+(?:#|number)[:\s]*([0-9\-]{6,})/i) ||
    firstMatch(text, /Acct(?:ount)?\s*(?:#|no\.?)[:\s]*([0-9\-]{6,})/i)
  );
}

function auditFromText(text) {
  const utility = guessUtility(text);
  const account_number = parseAccount(text);
  const { start, end } = parseDates(text);

  const total_due = findMoney(text, [
    "Total amount due",
    "Amount due",
    "Current balance due",
    "Total due",
  ]);
  const delivery_charges = findMoney(text, [
    "delivery charges",
    "distribution",
    "basic service charge",
  ]);
  const supply_charges = findMoney(text, [
    "supply charges",
    "generation",
    "energy supply",
    "gas supply",
  ]);
  const taxes = findMoney(text, ["sales tax", "tax", "grt"]);
  const usage = parseUsage(text);

  return {
    utility,
    account_number,
    billing_period: { start, end },
    totals: { total_due, delivery_charges, supply_charges, taxes },
    usage,
    meta: { parsed_at: new Date().toISOString(), confidence: "low/heuristic" },
  };
}

// ---------- Savings helpers ----------
function inferMonthlyVolume(audit) {
  // prefer electricity, else gas therms, else gas ccf
  if (audit?.usage?.electricity_kwh != null) return { qty: audit.usage.electricity_kwh, unit: "kWh" };
  if (audit?.usage?.gas_therms != null) return { qty: audit.usage.gas_therms, unit: "therms" };
  if (audit?.usage?.gas_ccf != null) return { qty: audit.usage.gas_ccf, unit: "ccf" };
  return { qty: null, unit: "units" };
}

function computeSavings({ offerRate, currentRate, audit }) {
  const { qty, unit } = inferMonthlyVolume(audit);

  if (!qty || !offerRate || !currentRate) {
    return {
      unit, monthlyQty: qty, currentRate, offerRate,
      monthlySavings: null, annualSavings: null,
      termSavings: { "2yr": null, "3yr": null, "4yr": null, "5yr": null },
    };
  }

  const delta = currentRate - offerRate; // $ saved per unit
  const monthlySavings = +(qty * delta).toFixed(2);
  const annualSavings = +(monthlySavings * 12).toFixed(2);
  const termSavings = {
    "2yr": +(annualSavings * 2).toFixed(2),
    "3yr": +(annualSavings * 3).toFixed(2),
    "4yr": +(annualSavings * 4).toFixed(2),
    "5yr": +(annualSavings * 5).toFixed(2),
  };

  return {
    unit, monthlyQty: qty, currentRate, offerRate,
    monthlySavings, annualSavings, termSavings,
  };
}

// ---------- PDF ----------
function makeProposalPDF(res, { customerLine, utility, account, period, savings, audit }) {
  const doc = new PDFDocument({ size: "LETTER", margin: 54 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'inline; filename="energy_proposal.pdf"');
  doc.pipe(res);

  const H1 = 26, H2 = 14, BODY = 11;

  doc.font("Helvetica-Bold").fontSize(28).fillColor("black")
    .text("ENERGY PROPOSAL", { align: "left" });
  doc.moveDown(0.4);
  doc.fontSize(12).font("Helvetica").fillColor("black")
    .text(`Prepared For: ${customerLine}`)
    .text(`Utility: ${utility}${account ? "   •   Account: " + account : ""}`);
  if (period?.start || period?.end) {
    doc.text(`Billing Period: ${period.start ?? "—"} to ${period.end ?? "—"}`);
  }
  doc.moveDown(0.8);
  doc.moveTo(54, doc.y).lineTo(558, doc.y).strokeColor("black").stroke();
  doc.moveDown(0.6);

  // Savings
  doc.font("Helvetica-Bold").fontSize(H1).fillColor("black");
  const head = (savings.monthlySavings != null)
    ? `Estimated Monthly Savings: $${savings.monthlySavings.toLocaleString()}`
    : `Estimated Monthly Savings: —`;
  doc.text(head);

  doc.moveDown(0.2);
  doc.fontSize(18).text(
    (savings.annualSavings != null)
      ? `Annual Savings: $${savings.annualSavings.toLocaleString()}`
      : "Annual Savings: —"
  );

  doc.moveDown(0.4);
  doc.font("Helvetica-Bold").fontSize(H2).text("Term Savings:");
  doc.font("Helvetica").fontSize(BODY);
  const t = savings.termSavings || {};
  doc.text(`2 Years: ${t["2yr"] != null ? "$" + t["2yr"].toLocaleString() : "—"}`);
  doc.text(`3 Years: ${t["3yr"] != null ? "$" + t["3yr"].toLocaleString() : "—"}`);
  doc.text(`4 Years: ${t["4yr"] != null ? "$" + t["4yr"].toLocaleString() : "—"}`);
  doc.text(`5 Years: ${t["5yr"] != null ? "$" + t["5yr"].toLocaleString() : "—"}`);

  doc.moveDown(0.8);
  doc.moveTo(54, doc.y).lineTo(558, doc.y).stroke();

  // Inputs
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(H2).text("Inputs");
  doc.font("Helvetica").fontSize(BODY);
  doc.text(`Current Supply Rate: ${savings.currentRate ?? "—"}`);
  doc.text(`Offered Supply Rate: ${savings.offerRate ?? "—"}`);
  doc.text(`Monthly Volume Used: ${savings.monthlyQty ?? "—"} ${savings.unit}`);

  // Parsed details
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(H2).text("Parsed Bill Details");
  doc.font("Helvetica").fontSize(9)
    .text(JSON.stringify(audit, null, 2), { width: 504 });

  doc.end();
}

// ---------- Routes ----------
app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/", (_req, res) => {
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Wattly Bill Audit</title>
<style>
  :root { color-scheme: dark; }
  body { background:#000; color:#fff; font:16px/1.45 system-ui, -apple-system, Segoe UI, Roboto; margin:0; }
  .wrap{ max-width:720px; margin:32px auto; padding:0 16px; }
  h1{ font-size:28px; margin:0 0 16px; font-weight:800; }
  .card{ background:#111; border:1px solid #222; border-radius:10px; padding:18px; }
  label{ display:block; font-size:14px; opacity:.9; margin:10px 0 6px; }
  input[type=file], input[type=text]{ width:100%; padding:10px; border-radius:8px; border:1px solid #333; background:#000; color:#fff; }
  .row{ display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  button{ background:#fff; color:#000; border:0; border-radius:10px; padding:12px 16px; font-weight:700; margin-top:14px; }
  small{ opacity:.7 }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Wattly Bill Audit</h1>
    <form class="card" action="/proposal" method="post" enctype="multipart/form-data">
      <label>Upload your bill PDF</label>
      <input type="file" name="bill" accept=".pdf" required />

      <div class="row">
        <div>
          <label>Offer supply rate (optional)</label>
          <input type="text" name="offer_rate" placeholder="e.g. 0.6900" />
        </div>
        <div>
          <label>Current rate (optional)</label>
          <input type="text" name="current_rate" placeholder="leave blank to infer" />
        </div>
      </div>

      <div class="row">
        <div>
          <label>Output format</label>
          <select name="format">
            <option value="">JSON (default)</option>
            <option value="pdf">PDF proposal</option>
          </select>
        </div>
      </div>

      <button type="submit">Upload & Analyze</button>
      <p><small>We infer volume (therms/ccf/kWh) and an effective supply rate when possible.</small></p>
    </form>

    <p class="card" style="margin-top:18px">
      <strong>API:</strong> POST <code>/proposal</code> (multipart/form-data) with field <code>bill</code> (PDF).<br/>
      Optional fields: <code>offer_rate</code>, <code>current_rate</code>, <code>format=pdf</code> for a PDF proposal.
    </p>
  </div>
</body>
</html>`);
});

// Main proposal endpoint
app.post("/proposal", async (req, res) => {
  try {
    if (!req.files || !req.files.bill) {
      return res.status(400).json({ error: "No file uploaded. Field name must be 'bill'." });
    }
    const file = req.files.bill;
    if (!/\.pdf$/i.test(file.name)) {
      return res.status(400).json({ error: "Please upload a PDF file." });
    }

    const parsed = await pdfParse(file.data);
    const text = parsed.text || "";
    if (!text.trim()) {
      return res.status(422).json({ error: "Could not extract text from PDF." });
    }

    const audit = auditFromText(text);

    const offerRate = req.body.offer_rate ?? req.query.offer_rate;
    const currentRate = req.body.current_rate ?? req.query.current_rate;
    const offer = offerRate != null ? Number(offerRate) : null;
    const current = currentRate != null ? Number(currentRate) : null;

    const savings = computeSavings({
      offerRate: isFinite(offer) ? offer : null,
      currentRate: isFinite(current) ? current : null,
      audit,
    });

    const customerLine =
      audit?.account_number
        ? `${audit.account_number}`
        : (audit?.utility ?? "Customer");

    const format = (req.query.format || req.body.format || "").toString().toLowerCase();

    if (format === "pdf") {
      return makeProposalPDF(res, {
        customerLine,
        utility: audit.utility,
        account: audit.account_number || null,
        period: audit.billing_period || {},
        savings,
        audit,
      });
    }

    return res.json({
      ok: true,
      proposal: {
        customer: customerLine,
        utility: audit.utility,
        account: audit.account_number,
        period: audit.billing_period,
        savings,
      },
      audit,
    });
  } catch (err) {
    console.error("Proposal error:", err);
    res.status(500).json({ error: "Server error", detail: String(err.message || err) });
  }
});

// ---------- Start ----------
app.listen(PORT, BIND, () => {
  console.log(`Server listening on http://${BIND}:${PORT}`);
});
