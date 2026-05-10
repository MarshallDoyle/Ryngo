#!/usr/bin/env -S node --enable-source-maps
/**
 * audit-network-calls.ts
 *
 * Fails the build if `packages/core/src/` or `packages/cli/src/` contains
 * any outbound-network call shape that is not explicitly justified by a
 * preceding `// codegraph:network-ok <reason>` comment on the same line
 * or the line immediately above.
 *
 * This is the mechanical counterpart to PRIVACY.md. The list of allowed
 * reasons is short and intentional: any new entry requires a PRIVACY.md
 * update in the same PR.
 *
 * Run locally:   pnpm tsx scripts/audit-network-calls.ts
 * Run in CI:     same command, exit code is the gate.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import process from "node:process";

const REPO_ROOT = resolve(__dirname, "..");

const SCAN_ROOTS = [
  "packages/core/src",
  "packages/cli/src",
] as const;

const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".tsbuildinfo",
  "coverage",
  "__fixtures__",
  "__snapshots__",
]);

/**
 * Source patterns that indicate an outbound network call. Each entry
 * carries a label (used in the failure message) and a regex that must
 * match an actual call site, not just a string mention.
 *
 * Detection notes:
 *   - We anchor most patterns at a word boundary or import-shape so a
 *     comment that mentions the word doesn't trigger a false positive.
 *   - We deliberately do NOT match string literals like "fetch is
 *     forbidden" — the regex requires a `(` or an import path.
 */
const NETWORK_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "fetch(",          pattern: /(?<![A-Za-z0-9_$.])fetch\s*\(/ },
  { label: "https.request(",  pattern: /(?<![A-Za-z0-9_$.])https?\.request\s*\(/ },
  { label: "https.get(",      pattern: /(?<![A-Za-z0-9_$.])https?\.get\s*\(/ },
  { label: "XMLHttpRequest",  pattern: /(?<![A-Za-z0-9_$.])XMLHttpRequest\b/ },
  { label: "axios",           pattern: /(?:from\s+['"]axios['"]|require\(\s*['"]axios['"]\s*\)|(?<![A-Za-z0-9_$.])axios\s*[.(])/ },
  { label: "got",             pattern: /(?:from\s+['"]got['"]|require\(\s*['"]got['"]\s*\)|(?<![A-Za-z0-9_$.])got\s*\()/ },
  { label: "node-fetch",      pattern: /(?:from\s+['"]node-fetch['"]|require\(\s*['"]node-fetch['"]\s*\))/ },
  { label: "undici",          pattern: /(?:from\s+['"]undici['"]|require\(\s*['"]undici['"]\s*\)|(?<![A-Za-z0-9_$.])undici\.(?:request|fetch|stream|Client|Pool|Agent)\b)/ },
];

const WHITELIST_MARKER = /\/\/\s*codegraph:network-ok\b\s*(.*)$/;

interface Finding {
  file: string;
  lineNumber: number;
  line: string;
  label: string;
}

interface AuditReport {
  filesScanned: number;
  findings: Finding[];
  whitelisted: Array<Finding & { reason: string }>;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (SKIP_DIR_NAMES.has(entry.name)) continue;

    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;

    const dot = entry.name.lastIndexOf(".");
    if (dot < 0) continue;
    const ext = entry.name.slice(dot);
    if (!SCAN_EXTENSIONS.has(ext)) continue;

    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) continue;
    if (entry.name.endsWith(".spec.ts") || entry.name.endsWith(".spec.tsx")) continue;

    out.push(full);
  }
}

function stripBlockComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) {
        for (; i < source.length; i++) out += source[i] === "\n" ? "\n" : " ";
        return out;
      }
      for (let j = i; j < end + 2; j++) out += source[j] === "\n" ? "\n" : " ";
      i = end + 2;
      continue;
    }
    out += source[i];
    i += 1;
  }
  return out;
}

function isInsideStringLiteral(line: string, columnIndex: number): boolean {
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = 0; i < columnIndex; i++) {
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : "";
    if (prev === "\\") continue;
    if (!inDouble && !inBacktick && ch === "'") inSingle = !inSingle;
    else if (!inSingle && !inBacktick && ch === '"') inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === "`") inBacktick = !inBacktick;
  }
  return inSingle || inDouble || inBacktick;
}

function whitelistReasonFor(lineIdx: number, lines: string[]): string | null {
  const sameLine = lines[lineIdx] ?? "";
  const sameLineMatch = sameLine.match(WHITELIST_MARKER);
  if (sameLineMatch) return (sameLineMatch[1] || "").trim() || "(no reason given)";

  const prev = (lines[lineIdx - 1] ?? "").trim();
  const prevMatch = prev.match(/^\/\/\s*codegraph:network-ok\b\s*(.*)$/);
  if (prevMatch) return (prevMatch[1] || "").trim() || "(no reason given)";

  return null;
}

async function scanFile(absPath: string): Promise<{ findings: Finding[]; whitelisted: Array<Finding & { reason: string }> }> {
  const raw = await readFile(absPath, "utf8");
  const stripped = stripBlockComments(raw);
  const lines = stripped.split(/\r?\n/);
  const rel = relative(REPO_ROOT, absPath);

  const findings: Finding[] = [];
  const whitelisted: Array<Finding & { reason: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? "";
    const codePortion = rawLine.replace(/\/\/.*$/, "");

    for (const { label, pattern } of NETWORK_PATTERNS) {
      const match = codePortion.match(pattern);
      if (!match) continue;
      const col = match.index ?? 0;
      if (isInsideStringLiteral(codePortion, col)) continue;

      const reason = whitelistReasonFor(i, lines);
      const finding: Finding = {
        file: rel,
        lineNumber: i + 1,
        line: rawLine.trimEnd(),
        label,
      };

      if (reason !== null) {
        whitelisted.push({ ...finding, reason });
      } else {
        findings.push(finding);
      }
    }
  }

  return { findings, whitelisted };
}

async function audit(): Promise<AuditReport> {
  const allFiles: string[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = resolve(REPO_ROOT, root);
    try {
      const s = await stat(abs);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }
    await walk(abs, allFiles);
  }

  const findings: Finding[] = [];
  const whitelisted: Array<Finding & { reason: string }> = [];

  for (const f of allFiles) {
    const r = await scanFile(f);
    findings.push(...r.findings);
    whitelisted.push(...r.whitelisted);
  }

  return { filesScanned: allFiles.length, findings, whitelisted };
}

function formatFinding(f: Finding): string {
  return `  ${f.file}:${f.lineNumber}  [${f.label}]\n    ${f.line}`;
}

async function main(): Promise<void> {
  const report = await audit();

  if (process.env.CODEGRAPH_AUDIT_VERBOSE === "1" || process.argv.includes("--verbose")) {
    process.stdout.write(`audit-network-calls: scanned ${report.filesScanned} file(s)\n`);
    if (report.whitelisted.length > 0) {
      process.stdout.write(`audit-network-calls: ${report.whitelisted.length} explicitly justified call(s):\n`);
      for (const w of report.whitelisted) {
        process.stdout.write(`  ${w.file}:${w.lineNumber}  [${w.label}]  -> ${w.reason}\n`);
      }
    }
  }

  if (report.findings.length === 0) {
    process.stdout.write(
      `audit-network-calls: OK — ${report.filesScanned} file(s) scanned, ` +
      `${report.whitelisted.length} justified, 0 unjustified.\n`,
    );
    process.exit(0);
  }

  process.stderr.write(
    `audit-network-calls: FAIL — ${report.findings.length} unjustified network call(s):\n\n`,
  );
  for (const f of report.findings) {
    process.stderr.write(formatFinding(f) + "\n\n");
  }
  process.stderr.write(
    "Each call must be preceded (same line or line above) by a comment of the form:\n" +
    "    // codegraph:network-ok <reason>\n" +
    "where <reason> matches one of the entries enumerated in PRIVACY.md.\n" +
    "If the call is genuinely needed, document it in PRIVACY.md in the same PR.\n",
  );
  process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`audit-network-calls: crashed: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(2);
});
