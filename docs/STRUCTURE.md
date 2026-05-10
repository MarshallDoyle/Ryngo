# codegraph Documentation Site — Structure

## 1. Framework Choice: **Astro Starlight**

Recommended over Nextra and Mintlify for the following reasons:

- **OSS-native and matches codegraph's ethos.** Starlight is MIT-licensed, ships as an Astro integration, and produces a fully static site you can host anywhere (GitHub Pages, Cloudflare Pages, Netlify, S3). No vendor lock-in, no hosted dashboard, no telemetry — same posture as a no-LLM static-analysis tool. Mintlify is closed-source and tied to their hosted platform; that's the wrong signal for an MIT OSS project where contributors expect to read and patch the docs toolchain itself.
- **Search out of the box, no API key.** Starlight ships with [Pagefind](https://pagefind.app/) by default — fully client-side, indexed at build time, no Algolia account required. Nextra technically supports FlexSearch but the default-on Pagefind story is cleaner and faster for our size. Mintlify has search but it's tied to their service.
- **Dark mode and theming built in.** Starlight has first-class light/dark with system-pref detection, CSS-variable theming so we can drop in codegraph's brand tokens, and good defaults for code blocks (Shiki) — relevant since half our docs are CLI invocations and YAML.
- **Easy contribution.** Pages are plain Markdown / MDX in a flat `src/content/docs/` tree. A drive-by contributor can fix a typo from the GitHub web editor with zero local setup. Nextra is comparable but pulls in Next.js as a runtime dep, which is heavier than necessary for a docs site and surprises contributors who just want to edit prose. Astro's island architecture also keeps the JS payload small.
- **Strong primitives for technical docs.** Built-in components for callouts (`<Aside>`), tabs, file trees, code groups, and a sidebar that's trivially configured from a single `astro.config.mjs`. Auto-generated "Edit this page on GitHub" links and previous/next navigation. This covers ~95% of what we'd need to hand-build elsewhere.

**Runner-up:** Nextra is fine and the React ecosystem is familiar; pick it if the team already has a Next.js app and wants to share components. Mintlify is excellent if you want zero-effort hosting and can accept the closed-source tradeoff — for codegraph specifically, the values mismatch outweighs the convenience.

---

## 2. Information Architecture

```
docs/
├── index.mdx                                    # Landing page
│
├── getting-started/
│   ├── index.mdx                                # Overview + 60-second pitch, quickstart links
│   ├── install.md                               # npm/brew/curl install, OS matrix, verifying the install
│   ├── first-index.md                           # Run `codegraph index` on a sample repo, what gets emitted
│   ├── viewing-the-graph.md                     # Launch `codegraph serve`, open localhost, basic navigation
│   └── first-pr-comment.md                      # Wire up the GitHub Action, push a PR, read the comment
│
├── concepts/
│   ├── index.mdx                                # Mental model overview, when to read which page
│   ├── ir.md                                    # The IR: what it is, schema, why JSON, stability guarantees
│   ├── nodes-and-tiers.md                       # Node kinds (file/symbol/call-site/...), tier 0/1/2 semantics
│   ├── edges-and-types.md                       # Edge taxonomy (calls/imports/reads/writes/derives/...)
│   ├── adapters.md                              # What adapters do, where they fit, language coverage
│   ├── pure-vs-effectful.md                     # Effect tracking model, why it matters, false positives
│   └── diff-and-pr-comments.md                  # How diffs are computed, what shows up in a PR comment
│
├── cli/
│   ├── index.mdx                                # Command index, global flags (--config, --json, --quiet)
│   ├── index-command.md                         # `codegraph index` — full reference
│   ├── diff.md                                  # `codegraph diff` — full reference
│   ├── serve.md                                 # `codegraph serve` — viewer launch, ports, auth
│   ├── export.md                                # `codegraph export` — DOT/JSON/SVG output
│   ├── init.md                                  # `codegraph init` — scaffolds .codegraph.yml
│   └── adapter.md                               # `codegraph adapter` — list/install/test adapters
│
├── github-action/
│   ├── index.mdx                                # What it does, screenshot of a real PR comment
│   ├── install.md                               # `uses:` block, minimum permissions, workflow placement
│   ├── inputs.md                                # Every input documented with defaults and examples
│   ├── examples.md                              # Common workflows (monorepo, matrix, fork PRs, scheduled)
│   └── troubleshooting.md                       # Token scopes, comment dedup, large-repo timeouts
│
├── viewer/
│   ├── index.mdx                                # Tour of the UI with annotated screenshot
│   ├── keyboard-shortcuts.md                    # Full key map, printable cheatsheet
│   ├── drill-down.md                            # Expanding nodes, following edges, breadcrumbs
│   ├── filtering.md                             # Filter syntax, saved filters, query examples
│   └── exports.md                               # Save view as PNG/SVG/JSON, share links, embed snippets
│
├── configuration/
│   └── codegraph-yml.md                         # Full `.codegraph.yml` reference: every key, defaults, examples
│
├── adapters/
│   ├── index.mdx                                # Why write an adapter, when not to
│   ├── sdk.md                                   # The adapter SDK API surface (types, helpers, test harness)
│   ├── lifecycle.md                             # Init → scan → emit → teardown, hooks, error handling
│   ├── examples.md                              # Annotated walk-throughs (Python adapter, SQL adapter)
│   └── publishing.md                            # Naming, versioning, registry submission, badges
│
├── recipes/
│   ├── index.mdx                                # Recipe index, organized by goal
│   ├── db-writes-from-http.md                   # "Find all DB writes reachable from HTTP input"
│   ├── new-sinks-in-pr.md                       # "Detect new sinks introduced in a PR"
│   └── embed-subgraph-readme.md                 # "Embed a live subgraph in your README"
│
├── faq.md                                       # Top 15 questions, grouped (install / accuracy / perf / privacy)
│
└── contributing/
    ├── index.mdx                                # How the project is organized, code of conduct link
    ├── development-setup.md                     # Cloning, pnpm install, running tests, debugging adapters
    ├── architecture.md                          # Repo layout, package boundaries, where things live
    └── docs.md                                  # How to edit docs, preview locally, style guide
```

### Sidebar grouping (config-level)

Starlight sidebar order, top to bottom:

1. **Getting started** (collapsed by default on inner pages, expanded on `/getting-started/*`)
2. **Concepts**
3. **CLI reference**
4. **GitHub Action**
5. **Viewer**
6. **Configuration**
7. **Writing an adapter**
8. **Recipes**
9. **FAQ** (single page, no group)
10. **Contributing**

### Page conventions

- Every page has frontmatter with `title`, `description` (used for `<meta>` and search snippets), and an optional `sidebar.order` for manual ordering inside a group.
- Reference pages (CLI, config, action inputs) are tabular — argument, type, default, description, example. No prose padding.
- Conceptual pages open with a one-sentence "what this is" line, then a "why you care" paragraph, then the meat. No more than two heading levels deep where avoidable.
- Code samples are runnable as written. If a sample needs setup, the setup is in a collapsed `<details>` above it.
- Every concept page links to the corresponding CLI flag and config key when one exists. Every CLI page links back to the relevant concept page.
- Recipes follow a fixed shape: **Goal → Prerequisites → Steps → Verify → Variations**.
