/**
 * Tier-2 framework adapter registry.
 *
 * Each adapter exports four optional hooks (per spec/adapter-interface.md):
 *
 *   detect(ctx) → boolean           // run on this repo?
 *   analyzeFile(file, ctx) → frags  // per-file emit; called for each parsed file
 *   resolveCrossFile(ctx) → frags   // second pass after all per-file emits
 *   finalize(ctx) → frags           // last-chance validation / cleanup
 *
 * `frags` shape:
 *   { nodes: [...], edges: [...], effects?: [{ ownerId, sink }] }
 *
 * Adapters add new node kinds (`http-route`, `db-model`, `env`, `infra-resource`)
 * and edge kinds (`db-read`, `db-write`, `route-handler`, `env-read`,
 * `network`, `fs-read`, `fs-write`, `exec`). The IR assembler merges them
 * unchanged.
 *
 * Topological order: detection runs first, then per-file, then cross-file,
 * then finalize. Within each phase adapters run in registration order.
 */
import express from "./express.js";
import fastapi from "./fastapi.js";
import nextjs from "./nextjs.js";
import django from "./django.js";
import rails from "./rails.js";
import spring from "./spring.js";
import prisma from "./prisma.js";
import sqlalchemy from "./sqlalchemy.js";
import graphql from "./graphql.js";
import terraform from "./terraform.js";
import env from "./env.js";

const REGISTRY = [
  express, fastapi, nextjs, django, rails, spring,
  prisma, sqlalchemy, graphql, terraform, env,
];

/**
 * Run all adapters whose `detect(ctx)` returns true.
 *
 * `ctx` carries:
 *   - parsedFiles: Array<{ relPath, parsed }>
 *   - fileIndex:   Map<relPath, fileNodeId>
 *   - rootDir:     string (clone path, for direct file reads)
 *   - readFile:    async (relPath) => string | null
 *   - repoName:    string ("owner/repo")
 *
 * Returns:
 *   { nodes, edges, effects, diagnostics, ranAdapters: [...adapter names] }
 */
export async function runAdapters(ctx) {
  const ranAdapters = [];
  const allNodes = [];
  const allEdges = [];
  const allEffects = [];
  const diagnostics = [];

  for (const adapter of REGISTRY) {
    let active = false;
    try {
      active = await adapter.detect?.(ctx);
    } catch (err) {
      diagnostics.push(`adapter ${adapter.name} detect threw: ${err.message}`);
      continue;
    }
    if (!active) continue;
    ranAdapters.push(adapter.name);

    const adapterCtx = { ...ctx, adapter };

    if (adapter.analyzeFile) {
      // Start from parsedFiles, then layer in unparsed files the adapter
      // declared interest in (e.g. env adapter wants to read `.env`).
      const targets = new Map();
      for (const pf of ctx.parsedFiles) targets.set(pf.relPath, pf);
      if (adapter.scanUnparsed) {
        for (const af of ctx.allFiles || []) {
          if (!targets.has(af.relPath) && adapter.scanUnparsed(af.relPath)) {
            targets.set(af.relPath, {
              relPath: af.relPath,
              parsed: { lang: "raw", backend: "none", imports: [], defs: [], calls: [] },
            });
          }
        }
      }
      for (const pf of targets.values()) {
        try {
          const frags = await adapter.analyzeFile(pf, adapterCtx);
          mergeFragments(frags, allNodes, allEdges, allEffects);
        } catch (err) {
          diagnostics.push(
            `adapter ${adapter.name} analyzeFile(${pf.relPath}) threw: ${err.message}`,
          );
        }
      }
    }

    if (adapter.resolveCrossFile) {
      try {
        const frags = await adapter.resolveCrossFile(adapterCtx);
        mergeFragments(frags, allNodes, allEdges, allEffects);
      } catch (err) {
        diagnostics.push(
          `adapter ${adapter.name} resolveCrossFile threw: ${err.message}`,
        );
      }
    }

    if (adapter.finalize) {
      try {
        const frags = await adapter.finalize(adapterCtx);
        mergeFragments(frags, allNodes, allEdges, allEffects);
      } catch (err) {
        diagnostics.push(
          `adapter ${adapter.name} finalize threw: ${err.message}`,
        );
      }
    }
  }

  return {
    nodes: dedup(allNodes),
    edges: dedupEdges(allEdges),
    effects: allEffects,
    diagnostics,
    ranAdapters,
  };
}

function mergeFragments(frags, nodes, edges, effects) {
  if (!frags) return;
  if (Array.isArray(frags.nodes)) nodes.push(...frags.nodes);
  if (Array.isArray(frags.edges)) edges.push(...frags.edges);
  if (Array.isArray(frags.effects)) effects.push(...frags.effects);
}

function dedup(nodes) {
  const seen = new Map();
  for (const n of nodes) {
    if (!seen.has(n.id)) seen.set(n.id, n);
  }
  return [...seen.values()];
}

function dedupEdges(edges) {
  const seen = new Map();
  for (const e of edges) {
    const key = e.id || `${e.source}=>${e.target}@${e.kind}`;
    if (!seen.has(key)) {
      seen.set(key, { ...e, id: key });
    }
  }
  return [...seen.values()];
}

export { REGISTRY };
