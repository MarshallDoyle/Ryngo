import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IR, SchemaVersion } from './types';
import { SCHEMA_VERSION } from './types';
import { IRLoadError, loadIR, saveIR, serializeIR } from './io';
import { MigrationRegistry } from './migrations';

/**
 * A minimal valid IR fixture. Whatever ir-types decides (`IRDocument` wrapper
 * vs. flattened), the on-disk JSON has `schemaVersion` at the top level,
 * so this fixture round-trips through JSON correctly.
 */
function fixture(): IR {
  return {
    schemaVersion: SCHEMA_VERSION,
    metadata: {
      repo: 'codegraph/test',
      commit: '0000000000000000000000000000000000000000',
      generatedAt: '2026-05-09T00:00:00.000Z',
      generators: [{ name: 'test', version: '0.0.0' }],
    },
    nodes: [
      {
        id: 'svc:root' as IR['nodes'][number]['id'],
        signature: 'service|codegraph/test|.',
        tier: 'service',
        name: 'root',
        path: '.',
      },
    ],
    edges: [],
  } as unknown as IR;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codegraph-io-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('saveIR + loadIR', () => {
  it('round-trips an IR byte-for-byte', async () => {
    const file = path.join(tmpDir, 'ir.json');
    const ir = fixture();

    await saveIR(file, ir);
    const firstBytes = await fs.readFile(file);

    const loaded = await loadIR(file);
    await saveIR(file, loaded);
    const secondBytes = await fs.readFile(file);

    expect(secondBytes.equals(firstBytes)).toBe(true);
  });

  it('serializes keys in deterministic (sorted) order', async () => {
    const ir = fixture();
    const json = serializeIR(ir);
    // schemaVersion < metadata < nodes < edges sorted alphabetically:
    //   edges, metadata, nodes, schemaVersion
    const idxEdges = json.indexOf('"edges"');
    const idxMetadata = json.indexOf('"metadata"');
    const idxNodes = json.indexOf('"nodes"');
    const idxSchema = json.indexOf('"schemaVersion"');
    expect(idxEdges).toBeGreaterThan(-1);
    expect(idxMetadata).toBeGreaterThan(idxEdges);
    expect(idxNodes).toBeGreaterThan(idxMetadata);
    expect(idxSchema).toBeGreaterThan(idxNodes);
  });

  it('two saves of the same IR produce identical bytes', async () => {
    const a = path.join(tmpDir, 'a.json');
    const b = path.join(tmpDir, 'b.json');
    const ir = fixture();
    await saveIR(a, ir);
    await saveIR(b, ir);
    const ab = await fs.readFile(a);
    const bb = await fs.readFile(b);
    expect(ab.equals(bb)).toBe(true);
  });

  it('saveIR writes atomically — no .tmp file remains on success', async () => {
    const file = path.join(tmpDir, 'ir.json');
    await saveIR(file, fixture());
    const entries = await fs.readdir(tmpDir);
    expect(entries).toEqual(['ir.json']);
  });

  it('saveIR creates parent directories as needed', async () => {
    const file = path.join(tmpDir, 'nested', 'deeper', 'ir.json');
    await saveIR(file, fixture());
    await expect(fs.stat(file)).resolves.toBeDefined();
  });
});

describe('loadIR errors', () => {
  it('throws IRLoadError when the file is missing', async () => {
    const file = path.join(tmpDir, 'nope.json');
    await expect(loadIR(file)).rejects.toBeInstanceOf(IRLoadError);
    await expect(loadIR(file)).rejects.toThrow(/not found/i);
  });

  it('throws IRLoadError on malformed JSON', async () => {
    const file = path.join(tmpDir, 'bad.json');
    await fs.writeFile(file, '{ "schemaVersion": "0.1.0", '); // truncated
    await expect(loadIR(file)).rejects.toBeInstanceOf(IRLoadError);
    await expect(loadIR(file)).rejects.toThrow(/not valid JSON/);
  });

  it('throws IRLoadError when the document is not an object', async () => {
    const file = path.join(tmpDir, 'arr.json');
    await fs.writeFile(file, '[]');
    await expect(loadIR(file)).rejects.toBeInstanceOf(IRLoadError);
  });

  it('throws IRLoadError when schemaVersion is missing', async () => {
    const file = path.join(tmpDir, 'no-ver.json');
    await fs.writeFile(file, JSON.stringify({ nodes: [], edges: [] }));
    await expect(loadIR(file)).rejects.toBeInstanceOf(IRLoadError);
    await expect(loadIR(file)).rejects.toThrow(/schemaVersion/);
  });
});

describe('migrations', () => {
  it('applies a registered migration to lift an old document to current', async () => {
    const file = path.join(tmpDir, 'old.json');
    const oldVersion = '0.0.9' as SchemaVersion;
    // An old document missing today's `metadata.generators` field.
    const oldDoc = {
      schemaVersion: oldVersion,
      metadata: {
        repo: 'codegraph/test',
        commit: '0000000000000000000000000000000000000000',
        generatedAt: '2026-05-09T00:00:00.000Z',
        // No `generators` — the migration adds it.
      },
      nodes: [
        {
          id: 'svc:root',
          signature: 'service|codegraph/test|.',
          tier: 'service',
          name: 'root',
          path: '.',
        },
      ],
      edges: [],
    };
    await fs.writeFile(file, JSON.stringify(oldDoc));

    const registry = new MigrationRegistry();
    registry.register({
      from: oldVersion,
      to: SCHEMA_VERSION,
      apply: (doc) => {
        const d = doc as Record<string, unknown>;
        const md = (d.metadata ?? {}) as Record<string, unknown>;
        return {
          ...d,
          metadata: {
            ...md,
            generators: [{ name: 'legacy-migration', version: '0.0.0' }],
          },
        };
      },
    });

    const loaded = await loadIR(file, { registry });
    expect((loaded as unknown as { schemaVersion: string }).schemaVersion).toBe(
      SCHEMA_VERSION,
    );
    expect(
      (loaded as unknown as { metadata: { generators: unknown[] } }).metadata
        .generators,
    ).toBeDefined();
  });

  it('throws when no migration path exists from an unknown version', async () => {
    const file = path.join(tmpDir, 'future.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        schemaVersion: '99.0.0',
        metadata: {
          repo: '',
          commit: '',
          generatedAt: '2026-05-09T00:00:00.000Z',
          generators: [],
        },
        nodes: [],
        edges: [],
      }),
    );
    await expect(loadIR(file)).rejects.toThrow(/no migration registered/);
  });
});

describe('MigrationRegistry', () => {
  it('rejects duplicate `from` registrations', () => {
    const r = new MigrationRegistry();
    r.register({ from: '0.0.1' as SchemaVersion, to: '0.0.2' as SchemaVersion, apply: (d) => d });
    expect(() =>
      r.register({ from: '0.0.1' as SchemaVersion, to: '0.0.3' as SchemaVersion, apply: (d) => d }),
    ).toThrow(/duplicate/);
  });

  it('rejects no-op migrations', () => {
    const r = new MigrationRegistry();
    expect(() =>
      r.register({ from: '0.0.1' as SchemaVersion, to: '0.0.1' as SchemaVersion, apply: (d) => d }),
    ).toThrow(/no-op/);
  });

  it('lists migrations sorted by `from`', () => {
    const r = new MigrationRegistry();
    r.register({ from: '0.0.3' as SchemaVersion, to: '0.0.4' as SchemaVersion, apply: (d) => d });
    r.register({ from: '0.0.1' as SchemaVersion, to: '0.0.2' as SchemaVersion, apply: (d) => d });
    const versions = r.list().map((m) => m.from);
    expect(versions).toEqual(['0.0.1', '0.0.3']);
  });
});
