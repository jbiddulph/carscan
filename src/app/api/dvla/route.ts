import { NextResponse } from "next/server";

const DVLA_API_URL = process.env.DVLA_VES_API_URL;
const DVLA_API_KEY = process.env.DVLA_VES_API_KEY;

export async function POST(request: Request) {
  const payload = (await request.json().catch(() => ({}))) as {
    registration?: string;
  };

  const rawRegistration = payload.registration ?? "";
  const normalizedRegistration = rawRegistration
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!normalizedRegistration) {
    return NextResponse.json(
      { error: "Registration is required." },
      { status: 400 }
    );
  }

  if (!DVLA_API_URL || !DVLA_API_KEY) {
    return NextResponse.json(
      { error: "DVLA VES API is not configured." },
      { status: 501 }
    );
  }

  try {
    const response = await fetch(`${DVLA_API_URL}/vehicles`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": DVLA_API_KEY,
      },
      body: JSON.stringify({ registrationNumber: normalizedRegistration }),
      cache: "no-store",
    });

    const data = await response.json().catch(() => ({}));
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    return NextResponse.json(
      { error: "Unable to reach DVLA VES API." },
      { status: 502 }
    );
  }
}
