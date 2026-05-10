const BASE = process.env.NEXT_PUBLIC_PAYMENTS_API_URL ?? "http://localhost:8000";
const TOKEN = process.env.PAYMENTS_API_TOKEN ?? "";

type Ok<T> = { ok: true } & T;
type Err = { ok: false; status: number; message: string };

async function request<T>(path: string, init?: RequestInit): Promise<Ok<T> | Err> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    return { ok: false, status: res.status, message: await res.text() };
  }
  const data = (await res.json()) as T;
  return { ok: true, ...data };
}

export type ChargeInput = {
  amount: number;
  currency: string;
  customerId: string;
};

export type ChargeResult = {
  id: string;
  status: "succeeded" | "requires_review" | "declined";
  amount: number;
};

export function postCharge(input: ChargeInput) {
  return request<ChargeResult>("/charges", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type RefundInput = { chargeId: string; reason: string };
export type RefundResult = { id: string; chargeId: string; status: "refunded" };

export function postRefund(input: RefundInput) {
  return request<RefundResult>("/refunds", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type Customer = { id: string; email: string; createdAt: string };

export function getCustomer(id: string) {
  return request<Customer>(`/customers/${encodeURIComponent(id)}`);
}
