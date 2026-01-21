"use client";

import Link from "next/link";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type ScanRecord = {
  id: string;
  created_at: string;
  plate: string;
  vehicle_data: Record<string, string | number | boolean | null>;
  location: { lat: number; lng: number } | null;
  snapshot_path: string | null;
  raw_snapshot_path: string | null;
};

const formatLabel = (value: string) =>
  value
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());

const buildShareText = (record: ScanRecord) => {
  const lines = Object.entries(record.vehicle_data ?? {}).map(
    ([key, value]) => `${formatLabel(key)}: ${String(value)}`
  );
  const locationLine = record.location
    ? `Location: ${record.location.lat.toFixed(6)}, ${record.location.lng.toFixed(6)}`
    : "";
  return `Vehicle details\n${lines.join("\n")}${locationLine ? `\n${locationLine}` : ""}`;
};

export default function MyScansPage() {
  const [records, setRecords] = useState<ScanRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState<ScanRecord | null>(null);
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const mapboxToken = process.env.NEXT_PUBLIC_MAPBOX_PUBLIC_KEY ?? "";

  useEffect(() => {
    let active = true;
    const fetchRecords = async () => {
      setLoading(true);
      setError(null);
      const from = page * 20;
      const to = from + 19;
      const { data, error: fetchError, count } = await supabase
        .from("carscan_vehicles")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, to);
      if (!active) return;
      if (fetchError) {
        setError(fetchError.message);
        setLoading(false);
        return;
      }
      setRecords((data ?? []) as ScanRecord[]);
      setTotal(count ?? 0);
      setLoading(false);
    };
    fetchRecords();
    return () => {
      active = false;
    };
  }, [page]);

  useEffect(() => {
    let active = true;
    const buildSignedUrls = async () => {
      if (!records.length) {
        setSignedUrls({});
        return;
      }
      const entries = await Promise.all(
        records.flatMap((record) => {
          const paths = [record.raw_snapshot_path, record.snapshot_path].filter(
            Boolean
          ) as string[];
          return paths.map(async (path) => {
            const { data } = await supabase.storage
              .from("carscan")
              .createSignedUrl(path, 60 * 60);
            return [path, data?.signedUrl ?? ""] as const;
          });
        })
      );
      if (!active) return;
      const map: Record<string, string> = {};
      for (const [path, url] of entries) {
        if (url) map[path] = url;
      }
      setSignedUrls(map);
    };
    buildSignedUrls();
    return () => {
      active = false;
    };
  }, [records]);

  useEffect(() => {
    if (!selected?.location || !mapContainerRef.current || !mapboxToken) return;
    mapboxgl.accessToken = mapboxToken;
    if (!mapRef.current) {
      mapRef.current = new mapboxgl.Map({
        container: mapContainerRef.current,
        style: "mapbox://styles/mapbox/streets-v12",
        center: [selected.location.lng, selected.location.lat],
        zoom: 13,
      });
      mapRef.current.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");
      markerRef.current = new mapboxgl.Marker({ color: "#0f172a" })
        .setLngLat([selected.location.lng, selected.location.lat])
        .addTo(mapRef.current);
    } else {
      mapRef.current.setCenter([selected.location.lng, selected.location.lat]);
      markerRef.current?.setLngLat([selected.location.lng, selected.location.lat]);
    }
  }, [selected, mapboxToken]);

  useEffect(() => {
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / 20));
  const pageLabel = `${page + 1} / ${totalPages}`;

  const details = useMemo(() => {
    if (!selected) return null;
    return Object.entries(selected.vehicle_data ?? {});
  }, [selected]);

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-10 text-slate-100">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <header className="flex items-center justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-slate-400">CarScan</p>
            <h1 className="mt-2 text-3xl font-semibold">My Scans</h1>
          </div>
          <Link className="text-xs font-semibold uppercase tracking-[0.3em] text-emerald-400" href="/">
            Back to Scan
          </Link>
        </header>

        {loading ? (
          <p className="text-sm text-slate-400">Loading scans...</p>
        ) : error ? (
          <p className="text-sm text-rose-400">{error}</p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {records.map((record) => {
                const rawUrl = record.raw_snapshot_path
                  ? signedUrls[record.raw_snapshot_path]
                  : "";
                const croppedUrl = record.snapshot_path
                  ? signedUrls[record.snapshot_path]
                  : "";
                const shareText = buildShareText(record);
                return (
                  <button
                    key={record.id}
                    type="button"
                    onClick={() => setSelected(record)}
                    className="text-left rounded-2xl border border-slate-800 bg-slate-900/60 p-4 transition hover:border-emerald-500"
                  >
                    <div className="grid gap-3">
                      {rawUrl ? (
                        <img
                          src={rawUrl}
                          alt="Raw scan"
                          className="h-32 w-full rounded-xl object-cover"
                        />
                      ) : (
                        <div className="h-32 w-full rounded-xl bg-slate-800" />
                      )}
                      {croppedUrl ? (
                        <img
                          src={croppedUrl}
                          alt="Detected plate"
                          className="h-20 w-full rounded-xl object-cover"
                        />
                      ) : (
                        <div className="h-20 w-full rounded-xl bg-slate-800" />
                      )}
                      <div>
                        <p className="text-xs uppercase tracking-[0.3em] text-slate-400">
                          {record.plate || "Unknown"}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {new Date(record.created_at).toLocaleString()}
                        </p>
                      </div>
                      <div className="grid gap-2 text-[10px] uppercase tracking-[0.3em] text-slate-400">
                        <a
                          className="rounded-full border border-slate-700 px-3 py-2 text-center text-slate-200"
                          href={`sms:?body=${encodeURIComponent(shareText)}`}
                        >
                          Text
                        </a>
                        <a
                          className="rounded-full border border-slate-700 px-3 py-2 text-center text-slate-200"
                          href={`mailto:?subject=${encodeURIComponent(
                            "Vehicle details"
                          )}&body=${encodeURIComponent(shareText)}`}
                        >
                          Email
                        </a>
                        <a
                          className="rounded-full border border-slate-700 px-3 py-2 text-center text-slate-200"
                          href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          WhatsApp
                        </a>
                        <a
                          className="rounded-full border border-slate-700 px-3 py-2 text-center text-slate-200"
                          href={`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(
                            typeof window !== "undefined" ? window.location.href : ""
                          )}&quote=${encodeURIComponent(shareText)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Facebook
                        </a>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between text-xs uppercase tracking-[0.3em] text-slate-400">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(0, current - 1))}
                disabled={page === 0}
                className="rounded-full border border-slate-700 px-4 py-2 disabled:opacity-50"
              >
                Previous
              </button>
              <span>{pageLabel}</span>
              <button
                type="button"
                onClick={() =>
                  setPage((current) => (current + 1 < totalPages ? current + 1 : current))
                }
                disabled={page + 1 >= totalPages}
                className="rounded-full border border-slate-700 px-4 py-2 disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </>
        )}

        {selected ? (
          <section className="rounded-3xl border border-slate-800 bg-slate-900/60 p-6">
            <div className="flex flex-col gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.35em] text-slate-400">Selected Scan</p>
                <h2 className="mt-2 text-2xl font-semibold">{selected.plate}</h2>
              </div>
              {selected.location && mapboxToken ? (
                <div className="overflow-hidden rounded-2xl border border-slate-800">
                  <div ref={mapContainerRef} className="h-56 w-full" />
                </div>
              ) : null}
              {details ? (
                <dl className="mt-2 grid gap-3 text-sm text-slate-300 sm:grid-cols-2">
                  {details.map(([key, value]) => (
                    <div
                      key={key}
                      className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3"
                    >
                      <dt className="text-xs uppercase tracking-[0.3em] text-slate-400">
                        {formatLabel(key)}
                      </dt>
                      <dd className="mt-2 text-base font-semibold text-slate-100">
                        {String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
