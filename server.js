// server.js
// Minimal bill-audit API for Render (Node/Express + pdf-parse)

const express = require("express");
const fileUpload = require("express-fileupload");
const pdfParse = require("pdf-parse");

const app = express();

// ---------- Config ----------
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

// ---------- Helpers ----------
function firstMatch(text, regex) {
  const m = text.match(regex);
  return m ? m[1].trim() : null;
}

function findMoney(text, labels = []) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (labels.length) {
    const labelRegex = new RegExp(labels.join("|"), "i");
    for (let i = 0; i < lines.length; i++) {
      if (labelRegex.test(lines[i])) {
