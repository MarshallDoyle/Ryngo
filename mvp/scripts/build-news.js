/**
 * Build `mvp/landing/data/news.json` from `mvp/CHANGELOG.md`.
 *
 * The CHANGELOG follows a strict format: each ship is one line, newest
 * at top, formatted as `YYYY-MM-DD  agent  one sentence.` (per
 * AGENTS.md convention). We grab the top N entries and turn each into
 * a `{ date, agent, title, blurb }` row for the landing's "Latest"
 * section.
 *
 * Why a build step instead of fetching CHANGELOG.md at request time:
 *   - the landing page renders before any client JS runs; baking the
 *     news at deploy time means the section is in the initial HTML
 *   - CHANGELOG.md is ~150 KB and growing; serving only 5 lines as
 *     JSON saves bandwidth
 *   - the parser handles the title/blurb split (first sentence vs.
 *     rest) once, not on every page load
 *
 * Usage:
 *   npm run build:news                       # default: top 6 items
 *   node scripts/build-news.js --limit=10    # explicit cap
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATH = path.join(__dirname, "..", "CHANGELOG.md");
const OUTPUT_PATH = path.join(
  __dirname,
  "..",
  "landing",
  "data",
  "news.json",
);

const argv = process.argv.slice(2);
const limitArg = argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.slice("--limit=".length)) : 6;

// CHANGELOG line shape:
//   `2026-05-10  claude  Token-efficiency benchmark — runs the corpus harness …`
// Anchored at start-of-line; agent token is alphanumeric; everything
// after the second whitespace block is the body.
const LINE_RE = /^(\d{4}-\d{2}-\d{2})\s+(\w+)\s+(.+)$/;

async function main() {
  const text = await fs.readFile(CHANGELOG_PATH, "utf8");
  const items = parseChangelog(text, LIMIT);
  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  const payload = {
    updatedAt: new Date().toISOString().slice(0, 10),
    source: "mvp/CHANGELOG.md",
    items,
  };
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 2) + "\n");
  console.log(
    `news.json: wrote ${items.length} item${items.length === 1 ? "" : "s"} → ${path.relative(process.cwd(), OUTPUT_PATH)}`,
  );
  for (const item of items) {
    console.log(`  ${item.date} · ${item.agent} · ${item.title.slice(0, 70)}`);
  }
}

export function parseChangelog(text, limit = 6) {
  const items = [];
  for (const raw of text.split("\n")) {
    if (items.length >= limit) break;
    const m = raw.match(LINE_RE);
    if (!m) continue;
    const [, date, agent, body] = m;
    items.push(parseEntry({ date, agent, body }));
  }
  return items;
}

/**
 * Split a CHANGELOG body into a short title and a longer blurb.
 *
 * Title: everything up to the first "—" (em-dash, used as a header /
 * description separator in our convention). If there's no em-dash,
 * the title is the full body capped at ~70 chars and the blurb is
 * empty.
 *
 * Blurb: everything after the em-dash, trimmed and capped at 280
 * chars for landing-card sanity.
 */
function parseEntry({ date, agent, body }) {
  const emDashIdx = body.indexOf("—");
  let title;
  let blurb = "";
  if (emDashIdx > 0) {
    title = body.slice(0, emDashIdx).trim();
    blurb = body.slice(emDashIdx + 1).trim();
  } else {
    title = body.trim();
  }
  // Compact whitespace runs (CHANGELOG sometimes wraps mid-paragraph).
  title = title.replace(/\s+/g, " ");
  blurb = blurb.replace(/\s+/g, " ");
  if (title.length > 110) title = title.slice(0, 107) + "...";
  if (blurb.length > 280) blurb = blurb.slice(0, 277) + "...";
  return { date, agent, title, blurb };
}

// Self-execute only when run via `node scripts/build-news.js` so
// `parseChangelog` can be imported in tests.
const argv1 = process.argv[1] || "";
const invokedDirectly =
  argv1.length > 0 &&
  fileURLToPath(import.meta.url) === path.resolve(argv1);
if (invokedDirectly) {
  main().catch((err) => {
    console.error("build-news failed:", err);
    process.exit(1);
  });
}
