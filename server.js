const express = require("express");
const fileUpload = require("express-fileupload");
const app = express();

app.use(fileUpload({ limits: { fileSize: 20 * 1024 * 1024 } }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => {
  res.send(`<!doctype html><html><body style="font-family:Arial">
    <h2>Upload Bill → Proposal (Smoke Test)</h2>
    <form action="/proposal" method="post" enctype="multipart/form-data" target="_blank">
      <input type="file" name="bill" accept="application/pdf" required>
      <button type="submit">Generate</button>
    </form>
    <p>If you see this page, the server is running.</p>
  </body></html>`);
});

app.post("/proposal", (_req, res) => {
  res.send("<h1>Server is running ✅</h1><p>PDF parsing comes next.</p>");
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log("Listening on " + PORT));
