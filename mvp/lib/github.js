/**
 * Validate and preflight public GitHub repositories before cloning.
 */
const GITHUB_URL_RE =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;
const PREFLIGHT_CACHE_MS = 5 * 60 * 1000;
const MAX_REPO_SIZE_KB = 200 * 1024;

const preflightCache = new Map();

export class GitHubPreflightError extends Error {
  constructor(status, reason, message) {
    super(message);
    this.name = "GitHubPreflightError";
    this.status = status;
    this.reason = reason;
  }
}

/** Parse a github.com repository URL into stable public coordinates. */
export function parseGitHubRepoUrl(githubUrl) {
  const trimmed = String(githubUrl || "").trim();
  const match = trimmed.match(GITHUB_URL_RE);
  if (!match) {
    throw new GitHubPreflightError(
      400,
      "invalid_url",
      "Not a valid github.com repo URL. Expected: https://github.com/owner/repo",
    );
  }
  return {
    owner: match[1],
    repo: match[2],
    fullName: `${match[1]}/${match[2]}`,
    normalizedUrl: `https://github.com/${match[1]}/${match[2]}`,
  };
}

/** Fetch GitHub metadata and reject repos too expensive for beta analysis. */
export async function preflightGitHubRepo(githubUrl) {
  const parsed = parseGitHubRepoUrl(githubUrl);
  const key = parsed.fullName.toLowerCase();
  const cached = preflightCache.get(key);
  if (cached && Date.now() - cached.ts < PREFLIGHT_CACHE_MS) {
    return cached.meta;
  }

  const response = await fetch(`https://api.github.com/repos/${parsed.fullName}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "ryngo-beta",
    },
    signal: AbortSignal.timeout(10_000),
  }).catch((err) => {
    throw new GitHubPreflightError(
      502,
      "repo_preflight_failed",
      `GitHub repo preflight failed: ${err.message || err}`,
    );
  });

  if (response.status === 404 || response.status === 403) {
    throw new GitHubPreflightError(
      404,
      "repo_not_found",
      "GitHub repo was not found, is private, or is not accessible.",
    );
  }
  if (!response.ok) {
    throw new GitHubPreflightError(
      502,
      "repo_preflight_failed",
      `GitHub repo preflight failed with status ${response.status}.`,
    );
  }

  const data = await response.json();
  if (data.private) {
    throw new GitHubPreflightError(
      404,
      "repo_not_found",
      "Private GitHub repos are not supported in this beta.",
    );
  }
  if (Number(data.size || 0) > MAX_REPO_SIZE_KB) {
    throw new GitHubPreflightError(
      413,
      "repo_too_large",
      `Repo is ${data.size} KB; beta analysis cap is ${MAX_REPO_SIZE_KB} KB.`,
    );
  }

  const meta = {
    ...parsed,
    defaultBranch: data.default_branch || "HEAD",
    sizeKb: Number(data.size || 0),
    visibility: data.visibility || "public",
  };
  preflightCache.set(key, { ts: Date.now(), meta });
  if (preflightCache.size > 100) {
    const oldest = [...preflightCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) preflightCache.delete(oldest[0]);
  }
  return meta;
}

export function preflightReason(error) {
  return error instanceof GitHubPreflightError ? error.reason : null;
}
