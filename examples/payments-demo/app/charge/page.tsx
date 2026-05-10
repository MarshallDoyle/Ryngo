"use client";

import { useState } from "react";
import { formatAmount } from "@/lib/format";

export default function ChargePage() {
  const [amount, setAmount] = useState("2500");
  const [currency, setCurrency] = useState("USD");
  const [customerId, setCustomerId] = useState("cus_demo_001");
  const [result, setResult] = useState<string | null>(null);

  async function submit() {
    const res = await fetch("/api/charge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amount: Number(amount),
        currency,
        customerId,
      }),
    });
    const json = await res.json();
    setResult(JSON.stringify(json, null, 2));
  }

  return (
    <section>
      <h1>Create a charge</h1>
      <p>Preview: {formatAmount(Number(amount), currency)}</p>
      <label>
        Amount (minor units)
        <input value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label>
        Currency
        <input value={currency} onChange={(e) => setCurrency(e.target.value)} />
      </label>
      <label>
        Customer
        <input value={customerId} onChange={(e) => setCustomerId(e.target.value)} />
      </label>
      <button onClick={submit}>Charge</button>
      {result && <pre>{result}</pre>}
    </section>
  );
}
