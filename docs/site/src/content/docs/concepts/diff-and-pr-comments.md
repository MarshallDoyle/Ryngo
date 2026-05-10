---
title: Diff & PR comments
description: How codegraph computes the diff between two IRs and what ends up in the PR comment.
sidebar:
  order: 7
---

> TODO: Walk through the diff algorithm at a conceptual level — node-id stability is what makes diffs structural, not textual. Categories of diff entries: added/removed/changed nodes, added/removed/changed edges, structural events (cycle introduced, orphan created, public-API break). Show an annotated screenshot of a real PR comment, then map each section back to a category. Cross-link to [`codegraph diff`](/cli/diff/) and [GitHub Action inputs](/github-action/inputs/).
