# codegraph — README Hero GIF Storyboard

A tight 8.0-second loop, no voiceover, no captions, designed for the top of `README.md` on a `#0B0D10` GitHub dark-theme background.

- **Duration:** 8.0s, perfectly loopable. Last frame is composed to match the first frame.
- **Resolution:** 1280×720 source, exported as 960×540 GIF (8 frames per second, palette-quantized to 64 colors). Also export a `.webm` at 1280×720, 24fps, ~1.5 MB — GitHub's README will show whichever the viewer's client prefers, with a static PNG fallback.
- **Color system:** identical to the demo video — bg `#0B0D10`, text `#E6E8EB`, typed-edge accent `#7CC4FF`, pure-blue `#3A6FA8`, effectful-amber `#FFC76B`. Consistency between the GIF and the video means the README and the launch video reinforce each other.
- **Type:** Inter Tight at 24px for any UI chrome, JetBrains Mono at 16px for code. No body text appears in the GIF — every text element is a UI label inside the viewer chrome.
- **Cursor:** same 24px white dot with 6px shadow as the video. The cursor is the viewer's protagonist; treat it accordingly.
- **Motion budget:** every transition uses 200–400ms ease-in-out cubic. No bounces. No springs. The aesthetic is "precise instrument," not "playful product."

---

## Why a 6–10 second loop, and why 8 specifically

Loop length is a tuning problem. Too short and the viewer can't absorb the four beats; too long and the GIF doesn't read as a *loop* and the file gets too big to embed in a README.

- 4–5s: feels twitchy, can't fit the inspector beat.
- 6s: works but the drill animations feel rushed.
- 8s: each of the four beats gets ~2s, the inspector lingers long enough to read, and the loop reset is gentle.
- 10s+: file size balloons past 3 MB; many GitHub viewers (especially mobile) will skip rendering it.

The four beats this GIF must land:
1. **There is a graph.** (0.0–2.0s)
2. **You can drill into it.** (2.0–4.0s)
3. **The edges have types.** (4.0–6.5s)
4. **It loops back, calmly.** (6.5–8.0s)

If any single beat is unreadable in 2s, that beat is wrong, not the duration.

---

## Shot-by-shot storyboard

### Beat 1 — graph appears (0.0s – 2.0s)

#### Shot 1.1 — repo opening (0.0s – 0.5s)
- **Frame 0.0s:** the GIF opens on a black-ish canvas (`#0B0D10`). At the top, a single line of monospaced text is already on screen, fading in from 0% to 100% opacity over 200ms: `~/repos/redwood-clone $`.
- **0.2s:** the prompt finishes fading in. The cursor blinks once.
- **0.3s – 0.5s:** the command `codegraph index .` types itself in, character by character (each character lands on a 30ms cadence so the whole command takes ~360ms).
- **End of shot:** the cursor sits after the command, blinking. No graph yet.

#### Shot 1.2 — index runs (0.5s – 1.2s)
- **0.5s:** Return is pressed (visual cue: the cursor moves to a new line).
- **0.5s – 1.0s:** a single line of progress text appears below the command and *types itself in* over 500ms, ticking up like a real progress display:
  > `parsing 412 files... resolving 8,930 symbols... emitting IR... done. 1.9s`
- The text is monospaced and right-aligned to the same column as the prompt. The numbers do not animate-count; they snap into place to keep the GIF compressible (animated digits are GIF poison — every frame becomes unique and the palette gets shredded).
- **1.0s – 1.2s:** the terminal frame (which has been the entire canvas so far) shrinks from full bleed to a small pill in the upper-left corner (320×40px), fading to 50% opacity as it goes. The body of the canvas is now empty.

#### Shot 1.3 — graph materializes (1.2s – 2.0s)
- **1.2s:** seven service nodes (rounded rectangles, each ~140×60px) fade in at their final positions over 400ms. They are positioned in a force-directed layout that has been pre-seeded so it lands the same way every export. Labels: `web`, `api-gateway`, `checkout`, `inventory`, `auth`, `notifications`, `analytics`.
- **1.4s – 1.8s:** edges between the nodes draw themselves. Each edge is rendered as a path with a length of 0 → full over 400ms, drawn with `stroke-dasharray` style animation. Edges are unlabeled at this zoom.
- **1.8s – 2.0s:** a faint perimeter glow on the `checkout` node pulses once (scale 1.00 → 1.04 → 1.00 in 200ms, with a 6px `#7CC4FF` outer glow that fades in and out with the scale).
- **End of shot:** seven nodes, ~12 edges, `checkout` is highlighted, terminal pill is in the corner.

**What the viewer learned in beat 1:** "Run a command. Get a graph of your services."

---

### Beat 2 — drill in (2.0s – 4.0s)

#### Shot 2.1 — cursor enters (2.0s – 2.4s)
- **2.0s:** the white-dot cursor enters from the right edge of the canvas, decelerating as it approaches the `checkout` node. Travel is ~480px over 400ms with cubic ease-out so it *settles* rather than slams.
- **2.4s:** cursor is centered on the `checkout` node's label.

#### Shot 2.2 — first drill (service → module) (2.4s – 3.2s)
- **2.4s:** a small click ring (a 32px white circle, 0% → 60% → 0% opacity over 200ms) emanates from the cursor. This is the visual stand-in for a click event.
- **2.5s – 3.0s:** the semantic-zoom animation begins. The `checkout` node smoothly scales up to fill ~70% of the canvas while the other six services fade to 25% opacity and slide outward to the canvas edges. Inside the expanding `checkout` rectangle, six smaller module nodes fade in: `cart`, `pricing`, `tax`, `payments`, `orders`, `webhooks`.
- **3.0s – 3.2s:** the module-tier graph settles. Edges between modules animate in with the same `stroke-dasharray` length-grow pattern as before but quicker (200ms total).
- **End of shot:** six module nodes inside the `checkout` rectangle, faint outline of the parent `checkout` boundary still visible.

#### Shot 2.3 — second drill (module → function) (3.2s – 4.0s)
- **3.2s:** cursor moves from `checkout` center to the `payments` module over 200ms (~120px travel, ease-out).
- **3.4s:** a second click ring fires.
- **3.4s – 3.9s:** `payments` expands. Inside it, twelve function nodes fade in. They are colored at this stage:
  - 9 functions in pure-blue `#3A6FA8` (filled circles, ~32px diameter)
  - 3 functions in effectful-amber `#FFC76B` (filled circles, same size, with a small glyph indicating effect kind: `net`, `db`, one of each visible)
- **3.9s – 4.0s:** the layout settles. The cursor is now near the center of the canvas, between two specific function nodes that will matter in the next beat.

**What the viewer learned in beat 2:** "Two clicks and you're at function-level. Some functions are colored differently."

(They don't need to know yet *why* the colors differ. The next beat answers that.)

---

### Beat 3 — typed edge inspector (4.0s – 6.5s)

#### Shot 3.1 — cursor finds an edge (4.0s – 4.6s)
- **4.0s – 4.3s:** the cursor moves to the edge between `chargeCard` (an amber/effectful node) and `recordTransaction` (an amber/effectful node). The path is a 200ms diagonal ease-out.
- **4.3s – 4.6s:** as the cursor approaches the edge, the edge itself responds:
  - Its stroke widens from 2px to 3px.
  - Its color shifts from neutral gray (`#3A4147`) to typed-edge accent (`#7CC4FF`) over 300ms.
  - A small label fades in above the midpoint of the edge: `calls`.

#### Shot 3.2 — click and inspector (4.6s – 5.4s)
- **4.6s:** click ring on the edge midpoint.
- **4.7s – 5.2s:** an inspector panel slides in from the right edge of the canvas. It is 320px wide, dark (`#13161B`), with a 1px left border in `#2A3038`. The slide-in is a 500ms ease-out cubic — the panel decelerates as it lands.
- **5.0s – 5.4s:** content inside the inspector fades in line by line, each line landing 80ms after the previous. The visible content (each line is 16px JetBrains Mono):
  > `kind: calls`
  > `from: payments.chargeCard`
  > `to: payments.recordTransaction`
  > `call sites: 1`
  > `args: { amount, currency, idempotencyKey }`
  > `returns: Promise<TxnRecord>`
- The inspector header above this content is 18px Inter Tight: `Edge`.

#### Shot 3.3 — hold the inspector (5.4s – 6.5s)
- **5.4s – 6.5s:** the inspector holds. The cursor remains on the edge. The edge continues to glow gently. This is the *one* beat that lingers — the viewer needs ~1 full second to actually read the inspector text, especially on mobile.
- **At 6.0s:** a single subtle motion: the `Promise<TxnRecord>` in the last line gets a one-time underline highlight (a 200ms left-to-right wipe of `#7CC4FF` underline) to call out that the type is *inferred*, not user-written. This is the only animation in this 1.1s window. Restraint here keeps the GIF compressible.

**What the viewer learned in beat 3:** "Edges have a kind. Edges have inferred types. The graph knows things you didn't have to type yourself."

This is the moment the GIF justifies clicking through to the README, the docs, the install command. It needs to feel *informational*, not *flashy*.

---

### Beat 4 — loop reset (6.5s – 8.0s)

The loop reset is its own design problem. Done badly, the GIF feels like it stutters or restarts mid-thought. Done well, the viewer doesn't notice the seam.

#### Shot 4.1 — graceful zoom-out (6.5s – 7.4s)
- **6.5s:** the inspector slides back out to the right (300ms ease-in cubic — the inverse of its entry). The edge label `calls` fades back to neutral. The edge itself returns to 2px gray.
- **6.8s – 7.2s:** the cursor moves toward the upper-right corner, decelerating, and fades out over the last 200ms of its travel. By 7.2s there is no cursor.
- **7.0s – 7.4s:** a reverse-semantic-zoom plays in 400ms. The function-tier (`payments` interior) collapses back into the `payments` module. The module-tier collapses back into the `checkout` rectangle. The other six services fade back to 100% opacity from the periphery.
- **End of shot:** we are back to the seven-service graph. `checkout` is highlighted exactly the way it was at 1.8s.

#### Shot 4.2 — loop seam (7.4s – 8.0s)
- **7.4s – 7.8s:** the seven-service graph holds, with the `checkout` glow pulsing one more time exactly the way it did at 1.8s–2.0s. This identical pulse is the visual rhyme that makes the loop seamless.
- **7.8s – 8.0s:** the entire canvas fades from 100% to 0% over 200ms — but the *first* frame of the loop also starts at 0% and fades up over 200ms (i.e., shot 1.1's prompt fade-in). When the GIF wraps, these two fades concatenate into one smooth 400ms cross-fade and the seam disappears.

**The seam test:** play the exported GIF on a 4-loop preview. If you can spot the moment of restart, the cross-fade is wrong. The first frame's prompt opacity must be 0% on entry; if the export pipeline accidentally fixes the first frame to 100% opacity (some palette-quantization tools do this for compression), the seam will pop.

---

## Frame-budget summary

| Beat                    | Duration | What lands                                     |
|-------------------------|----------|------------------------------------------------|
| 1. Graph appears        | 2.0s     | `codegraph index .` → seven service nodes      |
| 2. Drill in             | 2.0s     | service → module → function (twelve nodes)     |
| 3. Typed edge inspector | 2.5s     | edge highlights, inspector slides in, reads    |
| 4. Loop reset           | 1.5s     | gentle zoom-out, identical pulse, cross-fade   |
| **Total**               | **8.0s** |                                                |

If beat 3 feels rushed in the first export, take 200ms from beat 4's hold and donate it to beat 3's inspector linger. Never take time from beat 1 or beat 2 — those carry the meaning that lets beat 3 make sense.

---

## Export checklist

- [ ] Source recorded at 1280×720 60fps (Cleanshot or OBS) for crisp scrub during the edit.
- [ ] Edited timeline conformed to 24fps for export.
- [ ] GIF: 960×540, 8 fps, 64-color palette, dithering off (it doubles file size for a barely visible quality bump on this color palette). Target file size <2.0 MB.
- [ ] WebM: 1280×720, 24 fps, VP9, target ~1.2 MB. This is the version GitHub actually serves to most modern viewers.
- [ ] Static PNG fallback: a 1280×720 freeze frame from 5.7s (the inspector beat). This is what social cards and slow GitHub clients show.
- [ ] First and last GIF frame are *visually identical* — same nodes, same opacity, same pulse phase. Confirm by exporting frame 0 and frame N as PNGs and diffing in an image tool.
- [ ] No real GitHub handles, no real file paths beyond what the demo repo actually contains, no API keys or tokens visible at any point.

---

## README embed snippet (for reference)

```markdown
<p align="center">
  <video autoplay loop muted playsinline poster="docs/hero-poster.png" width="960">
    <source src="docs/hero.webm" type="video/webm">
    <img src="docs/hero.gif" alt="codegraph: index, drill, inspect a typed edge" width="960">
  </video>
</p>
```

The `<video>`/`<img>` fallback chain means: modern viewers see the WebM, GIF-only renderers see the GIF, no-motion viewers see the poster PNG. All three are the same composition; only the format and motion differ.
