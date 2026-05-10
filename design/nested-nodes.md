# codegraph — Nested Nodes & Drill-Down UX

Status: design spec, v1
Owner: viewer team
Scope: React Flow viewer (`packages/viewer`)
Out of scope: graph extraction, layout algorithms (covered in `design/layout.md`), theming

---

## 0. Mental model

A codegraph is a forest of nested containers. Five tiers, in containment order:

```
service  ⊃  module  ⊃  type  ⊃  function  ⊃  expression
```

A `service` is a deployable unit (one row in `services.json`: an HTTP server, a worker, a CLI binary). A `module` is a source file or a directory-with-index, depending on language adapter. A `type` is a class, struct, interface, trait, or namespace. A `function` is the smallest callable. An `expression` is a sub-function thing the user pinned (a specific call site, a closure, a SQL query literal) — expressions exist only when explicitly pinned by the user or surfaced by an analyzer rule, never enumerated automatically.

The viewer never shows all five tiers flat. At any zoom level / drill state the user sees one "active tier" plus a thin shell of the parent tier as context. This is non-negotiable: a 50k-function repo at one tier is unreadable, period.

The drill state is two things: the **focused subtree** (which parent's children are expanded) and the **active tier** (deepest tier currently rendered as full nodes). They move together but can diverge briefly during animation.

---

## 1. Tier visuals

Each tier has a fixed visual archetype. Adapters can theme but cannot restructure. All sizes are in React Flow logical units (1 unit ≈ 1 CSS px at zoom 1.0).

### 1.1 Service — large card (480 × 280)

```
┌───────────────────────────────────────────────────┐
│ ▣ checkout-api                       [Node v20]   │
│ services/checkout                                 │
│ ─────────────────────────────────────────────────│
│  ◆ 47 modules    ƒ 312 functions    ↔ 1.2k edges │
│  ⚠ 3 cycles                                       │
│  ─────────────────────────────────────────────── │
│  [ HTTP ]  [ DB ]  [ Queue:orders ]               │
└───────────────────────────────────────────────────┘
```

- Header bar tinted by language family (TS = blue-grey, Go = teal, Python = ochre, Rust = rust, JVM = burgundy).
- Footer chips are *boundaries* — the externally-observable surfaces extracted by adapters. These are the only things visible from outside the service when it is collapsed.
- Drop shadow (`elevation-3`). Radius 12.
- Always renders a "ports" strip on left/right: inbound on left, outbound on right. Edges between services attach to ports, not the card body.

### 1.2 Module — medium card (280 × 160)

```
┌──────────────────────────────────┐
│ ◆ orders/checkout.ts             │
│ ────────────────────────────────│
│  T 2 types   ƒ 11 functions      │
│  imports: 6   exports: 3         │
│  ⓘ side-effects                  │
└──────────────────────────────────┘
```

- Slightly translucent fill (`bg/85`) so the parent service's tint bleeds through. This is the cheapest way to keep the user oriented — they can always tell which service a module belongs to without reading the breadcrumb.
- The "side-effects" badge is a tri-state pill: clean / impure / IO. Computed by adapter; surfaced because it changes how aggressively the user can refactor.
- No ports — module-to-module edges attach to the card edge, routed by ELK.

### 1.3 Type — card (220 × variable, min 100)

```
┌────────────────────────────┐
│ T  Order                   │
│ ──────────────────────────│
│  · id: string              │
│  · items: Item[]           │
│  · total(): number         │
│  · ship(addr): Promise…    │
└────────────────────────────┘
```

- Members stack vertically. Methods get a `ƒ` glyph; fields get `·`. Methods are clickable rows; clicking a method opens its function node inline (not a navigation — see §2.3 "in-place expansion").
- Height auto-sizes up to 8 rows, then shows `+ 12 more` and clips. The full member list is reachable by drilling into the type as a parent.

### 1.4 Function — compact node (160 × 60)

```
┌──────────────────────────┐
│ ƒ  computeTotal          │
│  3 params · 18 lines     │
└──────────────────────────┘
```

- This is the workhorse. Optimized to be readable at zoom 0.6+.
- A red corner triangle (▴) means the function has a TODO/FIXME or an analyzer warning attached. Hover surfaces the message; double-click drills in.
- A purple dot means recursion (direct or via cycle).
- Width does not vary with name length; long names are middle-truncated (`compute…Total`). Truncation is reversible on hover.

### 1.5 Expression — inline pill (auto-width × 24)

```
  ⟨ orders.find(byId) ⟩
```

- Pills don't live on the canvas as standalone nodes. They render *inside* a function node's body when that function is expanded one tier deeper, or as floating annotations on an edge midpoint when the user has pinned a specific call site.
- Pills are read-only in v1 — no drill-down past expression. Past expression is the source-code panel (separate surface).

### 1.6 Tier-to-pixel cheat sheet

| Tier       | Card size      | Default zoom band | Min readable zoom |
|------------|----------------|-------------------|-------------------|
| service    | 480 × 280      | 0.10 – 0.35       | 0.05              |
| module     | 280 × 160      | 0.30 – 0.80       | 0.20              |
| type       | 220 × variable | 0.60 – 1.20       | 0.45              |
| function   | 160 × 60       | 0.90 – 2.00       | 0.65              |
| expression | inline         | 1.50+             | 1.20              |

The "default zoom band" drives §8 (LOD).

---

## 2. Drill-down mechanic

Two mechanisms, layered. Both are always live; they cooperate.

### 2.1 Primary: explicit expand/collapse

- **Double-click a node** → expand into a sub-flow. The node becomes a "container" and its children appear inside, laid out by ELK in a new pass scoped to that subtree.
- **Click empty canvas inside the container** → no-op (preserves drag-to-pan).
- **Click empty canvas outside the container** → collapse, with one twist: it collapses *one* level. To collapse all the way out, click outside repeatedly or hit `Esc` (which collapses everything not on the current breadcrumb path).
- **Esc with nothing expanded** → deselect.
- Expansion is non-destructive: collapsing remembers child positions for the rest of the session, so re-expanding is instant and doesn't relayout.

Why double-click for expand, not single-click? Single-click is "select." We need select to be cheap (it drives the inspector panel and the breadcrumb). Conflating select + expand makes the inspector panel feel laggy because every click triggers a layout.

### 2.2 Secondary: zoom-based auto-expand (LOD)

Independent of explicit expand state, the renderer chooses which tier to show at the current zoom. See §8 for thresholds. Crucially, zoom-LOD only *adds* detail; it never *contradicts* an explicit expand. If the user double-clicked a service, that service stays expanded even when they zoom out far enough that auto-LOD would have collapsed it. This is the rule that keeps the interaction predictable.

### 2.3 Tertiary: in-place type-method expansion

When the user clicks a method row inside a Type card, the method's function node materializes *attached to the type card* (anchored on its right edge) without changing the active tier. This is for the common case "I'm reading a class, I want to glance at one method." It's intentionally cheap — doesn't update breadcrumb, doesn't push history. A second click on any other method swaps in that method (only one inline function visible per type at a time).

### 2.4 What collapsing means for state

Collapsing a parent:
1. Hides children (display only — they remain in the React Flow node array with `hidden: true`).
2. Reroutes edges that targeted children → re-target the parent (see §7 aggregation).
3. Restores the parent's "collapsed" size.
4. Pans the camera so the parent stays in approximately the same screen position (we measure the parent's center pre-collapse, run the collapse, then `setCenter` on the post-collapse parent center).

The pan-preservation is mandatory; without it the user loses their place every time they back out.

---

## 3. React Flow approach

### 3.1 `parentNode` is the spine

We use React Flow's parent/child relationship via `parentNode` (and `extent: 'parent'` to clip dragging). Every non-service node has a `parentNode` pointing at its container. Service nodes have no parent.

```ts
type CGNode = {
  id: string;            // stable, content-addressed: "svc:checkout/mod:orders.ts/fn:computeTotal"
  type: 'service' | 'module' | 'type' | 'function' | 'expression';
  parentNode?: string;   // id of container
  extent?: 'parent';     // clip to parent bounds when dragging (we mostly disable drag anyway)
  position: { x: number; y: number }; // RELATIVE to parentNode if parent is set
  data: CGNodeData;
  hidden?: boolean;      // collapse hides instead of removing
  style?: { width: number; height: number };
};
```

The thing that bites everyone the first time: **child positions are relative to the parent's top-left**, not the canvas. ELK layouts return absolute coordinates per subtree — we translate them to parent-relative before handing them to React Flow. The translation is `child.pos -= parent.pos` per subtree root.

### 3.2 Z-order and selection

React Flow draws parents before children, which is what we want — children always paint on top. Selection rings are children-first too, so clicking a child inside an expanded parent selects the child, not the parent. To select the parent of an expanded subtree, click its header strip (the top 32px), which we mark `data-cg-handle="parent"` and intercept in `onNodeClick`.

### 3.3 One layout per expanded subtree

Each container that is currently expanded owns a layout pass. We do not run a single global layout — that would re-jiggle everything every time anyone expands. Layout passes are keyed by `(parentId, childIds.sort().join(','))` and memoized for the session. Re-expanding a previously-expanded parent is O(1) layout cost.

### 3.4 Sub-flow boundaries

The expanded container draws a dashed inner border 12px inset from its outer edge, visually marking the "sub-flow zone." Edges that originate or terminate inside the zone hit the inner border first; edges crossing into the zone from outside hit the outer border. This costs us nothing visually but makes nested edges parseable.

---

## 4. Animation

### 4.1 Spring, ~200ms, three things move at once

When the user double-clicks a node to expand:

1. **Container resize**: from collapsed dimensions to expanded dimensions. Spring config: `{ stiffness: 220, damping: 26 }` → settles in ~190ms with a subtle overshoot.
2. **Children fade-in + scale**: children start at `opacity: 0, scale: 0.92` and tween to `opacity: 1, scale: 1`. Stagger by 12ms per child up to 8 children, then batch the rest. Cap total stagger at 100ms so it never feels slow.
3. **Edge re-routing**: edges that previously terminated at the parent need to re-target children. We do *not* reroute mid-animation — that looks awful (edges flailing). Instead, edges fade out at 0–60% of the animation, are recomputed at 60%, and fade back in at 60–100%. Net visual: edges briefly disappear and reappear on the new endpoints. This is the standard React Flow Pro pattern and it works.

Collapse is the same in reverse, with one shortcut: we don't stagger children on collapse (they all fade together at 90ms) because collapse is "get out of the way" and shouldn't feel ceremonial.

### 4.2 What we don't animate

- **Camera**: no auto-pan during expand. The container grows in place. If it grows off-screen, that's fine — the user can pan or hit `f` to fit. Auto-panning during expand is the single most disorienting interaction we tested in the prototype.
- **Layout-algorithm running**: ELK runs synchronously on a worker. If a layout takes >50ms (rare, only on huge subtrees), we show a 1-frame skeleton (faded child rectangles in their final positions) and then swap in the real children. We never animate during layout computation.

### 4.3 Reduced motion

If `prefers-reduced-motion: reduce`, all of the above becomes a 0ms snap. No exceptions, no "subtle" fallback. People who set that flag mean it.

---

## 5. Breadcrumbs

Top bar, full width, height 36, sits above the canvas (not on it).

```
┌─────────────────────────────────────────────────────────────────┐
│  acme-monorepo  ›  checkout-api  ›  orders/checkout.ts  ›  Order  ›  ship   │
└─────────────────────────────────────────────────────────────────┘
```

- Each segment is a button. Click → drill *to* that level (collapses everything deeper).
- The leftmost segment is always the repo. It's a no-op click target (we have no "above repo" tier) but renders for visual symmetry.
- Hover on a segment shows a popover with siblings at that level and a fuzzy filter — this doubles as a navigator. So the breadcrumb isn't just a path indicator, it's the cheapest sibling-jumper in the UI.
- Truncate from the middle when total width > viewport: `acme-monorepo › … › Order › ship`. The collapsed `…` expands on click into a popover listing the elided segments.
- The breadcrumb is bound to drill state, not to selection. Selecting a function inside an expanded module does *not* push the function onto the breadcrumb. Drilling into the function (double-click or `]`) does.

### 5.1 Permalinks

Every breadcrumb state is URL-encodable: `?focus=svc:checkout/mod:orders.ts/fn:computeTotal`. Sharing a link replays the drill. We use the content-addressed node ids from §3.1 directly as URL segments (URI-encoded).

---

## 6. Keyboard nav

Default bindings. Rebindable later; not in v1.

| Key             | Action                                                              |
|-----------------|---------------------------------------------------------------------|
| `[`             | Up one level (collapse current focused container, focus its parent) |
| `]`             | Down one level (expand current focus into its first/largest child)  |
| `Esc`           | Collapse everything off the current breadcrumb path                 |
| `f`             | Fit current focused subtree to viewport                             |
| `space`         | Hold-to-pan (releases cursor from selection)                        |
| `cmd+click`     | Focus a node and re-layout siblings around it (radial mode)         |
| `cmd+f`         | Open fuzzy node finder (searches names across tiers)                |
| `1`–`5`         | Force active tier: 1=service, 2=module, 3=type, 4=function, 5=expression. Overrides zoom-LOD until next manual zoom. |
| `g g`           | Go to repo root (Vim-style chord)                                   |
| `?`             | Show keybinding overlay                                             |

### 6.1 `]` "down a level": which child?

Picking which child to drill into when the user hits `]` is a UX question. Options we considered:

- **First in source order**: predictable, but useless on real repos where the first file alphabetically is rarely interesting.
- **Largest child**: works for "where's the bulk of this code," fails for entry-point hunting.
- **Selected child**: only works if the user has already selected one.

Answer: precedence is (1) selected child if there is one, (2) the child the cursor is hovering over, (3) the largest child by descendant-function-count. This sounds like overengineering for one keybinding, but it's the difference between `]` feeling psychic and feeling stupid.

### 6.2 `cmd+click` focus mode

Focus mode is a re-layout, not a drill. The clicked node moves to viewport center (animated), siblings re-arrange around it in a radial layout (function as origin, callers fanned counter-clockwise upper-left, callees clockwise lower-right), and unrelated siblings fade to 0.3 opacity. Hitting `Esc` restores hierarchical layout.

This is a "show me everything that talks to this thing" mode. It crosses tier boundaries — a focused function pulls in callers from other modules, which expand on demand.

---

## 7. Cross-tier edges

This is the hardest part of the design. Get it wrong and the graph is either a hairball or a lie.

### 7.1 Edge model

Every edge has the lowest tier at which it makes sense — the **resolution tier**. A function-to-function call has resolution `function`. An import has resolution `module`. A service-to-service HTTP call has resolution `service`. An edge can never *render* below its resolution tier, but it *can* render above it as an aggregate.

```ts
type CGEdge = {
  id: string;
  sourceId: string;          // id of resolution-tier source (e.g. fn:foo)
  targetId: string;
  resolutionTier: Tier;
  kind: 'call' | 'import' | 'http' | 'queue' | 'db' | 'extends';
  weight?: number;           // for aggregates: count of underlying edges
};
```

### 7.2 Aggregation rules

When the active tier is *higher* than an edge's resolution tier, the edge gets aggregated up:

- For each edge, walk source and target up the containment tree until they reach (or are at) the active tier.
- If the new source ≠ new target, emit an aggregate edge between them.
- Bucket aggregate edges by `(newSource, newTarget, kind)`. Sum weights.

So if module A's function `a1` calls module B's `b1` and `b2`, the module-tier view shows *one* `A → B` edge with `weight: 2` and label `2 calls`. Self-loops (calls within the same parent at the active tier) are dropped from the aggregate view — they're noise at that tier.

### 7.3 Aggregate edge visuals

```
    ┌───┐    8 calls    ┌───┐
    │ A │ ════════════▶ │ B │
    └───┘               └───┘
```

- Double-stroke for aggregates, single-stroke for resolution-tier edges. So at a glance the user knows whether they're looking at a "real" edge or a roll-up.
- Label format: `{count} {kind}s` — `8 calls`, `3 imports`, `2 queries`. Drop the `s` for `1`.
- Hover shows top-3 underlying edges with names; clicking shows all in the inspector panel.
- Color encodes kind: call=neutral, http=blue, db=green, queue=amber, extends=purple.

### 7.4 Mixed expansion (the gnarly case)

User expands module A but leaves module B collapsed. Now `a1` (visible) calls `b1` (hidden). What renders?

- The edge originates from `a1` (its real source).
- The edge terminates at module B's boundary (because B isn't expanded, `b1` doesn't exist on canvas).
- It draws as a *partial aggregate*: solid stroke at the source end (because the source is at resolution tier), double-stroke at the target end (because the target is rolled up). Label: `→ b1` (the name of the actual hidden target). This tells the user "if you expand B, this lands on b1."

This rule generalizes. An edge with one fully-resolved end and one rolled-up end always names its rolled-up end. Edges with both ends rolled up just show the count.

### 7.5 Edge re-routing on expand

When the user expands B in the example above:

1. Find all aggregate edges incident to B.
2. For each, replace with the underlying resolution-tier edges (now B's children exist, so the targets resolve).
3. Apply the §4.1 fade-out/fade-in.

We pre-index this — every container node carries a list of its incoming and outgoing aggregate edges. Expand is O(degree of container), not O(total edges).

---

## 8. Zoom-based LOD

Per §1.6, each tier has a zoom band. The active tier follows zoom by default:

| Zoom range  | Active tier       |
|-------------|-------------------|
| < 0.20      | service           |
| 0.20 – 0.50 | module            |
| 0.50 – 0.95 | type              |
| 0.95 – 1.80 | function          |
| > 1.80      | expression (inline within function) |

### 8.1 Hysteresis

Naively switching tiers at exact thresholds creates flicker when the user zooms near a boundary. We use 10% hysteresis: zooming in switches at the threshold, zooming out switches at threshold × 0.9. So if the function-tier threshold is 0.95, zooming out from function to type happens at 0.855. This single trick makes the difference between "feels janky" and "feels solid."

### 8.2 Cross-fade transitions

When the active tier changes:

- Old-tier nodes fade out over 120ms (`opacity: 1 → 0`, no scale change).
- New-tier nodes fade in over 120ms, offset by 60ms (so there's a 60ms overlap where both are visible).
- Edges follow the same pattern as §4.1 but compressed to 120ms.

We deliberately keep this faster than explicit expand (§4) because zoom-driven changes are involuntary and shouldn't feel ceremonial.

### 8.3 Override behavior (§2.2 reminder)

Explicit expansions persist across LOD transitions. If the user expanded module A while at module-tier zoom (so A's *types* are visible inside it), and then zooms out to service-tier, A stays expanded — the user gets the unusual but correct view of a single expanded module floating inside an otherwise service-tier canvas. This is the only way to support "I want to drill into one thing but keep everything else high-level," which is the most common power-user pattern.

A small badge in the bottom-right (`◉ 2 manual expansions`) tells the user when they're in this mixed state, with a one-click `Reset LOD` action.

---

## 9. Performance

The viewer needs to handle a 200k-function repo at 60fps. Here's the budget.

### 9.1 Virtualization: only render visible children

React Flow doesn't virtualize by default — it renders every node in the array (even with `hidden: true`, the DOM nodes exist). We override this with two layers:

- **Coarse virtualization**: nodes whose bounding box is fully outside the viewport (with a 1× viewport margin for prefetch) are kept out of the React Flow node array entirely. They live in a shadow store. Pan/zoom triggers a delta update to the array. Target: never have more than ~2× viewport-worth of nodes in the array.
- **Fine virtualization**: inside expanded containers, children that fall outside the container's *visible portion* are rendered as a single placeholder rect with the right bounds, swapped in only when scrolled into view. This matters for huge modules (200+ functions) — without it, expanding such a module thrashes for 500ms+.

### 9.2 LOD = free virtualization

The LOD system in §8 already prevents us from drawing function-tier nodes when zoomed out. At service-tier zoom for a 200k-function repo we draw maybe 40 service cards and 80 aggregate edges. Easy. The hard cases are when the user is zoomed in on one expanded subtree.

### 9.3 Edge culling

Edges incident only to nodes outside the viewport are culled. Edges incident to one inside / one outside node clip to the viewport edge — we render the visible segment with a faint terminator showing direction.

### 9.4 Memoize all the layouts

Layout passes (ELK) are expensive but deterministic given inputs. We memoize by `hash(parentId, sortedChildIds, layoutOptionsHash)`. Cache key collisions are impossible by construction. Cache lives in IndexedDB so revisiting a repo doesn't re-layout.

### 9.5 React Flow specifics

- `nodesDraggable={false}` by default. Drag-to-rearrange is opt-in via a "tinker mode" toggle. Most users will never use it, and turning it off saves a measurable amount of work per frame.
- `elementsSelectable={true}` but selection is single-only (`multiSelectionKeyCode={null}`). Multi-select adds complexity to the inspector panel for a feature ~5% of users use.
- Use `useNodesState` minimally — most state lives in a Zustand store that React Flow consumes via the `nodes` prop. This avoids the perf cliff where React Flow's internal state doubles up with app state.
- `nodeTypes` and `edgeTypes` are top-level constants. React Flow re-mounts everything if these change identity per render. Easy footgun.

### 9.6 Performance budget

| State                          | Frame budget | Node count target |
|--------------------------------|--------------|-------------------|
| Service-tier, 50 services      | 16ms         | <100              |
| Module-tier, 1 service expanded| 16ms         | <300              |
| Function-tier, 1 module expanded| 16ms        | <500              |
| Worst case: 5 manual expansions| 33ms (30fps) | <2000             |

If we're outside budget, we drop animation quality before dropping fidelity (cut animation to 100ms, drop staggered fade, etc.).

---

## 10. ASCII mockups

### 10.1 Mockup A — module-tier view, one service expanded

User is exploring `checkout-api`. Service is expanded; module-tier nodes visible inside. Other services collapsed.

```
┌─[ acme-monorepo › checkout-api ]──────────────────────────────────────────┐
│                                                                            │
│   ┌───────────┐                                                            │
│   │ ▣ orders  │                                                            │
│   │  (svc)    │                                                            │
│   └────┬──────┘                                                            │
│        │ 4 http                                                            │
│        ▼                                                                   │
│  ┌─────────────────────────────────────────────────────────────────┐      │
│  │ ▣ checkout-api                                          [Node]  │      │
│  │ ─────────────────────────────────────────────────────────────── │      │
│  │                                                                  │      │
│  │   ┌──────────────┐    8 calls    ┌──────────────┐                │      │
│  │   │ ◆ routes.ts  │ ════════════▶ │ ◆ orders.ts  │                │      │
│  │   └──────┬───────┘               └──────┬───────┘                │      │
│  │          │ 2 imports                    │ 3 imports              │      │
│  │          ▼                              ▼                        │      │
│  │   ┌──────────────┐               ┌──────────────┐                │      │
│  │   │ ◆ auth.ts    │               │ ◆ db.ts      │                │      │
│  │   │  ⓘ side-fx   │               │  ⓘ IO        │                │      │
│  │   └──────────────┘               └──────────────┘                │      │
│  │                                                                  │      │
│  └────────────────────────────────────┬─────────────────────────────┘      │
│                                       │ 2 http                             │
│                                       ▼                                    │
│                                 ┌───────────┐                              │
│                                 │ ▣ billing │                              │
│                                 │  (svc)    │                              │
│                                 └───────────┘                              │
│                                                                            │
│                                       [zoom: 0.42]    [◉ 1 expansion]      │
└────────────────────────────────────────────────────────────────────────────┘
```

Notes:
- `orders` and `billing` are sibling services, kept collapsed. The edges into and out of them are aggregate (double-stroke conceptually; rendered here as `═`).
- Inside `checkout-api`, edges between modules are aggregate too (still `═`, with counts) because the user is at module-tier — function-to-function calls roll up.
- The dashed inner border of the expanded service isn't shown in ASCII; in real UI it sits ~12px inside the outer card.

### 10.2 Mockup B — function-tier with mixed expansion + focus mode

User cmd-clicked `computeTotal`. Focus mode active. Callers fanned upper-left, callees lower-right. Unrelated nodes faded.

```
┌─[ acme-monorepo › checkout-api › orders.ts › computeTotal ]──────────────────┐
│                                                                                │
│   ┌──────────────┐                                                             │
│   │ ƒ checkout   │                                                             │
│   │  ⓘ caller    │·.                                                           │
│   └──────┬───────┘  ·.                                                         │
│          │            ·.                                                       │
│          │ call         ·.                                                     │
│          ▼                ·.                                                   │
│   ┌──────────────┐         ·.    ┌────────────────────┐                        │
│   │ ƒ placeOrder │            ─▶ │ ƒ computeTotal     │ ◀── focused           │
│   │  ⓘ caller    │ ─────call──▶  │   3 params         │                        │
│   └──────────────┘               │   18 lines         │                        │
│                                  └────────┬───────────┘                        │
│                                           │ 2 calls                            │
│                                           ▼                                    │
│                              ┌────────────────────┐                            │
│                              │ ƒ taxFor (callee)  │                            │
│                              └────────┬───────────┘                            │
│                                       │ 1 call                                 │
│                                       ▼                                        │
│                               ┌──────────────┐                                 │
│                               │ ◆ rates.ts   │  ← cross-module callee         │
│                               │  (collapsed) │     (aggregate edge target)   │
│                               └──────────────┘                                 │
│                                                                                │
│   ┌── faded ──┐    ┌── faded ──┐    ┌── faded ──┐                              │
│   │ ƒ unrelat │    │ ƒ logger  │    │ ƒ retry   │                              │
│   └───────────┘    └───────────┘    └───────────┘                              │
│                                                                                │
│                                              [zoom: 1.10]  [Esc to exit focus] │
└────────────────────────────────────────────────────────────────────────────────┘
```

Notes:
- `computeTotal` sits at viewport center after the focus animation.
- `rates.ts` is a collapsed module — `taxFor` calls into a function inside it, but since `rates.ts` isn't expanded, the edge terminates at the module with the partial-aggregate styling described in §7.4.
- Unrelated functions in the same module are still on screen but at 0.3 opacity. They remain interactive — clicking one exits focus mode and selects it.

---

## 11. Open questions deferred to v2

- **Multi-root focus**: cmd-clicking with shift held to add a second focus node. Layout becomes a 2-node radial. Useful for "compare these two functions' call neighborhoods." Out of scope for v1; the layout math gets ugly.
- **History**: forward/back buttons for drill state. Currently the URL is the history; we plan to wire it to browser history in v1.1.
- **Pinned expressions panel**: a side panel listing all pinned expressions across the graph, so they're discoverable independent of which function contains them.
- **Adapter-defined tiers**: some languages (Erlang, Elixir) have a "supervisor tree" tier that doesn't fit cleanly into service/module. Punt: adapters can declare extra tiers in v2; v1 forces them to bucket into the five.

---

## 12. What this design refuses to do

To be clear about the constraints we're imposing:

- **No flat function-graph view.** No "show me all 200k functions at once and let me filter." Every interaction is hierarchical. The fuzzy finder (`cmd+f`) is the answer to "I just want to find one thing."
- **No tier-skipping drill.** Double-clicking a service does not jump straight to functions. It expands one tier (service → modules). Users who want to land on a function use the URL or the fuzzy finder.
- **No persistent multi-pane.** One canvas, one breadcrumb, one focused subtree. We considered split-pane "two views into the graph" and rejected it — it sounds powerful and is unusable.
- **No drag-to-rearrange in default mode.** Layout is computed. Tinkering is opt-in.

These constraints are the design. Loosening any of them costs more clarity than it gains in flexibility.
