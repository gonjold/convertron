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

ffmpeg.setFfmpegPath(ffmpegPath);

initializeApp();
const storage = getStorage();
const db = getFirestore();

exports.convertMedia = onCall(
  {
    region: "us-east1",
    timeoutSeconds: 300,
    memory: "2GiB",
    maxInstances: 10,
  },
  async (request) => {
    const { storagePath, outputFormat, docId } = request.data;

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
      await docRef.update({ status: "processing", startedAt: Date.now() });

      // Download input from Storage
      const bucket = storage.bucket();
      const inputFile = bucket.file(normalizedPath);
      const [exists] = await inputFile.exists();
      if (!exists) {
        throw new HttpsError("not-found", "Input file not found in storage");
      }
      await inputFile.download({ destination: inputPath });

      // Run FFmpeg conversion
      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(inputPath);

        // Format-specific encoding settings
        if (outputFormat === "mp4") {
          cmd = cmd
            .videoCodec("libx264")
            .audioCodec("aac")
            .outputOptions(["-movflags", "+faststart", "-preset", "fast", "-crf", "23"]);
        } else if (outputFormat === "webm") {
          cmd = cmd
            .videoCodec("libvpx-vp9")
            .audioCodec("libopus")
            .outputOptions(["-crf", "30", "-b:v", "0"]);
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
          cmd = cmd.videoCodec("libx264").audioCodec("aac");
        } else if (outputFormat === "mov") {
          cmd = cmd.videoCodec("libx264").audioCodec("aac").outputOptions(["-movflags", "+faststart"]);
        } else if (outputFormat === "mkv") {
          cmd = cmd.videoCodec("libx264").audioCodec("aac");
        }

        cmd
          .output(outputPath)
          .on("end", resolve)
          .on("error", (err) => reject(new Error(`FFmpeg error: ${err.message}`)))
          .run();
      });

      // Upload result to Storage
      const outputStoragePath = `temp/conversions/${docId}/output.${outputFormat}`;
      await bucket.upload(outputPath, {
        destination: outputStoragePath,
        metadata: {
          contentType: getMimeType(outputFormat),
        },
      });

      // Generate signed download URL (7-day expiry)
      const [downloadUrl] = await bucket.file(outputStoragePath).getSignedUrl({
        action: "read",
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });

      // Get output file size
      const outputStats = fs.statSync(outputPath);

      // Update Firestore with result
      await docRef.update({
        status: "complete",
        downloadUrl,
        outputSize: outputStats.size,
        completedAt: Date.now(),
      });

      // Clean up input file from Storage
      await inputFile.delete().catch(() => {});

      return { success: true, downloadUrl };
    } catch (err) {
      // Update Firestore with error
      await docRef.update({
        status: "error",
        error: err.message || "Conversion failed",
        completedAt: Date.now(),
      }).catch(() => {});

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
