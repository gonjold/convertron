const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getStorage } = require("firebase-admin/storage");
const { getFirestore } = require("firebase-admin/firestore");
const ffmpegPath = require("ffmpeg-static");
const ffmpeg = require("fluent-ffmpeg");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execSync } = require("child_process");

// Verify ffmpeg binary at startup
console.log("[convertron] ffmpeg-static path:", ffmpegPath);
try {
  const exists = fs.existsSync(ffmpegPath);
  console.log("[convertron] ffmpeg binary exists:", exists);
  if (exists) {
    const stats = fs.statSync(ffmpegPath);
    console.log("[convertron] ffmpeg binary size:", stats.size, "mode:", stats.mode.toString(8));
    // Ensure executable
    fs.chmodSync(ffmpegPath, 0o755);
    const version = execSync(`${ffmpegPath} -version 2>&1 | head -1`, { timeout: 5000 }).toString().trim();
    console.log("[convertron] ffmpeg version:", version);
  }
} catch (err) {
  console.error("[convertron] ffmpeg binary check failed:", err.message);
}

ffmpeg.setFfmpegPath(ffmpegPath);

initializeApp();
const storage = getStorage();
const db = getFirestore();

exports.convertMedia = onCall(
  {
    region: "us-east1",
    timeoutSeconds: 540,
    memory: "4GiB",
    cpu: 2,
    maxInstances: 10,
    concurrency: 1,
  },
  async (request) => {
    const { storagePath, outputFormat, docId } = request.data;
    console.log("[convertron] Request received:", { storagePath, outputFormat, docId });

    // Validate inputs
    if (!storagePath || !outputFormat || !docId) {
      throw new HttpsError("invalid-argument", "Missing required fields: storagePath, outputFormat, docId");
    }

    // Path traversal prevention
    const normalizedPath = path.posix.normalize(storagePath);
    if (!normalizedPath.startsWith("temp/conversions/") || normalizedPath.includes("..")) {
      throw new HttpsError("invalid-argument", "Invalid storage path");
    }

    const allowedFormats = ["mp4", "webm", "avi", "mov", "mkv", "gif", "mp3", "wav", "ogg", "flac", "aac"];
    if (!allowedFormats.includes(outputFormat)) {
      throw new HttpsError("invalid-argument", `Unsupported format: ${outputFormat}`);
    }

    const docRef = db.collection("conversions").doc(docId);
    const tmpId = crypto.randomBytes(8).toString("hex");
    const inputPath = path.join(os.tmpdir(), `input_${tmpId}`);
    const outputPath = path.join(os.tmpdir(), `output_${tmpId}.${outputFormat}`);

    try {
      // Update status to processing
      console.log("[convertron] Updating status to processing...");
      await docRef.update({ status: "processing", startedAt: Date.now() });

      // Download input from Storage
      console.log("[convertron] Downloading from Storage:", normalizedPath);
      const bucket = storage.bucket();
      const inputFile = bucket.file(normalizedPath);
      const [exists] = await inputFile.exists();
      if (!exists) {
        throw new HttpsError("not-found", "Input file not found in storage");
      }
      await inputFile.download({ destination: inputPath });
      const inputStats = fs.statSync(inputPath);
      console.log("[convertron] Downloaded:", inputStats.size, "bytes to", inputPath);

      // Run FFmpeg conversion
      console.log("[convertron] Starting FFmpeg:", outputFormat);
      const startTime = Date.now();

      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(inputPath);

        // Format-specific encoding settings
        // Output -r 30 caps framerate (prevents VFR WebM 1000fps explosion)
        // This is NOT the same as input -r 30 which breaks playback speed
        if (outputFormat === "mp4") {
          cmd = cmd
            .videoCodec("libx264")
            .audioCodec("aac")
            .outputOptions(["-r", "30", "-preset", "fast", "-crf", "26", "-movflags", "+faststart"]);
        } else if (outputFormat === "webm") {
          cmd = cmd
            .videoCodec("libvpx-vp9")
            .audioCodec("libopus")
            .outputOptions(["-r", "30", "-crf", "33", "-b:v", "0", "-cpu-used", "4", "-deadline", "realtime"]);
        } else if (outputFormat === "gif") {
          cmd = cmd
            .outputOptions(["-vf", "fps=15,scale=480:-1:flags=lanczos", "-loop", "0"])
            .noAudio();
        } else if (outputFormat === "mp3") {
          cmd = cmd.noVideo().audioCodec("libmp3lame").audioBitrate("192k");
        } else if (outputFormat === "wav") {
          cmd = cmd.noVideo();
        } else if (outputFormat === "ogg") {
          cmd = cmd.noVideo().audioCodec("libvorbis");
        } else if (outputFormat === "flac") {
          cmd = cmd.noVideo().audioCodec("flac");
        } else if (outputFormat === "aac") {
          cmd = cmd.noVideo().audioCodec("aac").audioBitrate("192k");
        } else if (outputFormat === "avi") {
          cmd = cmd.videoCodec("libx264").audioCodec("aac").outputOptions(["-r", "30", "-preset", "fast", "-crf", "26"]);
        } else if (outputFormat === "mov") {
          cmd = cmd.videoCodec("libx264").audioCodec("aac").outputOptions(["-r", "30", "-preset", "fast", "-crf", "26", "-movflags", "+faststart"]);
        } else if (outputFormat === "mkv") {
          cmd = cmd.videoCodec("libx264").audioCodec("aac").outputOptions(["-r", "30", "-preset", "fast", "-crf", "26"]);
        }

        cmd
          .on("start", (cmdLine) => console.log("[convertron] FFmpeg command:", cmdLine))
          .on("stderr", (line) => {
            // Log FFmpeg stderr output periodically (progress info)
            if (line.includes("time=") || line.includes("error") || line.includes("Error")) {
              console.log("[convertron] FFmpeg:", line.trim());
            }
          })
          .on("end", () => {
            console.log("[convertron] FFmpeg finished in", ((Date.now() - startTime) / 1000).toFixed(1), "s");
            resolve();
          })
          .on("error", (err) => {
            console.error("[convertron] FFmpeg error:", err.message);
            reject(new Error(`FFmpeg error: ${err.message}`));
          })
          .output(outputPath)
          .run();
      });

      // Upload result to Storage
      const outputStats = fs.statSync(outputPath);
      console.log("[convertron] Output file:", outputStats.size, "bytes");

      const outputStoragePath = `temp/conversions/${docId}/output.${outputFormat}`;
      const downloadToken = crypto.randomUUID();
      console.log("[convertron] Uploading to Storage:", outputStoragePath);
      await bucket.upload(outputPath, {
        destination: outputStoragePath,
        metadata: {
          contentType: getMimeType(outputFormat),
          metadata: {
            firebaseStorageDownloadTokens: downloadToken,
          },
        },
      });

      // Build Firebase download URL (no IAM signBlob permission needed)
      const bucketName = bucket.name;
      const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(outputStoragePath)}?alt=media&token=${downloadToken}`;
      console.log("[convertron] Download URL generated");

      // Update Firestore with result
      console.log("[convertron] Updating Firestore: complete");
      await docRef.update({
        status: "complete",
        downloadUrl,
        outputSize: outputStats.size,
        completedAt: Date.now(),
      });

      // Clean up input file from Storage
      await inputFile.delete().catch(() => {});

      console.log("[convertron] Done! URL length:", downloadUrl.length);
      return { success: true, downloadUrl };
    } catch (err) {
      console.error("[convertron] CAUGHT ERROR:", err.message, err.stack);

      // Update Firestore with error
      await docRef.update({
        status: "error",
        error: err.message || "Conversion failed",
        completedAt: Date.now(),
      }).catch((e) => console.error("[convertron] Failed to update error status:", e.message));

      if (err instanceof HttpsError) throw err;
      throw new HttpsError("internal", err.message || "Conversion failed");
    } finally {
      // Clean up tmp files
      try { fs.unlinkSync(inputPath); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}
    }
  }
);

function getMimeType(format) {
  const map = {
    mp4: "video/mp4",
    webm: "video/webm",
    avi: "video/x-msvideo",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    gif: "image/gif",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    aac: "audio/aac",
  };
  return map[format] || "application/octet-stream";
}
