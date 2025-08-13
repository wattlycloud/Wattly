// server.js — ORIGINAL FLOW (upload bill -> extract -> audit) + SAVINGS ADD-ON (auto, no manual inputs)
// Drop-in for Render/Node. Endpoints: GET /healthz, GET / (tiny tester), POST /proposal (field: bill)
//
// Requires: express, express-fileupload, cors, pdf-parse
// Optional (only if you want PDF export via ?format=pdf): pdfkit

const express = require("express");
const fileUpload = require("express-fileupload");
const cors = require("cors");
const pdfParse = require("pdf-parse");

let PDFDocument = null;
try { PDFDocument = require("pdfkit"); } catch { /* optional */ }

const app = express();
const PORT = process.env.PORT || 8000;
const BIND = "0.0.0.0";

/* ------------------ middleware ------------------ */
app.use(cors({ origin: true }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(fileUpload({
  useTempFiles: false,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  abortOnLimit: true,
}));

/* ------------------ helpers (from the original working parser) ------------------ */
function firstMatch(text, regex, group = 1) {
  const m = text.match(regex);
  return m ? (m[group] || m[0]).trim() : null;
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

function normalizeUtilityName(raw = "") {
  const s = raw.toLowerCase();
  if (s.includes("con") && s.includes("ed")) return "Con Edison";
  if (s.includes("ameren")) return "Ameren";
  if (s.includes("com ed") || s.includes("comed")) return "COMED";
  if (s.includes("national grid")) return "National Grid (Massachusetts Electric)";
  if (s.includes("eversource") && (s.includes("western") || s.includes("wmeco")))
    return "Eversource (Western Massachusetts Electric Company)";
  if (s.includes("eversource") && (s.includes("nstar") || s.includes("boston")))
    return "Eversource (Formerly Boston Edison - NSTAR)";
  if (s.includes("eversource") && s.includes("psnh"))
    return "Eversource (Formerly PSNH)";
  if (s.includes("pseg") || s.includes("pse&g")) return "PSEG";
  if (s.includes("baltimore gas") || s.includes("bge")) return "Baltimore Gas and Electric";
  if (s.includes("delmarva")) return "Delmarva Power & Light";
  if (s.includes("toledo edison")) return "Toledo Edison";
  if (s.includes("aep ohio")) return "AEP Ohio (Columbus Southern)";
  if (s.includes("duquesne")) return "Duquesne Light";
  if (s.includes("met-ed") || s.includes("meted")) return "METED";
  if (s.includes("penelec") || s.includes("pennelec")) return "PENELEC";
  if (s.includes("peco")) return "PECO";
  if (s.includes("ppl")) return "PPL";
  if (s.includes("pennpower")) return "PennPower";
  if (s.includes("west penn")) return "West Penn Power";
  if (s.includes("unitil")) return "Unitil";
  if (s.includes("jersey central") || s.includes("jcp&l"))
    return "Jersey Central Power & Light";
  if (s.includes("rockland")) return "Rockland Electric Co";
  return null;
}

function guessUtility(text) {
  return (
    normalizeUtilityName(text) ||
    firstMatch(text, /^([A-Z][A-Za-z&.\s]{3,60})\s+(Bill|Invoice|Statement)/m, 1) ||
    "Unknown Utility"
  );
}

function parseAccount(text) {
  return (
    firstMatch(text, /Account\s*(?:#|number)[:\s]*([0-9\-]{6,})/i) ||
    firstMatch(text, /Acct(?:ount)?\s*(?:#|no\.?)[:\s]*([0-9\-]{6,})/i)
  );
}

function parseServiceAddress(text) {
  return firstMatch(text, /Service\s+delivered\s+to:\s*([A-Za-z0-9 #.,&/-]+)/i);
}

function parseDates(text) {
  const m1 = text.match(
    /Billing\s*period.*?([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})\s*(?:to|-|–)\s*([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/i
  );
  if (m1) return { start: m1[1], end: m1[2] };

  const m2 = text.match(
    /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*(?:to|-|–)\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i
  );
  if (m2) return { start: m2[1], end: m2[2] };

  return { start: null, end: null };
}

function parseUsageAndRates(text) {
  // Electric usage (kWh)
  const kwh =
    parseFloat(firstMatch(text, /Total\s+Usage\s*\(?kWh\)?[:\s]+([\d,]*\.?\d*)/i)) ||
    parseFloat((firstMatch(text, /([\d,]*\.?\d*)\s*kWh(?!\/)/i) || "").replace(/,/g, ""));

  // Incumbent electric rate in ¢/kWh
  const eRateC =
    parseFloat(firstMatch(text, /kWh\s*@\s*([\d.]+)\s*¢/i)) ||
    parseFloat(firstMatch(text, /¢\s*\/\s*kWh[^0-9]*([\d.]+)/i));

  // Gas usage (therms)
  const therms =
    parseFloat((firstMatch(text, /Total\s+Gas\s+Use\s*([\d,]*\.?\d*)\s*therms?/i) || "").replace(/,/g, "")) ||
    parseFloat((firstMatch(text, /([\d,]*\.?\d*)\s*therms(?!\/)/i) || "").replace(/,/g, ""));

  // Incumbent gas rate ($/therm)
  let gRateDollar = NaN;
  const centsLine = parseFloat(firstMatch(text, /total gas supply cost[^]*?is\s*([\d.]+)\s*¢/i));
  if (!isNaN(centsLine)) gRateDollar = centsLine / 100;
  else gRateDollar = parseFloat(firstMatch(text, /@\s*([\d.]+)\s*\/\s*(therm|ccf)/i));

  return {
    electricity_kwh: isFinite(kwh) ? Math.round(kwh) : null,
    incumbent_electric_rate: isFinite(eRateC) ? eRateC / 100 : null, // $/kWh
    gas_therms: isFinite(therms) ? Math.round(therms) : null,
    incumbent_gas_rate: isFinite(gRateDollar) ? gRateDollar : null   // $/therm
  };
}

function auditFromText(text) {
  const utility = guessUtility(text);
  const account_number = parseAccount(text);
  const service_address = parseServiceAddress(text);
  const billing_period = parseDates(text);
  const totals = {
    total_due: findMoney(text, ["Total amount due", "Amount due", "Current balance due", "Total due"]),
    delivery_charges: findMoney(text, ["delivery charges", "distribution", "basic service charge"]),
    supply_charges: findMoney(text, ["supply charges", "generation", "energy supply", "gas supply"]),
    taxes: findMoney(text, ["sales tax", "tax", "grt"]),
  };
  const usageRates = parseUsageAndRates(text);

  return {
    utility,
    account_number,
    service_address,
    billing_period,
    totals,
    usage: {
      electricity_kwh: usageRates.electricity_kwh,
      gas_therms: usageRates.gas_therms
    },
    rates_detected: {
      incumbent_electric_rate_usd_per_kwh: usageRates.incumbent_electric_rate,
      incumbent_gas_rate_usd_per_therm: usageRates.incumbent_gas_rate
    },
    meta: { parsed_at: new Date().toISOString(), confidence: "heuristic" },
    _notes: "Generic patterns—add utility-specific regexes over time for higher accuracy."
  };
}

/* ------------------ YOUR COMMERCIAL MATRIX (electric) ------------------ */
// state, utility, zone, rateClass, effectiveMM/YYYY, termMonths, matrixCents, ptcCents
const MATRIX = [
  ["CT","Eversource (Connecticut Light Power)","30","", "10/2025",60, 10.407,11.190],
  ["DE","Delmarva Power & Light","", "GS","09/2025",6, 9.035,10.520],
  ["IL","Ameren","1","DS2","10/2025",6, 7.772,12.180],
  ["IL","Ameren","2","DS2","11/2025",6, 8.008,12.180],
  ["IL","Ameren","3","DS2","10/2025",6, 8.170,12.180],
  ["IL","COMED","0-100","", "11/2025",6, 8.566,10.028],
  ["MA","Eversource (Formerly Boston Edison - NSTAR)","NEMA","G1","09/2025",48, 12.104,15.150],
  ["MA","Eversource (Formerly Boston Edison - NSTAR)","SEMA","G1","09/2025",48, 12.155,15.150],
  ["MA","Eversource (Western Massachusetts Electric Company)","WCMA","G2","09/2025",48, 11.924,13.400],
  ["MA","National Grid (Massachusetts Electric)","WCMA","G1","09/2025",24, 12.556,14.411],
  ["MA","National Grid (Massachusetts Electric)","SEMA","G1","09/2025",24, 12.612,14.411],
  ["MA","National Grid (Massachusetts Electric)","NEMA","G1","09/2025",24, 12.650,14.411],
  ["MA","Unitil","WCMA","G2","10/2025",36, 12.284,13.550],
  ["MD","Baltimore Gas and Electric","","G","09/2025",6, 11.437,12.021],
  ["MD","Delmarva Power & Light","","GS","10/2025",6, 10.720,11.880],
  ["MD","Potomac Edison/Allegany Power","","GS-TypeI","09/2025",9, 10.019,11.320],
  ["NH","Eversource (Formerly PSNH)","","G","09/2025",24, 10.226,13.240],
  ["NJ","Jersey Central Power & Light","","GS1","09/2025",12, 11.327,11.330],
  ["NJ","PSEG","","GLP","11/2025",6, 13.207,15.786],
  ["NJ","Rockland Electric Co","","SGS-S-ND","09/2025",48, 10.932,14.762],
  ["OH","AEP Ohio (Columbus Southern)","","GS2","09/2025",9, 7.854,10.523],
  ["OH","Toledo Edison","","GS","09/2025",9, 8.274,9.770],
  ["PA","Duquesne Light","","GM","09/2025",12, 10.112,10.250],
  ["PA","METED","","GSS","11/2025",48, 9.800,11.576],
  ["PA","PECO","","GS","10/2025",60, 8.634,9.380],
  ["PA","PENELEC","","GSS","10/2025",6, 10.272,11.000],
  ["PA","PPL","","GS1","09/2025",10, 10.443,12.114],
  ["PA","PennPower","","GS","11/2025",54, 10.973,12.720],
  ["PA","West Penn Power","","GS20D","10/2025",6, 9.063,10.537],
].map(r => ({
  state: r[0], utility: r[1], zone: r[2] || "", rateClass: r[3] || "",
  effective: r[4], termMonths: r[5], matrixCents: r[6], ptcCents: r[7]
}));

function pickMatrixOffer(utilityName) {
  if (!utilityName) return null;
  const canon = normalizeUtilityName(utilityName) || utilityName;
  const matches = MATRIX.filter(r =>
    r.utility.toLowerCase().includes(canon.toLowerCase()) ||
    canon.toLowerCase().includes(r.utility.toLowerCase())
  );
  if (matches.length === 0) return null;
  matches.sort((a,b)=> a.matrixCents - b.matrixCents);
  return matches[0];
}

function computeElectricSavings(kwh, incumbentRateUsdPerKwh, offerCentsPerKwh) {
  if (!isFinite(kwh) || !isFinite(incumbentRateUsdPerKwh) || !isFinite(offerCentsPerKwh)) return null;
  const offer = offerCentsPerKwh / 100.0; // $/kWh
  const monthly_inc = kwh * incumbentRateUsdPerKwh;
  const monthly_off = kwh * offer;
  const monthly_sav = monthly_inc - monthly_off;
  return {
    unit: "kWh",
    monthly_usage: kwh,
    current_rate: incumbentRateUsdPerKwh, // $/kWh
    offer_rate: offer,                    // $/kWh
    monthly_savings: monthly_sav,
    annual_savings: monthly_sav * 12,
    term_savings: {
      "2yr": monthly_sav * 12 * 2,
      "3yr": monthly_sav * 12 * 3,
      "4yr": monthly_sav * 12 * 4,
      "5yr": monthly_sav * 12 * 5,
    }
  };
}

/* ------------------ routes ------------------ */
app.get("/healthz", (_req, res) => res.send("ok"));

app.get("/", (_req, res) => {
  // Tiny tester page; your washer page should POST directly to /proposal
  res.type("html").send(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wattly API tester</title>
<style>body{font-family:system-ui,Arial;background:#000;color:#fff;margin:24px}
.box{background:#0b0b0b;border:1px solid #222;border-radius:12px;padding:16px;max-width:760px}
pre{white-space:pre-wrap;background:#0a0a0a;border:1px dashed #666;padding:10px;border-radius:10px}
small{color:#bbb}</style>
<div class="box">
  <h3>Wattly Bill → Audit</h3>
  <small>Upload a PDF (field <code>bill</code>). This is just for testing the backend.</small><br>
  <input id="f" type="file" accept="application/pdf">
  <button id="go">Upload & Parse</button>
  <pre id="out">Waiting…</pre>
</div>
<script>
  const out=document.getElementById('out'), f=document.getElementById('f');
  document.getElementById('go').onclick=async()=>{
    if(!f.files[0]){ out.textContent='Pick a PDF first.'; return; }
    const fd=new FormData(); fd.append('bill',f.files[0],f.files[0].name);
    out.textContent='Uploading…';
    try{
      const r=await fetch('/proposal',{method:'POST',body:fd,mode:'cors'});
      const ct=r.headers.get('content-type')||'';
      if(ct.includes('application/pdf')){ out.textContent='Got PDF ('+r.status+'). Saving…'; const b=await r.blob(); const a=document.createElement('a'); a.href=URL.createObjectURL(b); a.download='wattly_proposal.pdf'; a.click(); }
      else { out.textContent='Status '+r.status+'\\n\\n'+await r.text(); }
    }catch(e){ out.textContent='Fetch error: '+e; }
  };
</script>`);
});

app.post("/proposal", async (req, res) => {
  try {
    if (!req.files || !req.files.bill) {
      return res.status(400).json({ ok:false, error: "Upload field must be 'bill' (PDF)." });
    }
    const file = req.files.bill;
    if (!/\.pdf$/i.test(file.name)) {
      return res.status(400).json({ ok:false, error: "Please upload a PDF." });
    }

    const parsed = await pdfParse(file.data);
    const text = (parsed.text || "").trim();
    if (!text) return res.status(422).json({ ok:false, error: "Could not extract text from PDF." });

    // ORIGINAL behavior: build the audit object from the bill (no inputs)
    const audit = auditFromText(text);

    // ADD-ON: auto-pick a matrix electric offer for this utility and compute savings (monthly x 12, and 2–5 yrs)
    const util = audit.utility || "";
    const picked = pickMatrixOffer(util);
    let electricSavings = null;
    if (
      picked &&
      isFinite(audit?.usage?.electricity_kwh) &&
      isFinite(audit?.rates_detected?.incumbent_electric_rate_usd_per_kwh)
    ) {
      electricSavings = computeElectricSavings(
        Number(audit.usage.electricity_kwh),
        Number(audit.rates_detected.incumbent_electric_rate_usd_per_kwh),
        Number(picked.matrixCents)
      );
    }

    // If client asks for PDF explicitly (?format=pdf) AND pdfkit is installed, stream a 1-page B/W proposal
    const wantPdf = (String(req.query.format || req.body.format || "").toLowerCase() === "pdf");
    if (wantPdf && PDFDocument) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=\"wattly_proposal.pdf\"");
      const doc = new PDFDocument({ size: "LETTER", margin: 48 });
      doc.pipe(res);

      const money = (n)=> (isFinite(n) ? `$${Number(n).toFixed(2)}` : "—");
      const rateC = (r)=> (isFinite(r) ? `${(Number(r)*100).toFixed(3)}¢/kWh` : "—");

      doc.font("Helvetica-Bold").fontSize(20).text("ENERGY PROPOSAL", { align: "left" });
      doc.moveDown(0.4);
      doc.font("Helvetica").fontSize(10).text(`Prepared: ${new Date().toLocaleDateString()}`);
      doc.moveDown();

      // Header block (black/white style)
      doc.font("Helvetica-Bold").text("Prepared For:");
      doc.font("Helvetica")
        .text(`Utility: ${audit.utility || "—"}`)
        .text(`Account: ${audit.account_number || "—"}`)
        .text(`Service Address: ${audit.service_address || "—"}`)
        .text(`Billing: ${(audit.billing_period?.start || "—")} → ${(audit.billing_period?.end || "—")}`);
      doc.moveDown();
      doc.font("Helvetica-Bold").text("Totals");
      doc.font("Helvetica")
        .text(`Total Due: ${money(audit.totals?.total_due)}`)
        .text(`Delivery Charges: ${money(audit.totals?.delivery_charges)}`)
        .text(`Supply Charges: ${money(audit.totals?.supply_charges)}`)
        .text(`Taxes: ${money(audit.totals?.taxes)}`);
      doc.moveDown();
      doc.font("Helvetica-Bold").text("Usage");
      doc.font("Helvetica")
        .text(`Electricity: ${isFinite(audit.usage?.electricity_kwh) ? audit.usage.electricity_kwh : "—"} kWh`)
        .text(`Gas: ${isFinite(audit.usage?.gas_therms) ? audit.usage.gas_therms : "—"} therms`);
      doc.moveDown();

      if (electricSavings) {
        doc.font("Helvetica-Bold").text("Electric Savings (Auto from Matrix)");
        doc.font("Helvetica")
          .text(`Current Rate: ${rateC(audit.rates_detected?.incumbent_electric_rate_usd_per_kwh || NaN)}`)
          .text(`Offered Rate: ${rateC(electricSavings.offer_rate)}`)
          .text(`Estimated Monthly Savings: ${money(electricSavings.monthly_savings)}`)
          .text(`Estimated Annual Savings: ${money(electricSavings.annual_savings)}`)
          .text(`2yr: ${money(electricSavings.term_savings["2yr"])}   3yr: ${money(electricSavings.term_savings["3yr"])}`)
          .text(`4yr: ${money(electricSavings.term_savings["4yr"])}   5yr: ${money(electricSavings.term_savings["5yr"])}`);
      } else {
        doc.font("Helvetica-Bold").text("Electric Savings");
        doc.font("Helvetica").text("Insufficient data auto-extracted from this bill to compute savings.");
      }

      doc.end();
      return;
    }

    // DEFAULT: JSON (black & white audit + savings block)
    res.json({
      ok: true,
      audit,
      savings: {
        electric: electricSavings,
        combined: electricSavings ? {
          monthly_savings: electricSavings.monthly_savings,
          annual_savings: electricSavings.annual_savings,
          term_savings: electricSavings.term_savings
        } : null
      },
      offer_source: electricSavings && picked ? {
        state: picked.state,
        utility: picked.utility,
        zone: picked.zone,
        rate_class: picked.rateClass,
        effective: picked.effective,
        term_months: picked.termMonths,
        matrix_rate_cents_per_kwh: picked.matrixCents,
        utility_ptc_cents_per_kwh: picked.ptcCents
      } : null
    });

  } catch (err) {
    console.error("Proposal error:", err);
    res.status(500).json({ ok:false, error: "Server error", detail: String(err.message || err) });
  }
});

/* ------------------ start ------------------ */
app.listen(PORT, BIND, () => {
  console.log(`Server listening on http://${BIND}:${PORT}`);
});
