/**
 * `codegraph init` — write a starter `.codegraph.yml` to the working directory.
 *
 * Detection: a shallow scan of the cwd looks for stack markers (package.json,
 * pyproject.toml/requirements.txt, go.mod, Cargo.toml, prisma/schema.prisma,
 * next.config.*, app.py/main.py + a `fastapi` import, *.tf). The closest-fit
 * template is loaded from `./templates/*.yml`, marker blocks
 * (`>>> BOUNDARIES_BLOCK >>>` … `<<< BOUNDARIES_BLOCK <<<` and the matching
 * ADAPTERS_BLOCK) are filled in with detected values, and the result is
 * written to `<cwd>/.codegraph.yml`.
 *
 * The output is plain YAML text — we render it manually rather than pulling a
 * YAML serializer in. The CLI has no `yaml` dependency, and the surface area
 * we render here is small and well-bounded by the template.
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Public option shape. Mirrors the commander definitions in `index.ts`. */
export interface InitOptions {
  /** Force overwrite of an existing `.codegraph.yml`. */
  force?: boolean;
  /** Print the would-be config to stdout instead of writing it. */
  dryRun?: boolean;
  /** Explicit template name; auto-pick when unset. */
  template?: TemplateName;
}

/** Names of the templates shipped in `./templates/`. */
export type TemplateName = 'minimal' | 'monorepo' | 'polyglot';

const TEMPLATE_NAMES = new Set<TemplateName>(['minimal', 'monorepo', 'polyglot']);

/** Result of a stack detection sweep. Drives template choice + adapter list. */
interface DetectionResult {
  /** Workspace-style monorepo signal (pnpm-workspace.yaml or workspaces in package.json). */
  isMonorepo: boolean;
  /** Languages detected with high confidence. */
  languages: Set<'typescript' | 'javascript' | 'python' | 'go' | 'rust'>;
  /** Specific frameworks/tools the adapter section should pre-list. */
  frameworks: Set<'prisma' | 'nextjs' | 'fastapi' | 'terraform'>;
}

interface IOStreams {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/**
 * Run `codegraph init`. Returns the exit code; the caller passes it to
 * `process.exit`. Pure with respect to `cwd` and `io` so unit tests can
 * stub a temp dir + buffer streams.
 */
export async function runInit(
  cwd: string,
  options: InitOptions,
  io: IOStreams,
): Promise<number> {
  const target = join(cwd, '.codegraph.yml');
  const altTarget = join(cwd, '.codegraph.yaml');
  const existing = existsSync(target) ? target : existsSync(altTarget) ? altTarget : null;

  if (existing && !options.force && !options.dryRun) {
    io.stderr.write(
      `codegraph: ${basename(existing)} already exists. Re-run with --force to overwrite, or --dry-run to preview.\n`,
    );
    return 1; // ExitCode.UserError
  }

  const detection = detectStack(cwd);
  const templateName = options.template ?? pickTemplate(detection);

  if (!TEMPLATE_NAMES.has(templateName)) {
    io.stderr.write(
      `codegraph: unknown template "${templateName}". Choose one of: ${[...TEMPLATE_NAMES].join(', ')}.\n`,
    );
    return 1;
  }

  const projectName = basename(resolve(cwd)) || 'my-app';
  let rendered: string;
  try {
    rendered = renderTemplate(templateName, projectName, detection);
  } catch (err) {
    io.stderr.write(
      `codegraph: failed to render template "${templateName}": ${(err as Error).message}\n`,
    );
    return 99; // ExitCode.InternalError
  }

  if (options.dryRun) {
    io.stdout.write(rendered);
    if (!rendered.endsWith('\n')) io.stdout.write('\n');
    return 0;
  }

  try {
    writeFileSync(target, rendered, 'utf8');
  } catch (err) {
    io.stderr.write(
      `codegraph: failed to write ${target}: ${(err as Error).message}\n`,
    );
    return 1;
  }

  io.stderr.write(
    `codegraph: wrote .codegraph.yml (template: ${templateName})\n`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Stack detection
// ---------------------------------------------------------------------------

/**
 * Scan the repo root for stack markers. Reads at most a handful of small
 * files — the goal is a useful starter config in <100ms even on cold caches.
 */
export function detectStack(cwd: string): DetectionResult {
  const result: DetectionResult = {
    isMonorepo: false,
    languages: new Set(),
    frameworks: new Set(),
  };

  // package.json — TypeScript/JavaScript signal + workspace signal.
  const pkgPath = join(cwd, 'package.json');
  if (fileExists(pkgPath)) {
    result.languages.add('javascript');
    const pkg = readJsonSafe(pkgPath);
    if (pkg && typeof pkg === 'object') {
      const obj = pkg as Record<string, unknown>;
      if (Array.isArray(obj.workspaces) || (obj.workspaces as Record<string, unknown> | undefined)?.packages) {
        result.isMonorepo = true;
      }
      if (hasDep(obj, 'typescript') || fileExists(join(cwd, 'tsconfig.json'))) {
        result.languages.add('typescript');
      }
      if (hasDep(obj, 'next')) result.frameworks.add('nextjs');
      if (hasDep(obj, '@prisma/client') || hasDep(obj, 'prisma')) {
        result.frameworks.add('prisma');
      }
    }
  }
  if (fileExists(join(cwd, 'pnpm-workspace.yaml'))) {
    result.isMonorepo = true;
  }
  if (
    fileExists(join(cwd, 'tsconfig.json')) ||
    fileExists(join(cwd, 'tsconfig.base.json'))
  ) {
    result.languages.add('typescript');
  }

  // Python.
  const hasPyproject = fileExists(join(cwd, 'pyproject.toml'));
  const hasRequirements = fileExists(join(cwd, 'requirements.txt'));
  if (hasPyproject || hasRequirements) {
    result.languages.add('python');
    if (detectFastapi(cwd, hasPyproject, hasRequirements)) {
      result.frameworks.add('fastapi');
    }
  }

  // Go / Rust.
  if (fileExists(join(cwd, 'go.mod'))) result.languages.add('go');
  if (fileExists(join(cwd, 'Cargo.toml'))) result.languages.add('rust');

  // Prisma — schema file is the canonical signal even without the npm dep.
  if (fileExists(join(cwd, 'prisma', 'schema.prisma'))) {
    result.frameworks.add('prisma');
  }

  // Next.js — config file in cwd.
  for (const ext of ['js', 'mjs', 'cjs', 'ts']) {
    if (fileExists(join(cwd, `next.config.${ext}`))) {
      result.frameworks.add('nextjs');
      break;
    }
  }

  // Terraform — any *.tf at the repo root.
  if (hasFileWithExt(cwd, '.tf')) {
    result.frameworks.add('terraform');
  }

  return result;
}

/**
 * Choose the closest-fit template. The picker is intentionally simple:
 *   - polyglot if 2+ distinct backend/frontend languages are present
 *   - monorepo if a workspace marker fired
 *   - minimal otherwise (including the all-empty case)
 */
export function pickTemplate(d: DetectionResult): TemplateName {
  // Treat TS+JS as one language family — a TS project typically also reports
  // JS. The polyglot template only fires when truly distinct stacks are mixed.
  const hasJsFamily = d.languages.has('typescript') || d.languages.has('javascript');
  const backendLangs = (['python', 'go', 'rust'] as const).filter((l) =>
    d.languages.has(l),
  );
  const families = (hasJsFamily ? 1 : 0) + backendLangs.length;

  if (families >= 2) return 'polyglot';
  if (d.isMonorepo) return 'monorepo';
  return 'minimal';
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

/**
 * Read a template file, substitute the project name, and replace the
 * BOUNDARIES_BLOCK / ADAPTERS_BLOCK marker pairs with content derived from
 * the detection result. Markers that have no detected content are stripped
 * so the output stays clean.
 */
export function renderTemplate(
  name: TemplateName,
  projectName: string,
  detection: DetectionResult,
): string {
  const raw = readFileSync(templatePath(name), 'utf8');
  let out = raw.replace('__PROJECT_NAME__', yamlString(projectName));

  // BOUNDARIES_BLOCK is overridden by detection only for the minimal template;
  // monorepo and polyglot ship hand-authored defaults inside the markers, so
  // we strip just the markers and keep their bodies.
  out =
    name === 'minimal'
      ? replaceBlock(out, 'BOUNDARIES_BLOCK', renderBoundaries(detection))
      : stripBlockMarkers(out, 'BOUNDARIES_BLOCK');

  out = replaceBlock(out, 'ADAPTERS_BLOCK', renderAdapters(detection));

  return collapseBlankLines(out);
}

/** Resolve the templates directory relative to the compiled module. */
function templatePath(name: TemplateName): string {
  // ESM-only: the package builds with `module: ESNext` and `verbatimModuleSyntax`.
  // The build step is responsible for copying `templates/*.yml` next to the
  // emitted JS so this same relative lookup works in `dist/` as in `src/`.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'templates', `${name}.yml`);
}

/**
 * Replace the body (and the marker lines) between `# >>> NAME >>>` and
 * `# <<< NAME <<<` with `body`. When `body` is empty, the marker pair and
 * its body are stripped entirely.
 */
function replaceBlock(source: string, name: string, body: string): string {
  const span = locateBlock(source, name);
  if (!span) return source;

  const before = source.slice(0, span.start);
  const after = source.slice(span.end);

  if (body.trim() === '') {
    return (before + after).replace(/\n{3,}/g, '\n\n');
  }
  return before + body.trimEnd() + '\n' + after;
}

/**
 * Remove the marker lines but keep the body that lived between them. Used
 * for templates where the body inside the markers is the hand-authored
 * default we want to preserve.
 */
function stripBlockMarkers(source: string, name: string): string {
  const open = `# >>> ${name} >>>`;
  const close = `# <<< ${name} <<<`;
  // Drop the whole line that contains the marker, including its trailing newline.
  return source
    .replace(new RegExp(`^.*${escapeRegExp(open)}.*\\n?`, 'm'), '')
    .replace(new RegExp(`^.*${escapeRegExp(close)}.*\\n?`, 'm'), '');
}

interface BlockSpan {
  /** Byte offset of the start of the line containing the open marker. */
  start: number;
  /** Byte offset just after the newline that follows the close marker. */
  end: number;
}

function locateBlock(source: string, name: string): BlockSpan | null {
  const open = `# >>> ${name} >>>`;
  const close = `# <<< ${name} <<<`;
  const openIdx = source.indexOf(open);
  const closeIdx = source.indexOf(close);
  if (openIdx === -1 || closeIdx === -1 || closeIdx < openIdx) return null;

  // Walk back to the start of the open marker's line.
  let start = openIdx;
  while (start > 0 && source[start - 1] !== '\n') start--;

  // Walk forward past the newline at the end of the close marker's line.
  let end = closeIdx + close.length;
  while (end < source.length && source[end] !== '\n') end++;
  if (end < source.length) end += 1; // include the trailing \n

  return { start, end };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a `boundaries:` block from the detection result. Used only for the
 * minimal template; monorepo and polyglot ship their own boundaries inside
 * the marker block, so we leave those untouched.
 */
function renderBoundaries(d: DetectionResult): string {
  const groups: Array<[string, string[]]> = [];
  if (d.languages.has('typescript') || d.languages.has('javascript')) {
    groups.push(['frontend', ['"**/*.ts"', '"**/*.tsx"', '"**/*.js"', '"**/*.jsx"']]);
  }
  const backend: string[] = [];
  if (d.languages.has('python')) backend.push('"**/*.py"');
  if (d.languages.has('go')) backend.push('"**/*.go"');
  if (d.languages.has('rust')) backend.push('"**/*.rs"');
  if (backend.length > 0) groups.push(['backend', backend]);

  if (d.frameworks.has('terraform')) {
    groups.push(['infra', ['"**/*.tf"']]);
  }

  if (groups.length === 0) return '';

  const lines: string[] = ['boundaries:'];
  for (const [boundary, patterns] of groups) {
    lines.push(`  ${boundary}:`);
    for (const p of patterns) lines.push(`    - ${p}`);
  }
  return lines.join('\n');
}

/**
 * Build an `adapters:` block. Only emitted when at least one adapter is
 * implied by the detection result; otherwise the block is dropped so the
 * config stays as small as possible.
 */
function renderAdapters(d: DetectionResult): string {
  const entries: Array<[string, Record<string, unknown> | null]> = [];

  if (d.languages.has('typescript')) {
    entries.push(['typescript', null]);
  } else if (d.languages.has('javascript')) {
    entries.push(['javascript', null]);
  }
  if (d.languages.has('python')) entries.push(['python', null]);
  if (d.languages.has('go')) entries.push(['go', null]);
  if (d.languages.has('rust')) entries.push(['rust', null]);

  if (d.frameworks.has('prisma')) entries.push(['prisma', null]);
  if (d.frameworks.has('nextjs')) entries.push(['nextjs', null]);
  if (d.frameworks.has('fastapi')) entries.push(['fastapi', null]);
  if (d.frameworks.has('terraform')) entries.push(['terraform', null]);

  if (entries.length === 0) return '';

  const lines: string[] = ['# Adapters auto-detected from your repo. Each runs by default; set'];
  lines.push('# `enabled: false` under any id to skip it.');
  lines.push('adapters:');
  for (const [id, opts] of entries) {
    if (opts === null) {
      lines.push(`  ${id}: {}`);
    } else {
      lines.push(`  ${id}:`);
      for (const [k, v] of Object.entries(opts)) {
        lines.push(`    ${k}: ${formatScalar(v)}`);
      }
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tiny helpers (no external deps)
// ---------------------------------------------------------------------------

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function hasFileWithExt(dir: string, ext: string): boolean {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(ext)) return true;
    }
  } catch {
    /* unreadable dir — treat as no match */
  }
  return false;
}

function readJsonSafe(p: string): unknown {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function hasDep(pkg: Record<string, unknown>, name: string): boolean {
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const block = pkg[key];
    if (block && typeof block === 'object' && name in (block as Record<string, unknown>)) {
      return true;
    }
  }
  return false;
}

/**
 * Heuristic FastAPI check. We're already inside a Python project; this just
 * looks for a `fastapi` mention in the obvious dependency manifest plus a
 * `main.py` or `app.py` entry point. The check is deliberately string-based
 * — full TOML parsing would be overkill for a one-shot init heuristic.
 */
function detectFastapi(cwd: string, hasPyproject: boolean, hasRequirements: boolean): boolean {
  const hasEntryFile =
    fileExists(join(cwd, 'main.py')) ||
    fileExists(join(cwd, 'app.py')) ||
    fileExists(join(cwd, 'app', 'main.py')) ||
    fileExists(join(cwd, 'src', 'main.py'));
  if (!hasEntryFile) return false;

  if (hasRequirements && fileMentions(join(cwd, 'requirements.txt'), 'fastapi')) {
    return true;
  }
  if (hasPyproject && fileMentions(join(cwd, 'pyproject.toml'), 'fastapi')) {
    return true;
  }
  return false;
}

function fileMentions(path: string, needle: string): boolean {
  try {
    return readFileSync(path, 'utf8').toLowerCase().includes(needle.toLowerCase());
  } catch {
    return false;
  }
}

/** Quote a YAML scalar only when necessary; identifier-shaped strings stay bare. */
function yamlString(s: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(s) ? s : JSON.stringify(s);
}

function formatScalar(v: unknown): string {
  if (typeof v === 'string') return yamlString(v);
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

/** Squash 3+ consecutive blank lines to a single blank line. */
function collapseBlankLines(s: string): string {
  return s.replace(/\n{3,}/g, '\n\n');
}
