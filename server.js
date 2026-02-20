const express = require("express");
const multer = require("multer");
const unzipper = require("unzipper");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = 3000;

app.use(express.static("public"));

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 100 * 1024 * 1024 } // max 100MB
});

app.post("/upload", upload.single("project"), (req, res) => {
  if (!req.file) return res.send("No file uploaded");

  const buildId = uuidv4();
  const extractPath = path.join(__dirname, "builds", buildId);

  fs.mkdirSync(extractPath, { recursive: true });

  console.log("Extracting...");

  fs.createReadStream(req.file.path)
    .pipe(unzipper.Extract({ path: extractPath }))
    .on("close", () => {

      console.log("Building APK...");

      exec(
        `cd ${extractPath} && flutter pub get && flutter build apk --release`,
        { maxBuffer: 1024 * 1024 * 500 },
        (err, stdout, stderr) => {

          if (err) {
            console.error(err);
            return res.send("Build failed");
          }

          const apkPath = path.join(
            extractPath,
            "build/app/outputs/flutter-apk/app-release.apk"
          );

          if (!fs.existsSync(apkPath)) {
            return res.send("APK not found");
          }

          res.download(apkPath, "app-release.apk", () => {
            // Cleanup
            fs.rmSync(extractPath, { recursive: true, force: true });
            fs.unlinkSync(req.file.path);
          });

        }
      );
    });
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
