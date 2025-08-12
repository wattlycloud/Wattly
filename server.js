// server.js
// Wattly Bill Audit + Proposal (HTML/JSON/PDF) with math breakdown

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
    limits: { fileSize: 25 * 1024 * 1024 },
    useTempFiles: false,
    abortOnLimit: true,
  })
);

// ---------------- Helpers: parsing ----------------
function firstMatch(text, regex) {
  const m = text.match(regex);
  return m ? m[1].trim() : null;
}

function findMoney(text, labels = []) {
  // Look for dollar amounts near label(s)
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const labelRegex = labels.length ? new RegExp(labels.join("|"), "i") : null;

  if (labelRegex) {
    for (let i = 0; i < lines.length; i++) {
      if (labelRegex.test(lines[i])) {
        for (let j = i; j < Math.min(i + 3, lines.length); j++) {
          const m = lines[j].match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/);
          if (m) return parseFloat(m[1].replace(/,/g, ""));
        }
      }
    }
  }

  // Fallback: largest dollar on page
  let max = null;
  const all = text.match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/g) || [];
  for (const s of all) {
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

  const gasCcf =
    firstMatch(text, /(\d{2,7})\s*ccf\b/i) ||
    firstMatch(text, /Total\s+Gas\s+Use\s+(\d+)\s*ccf/i);

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
    totals: {
      total_due,
      delivery_charges,
      supply_charges,
      taxes,
    },
    usage,
    meta: {
      parsed_at: new Date().toISOString(),
      confidence: "low/heuristic",
    },
    _notes: "General patterns; add utility-specific rules over time for higher accuracy.",
  };
}

// Try to infer an effective supply rate = supply_charges / monthly_qty
function inferEffectiveRate(audit) {
  const supply = audit?.totals?.supply_charges;
  if (!supply) return null;

  // prefer electric kWh
  if (audit?.usage?.electricity_kwh) {
    const qty = Number(audit.usage.electricity_kwh);
    if (qty > 0) return +(supply / qty).toFixed(4);
  }
  // fallback gas therms
  if (audit?.usage?.gas_therms) {
    const qty = Number(audit.usage.gas_therms);
    if (qty > 0) return +(supply / qty).toFixed(4);
  }
  // fallback gas ccf
  if (audit?.usage?.gas_ccf) {
    const qty = Number(audit.usage.gas_ccf);
    if (qty > 0) return +(supply / qty).toFixed(4);
  }
  return null;
}

// ---------------- Helpers: savings + formatting ----------------
function fmtMoney(n) {
  if (n == null || isNaN(n)) return "—";
  return `$${n.toFixed(2)}`;
}

function computeSavings(monthlyQty, unit, currentRate, offerRate) {
  if (!monthlyQty || !currentRate || !offerRate) {
    return { unit, monthlyQty, currentRate, offerRate, ok: false };
  }
  const monthlyAtCurrent = monthlyQty * currentRate;
  const monthlyAtOffer = monthlyQty * offerRate;
  const monthlySavings = monthlyAtCurrent - monthlyAtOffer;
  const annualSavings = monthlySavings * 12;
  return {
    unit, monthlyQty, currentRate, offerRate, ok: true,
    monthlyAtCurrent, monthlyAtOffer, monthlySavings, annualSavings,
    term: {
      "2yr": annualSavings * 2,
      "3yr": annualSavings * 3,
      "4yr": annualSavings * 4,
      "5yr": annualSavings * 5,
    },
  };
}

function buildMathBlock(audit, currentRate, offerRate) {
  const lines = [];
  lines.push("=== Math Breakdown ===");

  // Electric
  if (audit?.usage?.electricity_kwh) {
    const qty = Number(audit.usage.electricity_kwh);
    const s = computeSavings(qty, "kWh", currentRate, offerRate);
    lines.push("");
    lines.push("[Electric]");
    lines.push(`Monthly qty: ${qty} kWh`);
    lines.push(`Current rate: ${currentRate ?? "—"}  | Offer rate: ${offerRate ?? "—"}  ($/kWh)`);
    if (s.ok) {
      lines.push(`At current: ${qty} × ${currentRate} = ${fmtMoney(s.monthlyAtCurrent)}`);
      lines.push(`At offer:   ${qty} × ${offerRate} = ${fmtMoney(s.monthlyAtOffer)}`);
      lines.push(`Monthly savings: ${fmtMoney(s.monthlySavings)}`);
      lines.push(`Annual savings:  ${fmtMoney(s.annualSavings)}`);
      lines.push(`2yr: ${fmtMoney(s.term["2yr"])} | 3yr: ${fmtMoney(s.term["3yr"])} | 4yr: ${fmtMoney(s.term["4yr"])} | 5yr: ${fmtMoney(s.term["5yr"])}`);
    } else {
      lines.push("Not enough info (need monthly qty, current_rate, and offer_rate).");
    }
  }

  // Gas
  const gasQty = audit?.usage?.gas_therms ?? audit?.usage?.gas_ccf;
  const gasUnit = audit?.usage?.gas_therms ? "therms" : (audit?.usage?.gas_ccf ? "ccf" : null);
  if (gasQty && gasUnit) {
    const qty = Number(gasQty);
    const s = computeSavings(qty, gasUnit, currentRate, offerRate);
    lines.push("");
    lines.push("[Gas]");
    lines.push(`Monthly qty: ${qty} ${gasUnit}`);
    lines.push(`Current rate: ${currentRate ?? "—"}  | Offer rate: ${offerRate ?? "—"}  ($/${gasUnit})`);
    if (s.ok) {
      lines.push(`At current: ${qty} × ${currentRate} = ${fmtMoney(s.monthlyAtCurrent)}`);
      lines.push(`At offer:   ${qty} × ${offerRate} = ${fmtMoney(s.monthlyAtOffer)}`);
      lines.push(`Monthly savings: ${fmtMoney(s.monthlySavings)}`);
      lines.push(`Annual savings:  ${fmtMoney(s.annualSavings)}`);
      lines.push(`2yr: ${fmtMoney(s.term["2yr"])} | 3yr: ${fmtMoney(s.term["3yr"])} | 4yr: ${fmtMoney(s.term["4yr"])} | 5yr: ${fmtMoney(s.term["5yr"])}`);
    } else {
      lines.push("Not enough info (need monthly qty, current_rate, and offer_rate).");
    }
  }

  if (lines.length === 1) {
    lines.push("");
    lines.push("No usage quantities found to show math.");
  }

  return lines.join("\n");
}

// ---------------- HTML pieces ----------------
function htmlPage(body) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Wattly Bill Audit</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background:#000; color:#ddd; margin:0; }
  .wrap { max-width: 920px; margin: 32px auto; padding: 0 16px; }
  h1 { margin: 0 0 20px; font-size: 32px; color: #fff; }
  .card { background:#111; border:1px solid #222; border-radius:12px; padding:16px; margin:16px 0; }
  label { display:block; margin:8px 0 6px; font-weight:600; }
  input[type="text"] { width:100%; padding:10px; border-radius:10px; border:1px solid #333; background:#0c0c0c; color:#eee; }
  select { padding:10px; border-radius:10px; border:1px solid #333; background:#0c0c0c; color:#eee; }
  button { background:#fff; color:#000; border:0; border-radius:12px; padding:12px 16px; font-weight:700; cursor:pointer; }
  table { width:100%; border-collapse:collapse; }
  th, td { padding:10px; border-bottom:1px solid #222; }
  th { text-align:left; color:#bbb; }
  pre { background:#0b0b0b; border:1px solid #1b1b1b; padding:12px; border-radius:8px; overflow:auto; }
  .row { display:grid; grid-template-columns: 1fr auto; gap: 12px; align-items:center; }
</style>
</head>
<body>
  <div class="wrap">
    ${body}
  </div>
</body>
</html>`;
}

function uploadForm() {
  return htmlPage(`
    <h1>Wattly Bill Audit</h1>
    <div class="card">
      <form action="/proposal" method="post" enctype="multipart/form-data">
        <label>Upload your bill PDF</label>
        <input type="file" name="bill" accept=".pdf" required />
        <div class="row" style="margin-top:12px">
          <div>
            <label>Offer supply rate (optional)</label>
            <input type="text" name="offer_rate" placeholder="e.g. 0.6900" />
          </div>
          <div>
            <label>Current rate (optional)</label>
            <input type="text" name="current_rate" placeholder="leave blank to infer" />
          </div>
        </div>
        <div style="margin-top:12px">
          <label>Output format</label>
          <select name="format">
            <option value="json">JSON (default)</option>
            <option value="html">HTML page</option>
            <option value="pdf">PDF proposal</option>
          </select>
        </div>
        <div style="margin-top:16px">
          <button type="submit">Upload & Analyze</button>
        </div>
      </form>
      <p style="opacity:.7;margin-top:12px">We infer volume (therms/ccf/kWh) and an effective supply rate when possible.</p>
    </div>
    <div class="card" style="opacity:.85">
      <strong>API:</strong> POST <code>/proposal</code> (multipart/form-data) with field <code>bill</code> (PDF). Optional fields: <code>offer_rate</code>, <code>current_rate</code>, <code>format=pdf</code> for a PDF proposal.
    </div>
  `);
}

function htmlResults({ title, currentRate, offerRate, monthlyQty, unit, audit, mathBlock }) {
  return htmlPage(`
    <h1>${title}</h1>
    <div class="card">
      <table>
        <tr><th style="width:260px">Current Supplier</th><td>${fmtMoney(currentRate)}</td></tr>
        <tr><th>Offered Supplier</th><td>${fmtMoney(offerRate)}</td></tr>
        <tr><th>Usage detected</th><td>${monthlyQty ? `${monthlyQty} ${unit}` : "—"}</td></tr>
      </table>
    </div>

    <div class="card">
      <h3 style="margin:0 0 8px">Parsed Details (JSON)</h3>
      <pre>${JSON.stringify(audit, null, 2)}</pre>
    </div>

    <div class="card">
      <h3 style="margin:0 0 8px">Math breakdown</h3>
      <pre>${mathBlock}</pre>
    </div>

    <div class="card">
      <a href="/" style="text-decoration:none"><button>Analyze another bill</button></a>
    </div>
  `);
}

// ---------------- Routes ----------------
app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/", (_req, res) => res.send(uploadForm()));

app.post("/proposal", async (req, res) => {
  try {
    if (!req.files || !req.files.bill) {
      return res.status(400).json({ error: "No file uploaded. Field name must be 'bill'." });
    }
    const file = req.files.bill;
    if (!/\.pdf$/i.test(file.name)) {
      return res.status(400).json({ error: "Please upload a PDF file." });
    }

    // Parse PDF
    const parsed = await pdfParse(file.data);
    const text = parsed.text || "";
    if (!text.trim()) {
      return res.status(422).json({ error: "Could not extract text from PDF." });
    }

    // Build audit
    const audit = auditFromText(text);

    // Rates
    const offerRate = req.body.offer_rate ? Number(req.body.offer_rate) : null;
    let currentRate = req.body.current_rate ? Number(req.body.current_rate) : null;
    if (!currentRate) currentRate = inferEffectiveRate(audit);

    // Choose the best available "monthly qty" + unit for display/math
    let monthlyQty = null;
    let unit = null;
    if (audit.usage.electricity_kwh) { monthlyQty = audit.usage.electricity_kwh; unit = "kWh"; }
    else if (audit.usage.gas_therms) { monthlyQty = audit.usage.gas_therms; unit = "therms"; }
    else if (audit.usage.gas_ccf) { monthlyQty = audit.usage.gas_ccf; unit = "ccf"; }

    const mathBlock = buildMathBlock(audit, currentRate, offerRate);

    // JSON response (default)
    const want = (req.body.format || "").toLowerCase() || "json";
    if (want === "json") {
      return res.json({
        ok: true,
        proposal: {
          customer: audit.account_number || null,
          utility: audit.utility,
          account: audit.account_number || null,
          period: audit.billing_period,
          savings: {
            unit,
            monthlyQty,
            currentRate: currentRate || 0,
            offerRate: offerRate || 0,
          },
        },
        audit,
      });
    }

    // HTML results page
    if (want === "html") {
      const title = "Wattly Bill Audit";
      const html = htmlResults({ title, currentRate, offerRate, monthlyQty, unit, audit, mathBlock });
      return res.send(html);
    }

    // PDF proposal
    if (want === "pdf") {
      const doc = new PDFDocument({ margin: 48 });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="energy_proposal.pdf"');
      doc.pipe(res);

      // Title
      doc.fontSize(20).fillColor("#000").text("ENERGY PROPOSAL PREPARED FOR:", { underline: false });
      doc.moveDown(0.5);
      doc.fontSize(14).text(`${audit.utility}`, { continued: false });
      if (audit.account_number) doc.text(`Account: ${audit.account_number}`);
      if (audit.billing_period?.start || audit.billing_period?.end) {
        doc.text(`Period: ${audit.billing_period.start || "—"} to ${audit.billing_period.end || "—"}`);
      }
      doc.moveDown();

      // Rates & usage
      doc.fontSize(12);
      doc.text(`Current rate:  ${currentRate != null ? `$${currentRate.toFixed(4)}` : "—"}`);
      doc.text(`Offered rate:  ${offerRate != null ? `$${offerRate.toFixed(4)}` : "—"}`);
      doc.text(`Usage detected: ${monthlyQty ? `${monthlyQty} ${unit}` : "—"}`);
      doc.moveDown();

      // Math block
      doc.font("Courier").fontSize(10).text(mathBlock);
      doc.moveDown();

      // Footer
      doc.font("Helvetica").fontSize(8).fillColor("#444")
         .text("Generated by Wattly", { align: "right" });

      doc.end();
      return; // stream ends response
    }

    // Fallback
    return res.json({ ok: true, audit, note: "Unknown format; defaulted to JSON." });

  } catch (err) {
    console.error("Proposal error:", err);
    res.status(500).json({ error: "Server error", detail: String(err.message || err) });
  }
});

// ---------------- Start ----------------
app.listen(PORT, BIND, () => {
  console.log(`Server listening on http://${BIND}:${PORT}`);
});
