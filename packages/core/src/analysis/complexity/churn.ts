/**
 * Git churn + author count, scoped to file granularity.
 *
 * See design/complexity-overlay.md §1.4, §1.5, §4.2, §5.1.
 *
 * One `git log` invocation per repo, parsed streaming into two maps:
 *   - `churn[file]`     count of commits in the window touching the file.
 *   - `authors[file]`   set of distinct (mailmap-collapsed) author names.
 *
 * The output of the `git log` we use looks like:
 *
 *     <sha>\t<author>
 *     packages/core/src/foo.ts
 *     packages/cli/src/bar.ts
 *
 *     <sha>\t<author>
 *     packages/core/src/foo.ts
 *
 * Header lines and file lines are interleaved with blank-line separators
 * (`--name-only` always emits a blank line between commits). We parse this in
 * O(output) without buffering the whole thing as a list of commits.
 *
 * The cache key is the repo HEAD sha + the window. AST-derived metrics have
 * their own cache (per-file mtime); see `index.ts` for the orchestration.
 */
import { execFileSync } from "node:child_process";

export interface ChurnOptions {
  /** Repo root. Passed as `cwd` to `git`. */
  readonly repoRoot: string;
  /** Window size in days. Defaults to 90 per design §1.4. */
  readonly windowDays?: number;
}

/**
 * Per-file churn / author counts. Files that had no commits in the window
 * are absent from the map (callers treat absent as 0 churn / 0 authors).
 */
export interface ChurnResult {
  /** Map of repo-relative POSIX path -> commit count in the window. */
  readonly churn: ReadonlyMap<string, number>;
  /** Map of repo-relative POSIX path -> distinct author count. */
  readonly authors: ReadonlyMap<string, number>;
  /**
   * The HEAD sha at the time of computation. Used as the cache key for
   * invalidation (design §5.1). Empty string if HEAD couldn't be resolved
   * (e.g., shallow clone in a fresh CI runner — we still return what we
   * found, but the cache layer will key it as "no-sha" and refuse to reuse).
   */
  readonly headSha: string;
  /** Window in days actually used (defaulted if not supplied). */
  readonly windowDays: number;
}

/**
 * Run `git log` once and return the per-file maps. Synchronous because it
 * runs once per index (incremental updates reuse the cache, see design §5.2)
 * and because keeping it sync avoids a Promise chain through the metric
 * orchestrator.
 *
 * On any git failure (no .git, shallow clone with no history in the window,
 * permission denied) returns an empty result with `headSha === ""` rather
 * than throwing. The overlay must degrade gracefully — a missing churn
 * column is preferable to an aborted `codegraph index`.
 */
export function computeChurn(options: ChurnOptions): ChurnResult {
  const windowDays = options.windowDays ?? 90;
  const headSha = readHeadSha(options.repoRoot);

  const out = runGitLog(options.repoRoot, windowDays);
  if (out === null) {
    return {
      churn: new Map(),
      authors: new Map(),
      headSha,
      windowDays,
    };
  }

  const { churn, authors } = parseGitLog(out);
  // Convert author Sets to size counts so callers don't accidentally hold the
  // full string list in memory at the IR level. The aggregate step still
  // takes the union via the raw set when rolling up modules; for that we
  // expose `parseGitLog` separately below.
  const authorCounts = new Map<string, number>();
  for (const [file, set] of authors) authorCounts.set(file, set.size);

  return { churn, authors: authorCounts, headSha, windowDays };
}

/**
 * Same as `computeChurn` but returns the full per-file author *sets* so
 * higher tiers can union them (design §3.1: "module authors = size of the
 * union, not sum"). The IR-attached overlay only needs counts; the
 * aggregator needs the raw sets.
 */
export function computeChurnWithAuthorSets(options: ChurnOptions): {
  readonly churn: ReadonlyMap<string, number>;
  readonly authorSets: ReadonlyMap<string, ReadonlySet<string>>;
  readonly headSha: string;
  readonly windowDays: number;
} {
  const windowDays = options.windowDays ?? 90;
  const headSha = readHeadSha(options.repoRoot);

  const out = runGitLog(options.repoRoot, windowDays);
  if (out === null) {
    return {
      churn: new Map(),
      authorSets: new Map(),
      headSha,
      windowDays,
    };
  }

  const { churn, authors } = parseGitLog(out);
  return { churn, authorSets: authors, headSha, windowDays };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse the output of `git log --since=<n>.days --pretty=format:'%H<TAB>%an'
 * --name-only --use-mailmap` into per-file maps.
 *
 * Exposed for unit testing (we don't want to spawn git in tests). The format
 * is a sequence of records separated by blank lines; each record is:
 *
 *     <sha>\t<author>
 *     <file>
 *     <file>
 *     ...
 *
 * Note that `--name-only` *can* emit zero file lines for a commit that
 * touched only renames the way git's `-M` heuristic decides not to print, or
 * a merge commit that introduced no path-level changes; the parser handles
 * that case as "header without file lines".
 */
export function parseGitLog(stdout: string): {
  readonly churn: Map<string, number>;
  readonly authors: Map<string, Set<string>>;
} {
  const churn = new Map<string, number>();
  const authors = new Map<string, Set<string>>();

  // Split on any line-ending; tolerate CRLF on Windows runners. We don't use
  // `.split("\n\n")` because a multi-blank-line gap would produce empty
  // records — `git log --pretty=format` doesn't emit a trailing newline so
  // the format is "blank line == record separator."
  const lines = stdout.split(/\r?\n/);

  let currentAuthor: string | null = null;
  let currentRecordFiles: Set<string> | null = null;

  const flush = () => {
    if (currentAuthor === null || currentRecordFiles === null) return;
    for (const file of currentRecordFiles) {
      churn.set(file, (churn.get(file) ?? 0) + 1);
      let set = authors.get(file);
      if (!set) {
        set = new Set();
        authors.set(file, set);
      }
      set.add(currentAuthor);
    }
    currentAuthor = null;
    currentRecordFiles = null;
  };

  for (const line of lines) {
    if (line === "") {
      flush();
      continue;
    }

    // A header line contains a TAB. File paths from `--name-only` may
    // contain unusual characters but never a TAB unless they were committed
    // with `core.quotePath` off and a literal tab in the name — extremely
    // rare; we accept the false-positive risk in exchange for a
    // O(line-length) check rather than a state machine.
    const tabIdx = line.indexOf("\t");
    if (currentAuthor === null && tabIdx > 0) {
      // First non-empty line of a record: it's the header.
      // Header is `<sha><TAB><author name>`. Author may itself contain
      // spaces; everything after the first tab is the author.
      currentAuthor = line.slice(tabIdx + 1);
      currentRecordFiles = new Set();
      continue;
    }

    // Otherwise it's a file path within the current record.
    if (currentRecordFiles !== null) {
      // De-dup within a single commit — a commit listing the same path
      // twice (rare, but `--name-only` can do it for merges with conflict
      // resolution) should only count once.
      currentRecordFiles.add(line);
    }
  }

  // Trailing record without a separating blank line.
  flush();

  return { churn, authors };
}

// ---------------------------------------------------------------------------
// Git invocation
// ---------------------------------------------------------------------------

function runGitLog(repoRoot: string, windowDays: number): string | null {
  // The exact command from design §4.2. Args are passed as an array (not a
  // shell string) so there is no command-injection surface even if
  // `repoRoot` is attacker-controlled.
  const args = [
    "log",
    `--since=${windowDays}.days`,
    "--pretty=format:%H%x09%an",
    "--name-only",
    "--use-mailmap",
  ];

  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      // 64 MiB cap. A repo with >1M lines of git output in a 90d window is
      // exotic; if it happens we'll truncate and the metric will be
      // under-counted. That's still better than failing the whole index.
      maxBuffer: 64 * 1024 * 1024,
      // Don't inherit the parent's stdio — we don't want git's stderr
      // contaminating CLI output for the common "not a git repo" case.
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function readHeadSha(repoRoot: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}
