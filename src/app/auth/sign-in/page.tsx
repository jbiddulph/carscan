"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus("loading");
    setErrorMessage(null);
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      setStatus("error");
      setErrorMessage(error.message);
      return;
    }
    const token = data.session?.access_token;
    if (token) {
      localStorage.setItem("supabaseAccessToken", token);
    }
    setStatus("idle");
    router.push("/");
  };

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-16 text-slate-100">
      <div className="mx-auto flex w-full max-w-lg flex-col gap-6 rounded-3xl border border-slate-800 bg-slate-900/60 p-8">
        <div>
          <p className="text-xs uppercase tracking-[0.4em] text-slate-400">CarScan</p>
          <h1 className="mt-3 text-3xl font-semibold">Sign In</h1>
          <p className="mt-2 text-sm text-slate-400">
            Use your email and password to access saved scans.
          </p>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="text-xs uppercase tracking-[0.35em] text-slate-400">
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-2 w-full rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none"
              required
            />
          </label>
          <label className="text-xs uppercase tracking-[0.35em] text-slate-400">
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-2 w-full rounded-2xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none"
              required
            />
          </label>
          <button
            type="submit"
            className="mt-2 h-12 rounded-full bg-emerald-500 text-xs font-semibold uppercase tracking-[0.3em] text-white"
            disabled={status === "loading"}
          >
            {status === "loading" ? "Signing in..." : "Sign In"}
          </button>
        </form>
        {status === "error" ? (
          <p className="text-xs uppercase tracking-[0.3em] text-rose-400">
            {errorMessage ?? "Sign in failed."}
          </p>
        ) : null}
        <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-[0.35em] text-slate-400">
          <Link className="text-emerald-400" href="/auth/sign-up">
            Create account
          </Link>
          <Link className="text-slate-400" href="/">
            Back to Scan
          </Link>
        </div>
      </div>
    </div>
  );
}
