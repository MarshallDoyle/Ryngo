"use client";

import { useState } from "react";

export default function RefundPage() {
  const [chargeId, setChargeId] = useState("");
  const [reason, setReason] = useState("requested_by_customer");
  const [result, setResult] = useState<string | null>(null);

  async function submit() {
    const res = await fetch("/api/refund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chargeId, reason }),
    });
    const json = await res.json();
    setResult(JSON.stringify(json, null, 2));
  }

  return (
    <section>
      <h1>Issue a refund</h1>
      <label>
        Charge ID
        <input value={chargeId} onChange={(e) => setChargeId(e.target.value)} />
      </label>
      <label>
        Reason
        <input value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <button onClick={submit}>Refund</button>
      {result && <pre>{result}</pre>}
    </section>
  );
}
