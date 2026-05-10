/**
 * Dashboard tab — at-a-glance summary cards for non-engineers.
 *
 * Pure derivation off the IR via lib/dashboard.js. No fetches, no async,
 * no source code. The whole thing renders on the IR you already have.
 *
 * Cards (left to right, wraps on narrow viewports):
 *   1. Totals — files, analyzed, defs, packages, edges
 *   2. Languages — count per file extension/language
 *   3. Top packages — most-imported external deps
 *   4. Hotspots — files with the most edge traffic
 *   5. Dense files — files with the most definitions
 */
import { useMemo, useState } from "react";
import { dashboardStats } from "../../lib/dashboard.js";

const INTENT_KIND_GLYPH = {
  refactor: "↻",
  delete: "✕",
  tests: "✓",
  extract: "↗",
  rename: "✎",
};

const STATUS_LABEL = {
  open: "open",
  partial: "partial",
  satisfied: "satisfied",
  done: "done",
  violated: "violated",
};

export default function Dashboard({
  ir,
  ryngoState,
  onJumpToFile,
  onVerifyIntent,
}) {
  const stats = useMemo(() => dashboardStats(ir), [ir]);
  const [verifyResults, setVerifyResults] = useState({});
  const [verifyingId, setVerifyingId] = useState(null);

  if (!stats) return null;
  const t = stats.totals;
  const langEntries = Object.entries(stats.byLang).sort(
    (a, b) => b[1] - a[1],
  );

  const handleVerify = async (intent) => {
    if (!onVerifyIntent || verifyingId) return;
    setVerifyingId(intent.id);
    const result = await onVerifyIntent(intent.id);
    setVerifyingId(null);
    if (result) {
      setVerifyResults((r) => ({ ...r, [intent.id]: result }));
    }
  };

  const intents = ryngoState?.intents || [];

  return (
    <div className="dash">
      <div className="dash-header">
        <div>
          <div className="dash-eyebrow">Repository</div>
          <h2 className="dash-title mono">{stats.repo}</h2>
          <div className="dash-sub">
            ref:&nbsp;
            <span className="ref-badge">{stats.ref}</span>
          </div>
        </div>
        <div className="dash-stripe">
          <Stat label="files" value={t.files} />
          <Stat label="analyzed" value={t.analyzedFiles} />
          <Stat label="defs" value={t.definitions} accent="fn" />
          {t.cells > 0 && (
            <Stat label="cells" value={t.cells} accent="cell" />
          )}
          <Stat label="pkgs" value={t.packages} accent="pkg" />
          <Stat label="calls" value={t.callEdges} accent="call" />
        </div>
      </div>

      {intents.length > 0 && (
        <section className="dash-card dash-card-wide intents-card">
          <header>
            <h3>
              Apply-and-verify · {intents.length} intent
              {intents.length === 1 ? "" : "s"}
            </h3>
            <span className="dash-card-sub">
              the loop closer — your AI applies the change, click Verify, Ryngo diffs the IR
            </span>
          </header>
          <div className="dash-card-body">
            <ul className="intent-list">
              {intents.map((it) => {
                const result = verifyResults[it.id];
                const liveStatus = result?.status || it.status;
                return (
                  <li key={it.id} className="intent-row">
                    <button
                      type="button"
                      className="intent-main"
                      onClick={() => it.node && onJumpToFile?.(it.node)}
                      title={
                        it.node
                          ? "click to jump to the affected node"
                          : "no affected node"
                      }
                    >
                      <span
                        className={`intent-glyph kind-${it.type}`}
                        aria-hidden="true"
                      >
                        {INTENT_KIND_GLYPH[it.type] || "·"}
                      </span>
                      <div className="intent-text">
                        <div className="intent-id mono">{it.id}</div>
                        {it.node && (
                          <div className="intent-node mono">{it.node}</div>
                        )}
                      </div>
                    </button>
                    <span className={`status-badge status-${liveStatus}`}>
                      {STATUS_LABEL[liveStatus] || liveStatus}
                    </span>
                    <button
                      type="button"
                      className="intent-verify"
                      disabled={
                        verifyingId === it.id || liveStatus === "done"
                      }
                      onClick={() => handleVerify(it)}
                    >
                      {verifyingId === it.id ? "Verifying…" : "Verify"}
                    </button>
                    {result && (
                      <div className="intent-evidence">
                        {result.evidence.slice(0, 4).map((line, i) => (
                          <div key={i} className="evidence-line mono">
                            {line}
                          </div>
                        ))}
                        {result.evidence.length > 4 && (
                          <div className="muted">
                            …and {result.evidence.length - 4} more
                          </div>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      )}

      <div className="dash-grid">
        <Card title="Languages">
          {langEntries.length === 0 ? (
            <p className="muted">No analyzable files detected.</p>
          ) : (
            <ul className="bar-list">
              {langEntries.map(([lang, n]) => (
                <Bar
                  key={lang}
                  label={lang || "other"}
                  value={n}
                  max={langEntries[0][1]}
                />
              ))}
            </ul>
          )}
        </Card>

        <Card title="Top dependencies" subtitle="external packages">
          {stats.topPackages.length === 0 ? (
            <p className="muted">No external imports detected.</p>
          ) : (
            <ul className="bar-list">
              {stats.topPackages.map((p) => (
                <Bar
                  key={p.name}
                  label={p.name}
                  value={p.count}
                  max={stats.topPackages[0].count}
                  color="#fbbf24"
                  mono
                />
              ))}
            </ul>
          )}
        </Card>

        <Card title="Hotspots" subtitle="most-connected files">
          {stats.hotspots.length === 0 ? (
            <p className="muted">No file traffic yet.</p>
          ) : (
            <ul className="bar-list">
              {stats.hotspots.map((h) => (
                <Bar
                  key={h.file}
                  label={h.label}
                  sublabel={h.file}
                  value={h.count}
                  max={stats.hotspots[0].count}
                  color="#a5d8ff"
                  mono
                  onClick={
                    onJumpToFile
                      ? () => onJumpToFile(`file:${h.file}`)
                      : undefined
                  }
                />
              ))}
            </ul>
          )}
        </Card>

        <Card title="Dense files" subtitle="most definitions in one file">
          {stats.denseFiles.length === 0 ? (
            <p className="muted">No definitions to rank.</p>
          ) : (
            <ul className="bar-list">
              {stats.denseFiles.map((d) => (
                <Bar
                  key={d.file}
                  label={d.file.split("/").slice(-1)[0]}
                  sublabel={d.file}
                  value={d.defs}
                  max={stats.denseFiles[0].defs}
                  color="#d8b4fe"
                  mono
                  onClick={
                    onJumpToFile ? () => onJumpToFile(`file:${d.file}`) : undefined
                  }
                />
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="dash-footer">
        <span className="muted">
          Click any row above to jump straight to that file in the graph view.
        </span>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div className="stat">
      <div className={`stat-value ${accent ? "stat-" + accent : ""}`}>
        {value.toLocaleString()}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Card({ title, subtitle, children }) {
  return (
    <section className="dash-card">
      <header>
        <h3>{title}</h3>
        {subtitle && <span className="dash-card-sub">{subtitle}</span>}
      </header>
      <div className="dash-card-body">{children}</div>
    </section>
  );
}

function Bar({ label, sublabel, value, max, color, mono, onClick }) {
  const pct = max > 0 ? Math.max(4, (value / max) * 100) : 0;
  const Tag = onClick ? "button" : "div";
  return (
    <li>
      <Tag
        type={onClick ? "button" : undefined}
        className={`bar-row${onClick ? " bar-row-button" : ""}`}
        onClick={onClick}
      >
        <div className="bar-label">
          <span className={mono ? "mono" : ""}>{label}</span>
          {sublabel && <span className="bar-sub mono">{sublabel}</span>}
        </div>
        <div className="bar-track">
          <div
            className="bar-fill"
            style={{
              width: `${pct}%`,
              background: color || "var(--accent)",
            }}
          />
        </div>
        <div className="bar-value">{value}</div>
      </Tag>
    </li>
  );
}
