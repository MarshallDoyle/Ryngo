export function formatAmount(minorUnits: number, currency: string): string {
  const major = minorUnits / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(major);
}

// Dead code — exported but no inbound edge anywhere in the repo.
// codegraph should surface this as an unreferenced export.
export function formatCardLast4(pan: string): string {
  const digits = pan.replace(/\D/g, "");
  return `•••• ${digits.slice(-4)}`;
}
