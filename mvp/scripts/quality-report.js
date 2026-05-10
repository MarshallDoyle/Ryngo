/**
 * Print a small compiler-quality report from Postgres or the latest corpus run.
 */
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool } from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (process.env.DATABASE_URL && process.env.RYNGO_EVENTS !== "off") {
  await printDatabaseReport();
} else {
  await printCorpusFallback();
}

async function printDatabaseReport() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const [languages, diagnostics, flags, submissions] = await Promise.all([
      pool.query(`
        select coalesce(lang, 'other') as lang,
               count(*)::int as files,
               count(*) filter (
                 where coalesce(parse_status, '') <> 'ok'
                    or quality_flags <> '[]'::jsonb
               )::int as weak_files
          from file_outcomes
         group by 1
         order by weak_files desc, files desc
         limit 10
      `),
      pool.query(`
        select coalesce(code, 'diagnostic') as code, count(*)::int as count
          from compiler_diagnostics
         group by 1
         order by count desc, code asc
         limit 10
      `),
      pool.query(`
        select flag, count(*)::int as count
          from file_outcomes, jsonb_array_elements_text(quality_flags) as flag
         group by flag
         order by count desc, flag asc
         limit 10
      `),
      pool.query(`
        select submitted_at,
               concat_ws('/', repo_owner, repo_name) as repo,
               coalesce(ref, 'HEAD') as ref,
               accepted,
               reject_reason
          from repo_submissions
         order by submitted_at desc
         limit 10
      `),
    ]);

    console.log("# Ryngo quality report");
    printTable("Weak languages", languages.rows, ["lang", "files", "weak_files"]);
    printTable("Diagnostic codes", diagnostics.rows, ["code", "count"]);
    printTable("Quality flags", flags.rows, ["flag", "count"]);
    printTable("Recent submissions", submissions.rows, [
      "submitted_at",
      "repo",
      "ref",
      "accepted",
      "reject_reason",
    ]);
  } finally {
    await pool.end();
  }
}

async function printCorpusFallback() {
  const latest = path.resolve(__dirname, "..", "test", "results", "latest.md");
  const text = await fs.readFile(latest, "utf8").catch(() => "");
  console.log("# Ryngo quality report");
  console.log("");
  console.log("DATABASE_URL is not set; showing the latest corpus summary instead.");
  console.log("");
  if (!text) {
    console.log("No corpus result found. Run `npm run corpus` first.");
    return;
  }
  console.log(text.split("\n").slice(0, 80).join("\n"));
}

function printTable(title, rows, columns) {
  console.log("");
  console.log(`## ${title}`);
  if (!rows.length) {
    console.log("_No rows yet._");
    return;
  }
  console.log(`| ${columns.join(" | ")} |`);
  console.log(`| ${columns.map(() => "---").join(" | ")} |`);
  for (const row of rows) {
    console.log(`| ${columns.map((column) => display(row[column])).join(" | ")} |`);
  }
}

function display(value) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).replace(/\|/g, "\\|");
}
