import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

type SavePayload = {
  plate: string;
  vehicleData: Record<string, string | number | boolean | null>;
  ocrConfidence?: number | null;
  location?: { lat: number; lng: number } | null;
  snapshotUrl?: string | null;
  rawSnapshotUrl?: string | null;
};

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
);

const toBuffer = (dataUrl: string) => {
  const match = dataUrl.match(/^data:(.+);base64,(.*)$/);
  if (!match) return null;
  const mime = match[1];
  const data = Buffer.from(match[2], "base64");
  return { mime, data };
};

export async function POST(request: Request) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return NextResponse.json({ error: "Supabase env not configured." }, { status: 500 });
  }

  let payload: SavePayload;
  try {
    payload = (await request.json()) as SavePayload;
  } catch {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  let userId = "anonymous";
  if (token) {
    const { data } = await supabase.auth.getUser(token);
    if (data?.user?.id) {
      userId = data.user.id;
    }
  }

  const { data: inserted, error: insertError } = await supabase
    .from("carscan_vehicles")
    .insert({
      user_id: userId,
      plate: payload.plate,
      vehicle_data: payload.vehicleData,
      ocr_confidence: payload.ocrConfidence ?? null,
      location: payload.location ?? null,
      snapshot_path: null,
      raw_snapshot_path: null,
    })
    .select("id")
    .single();

  if (insertError || !inserted?.id) {
    return NextResponse.json({ error: insertError?.message || "Insert failed." }, { status: 500 });
  }

  const recordId = inserted.id as string;
  const folder = `carscan/${userId}`;
  const uploads: Record<string, string | null> = {
    snapshot_path: null,
    raw_snapshot_path: null,
  };

  if (payload.snapshotUrl) {
    const buffer = toBuffer(payload.snapshotUrl);
    if (buffer) {
      const path = `${folder}/${recordId}-snapshot.png`;
      const { error } = await supabase.storage
        .from("carscan")
        .upload(path, buffer.data, { contentType: buffer.mime, upsert: true });
      if (!error) {
        uploads.snapshot_path = path;
      }
    }
  }

  if (payload.rawSnapshotUrl) {
    const buffer = toBuffer(payload.rawSnapshotUrl);
    if (buffer) {
      const path = `${folder}/${recordId}-raw.png`;
      const { error } = await supabase.storage
        .from("carscan")
        .upload(path, buffer.data, { contentType: buffer.mime, upsert: true });
      if (!error) {
        uploads.raw_snapshot_path = path;
      }
    }
  }

  const { error: updateError } = await supabase
    .from("carscan_vehicles")
    .update({
      snapshot_path: uploads.snapshot_path,
      raw_snapshot_path: uploads.raw_snapshot_path,
    })
    .eq("id", recordId);

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, id: recordId, uploads });
}
