"use client";

import { OEM, PSM, type Worker as TesseractWorker } from "tesseract.js";
import { useEffect, useMemo, useRef, useState } from "react";

type VehicleData = Record<string, string | number | boolean | null>;

const formatLabel = (value: string) =>
  value
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ocrWorkerRef = useRef<TesseractWorker | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [plateInput, setPlateInput] = useState("");
  const [detectedPlate, setDetectedPlate] = useState<string | null>(null);
  const [ocrStatus, setOcrStatus] = useState<"idle" | "loading" | "success" | "error">(
    "idle"
  );
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [lookupStatus, setLookupStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [vehicleData, setVehicleData] = useState<VehicleData | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;

    const startCamera = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        setCameraReady(true);
      } catch (error) {
        setCameraError(
          error instanceof Error ? error.message : "Unable to access the camera."
        );
      }
    };

    startCamera();

    return () => {
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    return () => {
      ocrWorkerRef.current?.terminate().catch(() => null);
    };
  }, []);

  const captureFrame = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return null;

    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.95);
  };

  const normalizePlate = (value: string) =>
    value.toUpperCase().replace(/[^A-Z0-9]/g, "");

  const loadImageData = (dataUrl: string) =>
    new Promise<ImageData | null>((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const context = canvas.getContext("2d");
        if (!context) {
          resolve(null);
          return;
        }
        context.drawImage(img, 0, 0);
        resolve(context.getImageData(0, 0, canvas.width, canvas.height));
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });

  const detectPlateCrop = (imageData: ImageData) => {
    const maxWidth = 640;
    const scale = imageData.width > maxWidth ? maxWidth / imageData.width : 1;
    const width = Math.round(imageData.width * scale);
    const height = Math.round(imageData.height * scale);
    const smallCanvas = document.createElement("canvas");
    smallCanvas.width = width;
    smallCanvas.height = height;
    const smallCtx = smallCanvas.getContext("2d");
    if (!smallCtx) return null;
    const tempCanvas = document.createElement("canvas");
    tempCanvas.width = imageData.width;
    tempCanvas.height = imageData.height;
    const tempCtx = tempCanvas.getContext("2d");
    if (!tempCtx) return null;
    tempCtx.putImageData(imageData, 0, 0);
    smallCtx.drawImage(tempCanvas, 0, 0, width, height);
    const smallData = smallCtx.getImageData(0, 0, width, height);
    const gray = new Uint8ClampedArray(width * height);
    for (let i = 0; i < smallData.data.length; i += 4) {
      gray[i / 4] =
        0.299 * smallData.data[i] +
        0.587 * smallData.data[i + 1] +
        0.114 * smallData.data[i + 2];
    }
    const edges = new Uint8Array(width * height);
    const threshold = 120;
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const idx = y * width + x;
        const gx =
          -gray[idx - width - 1] -
          2 * gray[idx - 1] -
          gray[idx + width - 1] +
          gray[idx - width + 1] +
          2 * gray[idx + 1] +
          gray[idx + width + 1];
        const gy =
          -gray[idx - width - 1] -
          2 * gray[idx - width] -
          gray[idx - width + 1] +
          gray[idx + width - 1] +
          2 * gray[idx + width] +
          gray[idx + width + 1];
        const mag = Math.sqrt(gx * gx + gy * gy);
        edges[idx] = mag > threshold ? 1 : 0;
      }
    }
    const visited = new Uint8Array(width * height);
    let best: { x: number; y: number; w: number; h: number; area: number } | null =
      null;
    const minArea = width * height * 0.01;
    for (let i = 0; i < edges.length; i += 1) {
      if (!edges[i] || visited[i]) continue;
      const stack = [i];
      visited[i] = 1;
      let minX = width;
      let minY = height;
      let maxX = 0;
      let maxY = 0;
      let count = 0;
      while (stack.length) {
        const idx = stack.pop() ?? 0;
        const x = idx % width;
        const y = Math.floor(idx / width);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        count += 1;
        const neighbors = [
          idx - 1,
          idx + 1,
          idx - width,
          idx + width,
        ];
        for (const n of neighbors) {
          if (n < 0 || n >= edges.length) continue;
          if (!edges[n] || visited[n]) continue;
          visited[n] = 1;
          stack.push(n);
        }
      }
      const w = maxX - minX + 1;
      const h = maxY - minY + 1;
      const area = w * h;
      const aspect = w / h;
      if (area < minArea) continue;
      if (aspect < 2 || aspect > 6.5) continue;
      if (!best || area > best.area) {
        best = { x: minX, y: minY, w, h, area };
      }
    }
    if (!best) return null;
    const padX = Math.round(best.w * 0.08);
    const padY = Math.round(best.h * 0.25);
    const cropX = Math.max(0, best.x - padX);
    const cropY = Math.max(0, best.y - padY);
    const cropW = Math.min(width - cropX, best.w + padX * 2);
    const cropH = Math.min(height - cropY, best.h + padY * 2);
    return {
      x: cropX / scale,
      y: cropY / scale,
      width: cropW / scale,
      height: cropH / scale,
    };
  };

  const preprocessPlate = (imageData: ImageData) => {
    const { width, height, data } = imageData;
    const gray = new Uint8ClampedArray(width * height);
    let min = 255;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const value =
        0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      gray[i / 4] = value;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    const range = Math.max(1, max - min);
    for (let i = 0; i < gray.length; i += 1) {
      gray[i] = Math.min(255, Math.max(0, ((gray[i] - min) / range) * 255));
    }
    const integral = new Uint32Array((width + 1) * (height + 1));
    for (let y = 1; y <= height; y += 1) {
      let rowSum = 0;
      for (let x = 1; x <= width; x += 1) {
        rowSum += gray[(y - 1) * width + (x - 1)];
        integral[y * (width + 1) + x] =
          integral[(y - 1) * (width + 1) + x] + rowSum;
      }
    }
    const blockSize = 15;
    const half = Math.floor(blockSize / 2);
    const bias = 10;
    const binary = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y += 1) {
      const y0 = Math.max(0, y - half);
      const y1 = Math.min(height - 1, y + half);
      for (let x = 0; x < width; x += 1) {
        const x0 = Math.max(0, x - half);
        const x1 = Math.min(width - 1, x + half);
        const idx = y * width + x;
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        const sum =
          integral[(y1 + 1) * (width + 1) + (x1 + 1)] -
          integral[y0 * (width + 1) + (x1 + 1)] -
          integral[(y1 + 1) * (width + 1) + x0] +
          integral[y0 * (width + 1) + x0];
        const mean = sum / area;
        binary[idx] = gray[idx] < mean - bias ? 0 : 255;
      }
    }
    const morph = new Uint8ClampedArray(width * height);
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        let maxVal = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const val = binary[(y + dy) * width + (x + dx)];
            if (val > maxVal) maxVal = val;
          }
        }
        morph[y * width + x] = maxVal;
      }
    }
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        let minVal = 255;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const val = morph[(y + dy) * width + (x + dx)];
            if (val < minVal) minVal = val;
          }
        }
        binary[y * width + x] = minVal;
      }
    }
    let mean = 0;
    for (let i = 0; i < binary.length; i += 1) {
      mean += binary[i];
    }
    mean /= binary.length;
    if (mean < 127) {
      for (let i = 0; i < binary.length; i += 1) {
        binary[i] = 255 - binary[i];
      }
    }
    const processed = new ImageData(width, height);
    for (let i = 0; i < binary.length; i += 1) {
      const offset = i * 4;
      processed.data[offset] = binary[i];
      processed.data[offset + 1] = binary[i];
      processed.data[offset + 2] = binary[i];
      processed.data[offset + 3] = 255;
    }
    return processed;
  };

  const upscaleImageData = (imageData: ImageData, scale: number) => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(imageData.width * scale);
    canvas.height = Math.round(imageData.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return null;
    const temp = document.createElement("canvas");
    temp.width = imageData.width;
    temp.height = imageData.height;
    const tempCtx = temp.getContext("2d");
    if (!tempCtx) return null;
    tempCtx.putImageData(imageData, 0, 0);
    context.imageSmoothingEnabled = false;
    context.drawImage(temp, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  };

  const extractPlate = (rawText: string) => {
    const cleaned = rawText.toUpperCase().replace(/[^A-Z0-9]/g, " ");
    const condensed = cleaned.replace(/\s+/g, "");
    const strict = condensed.match(/[A-Z]{2}\d{2}[A-Z]{3}/);
    if (strict) return strict[0];
    const loose = condensed.match(/[A-Z0-9]{5,8}/);
    if (loose) return loose[0];
    const candidates = cleaned.split(/\s+/).filter(Boolean);
    return (
      candidates.find((candidate) => /^[A-Z]{2}\d{2}[A-Z]{3}$/.test(candidate)) ||
      candidates.find((candidate) => /^[A-Z0-9]{5,8}$/.test(candidate)) ||
      ""
    );
  };

  const getOcrWorker = async () => {
    if (ocrWorkerRef.current) {
      return ocrWorkerRef.current;
    }

    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng", 1, {
      logger: (message) => {
        if (typeof message?.progress === "number") {
          setOcrProgress(message.progress);
        }
      },
    });
    ocrWorkerRef.current = worker;
    return worker;
  };

  const runOcr = async (imageData: string, psm: PSM) => {
    setOcrStatus("loading");
    setOcrError(null);
    setOcrProgress(0);
    setOcrConfidence(null);

    try {
      const worker = await getOcrWorker();
      await worker.setParameters?.({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        tessedit_pageseg_mode: psm,
        tessedit_ocr_engine_mode: `${OEM.LSTM_ONLY}`,
      });
      const result = await worker.recognize(imageData);
      const text = result.data.text ?? "";
      const plate = extractPlate(text);
      if (!plate) {
        setOcrStatus("error");
        setOcrError("No plate detected. Try again with a clearer shot.");
        return "";
      }
      setOcrStatus("success");
      setOcrConfidence(result.data.confidence ?? null);
      return plate;
    } catch (error) {
      setOcrStatus("error");
      setOcrError(error instanceof Error ? error.message : "OCR failed.");
      return "";
    }
  };

  const handleDetectPlate = async () => {
    const snapshot = captureFrame();
    const trimmed = normalizePlate(plateInput.trim());
    if (trimmed) {
      setDetectedPlate(trimmed);
      setPlateInput(trimmed);
      return;
    }
    if (snapshot) {
      const imageData = await loadImageData(snapshot);
      let cropDataUrl = snapshot;
      if (imageData) {
        const crop = detectPlateCrop(imageData);
        if (crop) {
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(crop.width);
          canvas.height = Math.round(crop.height);
          const ctx = canvas.getContext("2d");
          if (ctx) {
            const temp = document.createElement("canvas");
            temp.width = imageData.width;
            temp.height = imageData.height;
            const tempCtx = temp.getContext("2d");
            if (tempCtx) {
              tempCtx.putImageData(imageData, 0, 0);
              ctx.drawImage(
                temp,
                crop.x,
                crop.y,
                crop.width,
                crop.height,
                0,
                0,
                canvas.width,
                canvas.height
              );
              cropDataUrl = canvas.toDataURL("image/png");
            }
          }
        }
      }
      setSnapshotUrl(cropDataUrl);
      const cropData = await loadImageData(cropDataUrl);
      const processedData = cropData ? preprocessPlate(cropData) : null;
      const processedUrl = processedData ? upscaleImageData(processedData, 2) : null;
      let ocrResult = normalizePlate(
        await runOcr(processedUrl ?? cropDataUrl, PSM.SINGLE_LINE)
      );
      if (!ocrResult) {
        ocrResult = normalizePlate(await runOcr(cropDataUrl, PSM.SINGLE_WORD));
      }
      if (ocrResult) {
        setDetectedPlate(ocrResult);
        setPlateInput(ocrResult);
        return;
      }
    }
  };

  const handleLookup = async () => {
    const registration = normalizePlate(detectedPlate || plateInput);
    if (!registration) {
      setLookupError("Enter or detect a registration before lookup.");
      setLookupStatus("error");
      return;
    }

    setLookupStatus("loading");
    setLookupError(null);

    try {
      const response = await fetch("/api/dvla", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ registration }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const message =
          payload?.error ||
          "DVLA lookup failed. Check API credentials and try again.";
        throw new Error(message);
      }
      const payload = (await response.json()) as VehicleData;
      setVehicleData(payload);
      setLookupStatus("success");
    } catch (error) {
      setVehicleData(null);
      setLookupStatus("error");
      setLookupError(error instanceof Error ? error.message : "Lookup failed.");
    }
  };

  const infoData = useMemo(() => {
    if (lookupStatus === "success" && vehicleData) {
      return vehicleData;
    }
    return null;
  }, [lookupStatus, vehicleData]);

  return (
    <div className="relative min-h-screen overflow-hidden px-6 py-10 text-slate-900">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(249,115,22,0.15),transparent_55%),radial-gradient(circle_at_80%_0%,rgba(56,189,248,0.18),transparent_45%)]" />
      <main className="relative mx-auto flex w-full max-w-6xl flex-col gap-10">
        <header className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-slate-900 text-amber-100 grid place-items-center text-lg font-semibold">
              CS
            </div>
            <div>
              <p className="text-xs uppercase tracking-[0.35em] text-slate-500">
                Vehicle Intelligence
              </p>
              <h1 className="font-[var(--font-display)] text-3xl text-slate-900 md:text-4xl">
                CarScan
              </h1>
            </div>
          </div>
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <p className="max-w-2xl text-pretty text-lg text-slate-600">
              Point your camera at a registration plate, detect the text, and pull
              DVLA VES vehicle details in seconds.
            </p>
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-[32px] border border-white/80 bg-white/70 p-6 shadow-[0_20px_60px_rgba(15,23,42,0.08)] backdrop-blur animate-slide-up">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-[var(--font-display)] text-2xl text-slate-900">
                Camera Feed
              </h2>
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.25em] ${
                  cameraReady ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"
                }`}
              >
                {cameraReady ? "Ready" : "Waiting"}
              </span>
            </div>
            <div className="mt-4 rounded-[24px] border border-slate-200 bg-slate-950/90 p-4 text-slate-100">
              <div className="aspect-video w-full overflow-hidden rounded-[20px] border border-white/10 bg-slate-900">
                <video
                  ref={videoRef}
                  className="h-full w-full object-cover"
                  autoPlay
                  muted
                  playsInline
                />
              </div>
              <canvas ref={canvasRef} className="hidden" />
              {cameraError ? (
                <p className="mt-4 text-sm text-amber-200">{cameraError}</p>
              ) : (
                <p className="mt-4 text-xs uppercase tracking-[0.3em] text-slate-300">
                  Hold steady for best detection
                </p>
              )}
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-[1.1fr_0.9fr]">
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                <label className="text-xs uppercase tracking-[0.35em] text-slate-400">
                  Manual Plate Entry
                </label>
                <input
                  value={plateInput}
                  onChange={(event) => setPlateInput(event.target.value)}
                  placeholder="e.g. LM22 XPT"
                  className="mt-2 w-full bg-transparent text-lg font-semibold uppercase tracking-[0.2em] text-slate-900 outline-none placeholder:text-slate-400"
                />
              </div>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={handleDetectPlate}
                  disabled={ocrStatus === "loading"}
                  className="h-12 w-full rounded-full bg-orange-500 text-sm font-semibold uppercase tracking-[0.3em] text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {ocrStatus === "loading" ? "Scanning..." : "Detect Plate"}
                </button>
                <button
                  type="button"
                  onClick={handleLookup}
                  className="h-12 w-full rounded-full border border-slate-300 bg-white text-sm font-semibold uppercase tracking-[0.3em] text-slate-800 transition hover:border-slate-900"
                >
                  Lookup DVLA
                </button>
              </div>
            </div>
            {snapshotUrl ? (
              <div className="mt-6 rounded-[20px] border border-slate-200 bg-white p-4">
                <p className="text-xs uppercase tracking-[0.3em] text-slate-400">
                  Snapshot
                </p>
                <img
                  src={snapshotUrl}
                  alt="Captured plate snapshot"
                  className="mt-3 w-full rounded-[16px] object-cover"
                />
              </div>
            ) : null}
          </div>

          <div className="flex flex-col gap-6">
            <div className="rounded-[28px] border border-white/80 bg-white/80 p-6 shadow-[0_18px_40px_rgba(15,23,42,0.1)] animate-fade-in">
              <h2 className="font-[var(--font-display)] text-2xl text-slate-900">
                Detection Result
              </h2>
              <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-xs uppercase tracking-[0.35em] text-slate-400">
                  Detected Plate
                </p>
                <p className="mt-2 text-2xl font-semibold uppercase tracking-[0.3em] text-slate-900">
                  {detectedPlate || "Waiting..."}
                </p>
              </div>
              <p className="mt-4 text-sm text-slate-500">
                OCR runs locally in your browser. Clean lighting and steady
                framing help accuracy.
              </p>
              {ocrStatus === "loading" ? (
                <p className="mt-3 text-sm text-slate-600">
                  OCR scanning {Math.round(ocrProgress * 100)}%
                </p>
              ) : null}
              {ocrConfidence !== null && ocrStatus === "success" ? (
                <p className="mt-3 text-sm text-emerald-700">
                  OCR confidence {Math.round(ocrConfidence)}%
                </p>
              ) : null}
              {ocrError ? (
                <p className="mt-3 text-sm text-rose-600">{ocrError}</p>
              ) : null}
              {lookupStatus === "loading" ? (
                <p className="mt-4 text-sm text-orange-600">Requesting DVLA VES...</p>
              ) : null}
              {lookupError ? (
                <p className="mt-3 text-sm text-rose-600">{lookupError}</p>
              ) : null}
            </div>

            <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_18px_40px_rgba(15,23,42,0.08)]">
              <h2 className="font-[var(--font-display)] text-2xl text-slate-900">
                Vehicle Data
              </h2>
              {infoData ? (
                <dl className="mt-4 grid gap-3 text-sm text-slate-600">
                  {Object.entries(infoData).map(([key, value]) => (
                    <div
                      key={key}
                      className="flex items-center justify-between gap-4 rounded-xl border border-slate-100 bg-slate-50 px-4 py-3"
                    >
                      <dt className="text-xs uppercase tracking-[0.3em] text-slate-400">
                        {formatLabel(key)}
                      </dt>
                      <dd className="text-right text-base font-semibold text-slate-900">
                        {String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="mt-4 text-sm text-slate-500">
                  Run a lookup to populate DVLA VES results.
                </p>
              )}
            </div>
          </div>
        </section>

        <section className="grid gap-4 rounded-[28px] border border-white/90 bg-white/70 p-6 shadow-[0_16px_40px_rgba(15,23,42,0.08)]">
          <div>
            <h2 className="font-[var(--font-display)] text-2xl text-slate-900">
              How it works
            </h2>
            <p className="mt-2 text-sm text-slate-500">
              Capture the plate, validate OCR, and trigger DVLA VES lookup when
              the registration is confirmed.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {[
              {
                title: "Capture",
                copy: "Use the rear camera and isolate the plate in-frame.",
              },
              {
                title: "Detect",
                copy: "OCR extracts the registration and confirms format.",
              },
              {
                title: "Lookup",
                copy: "DVLA VES responds with vehicle data instantly.",
              },
            ].map((item) => (
              <div
                key={item.title}
                className="rounded-2xl border border-slate-200 bg-white px-4 py-4"
              >
                <h3 className="text-sm font-semibold uppercase tracking-[0.3em] text-slate-500">
                  {item.title}
                </h3>
                <p className="mt-3 text-base text-slate-700">{item.copy}</p>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
