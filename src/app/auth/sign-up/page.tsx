"use client";

import Link from "next/link";

export default function SignUpPage() {
  return (
    <div className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100">
      <div className="mx-auto flex w-full max-w-lg flex-col gap-6 rounded-3xl border border-slate-800 bg-slate-900/60 p-8">
        <div>
          <p className="text-xs uppercase tracking-[0.4em] text-slate-400">CarScan</p>
          <h1 className="mt-3 text-3xl font-semibold">Sign Up</h1>
          <p className="mt-2 text-sm text-slate-400">
            Authentication can be added here when you are ready to connect Supabase
            Auth.
          </p>
        </div>
        <div className="rounded-2xl border border-dashed border-slate-700 p-6 text-sm text-slate-400">
          Placeholder sign-up screen.
        </div>
        <Link
          className="text-xs font-semibold uppercase tracking-[0.35em] text-emerald-400"
          href="/"
        >
          Back to Scan
        </Link>
      </div>
    </div>
  );
}
