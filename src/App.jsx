import { useState, useRef, useCallback, useEffect } from "react";

const SUPPORTED_CONVERSIONS = {
  image: {
    label: "Image", icon: "🖼",
    inputFormats: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "svg", "ico", "tiff", "avif"],
    outputFormats: ["png", "jpg", "webp", "bmp", "gif", "ico"],
    color: "#10b981",
  },
  video: {
    label: "Video", icon: "🎬",
    inputFormats: ["webm", "mp4", "avi", "mov", "mkv", "flv", "wmv", "m4v", "3gp", "ogv"],
    outputFormats: ["mp4", "webm", "avi", "mov", "mkv", "gif"],
    color: "#6366f1",
  },
  audio: {
    label: "Audio", icon: "🎵",
    inputFormats: ["mp3", "wav", "ogg", "flac", "aac", "wma", "m4a", "opus", "webm"],
    outputFormats: ["mp3", "wav", "ogg", "flac", "aac"],
    color: "#f59e0b",
  },
};

function getFileCategory(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  for (const [cat, info] of Object.entries(SUPPORTED_CONVERSIONS)) {
    if (info.inputFormats.includes(ext)) return cat;
  }
  return null;
}

function getFileExt(filename) {
  return filename.split(".").pop().toLowerCase();
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

async function convertImage(file, outputFormat, onProgress) {
  return new Promise((resolve, reject) => {
    onProgress(10);
    const reader = new FileReader();
    reader.onload = (e) => {
      onProgress(30);
      const img = new Image();
      img.onload = () => {
        onProgress(50);
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (outputFormat === "jpg" || outputFormat === "ico") {
          ctx.fillStyle = "#FFFFFF";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(img, 0, 0);
        onProgress(70);
        const mimeMap = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", bmp: "image/bmp", gif: "image/gif", ico: "image/png" };
        canvas.toBlob(
          (blob) => { if (!blob) { reject(new Error("Conversion failed")); return; } onProgress(100); resolve(blob); },
          mimeMap[outputFormat] || "image/png", 0.92
        );
      };
      img.onerror = () => reject(new Error("Failed to load image"));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

let ffmpegInstance = null;
let ffmpegLoading = false;
let ffmpegLoadListeners = [];

function notifyFFmpegListeners(status) {
  ffmpegLoadListeners.forEach((fn) => fn(status));
}

async function loadFFmpeg(onProgress) {
  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoading) {
    while (ffmpegLoading) await new Promise((r) => setTimeout(r, 200));
    if (!ffmpegInstance) throw new Error("FFmpeg failed to load.");
    return ffmpegInstance;
  }
  ffmpegLoading = true;
  notifyFFmpegListeners("loading");
  onProgress(5);
  try {
    const { FFmpeg } = await import("@ffmpeg/ffmpeg");
    const { fetchFile, toBlobURL } = await import("@ffmpeg/util");
    const ffmpeg = new FFmpeg();
    onProgress(15);
    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm";
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    });
    onProgress(30);
    ffmpegInstance = { ffmpeg, fetchFile };
    ffmpegLoading = false;
    notifyFFmpegListeners("ready");
    return ffmpegInstance;
  } catch (err) {
    ffmpegLoading = false;
    notifyFFmpegListeners("error");
    throw new Error("FFmpeg failed to load. Make sure the site is served with Cross-Origin headers enabled.");
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Conversion timed out after ${Math.round(ms / 1000)}s. Try a smaller file or different format.`)), ms)),
  ]);
}

async function convertMedia(file, outputFormat, onProgress) {
  const { ffmpeg, fetchFile } = await loadFFmpeg(onProgress);
  const inputExt = getFileExt(file.name);
  const inputName = `input.${inputExt}`;
  const outputName = `output.${outputFormat}`;
  onProgress(40);
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  onProgress(50);
  let args = ["-i", inputName];
  if (outputFormat === "gif") args.push("-vf", "fps=15,scale=480:-1:flags=lanczos", "-loop", "0");
  else if (outputFormat === "mp4") args.push("-c:v", "libx264", "-preset", "fast", "-crf", "23", "-c:a", "aac");
  else if (outputFormat === "webm") args.push("-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0", "-c:a", "libopus");
  else if (outputFormat === "mp3") args.push("-vn", "-ab", "192k");
  else if (outputFormat === "wav") args.push("-vn");
  else if (outputFormat === "ogg") args.push("-vn", "-c:a", "libvorbis");
  else if (outputFormat === "flac") args.push("-vn", "-c:a", "flac");
  else if (outputFormat === "aac") args.push("-vn", "-c:a", "aac", "-b:a", "192k");
  args.push(outputName);
  onProgress(60);
  await withTimeout(ffmpeg.exec(args), 60000);
  onProgress(90);
  const data = await ffmpeg.readFile(outputName);
  onProgress(100);
  const mimeMap = { mp4: "video/mp4", webm: "video/webm", avi: "video/x-msvideo", mov: "video/quicktime", mkv: "video/x-matroska", gif: "image/gif", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac" };
  return new Blob([data.buffer], { type: mimeMap[outputFormat] || "application/octet-stream" });
}

function Spinner({ size = 16, color = "#6366f1" }) {
  return (
    <div style={{ width: size, height: size, border: `2px solid ${color}33`, borderTopColor: color, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
  );
}

function FFmpegBanner({ status }) {
  if (status === "loading") return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "12px 20px", background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 10, marginBottom: 16 }}>
      <Spinner size={14} color="#6366f1" />
      <span style={{ fontSize: 13, color: "#a5b4fc", fontFamily: "'JetBrains Mono', monospace" }}>Loading video engine (~30 MB, first time only)...</span>
    </div>
  );
  if (status === "error") return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "12px 20px", background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 10, marginBottom: 16 }}>
      <span style={{ fontSize: 13, color: "#fca5a5", fontFamily: "'JetBrains Mono', monospace" }}>Failed to load video engine. Cross-Origin headers may be missing.</span>
    </div>
  );
  return null;
}

function FileItem({ item, onRemove, onFormatChange }) {
  const cat = SUPPORTED_CONVERSIONS[item.category];
  const barColor = cat?.color || "#888";
  return (
    <div style={{ background: item.status === "done" ? "rgba(16,185,129,0.06)" : item.status === "error" ? "rgba(239,68,68,0.06)" : "rgba(255,255,255,0.03)", border: `1px solid ${item.status === "done" ? "rgba(16,185,129,0.2)" : item.status === "error" ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.08)"}`, borderRadius: 10, padding: "14px 18px", display: "flex", alignItems: "center", gap: 14, transition: "all 0.3s ease", flexWrap: "wrap" }}>
      <div style={{ fontSize: 26, lineHeight: 1 }}>{cat?.icon || "📄"}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "'JetBrains Mono', 'SF Mono', monospace", fontSize: 13, fontWeight: 600, color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{item.file.name}</span>
          <span style={{ fontSize: 11, color: "#64748b", fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>{formatBytes(item.file.size)}</span>
        </div>
        {item.status === "converting" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
            <div style={{ flex: 1, height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${item.progress}%`, background: `linear-gradient(90deg, ${barColor}, ${barColor}cc)`, borderRadius: 2, transition: "width 0.3s ease" }} />
            </div>
            <Spinner size={12} color={barColor} />
          </div>
        )}
        {item.status === "error" && <div style={{ fontSize: 11, color: "#ef4444", marginTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>{item.error}</div>}
        {item.status === "done" && item.outputBlob && <div style={{ fontSize: 11, color: "#10b981", marginTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>✓ Converted · {formatBytes(item.outputBlob.size)}</div>}
      </div>
      {item.status === "idle" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, color: "#64748b" }}>→</span>
          <select value={item.outputFormat} onChange={(e) => onFormatChange(item.id, e.target.value)}
            style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, color: "#e2e8f0", padding: "6px 10px", fontSize: 13, fontFamily: "'JetBrains Mono', monospace", cursor: "pointer", outline: "none", textTransform: "uppercase" }}>
            {cat?.outputFormats.filter(f => f !== getFileExt(item.file.name)).map((f) => (<option key={f} value={f}>{f}</option>))}
          </select>
        </div>
      )}
      {item.status === "done" && item.outputBlob && (
        <button onClick={() => { const url = URL.createObjectURL(item.outputBlob); const a = document.createElement("a"); a.href = url; a.download = item.file.name.replace(/\.[^.]+$/, `.${item.outputFormat}`); a.click(); URL.revokeObjectURL(url); }}
          style={{ background: "linear-gradient(135deg, #10b981, #059669)", border: "none", borderRadius: 8, color: "#fff", padding: "8px 16px", fontSize: 12, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          ↓ Save
        </button>
      )}
      {item.status !== "converting" && (
        <button onClick={() => onRemove(item.id)} style={{ background: "none", border: "none", color: "#475569", fontSize: 18, cursor: "pointer", padding: "4px 8px", lineHeight: 1 }}>×</button>
      )}
    </div>
  );
}

export default function FileConverter() {
  const [files, setFiles] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [ffmpegStatus, setFfmpegStatus] = useState(null);
  const fileInputRef = useRef(null);
  const idCounter = useRef(0);

  useEffect(() => {
    const listener = (status) => setFfmpegStatus(status);
    ffmpegLoadListeners.push(listener);
    return () => { ffmpegLoadListeners = ffmpegLoadListeners.filter((fn) => fn !== listener); };
  }, []);

  const addFiles = useCallback((newFiles) => {
    const items = Array.from(newFiles).map((file) => {
      const category = getFileCategory(file.name);
      const ext = getFileExt(file.name);
      const outputFormats = category ? SUPPORTED_CONVERSIONS[category].outputFormats.filter(f => f !== ext) : [];
      let defaultOutput = outputFormats[0] || "";
      if (ext === "webm" && outputFormats.includes("mp4")) defaultOutput = "mp4";
      if (ext === "png" && outputFormats.includes("jpg")) defaultOutput = "jpg";
      if (ext === "wav" && outputFormats.includes("mp3")) defaultOutput = "mp3";
      if (ext === "bmp" && outputFormats.includes("png")) defaultOutput = "png";
      if (ext === "flac" && outputFormats.includes("mp3")) defaultOutput = "mp3";
      return { id: ++idCounter.current, file, category, outputFormat: defaultOutput, status: category ? "idle" : "unsupported", progress: 0, outputBlob: null, error: null };
    });
    setFiles((prev) => [...prev, ...items]);
  }, []);

  // Clipboard paste support
  useEffect(() => {
    const handlePaste = (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const pastedFiles = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) pastedFiles.push(file);
        }
      }
      if (pastedFiles.length > 0) {
        e.preventDefault();
        addFiles(pastedFiles);
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [addFiles]);

  const handleDrop = useCallback((e) => { e.preventDefault(); setIsDragging(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }, [addFiles]);
  const handleDragOver = useCallback((e) => { e.preventDefault(); setIsDragging(true); }, []);
  const handleDragLeave = useCallback((e) => { e.preventDefault(); setIsDragging(false); }, []);
  const removeFile = (id) => setFiles((prev) => prev.filter((f) => f.id !== id));
  const changeFormat = (id, format) => setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, outputFormat: format } : f)));

  const convertFile = async (item) => {
    setFiles((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: "converting", progress: 0 } : f)));
    const onProgress = (p) => setFiles((prev) => prev.map((f) => (f.id === item.id ? { ...f, progress: p } : f)));
    try {
      let blob;
      if (item.category === "image") blob = await convertImage(item.file, item.outputFormat, onProgress);
      else blob = await convertMedia(item.file, item.outputFormat, onProgress);
      setFiles((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: "done", progress: 100, outputBlob: blob } : f)));
    } catch (err) {
      setFiles((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: "error", error: err.message } : f)));
    }
  };

  const convertAll = () => files.filter((f) => f.status === "idle" && f.category).forEach(convertFile);
  const downloadAll = () => { files.filter((f) => f.status === "done" && f.outputBlob).forEach((f) => { const url = URL.createObjectURL(f.outputBlob); const a = document.createElement("a"); a.href = url; a.download = f.file.name.replace(/\.[^.]+$/, `.${f.outputFormat}`); a.click(); URL.revokeObjectURL(url); }); };
  const clearAll = () => setFiles([]);
  const idleFiles = files.filter((f) => f.status === "idle");
  const doneFiles = files.filter((f) => f.status === "done");
  const allFormats = Object.values(SUPPORTED_CONVERSIONS).flatMap((c) => c.inputFormats);
  const uniqueFormats = [...new Set(allFormats)].sort();

  return (
    <div style={{ minHeight: "100vh", background: "#0a0e17", color: "#e2e8f0", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "fixed", inset: 0, backgroundImage: "linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)", backgroundSize: "60px 60px", pointerEvents: "none" }} />
      <div style={{ position: "relative", zIndex: 1, maxWidth: 720, margin: "0 auto", padding: "40px 20px" }}>
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: "linear-gradient(135deg, #6366f1, #10b981)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>⚡</div>
            <h1 style={{ fontSize: "clamp(24px, 5vw, 32px)", fontWeight: 800, letterSpacing: "-0.03em", margin: 0, background: "linear-gradient(135deg, #e2e8f0, #94a3b8)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>CONVERTRON</h1>
          </div>
          <p style={{ color: "#64748b", fontSize: "clamp(11px, 2.5vw, 14px)", margin: 0, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.02em" }}>Free, private, runs in your browser · No uploads, no servers, no limits</p>
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 6, marginTop: 20 }}>
            {Object.entries(SUPPORTED_CONVERSIONS).map(([key, cat]) => (
              <div key={key} style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 20, background: `${cat.color}11`, border: `1px solid ${cat.color}33`, fontSize: 11, color: cat.color, fontFamily: "'JetBrains Mono', monospace", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                <span>{cat.icon}</span><span>{cat.label}</span><span style={{ opacity: 0.5 }}>· {cat.inputFormats.length} formats</span>
              </div>
            ))}
          </div>
        </div>

        <FFmpegBanner status={ffmpegStatus} />

        <div onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onClick={() => fileInputRef.current?.click()}
          style={{ border: `2px dashed ${isDragging ? "#6366f1" : "rgba(255,255,255,0.1)"}`, borderRadius: 16, padding: files.length === 0 ? "60px 20px" : "30px 20px", textAlign: "center", cursor: "pointer", transition: "all 0.3s ease", background: isDragging ? "rgba(99,102,241,0.05)" : "rgba(255,255,255,0.01)", marginBottom: 24 }}>
          <input ref={fileInputRef} type="file" multiple accept={uniqueFormats.map((f) => `.${f}`).join(",")} onChange={(e) => { if (e.target.files.length) addFiles(e.target.files); e.target.value = ""; }} style={{ display: "none" }} />
          <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.6 }}>{isDragging ? "⚡" : "↑"}</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6, color: "#cbd5e1" }}>{isDragging ? "Drop files to convert" : "Drop files here or click to browse"}</div>
          <div style={{ fontSize: 12, color: "#475569", fontFamily: "'JetBrains Mono', monospace" }}>Images · Videos · Audio — all converted locally in your browser</div>
          <div style={{ fontSize: 11, color: "#334155", fontFamily: "'JetBrains Mono', monospace", marginTop: 8 }}>You can also paste images with Ctrl+V / Cmd+V</div>
        </div>
        {files.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
            {files.map((item) => (<FileItem key={item.id} item={item} onRemove={removeFile} onFormatChange={changeFormat} />))}
          </div>
        )}
        {files.length > 0 && (
          <div className="action-buttons" style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            {idleFiles.length > 0 && (
              <button onClick={convertAll} style={{ background: "linear-gradient(135deg, #6366f1, #4f46e5)", border: "none", borderRadius: 10, color: "#fff", padding: "12px 28px", fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.08em", boxShadow: "0 4px 20px rgba(99,102,241,0.3)" }}>
                ⚡ Convert {idleFiles.length > 1 ? `All (${idleFiles.length})` : ""}
              </button>
            )}
            {doneFiles.length > 1 && (
              <button onClick={downloadAll} style={{ background: "linear-gradient(135deg, #10b981, #059669)", border: "none", borderRadius: 10, color: "#fff", padding: "12px 28px", fontSize: 14, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.08em", boxShadow: "0 4px 20px rgba(16,185,129,0.3)" }}>
                ↓ Download All
              </button>
            )}
            <button onClick={clearAll} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, color: "#94a3b8", padding: "12px 20px", fontSize: 13, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", cursor: "pointer", textTransform: "uppercase", letterSpacing: "0.05em" }}>Clear</button>
          </div>
        )}
        {files.length === 0 && (
          <div style={{ marginTop: 40 }}>
            <div style={{ textAlign: "center", fontSize: 12, color: "#475569", fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 20 }}>Supported Conversions</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
              {Object.entries(SUPPORTED_CONVERSIONS).map(([key, cat]) => (
                <div key={key} style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: 16 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                    <span style={{ fontSize: 18 }}>{cat.icon}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: cat.color, textTransform: "uppercase", letterSpacing: "0.05em", fontFamily: "'JetBrains Mono', monospace" }}>{cat.label}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "#64748b", fontFamily: "'JetBrains Mono', monospace", lineHeight: 1.8 }}>
                    <div><span style={{ color: "#94a3b8" }}>IN:</span> {cat.inputFormats.join(", ")}</div>
                    <div><span style={{ color: "#94a3b8" }}>OUT:</span> {cat.outputFormats.join(", ")}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{ textAlign: "center", marginTop: 48, fontSize: 11, color: "#334155", fontFamily: "'JetBrains Mono', monospace" }}>
          100% client-side · Your files never leave your device · Powered by FFmpeg.wasm + Canvas API
        </div>
      </div>
    </div>
  );
}
