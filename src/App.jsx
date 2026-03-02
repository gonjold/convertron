import { useState, useRef, useCallback, useEffect } from "react";
import { ref, uploadBytesResumable } from "firebase/storage";
import { doc, setDoc, onSnapshot } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { storage, db, functions } from "./firebase";

const SUPPORTED_CONVERSIONS = {
  image: {
    label: "Image",
    inputFormats: ["png", "jpg", "jpeg", "webp", "bmp", "gif", "svg", "ico", "tiff", "avif"],
    outputFormats: ["png", "jpg", "webp", "bmp", "gif", "ico"],
  },
  video: {
    label: "Video",
    inputFormats: ["webm", "mp4", "avi", "mov", "mkv", "flv", "wmv", "m4v", "3gp", "ogv"],
    outputFormats: ["mp4", "webm", "avi", "mov", "mkv", "gif"],
  },
  audio: {
    label: "Audio",
    inputFormats: ["mp3", "wav", "ogg", "flac", "aac", "wma", "m4a", "opus", "webm"],
    outputFormats: ["mp3", "wav", "ogg", "flac", "aac"],
  },
};

const c = {
  bg: "rgb(10,10,10)",
  surface: "rgb(18,18,18)",
  border: "rgb(38,38,38)",
  muted: "rgb(115,115,115)",
  text: "#ffffff",
  green: "#22c55e",
  red: "#ef4444",
  track: "rgb(28,28,28)",
};

const font = "'Inter', -apple-system, BlinkMacSystemFont, sans-serif";

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

function formatElapsed(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

// --- Image conversion (client-side, unchanged) ---
async function convertImage(file, outputFormat, onProgress) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Image conversion timed out after 60s.")), 60000);
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
          (blob) => { clearTimeout(timeout); if (!blob) { reject(new Error("Conversion failed")); return; } onProgress(100); resolve(blob); },
          mimeMap[outputFormat] || "image/png", 0.92
        );
      };
      img.onerror = () => { clearTimeout(timeout); reject(new Error("Failed to load image")); };
      img.src = e.target.result;
    };
    reader.onerror = () => { clearTimeout(timeout); reject(new Error("Failed to read file")); };
    reader.readAsDataURL(file);
  });
}

// --- Server-side media conversion via Firebase ---
function generateDocId() {
  return crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function convertMediaServer(file, outputFormat, onProgress, onStatus) {
  const docId = generateDocId();
  const storagePath = `temp/conversions/${docId}/input.${getFileExt(file.name)}`;
  const storageRef = ref(storage, storagePath);

  // Phase 1: Upload to Firebase Storage (0-50%)
  onStatus("uploading");
  await new Promise((resolve, reject) => {
    const uploadTask = uploadBytesResumable(storageRef, file);
    uploadTask.on(
      "state_changed",
      (snapshot) => {
        const pct = (snapshot.bytesTransferred / snapshot.totalBytes) * 50;
        onProgress(Math.round(pct));
      },
      (error) => reject(new Error("Upload failed: " + error.message)),
      () => resolve()
    );
  });

  onProgress(50);

  // Create Firestore doc to track conversion
  const docRef = doc(db, "conversions", docId);
  await setDoc(docRef, {
    status: "pending",
    storagePath,
    outputFormat,
    createdAt: Date.now(),
  });

  // Phase 2: Call Cloud Function
  onStatus("processing");
  const convertMedia = httpsCallable(functions, "convertMedia", { timeout: 540000 });

  // Start Firestore listener for status updates
  const statusPromise = new Promise((resolve, reject) => {
    const unsubscribe = onSnapshot(docRef, (snap) => {
      const data = snap.data();
      if (!data) return;

      if (data.status === "processing") {
        onProgress(60);
      } else if (data.status === "complete") {
        unsubscribe();
        resolve(data);
      } else if (data.status === "error") {
        unsubscribe();
        reject(new Error(data.error || "Conversion failed on server"));
      }
    });

    // Timeout safety
    setTimeout(() => {
      unsubscribe();
      reject(new Error("Conversion timed out after 9 minutes"));
    }, 9 * 60 * 1000);
  });

  // Fire the function call (don't await — we listen via Firestore)
  convertMedia({ storagePath, outputFormat, docId }).catch(() => {
    // Error will surface through Firestore listener
  });

  // Wait for completion via Firestore
  const result = await statusPromise;
  onProgress(95);
  onStatus("done");
  onProgress(100);

  return {
    downloadUrl: result.downloadUrl,
    outputSize: result.outputSize,
  };
}

function Spinner({ size = 14 }) {
  return (
    <div style={{ width: size, height: size, border: `1.5px solid ${c.track}`, borderTopColor: c.muted, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
  );
}

function useElapsedTimer(active) {
  const [elapsed, setElapsed] = useState(0);
  const ref = useRef(null);
  useEffect(() => {
    if (active) {
      setElapsed(0);
      ref.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    } else {
      clearInterval(ref.current);
    }
    return () => clearInterval(ref.current);
  }, [active]);
  return elapsed;
}

function FileItem({ item, onRemove, onFormatChange }) {
  const cat = SUPPORTED_CONVERSIONS[item.category];
  const isConverting = item.status === "converting";
  const isMedia = item.category === "video" || item.category === "audio";
  const elapsed = useElapsedTimer(isConverting);

  const statusLabel = isMedia && isConverting
    ? item.serverStatus === "uploading"
      ? "Uploading..."
      : item.serverStatus === "processing"
        ? "Converting on server..."
        : "Processing..."
    : "Processing...";

  return (
    <div style={{ borderBottom: `1px solid ${c.border}`, padding: "16px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
            <span style={{ fontSize: 14, fontWeight: 500, color: c.text, fontFamily: font, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.file.name}</span>
            <span style={{ fontSize: 12, color: c.muted, fontFamily: font, flexShrink: 0 }}>{formatBytes(item.file.size)}</span>
          </div>
        </div>
        {item.status === "idle" && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{ color: c.muted }}><path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            <select value={item.outputFormat} onChange={(e) => onFormatChange(item.id, e.target.value)}
              style={{ background: c.surface, border: `1px solid ${c.border}`, borderRadius: 6, color: c.text, padding: "6px 10px", fontSize: 13, fontFamily: font, cursor: "pointer", outline: "none", textTransform: "uppercase", appearance: "none", WebkitAppearance: "none", paddingRight: 24, backgroundImage: `url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23737373' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`, backgroundRepeat: "no-repeat", backgroundPosition: "right 8px center" }}>
              {cat?.outputFormats.filter(f => f !== getFileExt(item.file.name)).map((f) => (<option key={f} value={f}>{f}</option>))}
            </select>
          </div>
        )}
        {!isConverting && item.status !== "done" && (
          <button onClick={() => onRemove(item.id)} style={{ background: "none", border: "none", color: c.muted, cursor: "pointer", padding: "4px", lineHeight: 1, flexShrink: 0 }} aria-label="Remove">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
          </button>
        )}
      </div>

      {isConverting && (
        <div style={{ marginTop: 10 }}>
          <div style={{ height: 2, background: c.track, borderRadius: 1, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${item.progress}%`, background: c.text, borderRadius: 1, transition: "width 0.4s ease" }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
            <Spinner size={11} />
            <span style={{ fontSize: 12, color: c.muted, fontFamily: font }}>
              {statusLabel} {formatElapsed(elapsed)}
            </span>
          </div>
        </div>
      )}

      {item.status === "error" && (
        <div style={{ fontSize: 12, color: c.red, marginTop: 8, fontFamily: font }}>{item.error}</div>
      )}

      {item.status === "done" && item.downloadUrl && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: c.green, fontFamily: font, marginBottom: 10 }}>
            Done{item.outputSize ? ` · ${formatBytes(item.outputSize)}` : ""}
          </div>
          <button onClick={async () => {
              const response = await fetch(item.downloadUrl);
              const blob = await response.blob();
              const blobUrl = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = blobUrl;
              a.download = item.file.name.replace(/\.[^.]+$/, `.${item.outputFormat}`);
              a.click();
              URL.revokeObjectURL(blobUrl);
            }}
            style={{ width: "100%", background: c.text, border: "none", borderRadius: 8, color: c.bg, padding: "12px 24px", fontSize: 14, fontWeight: 600, fontFamily: font, cursor: "pointer", textAlign: "center" }}>
            Download {item.file.name.replace(/\.[^.]+$/, `.${item.outputFormat}`)}
          </button>
        </div>
      )}

      {item.status === "done" && item.outputBlob && !item.downloadUrl && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: c.green, fontFamily: font, marginBottom: 10 }}>Done · {formatBytes(item.outputBlob.size)}</div>
          <button onClick={() => { const url = URL.createObjectURL(item.outputBlob); const a = document.createElement("a"); a.href = url; a.download = item.file.name.replace(/\.[^.]+$/, `.${item.outputFormat}`); a.click(); URL.revokeObjectURL(url); }}
            style={{ width: "100%", background: c.text, border: "none", borderRadius: 8, color: c.bg, padding: "12px 24px", fontSize: 14, fontWeight: 600, fontFamily: font, cursor: "pointer" }}>
            Download {item.file.name.replace(/\.[^.]+$/, `.${item.outputFormat}`)}
          </button>
        </div>
      )}
    </div>
  );
}

function HowItWorks() {
  const stepStyle = { flex: 1, textAlign: "center", padding: "20px 16px", background: c.surface, borderRadius: 8, border: `1px solid ${c.border}` };
  const numStyle = { fontSize: 11, fontWeight: 600, color: c.muted, fontFamily: font, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 };
  const labelStyle = { fontSize: 14, fontWeight: 500, color: c.text, fontFamily: font };

  return (
    <div className="how-it-works" style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32 }}>
      <div style={stepStyle}>
        <div style={numStyle}>Step 1</div>
        <div style={labelStyle}>Drop or select files</div>
      </div>
      <svg className="step-arrow" width="20" height="20" viewBox="0 0 20 20" fill="none" style={{ flexShrink: 0, color: c.muted }}><path d="M7 4l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      <div style={stepStyle}>
        <div style={numStyle}>Step 2</div>
        <div style={labelStyle}>Pick output format</div>
      </div>
      <svg className="step-arrow" width="20" height="20" viewBox="0 0 20 20" fill="none" style={{ flexShrink: 0, color: c.muted }}><path d="M7 4l6 6-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
      <div style={stepStyle}>
        <div style={numStyle}>Step 3</div>
        <div style={labelStyle}>Convert</div>
      </div>
    </div>
  );
}

export default function FileConverter() {
  const [files, setFiles] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);
  const idCounter = useRef(0);

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
      return { id: ++idCounter.current, file, category, outputFormat: defaultOutput, status: category ? "idle" : "unsupported", progress: 0, outputBlob: null, outputSize: null, downloadUrl: null, serverStatus: null, error: null };
    });
    setFiles((prev) => [...prev, ...items]);
  }, []);

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
    setFiles((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: "converting", progress: 0, serverStatus: null } : f)));
    const onProgress = (p) => setFiles((prev) => prev.map((f) => (f.id === item.id ? { ...f, progress: p } : f)));

    try {
      if (item.category === "image") {
        // Client-side image conversion (unchanged)
        const blob = await convertImage(item.file, item.outputFormat, onProgress);
        setFiles((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: "done", progress: 100, outputBlob: blob } : f)));
      } else {
        // Server-side media conversion via Firebase
        const onStatus = (status) => setFiles((prev) => prev.map((f) => (f.id === item.id ? { ...f, serverStatus: status } : f)));
        const result = await convertMediaServer(item.file, item.outputFormat, onProgress, onStatus);
        setFiles((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: "done", progress: 100, downloadUrl: result.downloadUrl, outputSize: result.outputSize } : f)));
      }
    } catch (err) {
      setFiles((prev) => prev.map((f) => (f.id === item.id ? { ...f, status: "error", error: err.message } : f)));
    }
  };

  const convertAll = () => files.filter((f) => f.status === "idle" && f.category).forEach(convertFile);
  const downloadAll = () => {
    files.filter((f) => f.status === "done").forEach((f) => {
      if (f.outputBlob) {
        const url = URL.createObjectURL(f.outputBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = f.file.name.replace(/\.[^.]+$/, `.${f.outputFormat}`);
        a.click();
        URL.revokeObjectURL(url);
      } else if (f.downloadUrl) {
        const a = document.createElement("a");
        a.href = f.downloadUrl;
        a.download = f.file.name.replace(/\.[^.]+$/, `.${f.outputFormat}`);
        a.click();
      }
    });
  };
  const clearAll = () => setFiles([]);
  const idleFiles = files.filter((f) => f.status === "idle");
  const doneFiles = files.filter((f) => f.status === "done");
  const allFormats = Object.values(SUPPORTED_CONVERSIONS).flatMap((c) => c.inputFormats);
  const uniqueFormats = [...new Set(allFormats)].sort();

  return (
    <div style={{ minHeight: "100vh", background: c.bg, color: c.text, fontFamily: font }}>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "64px 24px 48px" }}>

        {/* Header */}
        <div style={{ marginBottom: 40 }}>
          <h1 style={{ fontSize: "clamp(28px, 5vw, 36px)", fontWeight: 700, letterSpacing: "-0.03em", color: c.text, marginBottom: 8 }}>Convertron</h1>
          <p style={{ fontSize: 15, color: c.muted, fontFamily: font, lineHeight: 1.5 }}>Convert images, video, and audio. Images convert locally. Video and audio are processed on a secure server.</p>
        </div>

        {/* How it works */}
        {files.length === 0 && <HowItWorks />}

        {/* Drop zone */}
        <div onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onClick={() => fileInputRef.current?.click()}
          style={{ border: `1.5px dashed ${isDragging ? c.muted : c.border}`, borderRadius: 10, padding: files.length === 0 ? "56px 24px" : "32px 24px", textAlign: "center", cursor: "pointer", transition: "border-color 0.2s ease", marginBottom: 32 }}>
          <input ref={fileInputRef} type="file" multiple accept={uniqueFormats.map((f) => `.${f}`).join(",")} onChange={(e) => { if (e.target.files.length) addFiles(e.target.files); e.target.value = ""; }} style={{ display: "none" }} />
          <div style={{ fontSize: 14, fontWeight: 500, color: c.text, marginBottom: 6, fontFamily: font }}>{isDragging ? "Drop to add files" : "Drop files here or click to browse"}</div>
          <div style={{ fontSize: 13, color: c.muted, fontFamily: font }}>Images, video, audio — or paste with Ctrl+V</div>
        </div>

        {/* File list */}
        {files.length > 0 && (
          <div style={{ marginBottom: 32 }}>
            {files.map((item) => (<FileItem key={item.id} item={item} onRemove={removeFile} onFormatChange={changeFormat} />))}
          </div>
        )}

        {/* Action buttons */}
        {files.length > 0 && (
          <div className="action-buttons" style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {idleFiles.length > 0 && (
              <button onClick={convertAll} style={{ background: c.text, border: "none", borderRadius: 8, color: c.bg, padding: "10px 24px", fontSize: 14, fontWeight: 600, fontFamily: font, cursor: "pointer" }}>
                Convert{idleFiles.length > 1 ? ` all (${idleFiles.length})` : ""}
              </button>
            )}
            {doneFiles.length > 1 && (
              <button onClick={downloadAll} style={{ background: c.track, border: `1px solid ${c.border}`, borderRadius: 8, color: c.text, padding: "10px 24px", fontSize: 14, fontWeight: 600, fontFamily: font, cursor: "pointer" }}>
                Download all
              </button>
            )}
            <button onClick={clearAll} style={{ background: "transparent", border: `1px solid ${c.border}`, borderRadius: 8, color: c.muted, padding: "10px 20px", fontSize: 13, fontWeight: 500, fontFamily: font, cursor: "pointer" }}>Clear</button>
          </div>
        )}

        {/* Supported formats */}
        {files.length === 0 && (
          <div style={{ marginTop: 48 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: c.muted, fontFamily: font, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 20 }}>Supported formats</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {Object.entries(SUPPORTED_CONVERSIONS).map(([key, cat]) => (
                <div key={key} style={{ borderBottom: `1px solid ${c.border}`, padding: "16px 0" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: c.text, fontFamily: font, marginBottom: 6 }}>{cat.label}</div>
                  <div style={{ fontSize: 12, color: c.muted, fontFamily: font, lineHeight: 1.7 }}>
                    <span>{cat.inputFormats.join(", ")}</span>
                    <span style={{ margin: "0 8px", color: c.border }}>→</span>
                    <span>{cat.outputFormats.join(", ")}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div style={{ marginTop: 48, fontSize: 12, color: "rgb(50,50,50)", fontFamily: font }}>
          Images convert in your browser. Video and audio are processed server-side.
        </div>
      </div>
    </div>
  );
}
