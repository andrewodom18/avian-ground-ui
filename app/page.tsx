import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AVIAN Ground | Operations",
  description: "Read-only AVIAN mesh health and field telemetry.",
  other: { "codex-preview": "development" },
};

const peers = [
  { name: "aircraft-001", role: "Aircraft", link: "Silvus", state: "online" },
  { name: "observer-001", role: "Observer", link: "Silvus", state: "online" },
  { name: "ground-mac", role: "Ground", link: "Satellite", state: "online" },
  { name: "aircraft-002", role: "Aircraft", link: "—", state: "offline" },
];

const events = [
  { time: "14:32:08", tone: "warn", text: "aircraft-002 peer unavailable; reconnecting" },
  { time: "14:31:44", tone: "good", text: "Image manifest synchronized from aircraft-001" },
  { time: "14:31:19", tone: "info", text: "Silvus observation refreshed · 4 RF neighbors" },
  { time: "14:30:57", tone: "good", text: "MAVLink system 1 lock refreshed" },
];

export default function Home() {
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">A</div>
          <div><p className="eyebrow">AVIAN GROUND</p><h1>Operations overview</h1></div>
        </div>
        <div className="sync-state" role="status">
          <span className="status-dot good" /> Live · ground-001
          <span className="sync-time">updated 2s ago</span>
        </div>
      </header>

      <section className="alert-strip" aria-label="Active warning">
        <div><span className="alert-symbol">!</span><strong>One peer is unavailable</strong></div>
        <span>Fallback connection attempts are active. Flight services remain independent.</span>
      </section>

      <section className="metric-grid" aria-label="Mission health summary">
        <article className="metric-card"><p>Agent readiness</p><div className="metric-line"><strong>Degraded</strong><span className="metric-state warn">Attention</span></div><small>4 of 5 configured nodes ready</small></article>
        <article className="metric-card"><p>Connected peers</p><div className="metric-line"><strong>4 / 5</strong><span className="trend">80%</span></div><small>One reconnect in progress</small></article>
        <article className="metric-card"><p>MAVLink</p><div className="metric-line"><strong>Locked</strong><span className="metric-state good">Fresh</span></div><small>System 1 · message age 0.4s</small></article>
        <article className="metric-card"><p>Radio monitor</p><div className="metric-line"><strong>Healthy</strong><span className="metric-state good">Fresh</span></div><small>Last observation 3s ago</small></article>
      </section>

      <section className="content-grid">
        <article className="panel peer-panel">
          <div className="panel-heading"><div><p className="eyebrow">MESH</p><h2>Peers and active paths</h2></div><span className="quiet-label">Read only</span></div>
          <div className="peer-table" role="table" aria-label="Peer status">
            <div className="peer-row table-head" role="row"><span>Node</span><span>Role</span><span>Selected path</span><span>Status</span></div>
            {peers.map((peer) => (
              <div className="peer-row" role="row" key={peer.name}>
                <strong>{peer.name}</strong><span>{peer.role}</span><span>{peer.link}</span><span className={`peer-state ${peer.state}`}><i />{peer.state}</span>
              </div>
            ))}
          </div>
        </article>

        <article className="panel path-panel">
          <div className="panel-heading"><div><p className="eyebrow">UNDERLAYS</p><h2>Link health</h2></div></div>
          <div className="path-item"><div><span className="status-dot good"/><strong>Silvus</strong></div><span>Primary</span><dl><div><dt>Latency</dt><dd>24 ms</dd></div><div><dt>Loss</dt><dd>0.8%</dd></div><div><dt>Stability</dt><dd>96%</dd></div></dl></div>
          <div className="path-item"><div><span className="status-dot good"/><strong>Satellite</strong></div><span>Standby</span><dl><div><dt>Latency</dt><dd>82 ms</dd></div><div><dt>Loss</dt><dd>1.4%</dd></div><div><dt>Stability</dt><dd>91%</dd></div></dl></div>
        </article>

        <article className="panel event-panel">
          <div className="panel-heading"><div><p className="eyebrow">EVENTS</p><h2>Warnings and logs</h2></div><span className="quiet-label">Last 15 minutes</span></div>
          <ol className="event-list">
            {events.map((event) => <li key={`${event.time}-${event.text}`}><time>{event.time}</time><span className={`event-mark ${event.tone}`} /><p>{event.text}</p></li>)}
          </ol>
        </article>

        <article className="panel payload-panel">
          <div className="panel-heading"><div><p className="eyebrow">PAYLOAD</p><h2>Synchronization</h2></div></div>
          <div className="payload-stats"><div><strong>128</strong><span>Accepted events</span></div><div><strong>0</strong><span>Rejected events</span></div><div><strong>14:31</strong><span>Latest manifest</span></div></div>
          <p className="panel-note">Metadata only. Image bytes and absolute imagery paths are never shown.</p>
        </article>
      </section>

      <footer>AVIAN Ground is observational only · Emergency actions remain in the operator CLI</footer>
    </main>
  );
}
