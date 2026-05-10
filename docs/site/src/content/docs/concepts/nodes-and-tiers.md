---
title: Nodes & tiers
description: The full enumeration of node kinds (file, symbol, call-site, route, query, ...) and the tier 0/1/2 semantics that gate how deep analysis runs.
sidebar:
  order: 3
---

> TODO: Open with a one-sentence "what a node is", then a table of every documented node kind with its required `attrs` schema. Follow with a section on tiers — tier 0 (file/structural), tier 1 (symbol-resolved), tier 2 (effect-propagated) — including approximate cost and what each tier unlocks. Cross-link from each kind row to the CLI flag that controls whether it gets emitted.
