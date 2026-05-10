---
title: Pure vs effectful
description: codegraph's effect tracking model — what counts as an effect, how effects propagate through the call graph, and why this matters for review.
sidebar:
  order: 6
---

> TODO: Define "effect" (db.write, network, fs.write, mutation, ...) and how the analyzer propagates effects bottom-up. Show a small diagram of a "pure" function turning effectful because a transitive callee writes to disk. Include a candid section on false positives — where the analysis over-approximates and how to suppress per-symbol via `.codegraph.yml`. Cross-link to [Configuration](/configuration/codegraph-yml/).
