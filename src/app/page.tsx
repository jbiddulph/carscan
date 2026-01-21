"use client";

import Link from "next/link";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as ort from "onnxruntime-web";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type VehicleData = Record<string, string | number | boolean | null>;

const formatLabel = (value: string) =>
  value
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());

export default function Home() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const detectorSessionRef = useRef<ort.InferenceSession | null>(null);
  const ocrSessionRef = useRef<ort.InferenceSession | null>(null);
  const ocrTimeoutRef = useRef<number | null>(null);
  const detailsRef = useRef<HTMLDivElement | null>(null);
  const detectionRef = useRef<HTMLDivElement | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraStartingRef = useRef(false);
  const snapshotBlobRef = useRef<Blob | null>(null);
  const rawSnapshotBlobRef = useRef<Blob | null>(null);
  const snapshotPreviewUrlRef = useRef<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [plateInput, setPlateInput] = useState("");
  const [detectedPlate, setDetectedPlate] = useState<string | null>(null);
  const [ocrStatus, setOcrStatus] = useState<"idle" | "loading" | "success" | "error">(
    "idle"
  );
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [lookupStatus, setLookupStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [vehicleData, setVehicleData] = useState<VehicleData | null>(null);
  const [locationStatus, setLocationStatus] = useState<
    "idle" | "loading" | "success" | "denied" | "error"
  >("idle");
  const [locationData, setLocationData] = useState<{ lat: number; lng: number } | null>(
    null
  );
  const [saveStatus, setSaveStatus] = useState<"idle" | "loading" | "success" | "error">(
    "idle"
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [zoomSupported, setZoomSupported] = useState(false);
  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_KEY ?? "";

  const startCamera = async () => {
    if (cameraStartingRef.current) return;
    cameraStartingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      const track = stream.getVideoTracks()[0];
      const capabilities = track?.getCapabilities?.();
      setZoomSupported(Boolean(capabilities && "zoom" in capabilities));
      setCameraReady(true);
      setCameraError(null);
    } catch (error) {
      setCameraError(
        error instanceof Error ? error.message : "Unable to access the camera."
      );
    } finally {
      cameraStartingRef.current = false;
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraReady(false);
    setZoomed(false);
  };

  useEffect(() => {
    startCamera();

    return () => {
      stopCamera();
    };
  }, []);

  const captureFrame = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return null;

    const sourceWidth = video.videoWidth || 1280;
    const sourceHeight = video.videoHeight || 720;
    const maxWidth = 960;
    const maxHeight = 540;
    const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1);
    const width = Math.round(sourceWidth * scale);
    const height = Math.round(sourceHeight * scale);
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), "image/jpeg", 0.75)
    );
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    return { blob, url };
  };

  const normalizePlate = (value: string) =>
    value.toUpperCase().replace(/[^A-Z0-9]/g, "");

  const clearOcrTimeout = () => {
    if (ocrTimeoutRef.current !== null) {
      window.clearTimeout(ocrTimeoutRef.current);
      ocrTimeoutRef.current = null;
    }
  };

  const OCR_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_";
  const OCR_PAD = "_";
  const OCR_INPUT = { width: 140, height: 70, maxSlots: 9 };

  const loadImageElement = (dataUrl: string) =>
    new Promise<HTMLImageElement | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });

  const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

  const configureOrt = () => {
    if (!ort.env.wasm.wasmPaths) {
      ort.env.wasm.wasmPaths = "/ort/";
    }
    ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
  };

  const getDetectorSession = async () => {
    if (detectorSessionRef.current) {
      return detectorSessionRef.current;
    }
    configureOrt();
    const session = await ort.InferenceSession.create(
      "/models/license_plate_detector.onnx"
    );
    detectorSessionRef.current = session;
    return session;
  };

  const getOcrSession = async () => {
    if (ocrSessionRef.current) {
      return ocrSessionRef.current;
    }
    configureOrt();
    const session = await ort.InferenceSession.create("/models/plate_ocr.onnx");
    ocrSessionRef.current = session;
    return session;
  };

  const prepareDetectorInput = (
    image: HTMLImageElement,
    width: number,
    height: number,
    useUint8: boolean
  ) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const scale = Math.min(width / image.width, height / image.height);
    const scaledWidth = Math.round(image.width * scale);
    const scaledHeight = Math.round(image.height * scale);
    const padX = Math.floor((width - scaledWidth) / 2);
    const padY = Math.floor((height - scaledHeight) / 2);
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, padX, padY, scaledWidth, scaledHeight);
    const imageData = ctx.getImageData(0, 0, width, height);
    const input = useUint8
      ? new Uint8Array(3 * width * height)
      : new Float32Array(3 * width * height);
    for (let i = 0; i < imageData.data.length; i += 4) {
      const idx = i / 4;
      if (useUint8) {
        input[idx] = imageData.data[i];
        input[idx + width * height] = imageData.data[i + 1];
        input[idx + 2 * width * height] = imageData.data[i + 2];
      } else {
        input[idx] = imageData.data[i] / 255;
        input[idx + width * height] = imageData.data[i + 1] / 255;
        input[idx + 2 * width * height] = imageData.data[i + 2] / 255;
      }
    }
    return {
      input,
      type: useUint8 ? ("uint8" as const) : ("float32" as const),
      scale,
      padX,
      padY,
      width,
      height,
    };
  };

  const iou = (a: number[], b: number[]) => {
    const x1 = Math.max(a[0], b[0]);
    const y1 = Math.max(a[1], b[1]);
    const x2 = Math.min(a[2], b[2]);
    const y2 = Math.min(a[3], b[3]);
    const interArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const boxAArea = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
    const boxBArea = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
    return interArea / Math.max(1, boxAArea + boxBArea - interArea);
  };

  const nms = (boxes: Array<{ box: number[]; score: number }>, threshold: number) => {
    const sorted = [...boxes].sort((a, b) => b.score - a.score);
    const selected: Array<{ box: number[]; score: number }> = [];
    while (sorted.length) {
      const current = sorted.shift();
      if (!current) break;
      selected.push(current);
      for (let i = sorted.length - 1; i >= 0; i -= 1) {
        if (iou(current.box, sorted[i].box) > threshold) {
          sorted.splice(i, 1);
        }
      }
    }
    return selected;
  };

  const parseDetectorOutput = (
    output: ort.Tensor,
    inputWidth: number,
    inputHeight: number,
    scoreThreshold: number
  ) => {
    const data = output.data as Float32Array;
    const dims = output.dims;
    const candidates: Array<{ box: number[]; score: number }> = [];
    if (dims.length !== 3) return candidates;
    let normalized = true;
    if (dims[2] <= 10) {
      const boxes = dims[1];
      const channels = dims[2];
      let maxCoord = 0;
      for (let i = 0; i < Math.min(boxes, 50); i += 1) {
        const base = i * channels;
        maxCoord = Math.max(
          maxCoord,
          Math.abs(data[base]),
          Math.abs(data[base + 1]),
          Math.abs(data[base + 2]),
          Math.abs(data[base + 3])
        );
      }
      normalized = maxCoord <= 1.5;
      for (let i = 0; i < boxes; i += 1) {
        const base = i * channels;
        const x = data[base];
        const y = data[base + 1];
        const w = data[base + 2];
        const h = data[base + 3];
        const obj = channels > 4 ? sigmoid(data[base + 4]) : 1;
        const cls = channels > 5 ? sigmoid(data[base + 5]) : 1;
        const score = obj * cls;
        if (score < scoreThreshold) continue;
        const scaleX = normalized ? inputWidth : 1;
        const scaleY = normalized ? inputHeight : 1;
        const cx = x * scaleX;
        const cy = y * scaleY;
        const bw = w * scaleX;
        const bh = h * scaleY;
        candidates.push({
          box: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2],
          score,
        });
      }
    } else {
      const channels = dims[1];
      const boxes = dims[2];
      let maxCoord = 0;
      for (let i = 0; i < Math.min(boxes, 50); i += 1) {
        maxCoord = Math.max(
          maxCoord,
          Math.abs(data[i]),
          Math.abs(data[i + boxes]),
          Math.abs(data[i + 2 * boxes]),
          Math.abs(data[i + 3 * boxes])
        );
      }
      normalized = maxCoord <= 1.5;
      for (let i = 0; i < boxes; i += 1) {
        const x = data[i];
        const y = data[i + boxes];
        const w = data[i + 2 * boxes];
        const h = data[i + 3 * boxes];
        const obj = channels > 4 ? sigmoid(data[i + 4 * boxes]) : 1;
        const cls = channels > 5 ? sigmoid(data[i + 5 * boxes]) : 1;
        const score = obj * cls;
        if (score < scoreThreshold) continue;
        const scaleX = normalized ? inputWidth : 1;
        const scaleY = normalized ? inputHeight : 1;
        const cx = x * scaleX;
        const cy = y * scaleY;
        const bw = w * scaleX;
        const bh = h * scaleY;
        candidates.push({
          box: [cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2],
          score,
        });
      }
    }
    return nms(candidates, 0.4);
  };

  const cropPlate = async (image: HTMLImageElement, box: number[]) => {
    const [x1, y1, x2, y2] = box;
    const width = Math.max(1, x2 - x1);
    const height = Math.max(1, y2 - y1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width);
    canvas.height = Math.round(height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, x1, y1, width, height, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((result) => resolve(result), "image/png")
    );
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    return { blob, url };
  };

  const prepareOcrInput = (image: HTMLImageElement, useUint8: boolean) => {
    const targetWidth = OCR_INPUT.width;
    const targetHeight = OCR_INPUT.height;
    const channels = 1;
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const scale = Math.min(
      targetWidth / image.width,
      targetHeight / image.height
    );
    const scaledWidth = Math.round(image.width * scale);
    const scaledHeight = Math.round(image.height * scale);
    const padX = Math.floor((targetWidth - scaledWidth) / 2);
    const padY = Math.floor((targetHeight - scaledHeight) / 2);
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(image, padX, padY, scaledWidth, scaledHeight);
    const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
    const pixelCount = targetWidth * targetHeight;
    const input = useUint8
      ? new Uint8Array(channels * pixelCount)
      : new Float32Array(channels * pixelCount);
    for (let i = 0; i < imageData.data.length; i += 4) {
      const idx = i / 4;
      const r = imageData.data[i];
      const g = imageData.data[i + 1];
      const b = imageData.data[i + 2];
      const toValue = (value: number) => (useUint8 ? value : value / 255);
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      input[idx] = toValue(gray);
    }
    return {
      input,
      shape: [1, targetHeight, targetWidth, 1] as const,
    };
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

  const decodeOcrOutput = (output: ort.Tensor) => {
    const data = output.data as Float32Array;
    const dims = output.dims;
    let slots = OCR_INPUT.maxSlots;
    let classes = OCR_ALPHABET.length;
    let layout: "slots-first" | "classes-first" = "slots-first";
    if (dims.length === 3) {
      if (dims[2] === classes) {
        slots = dims[1];
        layout = "slots-first";
      } else if (dims[1] === classes) {
        slots = dims[2];
        layout = "classes-first";
      }
    }
    let text = "";
    let confidenceSum = 0;
    for (let slot = 0; slot < slots; slot += 1) {
      let maxVal = -Infinity;
      let maxIdx = 0;
      for (let cls = 0; cls < classes; cls += 1) {
        const idx =
          layout === "slots-first"
            ? slot * classes + cls
            : cls * slots + slot;
        const value = data[idx];
        if (value > maxVal) {
          maxVal = value;
          maxIdx = cls;
        }
      }
      let expSum = 0;
      for (let cls = 0; cls < classes; cls += 1) {
        const idx =
          layout === "slots-first"
            ? slot * classes + cls
            : cls * slots + slot;
        expSum += Math.exp(data[idx] - maxVal);
      }
      const confidence = expSum ? 1 / expSum : 0;
      confidenceSum += confidence;
      const char = OCR_ALPHABET[maxIdx] ?? "";
      if (char !== OCR_PAD) {
        text += char;
      }
    }
    const avgConfidence = slots ? (confidenceSum / slots) * 100 : null;
    return { text, confidence: avgConfidence };
  };

  const runOcr = async (imageData: string) => {
    setOcrStatus("loading");
    setOcrError(null);
    setOcrConfidence(null);

    try {
      const image = await loadImageElement(imageData);
      if (!image) {
        throw new Error("Unable to read image.");
      }
      const session = await getOcrSession();
      const ocrMeta = session.inputMetadata[0] as { type?: string };
      const ocrUseUint8 = ocrMeta?.type?.includes("uint8") ?? false;
      const prepared = prepareOcrInput(image, ocrUseUint8);
      if (!prepared) {
        throw new Error("Unable to prepare OCR input.");
      }
      const inputName = session.inputNames[0];
      const tensor = new ort.Tensor(
        ocrUseUint8 ? "uint8" : "float32",
        prepared.input,
        prepared.shape
      );
      const results = await session.run({ [inputName]: tensor });
      const output = results[session.outputNames[0]] as ort.Tensor;
      const decoded = decodeOcrOutput(output);
      const plate = extractPlate(decoded.text);
      if (!plate) {
        setOcrStatus("error");
        setOcrError("No plate detected. Try again with a clearer shot.");
        clearOcrTimeout();
        return "";
      }
      setOcrStatus("success");
      setOcrConfidence(decoded.confidence ?? null);
      clearOcrTimeout();
      return plate;
    } catch (error) {
      setOcrStatus("error");
      setOcrError(error instanceof Error ? error.message : "OCR failed.");
      clearOcrTimeout();
      return "";
    }
  };

  const handleDetectPlate = async () => {
    if (ocrStatus === "loading") return;
    if (!cameraReady) {
      return;
    }
    const snapshot = await captureFrame();
    const trimmed = normalizePlate(plateInput.trim());
    if (trimmed) {
      setDetectedPlate(trimmed);
      setPlateInput(trimmed);
      return;
    }
    if (snapshot) {
      setOcrStatus("loading");
      setOcrError(null);
      clearOcrTimeout();
      ocrTimeoutRef.current = window.setTimeout(() => {
        setOcrStatus("error");
        setOcrError("Scan timed out. Please try again.");
      }, 15000);
      try {
        rawSnapshotBlobRef.current = snapshot.blob;
        stopCamera();
        const image = await loadImageElement(snapshot.url);
        if (!image) {
          throw new Error("Unable to read camera frame.");
        }
        const detectorSession = await getDetectorSession();
        const inputName = detectorSession.inputNames[0];
        const inputMeta = detectorSession.inputMetadata[0] as {
          dimensions?: Array<number | string>;
        };
        const inputHeight = Number(inputMeta?.dimensions?.[2]) || 640;
        const inputWidth = Number(inputMeta?.dimensions?.[3]) || 640;
        const prepared = prepareDetectorInput(image, inputWidth, inputHeight, false);
        if (!prepared) {
          throw new Error("Unable to prepare detector input.");
        }
        const tensor = new ort.Tensor(
          prepared.type,
          prepared.input,
          [1, 3, inputHeight, inputWidth]
        );
        const outputs = await detectorSession.run({ [inputName]: tensor });
        const output = outputs[detectorSession.outputNames[0]] as ort.Tensor;
        const detections = parseDetectorOutput(output, inputWidth, inputHeight, 0.3);
        if (!detections.length) {
          throw new Error("No plate detected. Try again with a clearer shot.");
        }
        const best = detections[0];
        const x1 = Math.max(0, (best.box[0] - prepared.padX) / prepared.scale);
        const y1 = Math.max(0, (best.box[1] - prepared.padY) / prepared.scale);
        const x2 = Math.min(
          image.width,
          (best.box[2] - prepared.padX) / prepared.scale
        );
        const y2 = Math.min(
          image.height,
          (best.box[3] - prepared.padY) / prepared.scale
        );
        const cropped = (await cropPlate(image, [x1, y1, x2, y2])) ?? snapshot;
        if (cropped.url !== snapshot.url) {
          URL.revokeObjectURL(snapshot.url);
        }
        if (snapshotPreviewUrlRef.current) {
          URL.revokeObjectURL(snapshotPreviewUrlRef.current);
        }
        snapshotPreviewUrlRef.current = cropped.url;
        snapshotBlobRef.current = cropped.blob;
        setSnapshotUrl(cropped.url);
        const ocrResult = normalizePlate(await runOcr(cropped.url));
        if (ocrResult) {
          setDetectedPlate(ocrResult);
          setPlateInput(ocrResult);
          detectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
          return;
        }
      } catch (error) {
        setOcrStatus("error");
        setOcrError(error instanceof Error ? error.message : "Plate scan failed.");
        clearOcrTimeout();
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
    detailsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    requestLocation();

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

  const shareText = useMemo(() => {
    if (!infoData) return "";
    const lines = Object.entries(infoData).map(
      ([key, value]) => `${formatLabel(key)}: ${String(value)}`
    );
    const locationLine = locationData
      ? `Location: ${locationData.lat.toFixed(6)}, ${locationData.lng.toFixed(6)}`
      : "";
    return `Vehicle details\n${lines.join("\n")}${locationLine ? `\n${locationLine}` : ""}`;
  }, [infoData, locationData]);

  const handleShare = async () => {
    if (!shareText) return;
    const url = typeof window !== "undefined" ? window.location.href : "";
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Vehicle details",
          text: shareText,
          url,
        });
        return;
      } catch {
        return;
      }
    }
  };

  const handleSave = async () => {
    if (!infoData) return;
    setSaveStatus("loading");
    setSaveError(null);
    try {
      const token = localStorage.getItem("supabaseAccessToken") ?? "";
      if (!token) {
        throw new Error("Please sign in to save.");
      }
      const blobToDataUrl = (blob: Blob) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("Unable to read image."));
          reader.readAsDataURL(blob);
        });
      const snapshotDataUrl = snapshotBlobRef.current
        ? await blobToDataUrl(snapshotBlobRef.current)
        : null;
      const rawDataUrl = rawSnapshotBlobRef.current
        ? await blobToDataUrl(rawSnapshotBlobRef.current)
        : null;
      const response = await fetch("/api/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          plate: normalizePlate(detectedPlate || plateInput),
          vehicleData: infoData,
          ocrConfidence,
          location: locationData,
          snapshotUrl: snapshotDataUrl,
          rawSnapshotUrl: rawDataUrl,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload?.error || "Save failed.");
      }
      setSaveStatus("success");
    } catch (error) {
      setSaveStatus("error");
      setSaveError(error instanceof Error ? error.message : "Save failed.");
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setUserEmail(null);
  };

  const handleToggleZoom = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const capabilities = track.getCapabilities?.();
    if (!capabilities || !("zoom" in capabilities)) {
      setZoomSupported(false);
      return;
    }
    const target = zoomed ? 1 : 3;
    try {
      await track.applyConstraints({
        advanced: [{ zoom: target } as MediaTrackConstraintSet],
      });
      setZoomed(!zoomed);
    } catch {
      setZoomSupported(false);
    }
  };

  const handleResumeCamera = async () => {
    stopCamera();
    clearOcrTimeout();
    if (snapshotPreviewUrlRef.current) {
      URL.revokeObjectURL(snapshotPreviewUrlRef.current);
      snapshotPreviewUrlRef.current = null;
    }
    snapshotBlobRef.current = null;
    rawSnapshotBlobRef.current = null;
    setSnapshotUrl(null);
    setDetectedPlate(null);
    setPlateInput("");
    setOcrStatus("idle");
    setOcrError(null);
    setOcrConfidence(null);
    setLookupStatus("idle");
    setLookupError(null);
    setVehicleData(null);
    setSaveStatus("idle");
    setSaveError(null);
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    await startCamera();
  };


  const requestLocation = () => {
    if (!navigator.geolocation) {
      setLocationStatus("error");
      return;
    }
    setLocationStatus("loading");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocationData({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
        setLocationStatus("success");
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          setLocationStatus("denied");
        } else {
          setLocationStatus("error");
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  };

  useEffect(() => {
    if (!locationData || !mapContainerRef.current || !mapboxToken) return;

    mapboxgl.accessToken = mapboxToken;
    if (!mapRef.current) {
      mapRef.current = new mapboxgl.Map({
        container: mapContainerRef.current,
        style: "mapbox://styles/mapbox/streets-v12",
        center: [locationData.lng, locationData.lat],
        zoom: 14,
      });
      mapRef.current.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
      markerRef.current = new mapboxgl.Marker({ color: "#0f172a" })
        .setLngLat([locationData.lng, locationData.lat])
        .addTo(mapRef.current);
    } else {
      mapRef.current.setCenter([locationData.lng, locationData.lat]);
      markerRef.current?.setLngLat([locationData.lng, locationData.lat]);
    }
  }, [locationData, mapboxToken]);

  useEffect(() => {
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (snapshotPreviewUrlRef.current) {
        URL.revokeObjectURL(snapshotPreviewUrlRef.current);
        snapshotPreviewUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      const email = data.session?.user?.email ?? null;
      setUserEmail(email);
      if (data.session?.access_token) {
        localStorage.setItem("supabaseAccessToken", data.session.access_token);
      }
      setAuthReady(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      const email = session?.user?.email ?? null;
      setUserEmail(email);
      if (session?.access_token) {
        localStorage.setItem("supabaseAccessToken", session.access_token);
      } else {
        localStorage.removeItem("supabaseAccessToken");
      }
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, []);

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
            <nav className="ml-auto flex items-center gap-4 text-xs font-semibold uppercase tracking-[0.3em] text-slate-500">
              {authReady && userEmail ? (
                <>
                  <span className="hidden text-slate-600 md:inline">{userEmail}</span>
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="hover:text-slate-900"
                  >
                    Logout
                  </button>
                </>
              ) : (
                <>
                  <Link className="hover:text-slate-900" href="/auth/sign-in">
                    Sign In
                  </Link>
                  <Link className="hover:text-slate-900" href="/auth/sign-up">
                    Sign Up
                  </Link>
                </>
              )}
            </nav>
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
            <div className="mt-4 rounded-[24px] border border-slate-200 bg-slate-950/90 text-slate-100">
              <div className="aspect-video w-full overflow-hidden rounded-[20px] border border-white/10 bg-slate-900">
                <video
                  ref={videoRef}
                  className="h-full w-full object-cover"
                  autoPlay
                  muted
                  playsInline
                />
              </div>
              <div className="px-4 pb-4">
                <canvas ref={canvasRef} className="hidden" />
                {cameraError ? (
                  <p className="mt-4 text-sm text-amber-200">{cameraError}</p>
                ) : (
                  <p className="mt-4 text-xs uppercase tracking-[0.3em] text-slate-300">
                    Hold steady for best detection
                  </p>
                )}
              </div>
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-[1.1fr_0.9fr]">
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={cameraReady ? handleDetectPlate : handleResumeCamera}
                  disabled={ocrStatus === "loading"}
                  className="h-12 w-full rounded-full bg-orange-500 text-sm font-semibold uppercase tracking-[0.3em] text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {ocrStatus === "loading"
                    ? "Scanning..."
                    : cameraReady
                    ? "Detect Plate"
                    : "Resume Camera"}
                </button>
                <button
                  type="button"
                  onClick={handleToggleZoom}
                  disabled={!cameraReady || !zoomSupported}
                  className="h-12 w-full rounded-full border border-slate-300 bg-white text-sm font-semibold uppercase tracking-[0.3em] text-slate-800 transition hover:border-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {zoomed ? "Zoom Out" : "Zoom In"}
                </button>
              </div>
            </div>
            <div className="mt-4 rounded-2xl border border-slate-200 bg-white px-4 py-3">
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
            <div
              ref={detectionRef}
              className="rounded-[28px] border border-white/80 bg-white/80 p-6 shadow-[0_18px_40px_rgba(15,23,42,0.1)] animate-fade-in"
            >
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
                  Processing plate...
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
              <button
                type="button"
                onClick={handleLookup}
                className="mt-6 h-12 w-full rounded-full border border-slate-300 bg-white text-sm font-semibold uppercase tracking-[0.3em] text-slate-800 transition hover:border-slate-900"
              >
                Lookup DVLA
              </button>
            </div>

            <div
              ref={detailsRef}
              className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_18px_40px_rgba(15,23,42,0.08)]"
            >
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
              {locationStatus === "loading" ? (
                <p className="mt-4 text-xs uppercase tracking-[0.3em] text-slate-400">
                  Fetching location...
                </p>
              ) : null}
              {locationStatus === "denied" ? (
                <p className="mt-4 text-xs uppercase tracking-[0.3em] text-amber-600">
                  Location permission denied
                </p>
              ) : null}
              {locationStatus === "error" ? (
                <p className="mt-4 text-xs uppercase tracking-[0.3em] text-rose-600">
                  Location unavailable
                </p>
              ) : null}
              {locationData && mapboxToken ? (
                <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200">
                  <div ref={mapContainerRef} className="h-48 w-full" />
                </div>
              ) : null}
              {infoData ? (
                <div className="mt-6 grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={handleShare}
                    className="h-11 w-full rounded-full bg-slate-900 text-xs font-semibold uppercase tracking-[0.3em] text-white"
                  >
                    Share
                  </button>
                  <a
                    className="grid h-11 w-full place-items-center rounded-full border border-slate-300 text-xs font-semibold uppercase tracking-[0.3em] text-slate-700"
                    href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    WhatsApp
                  </a>
                  <a
                    className="grid h-11 w-full place-items-center rounded-full border border-slate-300 text-xs font-semibold uppercase tracking-[0.3em] text-slate-700"
                    href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(
                      typeof window !== "undefined" ? window.location.href : ""
                    )}&quote=${encodeURIComponent(shareText)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Facebook
                  </a>
                  <a
                    className="grid h-11 w-full place-items-center rounded-full border border-slate-300 text-xs font-semibold uppercase tracking-[0.3em] text-slate-700"
                    href={`sms:?body=${encodeURIComponent(shareText)}`}
                  >
                    Text
                  </a>
                  <a
                    className="grid h-11 w-full place-items-center rounded-full border border-slate-300 text-xs font-semibold uppercase tracking-[0.3em] text-slate-700 sm:col-span-2"
                    href={`mailto:?subject=${encodeURIComponent(
                      "Vehicle details"
                    )}&body=${encodeURIComponent(shareText)}`}
                  >
                    Email
                  </a>
                  <button
                    type="button"
                    onClick={handleSave}
                    className="h-12 w-full rounded-full bg-emerald-500 text-sm font-semibold uppercase tracking-[0.3em] text-white sm:col-span-2"
                  >
                    {saveStatus === "loading" ? "Saving..." : "Save"}
                  </button>
                  {saveStatus === "success" ? (
                    <p className="sm:col-span-2 text-xs uppercase tracking-[0.3em] text-emerald-600">
                      Saved to Database
                    </p>
                  ) : null}
                  {saveStatus === "error" ? (
                    <p className="sm:col-span-2 text-xs uppercase tracking-[0.3em] text-rose-600">
                      {saveError ?? "Save failed."}
                    </p>
                  ) : null}
                </div>
              ) : null}
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
