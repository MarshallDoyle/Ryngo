/**
 * detect — fast yes/no for "does this repo use FastAPI?".
 *
 * Per the adapter spec (§3.2), this must be cheap (<50ms target) and must not
 * scan source. We rely on the host-pre-parsed manifests it hands us:
 *
 *   - `pyproject.toml` — modern Python projects (PEP 621 [project.dependencies]
 *     or Poetry's [tool.poetry.dependencies]). Preferred signal.
 *   - `requirements.txt` (and friends) — exposed via `manifests.other` because
 *     they are not a "well-known" structured manifest the host pre-parses.
 *
 * If neither lists fastapi, we return inactive. This is sound:
 * `analyzeFile` will never receive a Python file that uses FastAPI without
 * fastapi being declared somewhere — the trade-off for a sub-50ms check.
 */
import type { DetectContext, DetectResult } from "@codegraph/adapter-sdk";

const REQ_LINE_RE = /(^|\n)\s*fastapi\b/i;

export async function detect(ctx: DetectContext): Promise<DetectResult> {
  const evidence: string[] = [];

  // ---- pyproject.toml -----------------------------------------------------
  // The host parses TOML for us; both PEP 621 and Poetry layouts surface
  // dependency names somewhere. We do a string-includes pass on the parsed
  // form's serialized `dependencies` shapes — a regex on the raw text would
  // be just as cheap, but data is what the host gives us.
  for (const py of ctx.manifests.pyproject) {
    if (containsFastapiDep(py.data)) {
      evidence.push(`pyproject.toml at ${py.path} declares fastapi`);
    }
  }

  // ---- requirements.txt (and *.txt requirements files) -------------------
  // Not a "structured" manifest, so adapters opt in by reading via fs.
  // We glob for the standard names; a cap keeps this O(repo) tiny.
  try {
    const reqFiles = await ctx.fs.glob("**/{requirements*.txt,requirements/*.txt}");
    for (const path of reqFiles) {
      const content = await ctx.fs.read(path);
      if (REQ_LINE_RE.test(content)) {
        evidence.push(`${path} lists fastapi`);
      }
    }
  } catch {
    // fs glob/read errors are not fatal in detect — they just mean less
    // evidence. We log via the SDK logger; the run continues.
    ctx.log.debug("detect: requirements.txt scan failed; continuing");
  }

  if (evidence.length === 0) return { active: false };
  return { active: true, evidence, confidence: 0.95 };
}

/**
 * Walk a parsed pyproject.toml looking for fastapi in the common dep tables.
 * Covers both PEP 621 and Poetry; the rest (PDM, Hatch) all settle into one
 * of those two shapes after their own toml parsers do their thing.
 */
function containsFastapiDep(data: Record<string, unknown>): boolean {
  // PEP 621: [project] dependencies = ["fastapi >=0.100", ...]
  const project = data["project"];
  if (isObject(project)) {
    const deps = project["dependencies"];
    if (Array.isArray(deps) && deps.some((d) => typeof d === "string" && /^\s*fastapi\b/i.test(d))) {
      return true;
    }
    // Optional deps: project.optional-dependencies.<group> = [...]
    const optional = project["optional-dependencies"];
    if (isObject(optional)) {
      for (const v of Object.values(optional)) {
        if (Array.isArray(v) && v.some((d) => typeof d === "string" && /^\s*fastapi\b/i.test(d))) {
          return true;
        }
      }
    }
  }

  // Poetry: [tool.poetry.dependencies] fastapi = "^0.100"
  const tool = data["tool"];
  if (isObject(tool)) {
    const poetry = tool["poetry"];
    if (isObject(poetry)) {
      const deps = poetry["dependencies"];
      if (isObject(deps) && "fastapi" in deps) return true;
      const groups = poetry["group"];
      if (isObject(groups)) {
        for (const g of Object.values(groups)) {
          if (isObject(g)) {
            const gdeps = g["dependencies"];
            if (isObject(gdeps) && "fastapi" in gdeps) return true;
          }
        }
      }
    }
  }

  // PDM: [tool.pdm.dev-dependencies] sometimes used; covered by tool walk above
  // when the user nests fastapi under tool.pdm.* — PDM itself routes runtime
  // deps into [project] so we already catch those.

  return false;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
