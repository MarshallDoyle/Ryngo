/**
 * Tests for the `.codegraph.yml` loader.
 *
 * Covers the five scenarios called out in the spec:
 *   1. Zero-config — no file present, defaults are returned verbatim.
 *   2. Partial override — user fields shadow defaults; unspecified ones
 *      keep their default value (deep-merge per §4).
 *   3. Longest-pattern boundary tie-break (and the more-specific-pattern-wins
 *      rule from §3.4).
 *   4. Unknown-adapter ids surface as warnings, not errors.
 *   5. A `schemaVersion` other than 1 is a hard error.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from './defaults.js';
import {
  CodegraphConfigError,
  classifyBoundary,
  loadConfig,
} from './loader.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codegraph-config-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeYaml(name: string, body: string): Promise<string> {
  const file = path.join(tmpDir, name);
  await fs.writeFile(file, body, 'utf8');
  return file;
}

class CapturingSink {
  warnings: string[] = [];
  warn(msg: string): void {
    this.warnings.push(msg);
  }
}

describe('loadConfig — zero-config', () => {
  it('returns the defaults when no .codegraph.yml exists', async () => {
    const sink = new CapturingSink();
    const cfg = await loadConfig(tmpDir, { warn: sink, env: {} });

    expect(cfg).toEqual(DEFAULT_CONFIG);
    expect(sink.warnings).toEqual([]);
    // Must be a clone — mutating the result must not bleed into DEFAULT_CONFIG.
    cfg.ignore.push('mutation');
    expect(DEFAULT_CONFIG.ignore).not.toContain('mutation');
  });

  it('treats an empty .codegraph.yml as a schema-validation error (no schemaVersion)', async () => {
    await writeYaml('.codegraph.yml', '');
    await expect(loadConfig(tmpDir, { env: {} })).rejects.toBeInstanceOf(CodegraphConfigError);
  });
});

describe('loadConfig — partial override', () => {
  it('merges user fields onto defaults (project, output.ir.path, ignore)', async () => {
    await writeYaml(
      '.codegraph.yml',
      [
        'schemaVersion: 1',
        'project:',
        '  name: my-app',
        'ignore:',
        '  - "vendor/**"',
        'output:',
        '  ir:',
        '    pretty: true',
      ].join('\n'),
    );

    const cfg = await loadConfig(tmpDir, { env: {} });

    expect(cfg.project.name).toBe('my-app');

    // user-added ignore is appended after defaults; defaults survive
    expect(cfg.ignore).toContain('**/node_modules/**'); // default kept
    expect(cfg.ignore).toContain('vendor/**'); // user added
    expect(cfg.ignore.indexOf('**/node_modules/**')).toBeLessThan(
      cfg.ignore.indexOf('vendor/**'),
    );

    // user override of one nested field; siblings keep defaults
    expect(cfg.output.ir.pretty).toBe(true);
    expect(cfg.output.ir.path).toBe('.codegraph/ir.json');
    expect(cfg.output.ir.splitChunks).toBe(false);

    // diff defaults are intact
    expect(cfg.diff.fail).toEqual(['error']);
    expect(cfg.diff.rules.boundaryViolationAdded).toBe('error');
  });

  it('honors CODEGRAPH_CONFIG to load a non-default location', async () => {
    const elsewhere = await writeYaml(
      'custom.yml',
      ['schemaVersion: 1', 'project:', '  name: env-config'].join('\n'),
    );

    const cfg = await loadConfig(tmpDir, {
      env: { CODEGRAPH_CONFIG: elsewhere },
    });

    expect(cfg.project.name).toBe('env-config');
  });

  it('errors clearly when CODEGRAPH_CONFIG points at a missing file', async () => {
    await expect(
      loadConfig(tmpDir, {
        env: { CODEGRAPH_CONFIG: path.join(tmpDir, 'does-not-exist.yml') },
      }),
    ).rejects.toThrow(/CODEGRAPH_CONFIG/);
  });

  it('reads .codegraph.json when present and no .yml exists', async () => {
    await fs.writeFile(
      path.join(tmpDir, '.codegraph.json'),
      JSON.stringify({ schemaVersion: 1, project: { name: 'json-app' } }),
      'utf8',
    );
    const cfg = await loadConfig(tmpDir, { env: {} });
    expect(cfg.project.name).toBe('json-app');
  });
});

describe('classifyBoundary — longest-pattern + tie-break', () => {
  it('picks the boundary with the longest matching pattern', async () => {
    await writeYaml(
      '.codegraph.yml',
      [
        'schemaVersion: 1',
        'boundaries:',
        '  frontend:',
        '    - "**/*.tsx"',
        '  shared:',
        '    - "packages/types/components/**"',
      ].join('\n'),
    );

    const cfg = await loadConfig(tmpDir, { env: {} });

    // Both patterns match — `shared`'s pattern body is longer (more specific) and wins.
    expect(classifyBoundary(cfg, 'packages/types/components/Foo.tsx')).toBe('shared');

    // Only `frontend` matches here.
    expect(classifyBoundary(cfg, 'apps/web/Bar.tsx')).toBe('frontend');

    // Nothing matches — implicit _unassigned.
    expect(classifyBoundary(cfg, 'README.md')).toBe('_unassigned');
  });

  it('breaks length ties by declaration order (top wins)', async () => {
    await writeYaml(
      '.codegraph.yml',
      [
        'schemaVersion: 1',
        'boundaries:',
        '  frontend:',
        '    - "src/**"',
        '  backend:',
        '    - "src/**"',
      ].join('\n'),
    );

    const cfg = await loadConfig(tmpDir, { env: {} });
    // Both patterns match identically; `frontend` is declared first.
    expect(classifyBoundary(cfg, 'src/whatever.ts')).toBe('frontend');
  });

  it('honors negation: a leading `!` removes a file from a boundary without moving it', async () => {
    await writeYaml(
      '.codegraph.yml',
      [
        'schemaVersion: 1',
        'boundaries:',
        '  frontend:',
        '    - "src/**"',
        '    - "!src/server/**"',
        '  backend:',
        '    - "src/server/**"',
      ].join('\n'),
    );

    const cfg = await loadConfig(tmpDir, { env: {} });

    // `src/server/db.ts` matches `src/**` in frontend AND the negation removes
    // it; backend's pattern still matches → backend wins.
    expect(classifyBoundary(cfg, 'src/server/db.ts')).toBe('backend');

    // Sanity: a non-server src file still belongs to frontend.
    expect(classifyBoundary(cfg, 'src/ui/index.tsx')).toBe('frontend');
  });
});

describe('loadConfig — unknown adapter id warns, does not error', () => {
  it('emits a warning for unrecognized adapter ids and still returns the config', async () => {
    await writeYaml(
      '.codegraph.yml',
      [
        'schemaVersion: 1',
        'adapters:',
        '  typescript:',
        '    tsconfig: ./tsconfig.json',
        '  zigzag:', // not in KNOWN_ADAPTER_IDS
        '    enabled: true',
      ].join('\n'),
    );

    const sink = new CapturingSink();
    const cfg = await loadConfig(tmpDir, { warn: sink, env: {} });

    expect(cfg.adapters.typescript?.tsconfig).toBe('./tsconfig.json');
    expect(cfg.adapters.zigzag?.enabled).toBe(true);
    expect(sink.warnings).toHaveLength(1);
    expect(sink.warnings[0]).toMatch(/zigzag/);
    expect(sink.warnings[0]).toMatch(/unknown adapter/i);
  });

  it('does not warn for any known adapter id', async () => {
    await writeYaml(
      '.codegraph.yml',
      [
        'schemaVersion: 1',
        'adapters:',
        '  typescript: {}',
        '  python: { enabled: false }',
        '  go: { buildTags: ["integration"] }',
        '  scip: { indexPath: ./build/index.scip }',
      ].join('\n'),
    );

    const sink = new CapturingSink();
    await loadConfig(tmpDir, { warn: sink, env: {} });
    expect(sink.warnings).toEqual([]);
  });
});

describe('loadConfig — schemaVersion mismatch is a hard error', () => {
  it('rejects schemaVersion: 2 with a CodegraphConfigError', async () => {
    await writeYaml('.codegraph.yml', 'schemaVersion: 2\n');
    await expect(loadConfig(tmpDir, { env: {} })).rejects.toBeInstanceOf(
      CodegraphConfigError,
    );
    await expect(loadConfig(tmpDir, { env: {} })).rejects.toThrow(/schemaVersion/);
  });

  it('rejects a missing schemaVersion (validation error)', async () => {
    await writeYaml('.codegraph.yml', 'project:\n  name: bad\n');
    await expect(loadConfig(tmpDir, { env: {} })).rejects.toBeInstanceOf(
      CodegraphConfigError,
    );
  });

  it('rejects a malformed YAML document with a parse error', async () => {
    await writeYaml('.codegraph.yml', 'schemaVersion: 1\nproject: [unterminated');
    await expect(loadConfig(tmpDir, { env: {} })).rejects.toThrow(/parse/);
  });
});
