const express = require("express");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const tesseract = require("tesseract.js");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

const app = express();
const upload = multer({ dest: "uploads/" });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simple home route
app.get("/", (req, res) => {
  res.send("Wattly Bill Audit API is running.");
});

// Upload route
app.post("/upload", upload.single("bill"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const filePath = path.join(__dirname, req.file.path);
  let textContent = "";

  try {
    if (req.file.mimetype === "application/pdf") {
      const dataBuffer = fs.readFileSync(filePath);
      const pdfData = await pdfParse(dataBuffer);
      textContent = pdfData.text;
    } else {
      const ocrResult = await tesseract.recognize(filePath, "eng");
      textContent = ocrResult.data.text;
    }

    // Example: Extract total kWh or therm usage
    const usageMatch = textContent.match(/(\d{1,5})\s?(kWh|therms?)/i);
    const usage = usageMatch ? usageMatch[1] + " " + usageMatch[2] : "Not found";

    // Example: Extract rate
    const rateMatch = textContent.match(/\$?\d+\.\d+\s?(per kWh|\/therm)?/i);
    const rate = rateMatch ? rateMatch[0] : "Not found";

    const auditResult = `
      Wattly Bill Audit Results:
      Usage: ${usage}
      Rate: ${rate}
      Savings Estimate: ${(Math.random() * 20).toFixed(2)}%  (demo)
    `;

    // Send email
    let transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });

    await transporter.sendMail({
      from: `"Wattly Bill Audit" <${process.env.EMAIL_USER}>`,
      to: req.body.email || process.env.EMAIL_USER,
      cc: "sales@wattly.net",
      subject: "Your Wattly Bill Audit Results",
      text: auditResult
    });

    // Clean up uploaded file
    fs.unlinkSync(filePath);

    res.json({ message: "Audit complete, results sent by email", audit: auditResult });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error processing file" });
  }
});

// Render requires listening on process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
