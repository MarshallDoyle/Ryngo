/**
 * Background watcher — runs corpus-run on a fixed cadence so deltas keep
 * accumulating in test/results/history.json without manual triggering.
 *
 * Usage:
 *   node scripts/corpus-watch.js                       # default 30 min
 *   CORPUS_INTERVAL_MIN=60 node scripts/corpus-watch.js
 *   node scripts/corpus-watch.js --once                # run once and exit (same as corpus-run)
 *
 * Stop with Ctrl-C. PID is printed at startup so you can `kill <pid>`.
 *
 * The watcher does NOT spawn the runner as a child process — it imports it
 * so the same Node process handles every iteration (lower overhead, shared
 * cache between branches once we land 5.7+).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(__dirname, "corpus-run.js");

const argv = process.argv.slice(2);
const once = argv.includes("--once");
const intervalMin = Number(process.env.CORPUS_INTERVAL_MIN) || 30;
const intervalMs = Math.max(60_000, intervalMin * 60_000); // floor 1 min

console.log(
  `corpus-watch: interval=${intervalMin}min  pid=${process.pid}  (Ctrl-C to stop)`,
);

let stopping = false;
process.on("SIGINT", () => {
  console.log("\ncorpus-watch: stopping...");
  stopping = true;
});

async function tick() {
  const startedAt = new Date().toISOString();
  console.log(`\n[corpus-watch] tick @ ${startedAt}`);
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      console.log(`[corpus-watch] runner exited code=${code}`);
      resolve(null);
    });
    child.on("error", (err) => {
      console.error(`[corpus-watch] runner failed: ${err.message}`);
      resolve(null);
    });
  });
}

(async () => {
  await tick();
  if (once) return;
  while (!stopping) {
    await new Promise((r) => setTimeout(r, intervalMs));
    if (stopping) break;
    await tick();
  }
  console.log("corpus-watch: exited cleanly");
})();
