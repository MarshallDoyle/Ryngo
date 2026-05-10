import Link from "next/link";

export default function HomePage() {
  return (
    <section>
      <h1>payments-demo</h1>
      <p>A tiny payments app used as a codegraph demo fixture.</p>
      <ul>
        <li>
          <Link href="/charge">Create a charge</Link>
        </li>
        <li>
          <Link href="/refund">Issue a refund</Link>
        </li>
      </ul>
    </section>
  );
}
