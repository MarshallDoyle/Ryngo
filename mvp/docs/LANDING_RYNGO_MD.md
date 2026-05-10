# Landing — "How to plug `Ryngo.md` into your agent" section

This is a **drop-in spec for Codex** to add a new section to
`mvp/landing/index.html`. The motivation: Phase 11 shipped `Ryngo.md`
(per-repo manifest holding `## Comments` + `## Suppressions`) end-to-end,
but the landing page never explains how a user actually wires it into
their agent. Today's reader sees the MCP install section and the
mission statement but has no idea there's a file in their repo that
their agent can read.

Three distinct user flows. Each gets its own card. No one flow is
"correct" — they suit different workflows.

| Flow | User shape | Tool |
|---|---|---|
| **MCP** | Active coding loop with an MCP-aware agent | `read_ryngo_md` tool live |
| **Copy / paste** | One-off question in a chat UI | Clipboard → prompt prefix |
| **Commit to repo** | Persistent, team-shared, version-controlled | `Ryngo.md` at repo root |

---

## Where it goes in `index.html`

After the existing **Who Ryngo is for** (`.personas`) section and
**before** the FAQ (`#faq`). Rationale: a visitor has just read the
three personas; this section answers "what do I, as one of these
people, actually do next?" The MCP install section (`#mcp`) is far
above, so this new section also acts as a reminder pointer to it for
flow 1.

Suggested anchor id: `#ryngo-md`. Add to the header nav between
`Install MCP` and `Logo lab` (or just after `Install MCP`).

---

## The full section markup

Paste the following directly into `index.html`. Class names follow
the existing landing.css conventions (`.section`, `.section-alt`,
`.section-lede`, monospace via `.mono`). New classes prefixed with
`.ryngo-md-` so they're scoped + greppable.

```html
<section id="ryngo-md" class="section">
  <h2>Three ways to plug <code>Ryngo.md</code> into your agent</h2>
  <p class="section-lede">
    Every Ryngo repo gets one file at its root — <code>Ryngo.md</code>
    — that holds the comments you've left on nodes and the warnings
    you've dismissed. Plain Markdown, diff-friendly, edited from the
    viewer OR from your IDE. Pick whichever of these three paths
    matches how your agent already works; the file is the same on all
    three.
  </p>

  <div class="ryngo-md-grid">

    <article class="ryngo-md-card">
      <header>
        <span class="ryngo-md-chip">1 · live</span>
        <h3>Connect via MCP</h3>
      </header>
      <p>
        For agents in an active coding loop — <strong>Claude Code,
        ChatGPT MCP, Cursor, any MCP-aware harness</strong>. After the
        one-time install, your agent gets a <code>read_ryngo_md</code>
        tool. It calls it at the start of a session, sees your comments
        and suppressions, and respects them on every subsequent edit.
      </p>
      <pre class="ryngo-md-code mono"><code>$ npx ryngo-mcp install
# adds Ryngo to your MCP config — restart your agent

# Agent now has these tools:
#   read_ryngo_md          ← reads the manifest
#   get_compact_ir         ← reads the typed code map
#   list_intents           ← reads pending refactor markers</code></pre>
      <p class="ryngo-md-best">
        <strong>Best for:</strong> ongoing development, multi-step
        refactors, anything where the agent is editing on your behalf.
      </p>
      <p class="ryngo-md-foot">
        Full install guide: <a href="#mcp">↑ Install MCP</a>.
      </p>
    </article>

    <article class="ryngo-md-card">
      <header>
        <span class="ryngo-md-chip">2 · one-off</span>
        <h3>Copy &amp; paste</h3>
      </header>
      <p>
        For chat UIs that don't speak MCP — <strong>ChatGPT.com,
        Claude.ai, Gemini, Perplexity</strong>. Open the Ryngo viewer,
        click the <code>View&nbsp;Ryngo.md</code> button in the
        inspector, copy. Paste at the top of your prompt and ask
        anything.
      </p>
      <pre class="ryngo-md-code mono"><code># your prompt to ChatGPT / Claude.ai
Here's my repo's Ryngo manifest:

---
{paste from Ryngo viewer's "Copy" button}
---

The comments above explain what each function does. The
suppressions tell you which warnings I've already considered
and chosen to ignore. With that context: please refactor
src/auth/login.ts to support refresh tokens.</code></pre>
      <p class="ryngo-md-best">
        <strong>Best for:</strong> one-off questions, second opinions,
        any time you don't want to bring up an agent harness.
      </p>
      <p class="ryngo-md-foot">
        The file is small (typically &lt; 10 KB even for big repos).
        One paste fits in any model's context.
      </p>
    </article>

    <article class="ryngo-md-card">
      <header>
        <span class="ryngo-md-chip">3 · persistent</span>
        <h3>Commit to your repo</h3>
      </header>
      <p>
        For teams and anyone who wants the manifest to follow the code
        — <strong>vibe coders shipping daily, engineering teams,
        anyone whose AI sometimes loses context between sessions</strong>.
        Download <code>Ryngo.md</code> from the viewer and commit it at
        repo root. It's auto-discovered by:
      </p>
      <ul class="ryngo-md-list">
        <li><strong>Cursor</strong> — via the <code>.cursorrules</code> Ryngo generates</li>
        <li><strong>Claude Code</strong> — via the <code>CLAUDE.md</code> Ryngo generates</li>
        <li><strong>Aider, Continue, Codex</strong> — via the <code>AGENTS.md</code> convention</li>
        <li><strong>Your own scripts</strong> — it's plain Markdown</li>
      </ul>
      <pre class="ryngo-md-code mono"><code># save the manifest at your repo root
curl -O https://ryngo.ai/api/ryngo-md/download?repo=you/yourrepo

# or download from the viewer:
#   inspector → "View Ryngo.md" → "Save .md"

# then commit it like any other file
git add Ryngo.md
git commit -m "ryngo: dismiss intentional warnings + auth notes"</code></pre>
      <p class="ryngo-md-best">
        <strong>Best for:</strong> teams, code review, anything where
        a comment or a dismissed warning should outlive a single chat.
      </p>
      <p class="ryngo-md-foot">
        PR-review-friendly. Every dismissed warning is a one-liner
        diff with the reason attached.
      </p>
    </article>

  </div>

  <details class="ryngo-md-format">
    <summary>What's in <code>Ryngo.md</code> exactly?</summary>
    <p>
      Two sections today, both keyed on stable node ids
      (<code>def:src/foo.ts#bar</code>, <code>file:src/foo.ts</code>,
      <code>cell:notebook.ipynb#3</code>, …). Forward-compatible
      <code>## Connections</code> / <code>## Expose</code> /
      <code>## Flags</code> sections round-trip verbatim so future
      additions don't break old manifests.
    </p>
    <pre class="ryngo-md-code mono"><code># Ryngo

## Comments

### def:src/auth/login.ts#authenticate
&gt; handles refresh-token rotation; touch carefully
&gt; — marshall, 2026-05-10

## Suppressions

### def:src/auth/login.ts#authenticate
- nested-loop · items.length is bounded; intentional brute force
- recursion · tail-recursive; engine optimizes</code></pre>
    <p>
      Stable node ids mean comments survive renames as long as the
      symbol survives. Round-trip property test in
      <code>mvp/lib/ryngo-md.js</code>: serialize → parse → equal.
    </p>
  </details>
</section>
```

---

## CSS to add to `landing.css`

Append at the bottom. Uses existing CSS variables so the section
matches in both light and dark themes.

```css
/* ─── #ryngo-md — "three ways to plug it in" section ─────────────── */

.ryngo-md-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 18px;
  margin: 24px 0 16px;
}

.ryngo-md-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px 22px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ryngo-md-card header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 4px;
}

.ryngo-md-card h3 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.ryngo-md-chip {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--accent-ink);
  background: var(--accent);
  border-radius: 999px;
  padding: 3px 9px;
}

.ryngo-md-card p {
  color: var(--text);
  font-size: 14px;
  line-height: 1.55;
  margin: 0;
}

.ryngo-md-card .ryngo-md-best {
  color: var(--muted);
  font-size: 13px;
  margin-top: auto;          /* pin "best for" to the bottom */
  padding-top: 6px;
  border-top: 1px dashed var(--line);
}

.ryngo-md-card .ryngo-md-foot {
  color: var(--muted);
  font-size: 12px;
  font-style: italic;
}

.ryngo-md-code {
  background: var(--input-bg, #0b1220);
  color: var(--code-ink, #d8d3b4);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 12px 14px;
  font-size: 12px;
  line-height: 1.5;
  overflow-x: auto;
  margin: 0;
}

.ryngo-md-list {
  margin: 0 0 0 18px;
  padding: 0;
  font-size: 14px;
  line-height: 1.6;
}

.ryngo-md-format {
  margin-top: 8px;
  padding: 14px 18px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
}

.ryngo-md-format summary {
  cursor: pointer;
  font-weight: 600;
  color: var(--text);
}

.ryngo-md-format p {
  margin-top: 10px;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.55;
}

.ryngo-md-format .ryngo-md-code {
  margin-top: 10px;
}
```

---

## One small backend gap

Card 3 mentions `https://ryngo.ai/api/ryngo-md/download?repo=...`.
Today's `GET /api/ryngo-md?repo=...` returns JSON (`{raw, comments,
suppressions, …}`). Either:

- **Add a `?format=raw` query param** to the existing endpoint so the
  same handler returns the plain-text Markdown with
  `Content-Disposition: attachment; filename=Ryngo.md` when requested,
  OR
- **Add a sibling route** `GET /api/ryngo-md/download` that wraps the
  same store-read and sends the raw bytes.

Either is ~10 lines in `mvp/server.js`. I (claude) can ship this in a
follow-up commit; it doesn't touch any of Codex's in-flight files.

---

## Tone notes

- Keep the verbs concrete: "connect", "copy", "commit". No "leverage",
  "seamless", or other forbidden words (CI lint enforces).
- Three cards. Not four, not five — three because the user said
  "some people will use MCP, some people will copy and paste, some
  will want to download". One card per group.
- The `<details>` block at the bottom is for the curious; don't
  promote the file format up into the cards. The point of the cards
  is the workflow, not the schema.
- Don't soften "your agent reads it". That's the whole point of the
  product.
