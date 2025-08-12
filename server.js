// Minimal Wattly audit API: upload PDF -> JSON audit
const express = require("express");
const fileUpload = require("express-fileupload");
const pdfParse = require("pdf-parse");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
const BIND = "0.0.0.0";

app.use(cors({ origin: true }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(fileUpload({ limits: { fileSize: 25 * 1024 * 1024 }, abortOnLimit: true }));

// --- helpers ---
const firstMatch = (t, r) => { const m = t.match(r); return m ? (m[1] || m[0]).trim() : null; };

function guessUtility(text) {
  if (/con\s*ed(ison)?/i.test(text)) return "Con Edison";
  if (/southern california edison|sce/i.test(text)) return "SCE";
  if (/pge\b|pacific gas/i.test(text)) return "PG&E";
  if (/national grid/i.test(text)) return "National Grid";
  if (/pseg|pse&g/i.test(text)) return "PSE&G";
  return firstMatch(text, /^([A-Z][A-Za-z&.\s]{3,40})\s+(Bill|Invoice|Statement)/m) || "Unknown Utility";
}
function parseAccount(text) {
  return (
    firstMatch(text, /Account\s+(?:#|number)[:\s]*([0-9\-]{6,})/i) ||
    firstMatch(text, /Acct(?:ount)?\s*(?:#|no\.?)[:\s]*([0-9\-]{6,})/i)
  );
}
function parseDates(text) {
  const m1 = text.match(/Billing period.*?([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})\s*(?:to|-|–)\s*([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/i);
  if (m1) return { start: m1[1], end: m1[2] };
  const m2 = text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*(?:to|-|–)\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
  if (m2) return { start: m2[1], end: m2[2] };
  return { start: null, end: null };
}
function parseUsage(text) {
  const kwh = firstMatch(text, /(\d{2,6})\s*kWh\b/i);
  const gasTherms =
    firstMatch(text, /Total\s+Gas\s+Use\s+(\d+)\s*therms?/i) ||
    firstMatch(text, /(\d{1,5})\s*therms?\b/i);
  const gasCcf = firstMatch(text, /(\d{1,6})\s*ccf\b/i);
  return {
    electricity_kwh: kwh ? parseInt(kwh, 10) : null,
    gas_therms: gasTherms ? parseInt(gasTherms, 10) : null,
    gas_ccf: gasCcf ? parseInt(gasCcf, 10) : null,
  };
}
function findMoneyNear(text, labels = []) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const re = new RegExp(labels.join("|"), "i");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        const m = lines[j].match(/\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/);
        if (m) return parseFloat(m[1].replace(/,/g, ""));
      }
    }
  }
  return null;
}
function auditFromText(text) {
  const utility = guessUtility(text);
  const account_number = parseAccount(text);
  const billing_period = parseDates(text);
  const totals = {
    total_due: findMoneyNear(text, ["Total amount due", "Current balance due", "Amount due", "Total due"]),
    delivery_charges: findMoneyNear(text, ["delivery charges", "distribution", "basic service charge"]),
    supply_charges: findMoneyNear(text, ["supply charges", "generation", "energy supply", "gas supply"]),
    taxes: findMoneyNear(text, ["sales tax", "tax", "grt"]),
  };
  const usage = parseUsage(text);
  return {
    utility, account_number, billing_period, totals, usage,
    meta: { parsed_at: new Date().toISOString(), confidence: "heuristic" },
    _notes: "Generic parser; add utility-specific rules over time."
  };
}

// --- routes ---
app.get("/healthz", (_req, res) => res.send("ok"));

app.post("/proposal", async (req, res) => {
  try {
    if (!req.files || !req.files.bill) return res.status(400).json({ error: "Upload field must be 'bill' (PDF)." });
    const file = req.files.bill;
    if (!/\.pdf$/i.test(file.name)) return res.status(400).json({ error: "Please upload a PDF file." });

    const parsed = await pdfParse(file.data);
    const text = (parsed.text || "").trim();
    if (!text) return res.status(422).json({ error: "Could not extract text from PDF." });

    const audit = auditFromText(text);
    res.json({ ok: true, audit });
  } catch (err) {
    console.error("Proposal error:", err);
    res.status(500).json({ error: "Server error", detail: String(err.message || err) });
  }
});

// --- start ---
app.listen(PORT, BIND, () => console.log(`Server listening on http://${BIND}:${PORT}`));
