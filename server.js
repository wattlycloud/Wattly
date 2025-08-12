// server.js
// Wattly Bill Audit (Express + pdf-parse + PDFKit)
// - Upload a bill PDF -> JSON audit
// - Optional savings calc when rates are provided
// - Generate a clean one-page PDF proposal (black/white)

const express = require("express");
const fileUpload = require("express-fileupload");
const pdfParse = require("pdf-parse");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = process.env.PORT || 3000;
const BIND = "0.0.0.0";

// ---------------- Middleware ----------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(
  fileUpload({
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
    useTempFiles: false,
    abortOnLimit: true,
  })
);

// ---------------- Helpers (parsing) ----------------
function firstMatch(text, regex) {
  const m = text.match(regex);
  return m ? m[1].trim() : null;
}

function findMoney(text, labels = []) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (labels.length) {
    const labelRegex = new RegExp(labels.join("|"), "i");
    for (let i = 0; i < lines.length; i++) {
      if (labelRegex.test(lines[i])) {
        for (let j = i; j < Math.min(i + 3, lines.length); j++) {
          const m = lines[j].match(
            /\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/
          );
          if (m) return parseFloat(m[1].replace(/,/g, ""));
        }
      }
    }
  }
  // Fallback: largest number that looks like money
  let max = null;
  const moneyAll =
    text.match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/g) ||
    [];
  for (const s of moneyAll) {
    const v = parseFloat(s.replace(/[$,\s]/g, ""));
    if (!isNaN(v) && (max === null || v > max)) max = v;
  }
  return max;
}

function guessUtility(text) {
  if (/con\s*ed(ison)?/i.test(text)) return "Con Edison";
  if (/southern california edison|sce/i.test(text)) return "SCE";
  if (/pge\b|pacific gas/i.test(text)) return "PG&E";
  if (/national grid/i.test(text)) return "National Grid";
  if (/duke energy/i.test(text)) return "Duke Energy";
  if (/sdge|san diego gas/i.test(text)) return "SDG&E";
  return (
    firstMatch(text, /^([A-Z][A-Za-z&.\s]{3,40})\s+(Bill|Invoice|Statement)/m) ||
    "Unknown Utility"
  );
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
  const gasCcf =
    firstMatch(text, /Total\s+usage\s+in\s+ccf\s+(\d+)/i) ||
    firstMatch(text, /\b(\d{2,6})\s*ccf\b/i);
  const kwh = firstMatch(text, /(\d{2,7})\s*kWh\b/i);
  return {
    gas_therms: gasTherms ? parseInt(gasTherms, 10) : null,
    gas_ccf: gasCcf ? parseInt(gasCcf, 10) : null,
    electricity_kwh: kwh ? parseInt(kwh, 10) : null,
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
    _notes: "Heuristic parser. Add utility-specific patterns for higher accuracy.",
  };
}

// ---------------- Helpers (proposal + pdf) ----------------
function inferMonthlyQtyAndUnit(audit) {
  const u = audit.usage || {};
  if (u.electricity_kwh != null)
    return { qty: u.electricity_kwh, unit: "kWh" };
  if (u.gas_therms != null) return { qty: u.gas_therms, unit: "therms" };
  if (u.gas_ccf != null) return { qty: u.gas_ccf, unit: "ccf" };
  return { qty: null, unit: null };
}

function inferCurrentRate(audit) {
  const qty = inferMonthlyQtyAndUnit(audit).qty;
  const supply = audit.totals?.supply_charges;
  if (qty && supply) {
    const r = supply / qty;
    if (isFinite(r)) return r;
  }
  return null;
}

function toMoney(v) {
  if (v == null || isNaN(v)) return "—";
  return `$${Number(v).toFixed(2)}`;
}

function buildSavings({ qty, currentRate, offerRate }) {
  if (!(qty && currentRate != null && offerRate != null)) {
    return {
      unit: null,
      monthlyQty: qty || null,
      currentRate: currentRate || 0,
      offerRate: offerRate || 0,
      monthlySavings: null,
      annualSavings: null,
      termSavings: { "2yr": null, "3yr": null, "4yr": null, "5yr": null },
    };
  }
  const monthly = (currentRate - offerRate) * qty;
  const annual = monthly * 12;
  return {
    monthlyQty: qty,
    currentRate,
    offerRate,
    monthlySavings: monthly,
    annualSavings: annual,
    termSavings: {
      "2yr": annual * 2,
      "3yr": annual * 3,
      "4yr": annual * 4,
      "5yr": annual * 5,
    },
  };
}

// ---- PDF (buffered so mobile downloads don’t fail) ----
function buildProposalPDFDocument(doc, proposal) {
  // monochrome, bold emphasis
  doc.fillColor("#000");

  // Title
  doc.fontSize(22).font("Helvetica-Bold").text("ENERGY PROPOSAL PREPARED FOR:");
  doc.moveDown(0.4);
  doc.fontSize(18).font("Helvetica").text(`${proposal.customer}  •  ${proposal.utility}`);
  const p = proposal.period || {};
  if (p.start || p.end) {
    doc.moveDown(0.2);
    doc.fontSize(10).fillOpacity(0.7).text(`Billing Period: ${p.start || "—"} to ${p.end || "—"}`);
    doc.fillOpacity(1);
  }

  // A subtle divider
  doc.moveDown(0.6);
  doc.moveTo(48, doc.y).lineTo(564, doc.y).stroke();

  // Inputs section
  doc.moveDown(0.6);
  const s = proposal.savings || {};
  doc.fontSize(12).font("Helvetica-Bold").text("Inputs");
  doc.moveDown(0.2);
  const inputs = [
    ["Monthly Usage", s.monthlyQty != null && proposal.unit ? `${s.monthlyQty.toLocaleString()} ${proposal.unit}` : "—"],
    ["Current Rate", toMoney(s.currentRate)],
    ["Offer Rate", toMoney(s.offerRate)],
  ];
  inputs.forEach(([k, v]) => doc.font("Helvetica").text(`${k}: ${v}`));

  // Savings section
  doc.moveDown(0.8);
  doc.fontSize(14).font("Helvetica-Bold").text("SAVINGS");
  doc.moveDown(0.3);
  doc.fontSize(28).font("Helvetica-Bold").text(`Monthly: ${toMoney(s.monthlySavings)}`);
  doc.moveDown(0.2);
  doc.fontSize(18).font("Helvetica-Bold").text(`Annual: ${toMoney(s.annualSavings)}`);

  doc.moveDown(0.6);
  doc.fontSize(12).font("Helvetica-Bold").text("Multi-Year Terms");
  const terms = s.termSavings || {};
  [["2 Years", "2yr"], ["3 Years", "3yr"], ["4 Years", "4yr"], ["5 Years", "5yr"]]
    .forEach(([label, key]) => doc.font("Helvetica").text(`${label}: ${toMoney(terms[key])}`));

  // Footer
  doc.moveDown(1);
  doc.fontSize(9).fillOpacity(0.7).text(
    "Notes: Savings = (current rate − offered rate) × monthly usage. " +
    "Annual and term savings assume flat usage and a constant rate difference.",
    { align: "left" }
  );
  doc.fillOpacity(1);
}

function proposalPdfBuffer(proposal) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 48 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    buildProposalPDFDocument(doc, proposal);
    doc.end();
  });
}

async function sendProposalPdf(res, proposal) {
  const buf = await proposalPdfBuffer(proposal);
  res.status(200);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="energy_proposal.pdf"');
  res.setHeader("Content-Length", String(buf.length));
  res.setHeader("Cache-Control", "no-store");
  res.send(buf);
}

// ---------------- Web UI (simple) ----------------
const HOME_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Wattly Bill Audit</title>
  <style>
    :root { color-scheme: dark; }
    body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#0a0a0a; color:#eaeaea; }
    .wrap { max-width: 780px; margin: 40px auto; padding: 0 16px; }
    h1 { font-size: 40px; font-weight: 800; letter-spacing: .5px; margin-bottom: 18px; }
    .card { background: #141414; border: 1px solid #222; border-radius: 12px; padding: 18px; }
    label { display:block; font-size:14px; margin: 14px 0 6px; opacity:.9 }
    input[type="file"], input[type="text"], select {
      width:100%; background:#0f0f0f; border:1px solid #262626; color:#eee; border-radius:10px; padding:12px; font-size:16px;
    }
    button { background:#eaeaea; color:#000; font-weight:700; border:none; padding:12px 18px; border-radius:10px; margin-top:16px; }
    .tip { opacity:.7; font-size:13px; margin-top:10px; }
    code { background:#0f0f0f; padding:2px 6px; border-radius:6px; border:1px solid #262626; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Wattly Bill Audit</h1>
    <div class="card">
      <form action="/proposal" method="post" enctype="multipart/form-data">
        <label>Upload your bill PDF</label>
        <input type="file" name="bill" accept=".pdf" required />

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div>
            <label>Offer supply rate (optional)</label>
            <input type="text" name="offer_rate" placeholder="e.g. 0.6900" />
          </div>
          <div>
            <label>Current rate (optional)</label>
            <input type="text" name="current_rate" placeholder="leave blank to infer" />
          </div>
        </div>

        <label>Output format</label>
        <select name="format">
          <option value="json">JSON (default)</option>
          <option value="pdf">PDF proposal</option>
        </select>

        <button type="submit">Upload & Analyze</button>
      </form>
      <div class="tip">We infer volume (therms/ccf/kWh) and an effective supply rate when possible.</div>
    </div>

    <div class="card" style="margin-top:16px">
      <b>API:</b> POST <code>/proposal</code> (multipart/form-data) with field <code>bill</code> (PDF).
      Optional fields: <code>offer_rate</code>, <code>current_rate</code>, <code>format=pdf</code> for a PDF proposal.
    </div>
  </div>
</body>
</html>`;

// ---------------- Routes ----------------
app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/", (_req, res) => {
  res.status(200).send(HOME_HTML);
});

app.post("/proposal", async (req, res) => {
  try {
    if (!req.files || !req.files.bill) {
      return res
        .status(400)
        .json({ error: "No file uploaded. Field name must be 'bill'." });
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

    // Rates
    const offerRate =
      req.body.offer_rate != null && req.body.offer_rate !== ""
        ? Number(String(req.body.offer_rate).replace(/[^\d.]/g, ""))
        : null;
    let currentRate =
      req.body.current_rate != null && req.body.current_rate !== ""
        ? Number(String(req.body.current_rate).replace(/[^\d.]/g, ""))
        : null;
    if (currentRate == null) currentRate = inferCurrentRate(audit);

    const { qty, unit } = (() => {
      const s = inferMonthlyQtyAndUnit(audit);
      return { qty: s.qty, unit: s.unit };
    })();

    const savings = buildSavings({ qty, currentRate, offerRate });

    const proposal = {
      customer: audit.account_number || "(unknown account)",
      utility: audit.utility,
      account: audit.account_number || null,
      period: audit.billing_period,
      unit,
      savings,
    };

    // Output
    const wantPdf = String(req.body.format || "").toLowerCase() === "pdf";
    if (wantPdf) {
      return await sendProposalPdf(res, proposal);
    }
    return res.json({ ok: true, proposal, audit });
  } catch (err) {
    console.error("Proposal error:", err);
    res
      .status(500)
      .json({ error: "Server error", detail: String(err.message || err) });
  }
});

// ---------------- Start ----------------
app.listen(PORT, BIND, () => {
  console.log(`Server listening on http://${BIND}:${PORT}`);
});
