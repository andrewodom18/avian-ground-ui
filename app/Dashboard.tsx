"use client";

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Image as ImageIcon,
  Radio,
  RefreshCw,
  Satellite,
  ShieldCheck,
  TerminalSquare,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Underlay = {
  reachable: boolean;
  last_observed_at_ms: number | null;
  latency_ms: number | null;
  loss_ratio: number | null;
  goodput_bps: number | null;
  stability: number | null;
};

type AgentStatus = {
  schema_version: number;
  ready: boolean;
  node: { name: string; uptime_ms: number };
  peers: Array<{
    name: string;
    connected: boolean;
    selected_underlay: string | null;
    last_transition_at_ms: number;
  }>;
  underlays: Record<string, Underlay>;
  mavlink: {
    required: boolean;
    connected: boolean;
    target_system_id: number | null;
    last_message_at_ms: number | null;
  };
  payload: { accepted: number; rejected: number };
  radio: {
    required: boolean;
    fresh: boolean;
    last_observation_at_ms: number | null;
  };
  last_errors: Array<{ component: string; detail: string; at_ms: number }>;
};

type LogEntry = { timestamp_ms: number; unit: string; priority: number; message: string };
type RecordView = { published_at_ms: number };
type EventItem = { key: string; at: number; priority: number; source: string; text: string };
type EventLevel = "all" | "warning" | "error" | "info";
type EventOrder = "newest" | "oldest";

const STATUS_POLL_INTERVAL_MS = 10_000;
const SECONDARY_POLL_INTERVAL_MS = 30_000;
const EVENT_PAGE_SIZE = 8;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isAgentStatus(value: unknown): value is AgentStatus {
  if (!isObject(value) || value.schema_version !== 1 || typeof value.ready !== "boolean") return false;
  if (!isObject(value.node) || typeof value.node.name !== "string" || typeof value.node.uptime_ms !== "number") return false;
  if (!Array.isArray(value.peers) || !value.peers.every((peer) => isObject(peer)
    && typeof peer.name === "string" && typeof peer.connected === "boolean"
    && (peer.selected_underlay === null || typeof peer.selected_underlay === "string")
    && typeof peer.last_transition_at_ms === "number")) return false;
  if (!isObject(value.underlays) || !Object.values(value.underlays).every((underlay) => isObject(underlay)
    && typeof underlay.reachable === "boolean" && isNumberOrNull(underlay.last_observed_at_ms)
    && isNumberOrNull(underlay.latency_ms) && isNumberOrNull(underlay.loss_ratio)
    && isNumberOrNull(underlay.goodput_bps) && isNumberOrNull(underlay.stability))) return false;
  if (!isObject(value.mavlink) || typeof value.mavlink.required !== "boolean"
    || typeof value.mavlink.connected !== "boolean" || !isNumberOrNull(value.mavlink.target_system_id)
    || !isNumberOrNull(value.mavlink.last_message_at_ms)) return false;
  if (!isObject(value.payload) || typeof value.payload.accepted !== "number" || typeof value.payload.rejected !== "number") return false;
  if (!isObject(value.radio) || typeof value.radio.required !== "boolean" || typeof value.radio.fresh !== "boolean"
    || !isNumberOrNull(value.radio.last_observation_at_ms)) return false;
  return Array.isArray(value.last_errors) && value.last_errors.every((error) => isObject(error)
    && typeof error.component === "string" && typeof error.detail === "string" && typeof error.at_ms === "number");
}

function decodeStatusResponse(value: unknown): { status: AgentStatus } {
  if (!isObject(value) || !isAgentStatus(value.status)) throw new Error("Ground bridge returned an invalid status response");
  return { status: value.status };
}

function decodeLogResponse(value: unknown): { entries: LogEntry[] } {
  if (!isObject(value) || !Array.isArray(value.entries) || !value.entries.every((entry) => isObject(entry)
    && typeof entry.timestamp_ms === "number" && typeof entry.unit === "string"
    && typeof entry.priority === "number" && typeof entry.message === "string")) {
    throw new Error("Ground bridge returned an invalid log response");
  }
  return { entries: value.entries as LogEntry[] };
}

function decodeRecordResponse(value: unknown): { records: RecordView[] } {
  if (!isObject(value) || !Array.isArray(value.records) || !value.records.every((record) => isObject(record)
    && typeof record.published_at_ms === "number")) {
    throw new Error("Ground bridge returned an invalid record response");
  }
  return { records: value.records as RecordView[] };
}

async function fetchJson<T>(path: string, decode: (value: unknown) => T): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(path, { cache: "no-store", signal: controller.signal });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = isObject(payload) && typeof payload.detail === "string" ? payload.detail : `HTTP ${response.status}`;
      throw new Error(detail);
    }
    return decode(payload);
  } finally {
    window.clearTimeout(timer);
  }
}

function durationLabel(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function numberLabel(value: number | null | undefined, suffix = ""): string {
  return value == null || !Number.isFinite(value) ? "—" : `${Math.round(value)}${suffix}`;
}

function fetchErrorLabel(error: unknown, subject: string): string {
  if (error instanceof DOMException && error.name === "AbortError") return `${subject} request timed out`;
  if (error instanceof TypeError) return `${subject} could not reach the local bridge`;
  if (error instanceof Error && error.message) return `${subject}: ${error.message}`;
  return `${subject} is unavailable`;
}

function timestampLabel(timestamp: number | null | undefined): string {
  if (!timestamp) return "None";
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function eventTimeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function eventLevel(priority: number): Exclude<EventLevel, "all"> {
  if (priority <= 3) return "error";
  if (priority === 4) return "warning";
  return "info";
}

export function Dashboard() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [bulkRecords, setBulkRecords] = useState<RecordView[]>([]);
  const [ackRecords, setAckRecords] = useState<RecordView[]>([]);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [logsLoaded, setLogsLoaded] = useState(false);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [eventLevelFilter, setEventLevelFilter] = useState<EventLevel>("all");
  const [eventSourceFilter, setEventSourceFilter] = useState("all");
  const [eventQuery, setEventQuery] = useState("");
  const [eventOrder, setEventOrder] = useState<EventOrder>("newest");
  const [eventPage, setEventPage] = useState(1);
  const statusInFlight = useRef(false);
  const secondaryInFlight = useRef(false);

  const loadStatus = useCallback(async () => {
    if (statusInFlight.current) return;
    statusInFlight.current = true;
    try {
      const response = await fetchJson("/api/v1/status", decodeStatusResponse);
      setStatus(response.status);
      setBridgeError(null);
    } catch (error) {
      setStatus(null);
      setBridgeError(fetchErrorLabel(error, "AVIAN status"));
    } finally {
      statusInFlight.current = false;
    }
  }, []);

  const loadSecondary = useCallback(async () => {
    if (secondaryInFlight.current) return;
    secondaryInFlight.current = true;
    try {
      const results = await Promise.allSettled([
        fetchJson("/api/v1/logs?lines=200", decodeLogResponse),
        fetchJson("/api/v1/records?class=bulk&limit=20", decodeRecordResponse),
        fetchJson("/api/v1/records?class=acknowledgement&limit=20", decodeRecordResponse),
      ]);
      if (results[0].status === "fulfilled") {
        setLogs(results[0].value.entries);
        setLogsLoaded(true);
        setLogError(null);
      } else {
        setLogs([]);
        setLogsLoaded(false);
        setLogError(fetchErrorLabel(results[0].reason, "Service logs"));
      }
      if (results[1].status === "fulfilled") setBulkRecords(results[1].value.records);
      else setBulkRecords([]);
      if (results[2].status === "fulfilled") setAckRecords(results[2].value.records);
      else setAckRecords([]);
      if (results[1].status === "fulfilled" && results[2].status === "fulfilled") {
        setRecordsLoaded(true);
        setRecordError(null);
      } else {
        setRecordsLoaded(false);
        const failures = [
          results[1].status === "rejected" ? fetchErrorLabel(results[1].reason, "Payload manifests") : null,
          results[2].status === "rejected" ? fetchErrorLabel(results[2].reason, "Payload acknowledgements") : null,
        ].filter((value): value is string => value !== null);
        setRecordError(failures.join("; "));
      }
    } finally {
      secondaryInFlight.current = false;
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadStatus(), loadSecondary()]);
    setRefreshing(false);
  }, [loadSecondary, loadStatus]);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void refresh(), 0);
    const statusTimer = window.setInterval(() => {
      if (!document.hidden) void loadStatus();
    }, STATUS_POLL_INTERVAL_MS);
    const secondaryTimer = window.setInterval(() => {
      if (!document.hidden) void loadSecondary();
    }, SECONDARY_POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(statusTimer);
      window.clearInterval(secondaryTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadSecondary, loadStatus, refresh]);

  const disconnected = status?.peers.filter((peer) => !peer.connected) ?? [];
  const connected = (status?.peers.length ?? 0) - disconnected.length;
  const warnings = useMemo(() => {
    const values: string[] = [];
    if (!status && !bridgeError) values.push("Waiting for the first live AVIAN status snapshot");
    if (bridgeError) values.push(bridgeError);
    if (logError) values.push(logError);
    if (recordError) values.push(recordError);
    if (status && !status.ready) values.push("Agent acceptance requirements are not fully met");
    if (disconnected.length) values.push(`${disconnected.length} configured peer${disconnected.length === 1 ? " is" : "s are"} unavailable`);
    if (status?.mavlink.required && !status.mavlink.connected) values.push("Required MAVLink connection is unavailable");
    if (status?.radio.required && !status.radio.fresh) values.push("Required radio observation is stale or unhealthy");
    return values;
  }, [bridgeError, disconnected.length, logError, recordError, status]);

  const events = useMemo<EventItem[]>(() => [
    ...(status?.last_errors ?? []).map((error) => ({
      key: `error-${error.component}-${error.at_ms}`,
      at: error.at_ms,
      priority: 3,
      source: error.component,
      text: error.detail,
    })),
    ...logs.map((entry, index) => ({
      key: `log-${entry.timestamp_ms}-${index}`,
      at: entry.timestamp_ms,
      priority: entry.priority,
      source: entry.unit,
      text: entry.message,
    })),
  ], [logs, status?.last_errors]);
  const eventSources = useMemo(
    () => Array.from(new Set(events.map((event) => event.source))).sort((a, b) => a.localeCompare(b)),
    [events],
  );
  const filteredEvents = useMemo(() => {
    const query = eventQuery.trim().toLocaleLowerCase();
    return events
      .filter((event) => eventLevelFilter === "all" || eventLevel(event.priority) === eventLevelFilter)
      .filter((event) => eventSourceFilter === "all" || event.source === eventSourceFilter)
      .filter((event) => !query || `${event.source} ${event.text}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => eventOrder === "newest" ? b.at - a.at : a.at - b.at);
  }, [eventLevelFilter, eventOrder, eventQuery, eventSourceFilter, events]);
  const eventPageCount = Math.max(1, Math.ceil(filteredEvents.length / EVENT_PAGE_SIZE));
  const currentEventPage = Math.min(eventPage, eventPageCount);
  const pageStart = (currentEventPage - 1) * EVENT_PAGE_SIZE;
  const pagedEvents = filteredEvents.slice(pageStart, pageStart + EVENT_PAGE_SIZE);
  const filtersActive = eventLevelFilter !== "all" || eventSourceFilter !== "all" || eventQuery !== "";

  const latestManifest = bulkRecords[0]?.published_at_ms ?? null;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">A</div>
          <div><p className="eyebrow">AVIAN GROUND</p><h1>Operations overview</h1></div>
        </div>
        <div className="header-actions">
          <div className={`sync-state ${bridgeError ? "offline" : !status ? "connecting" : ""}`} role="status">
            {bridgeError ? <WifiOff size={15} /> : status ? <CheckCircle2 size={15} /> : <RefreshCw size={15} className="spinning" />}
            {bridgeError ? "Bridge offline" : status ? `Live · ${status.node.name}` : "Connecting to local bridge"}
            <span className="sync-time">Auto refresh 10s</span>
          </div>
          <button className="refresh-button" type="button" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? "spinning" : ""} /> Refresh now
          </button>
        </div>
      </header>

      {warnings.length > 0 ? (
        <details className="alert-strip">
          <summary>
            <span className="alert-primary"><AlertTriangle size={18} /><strong>{warnings[0]}</strong></span>
            <span className="warning-count">{warnings.length} active warning{warnings.length === 1 ? "" : "s"}<ChevronDown size={15} /></span>
          </summary>
          <div className="alert-details" aria-label="Active warning details">
            <p>Review each warning below. Use Refresh now after correcting the underlying service.</p>
            <ol>{warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ol>
          </div>
        </details>
      ) : (
        <section className="healthy-strip"><ShieldCheck size={18} /><strong>All configured acceptance requirements are healthy</strong></section>
      )}

      <section className="metric-grid" aria-label="Mission health summary">
        <Metric title="Agent readiness" value={status ? (status.ready ? "Ready" : "Degraded") : "Unavailable"} state={status?.ready ? "good" : "warn"} detail={status ? `Uptime ${durationLabel(status.node.uptime_ms)}` : "Waiting for local bridge"} icon={<ShieldCheck size={17} />} />
        <Metric title="Connected peers" value={status ? `${connected} / ${status.peers.length}` : "—"} state={status && !disconnected.length ? "good" : "warn"} detail={!status ? "Waiting for live peer status" : disconnected.length ? `${disconnected.length} reconnect in progress` : "All configured peers connected"} icon={<Activity size={17} />} />
        <Metric title="MAVLink" value={!status ? "—" : !status.mavlink.required ? "Optional" : status.mavlink.connected ? "Locked" : "Offline"} state={status && (status.mavlink.connected || !status.mavlink.required) ? "good" : "warn"} detail={!status ? "Waiting for live MAVLink status" : status.mavlink.target_system_id != null ? `System ${status.mavlink.target_system_id}` : "No current system lock"} icon={<Radio size={17} />} />
        <Metric title="Radio monitor" value={!status ? "—" : !status.radio.required ? "Optional" : status.radio.fresh ? "Healthy" : "Degraded"} state={status && (status.radio.fresh || !status.radio.required) ? "good" : "warn"} detail={!status ? "Waiting for live radio status" : !status.radio.required ? "Monitoring disabled" : status.radio.fresh ? "Observation current" : "Required observation unavailable"} icon={<Satellite size={17} />} />
      </section>

      <section className="content-grid">
        <article className="panel peer-panel">
          <PanelHeading eyebrow="MESH" title="Peers and active paths" detail="Read only" />
          <div className="peer-table" role="table" aria-label="Peer status">
            <div className="peer-row table-head" role="row"><span>Node</span><span>Role</span><span>Selected path</span><span>Status</span></div>
            {status?.peers.length ? status.peers.map((peer) => (
              <div className="peer-row" role="row" key={peer.name}>
                <strong>{peer.name}</strong><span>Peer</span><span>{peer.selected_underlay ?? "Not observed"}</span><span className={`peer-state ${peer.connected ? "online" : "offline"}`}><i />{peer.connected ? "online" : "offline"}</span>
              </div>
            )) : <EmptyRow text={bridgeError ? "Peer data unavailable" : status ? "No configured peers" : "Waiting for peer data"} />}
          </div>
        </article>

        <article className="panel path-panel">
          <PanelHeading eyebrow="UNDERLAYS" title="Link health" />
          {status && Object.keys(status.underlays).length > 0 ? Object.entries(status.underlays).map(([name, underlay]) => (
            <div className="path-item" key={name}>
              <div><span className={`status-dot ${underlay.reachable ? "good" : "bad"}`} /><strong>{name}</strong></div><span>{underlay.reachable ? "Reachable" : "Unavailable"}</span>
              <dl><div><dt>Latency</dt><dd>{numberLabel(underlay.latency_ms, " ms")}</dd></div><div><dt>Loss</dt><dd>{underlay.loss_ratio == null ? "—" : `${(underlay.loss_ratio * 100).toFixed(1)}%`}</dd></div><div><dt>Stability</dt><dd>{underlay.stability == null ? "—" : `${Math.round(underlay.stability * 100)}%`}</dd></div></dl>
            </div>
          )) : <div className="empty-state"><Satellite size={18} /><span>{status ? "No link observations available" : "Waiting for link observations"}</span></div>}
        </article>

        <article className="panel event-panel">
          <PanelHeading eyebrow="EVENTS" title="Warnings and logs" detail={logError ? "Log feed unavailable" : `${events.length} loaded`} />
          <div className="event-controls" aria-label="Event filters">
            <label className="event-search"><span>Search</span><input type="search" value={eventQuery} onChange={(event) => { setEventQuery(event.target.value); setEventPage(1); }} placeholder="Message or service" /></label>
            <label><span>Severity</span><select value={eventLevelFilter} onChange={(event) => { setEventLevelFilter(event.target.value as EventLevel); setEventPage(1); }}><option value="all">All</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option></select></label>
            <label><span>Service</span><select value={eventSourceFilter} onChange={(event) => { setEventSourceFilter(event.target.value); setEventPage(1); }}><option value="all">All services</option>{eventSources.map((source) => <option value={source} key={source}>{source}</option>)}</select></label>
            <label><span>Order</span><select value={eventOrder} onChange={(event) => { setEventOrder(event.target.value as EventOrder); setEventPage(1); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>
            {filtersActive ? <button className="clear-filters" type="button" onClick={() => { setEventLevelFilter("all"); setEventSourceFilter("all"); setEventQuery(""); setEventPage(1); }}>Clear filters</button> : null}
          </div>
          {pagedEvents.length ? <ol className="event-list">{pagedEvents.map((event) => (
            <li key={event.key}><time>{eventTimeLabel(event.at)}</time><span className={`event-level ${eventLevel(event.priority)}`}>{eventLevel(event.priority)}</span><p><b>{event.source}</b>{event.text}</p></li>
          ))}</ol> : <div className="empty-state event-empty"><TerminalSquare size={18} /><span>{filtersActive ? "No events match the current filters" : bridgeError || logError ? "Service logs unavailable" : logsLoaded ? "No recent warnings or logs" : "Waiting for service logs"}</span></div>}
          <div className="event-pagination" aria-label="Event pages">
            <span>{filteredEvents.length ? `${pageStart + 1}–${Math.min(pageStart + EVENT_PAGE_SIZE, filteredEvents.length)} of ${filteredEvents.length}` : "0 events"}</span>
            <div><button type="button" onClick={() => setEventPage(Math.max(1, currentEventPage - 1))} disabled={currentEventPage === 1}>Previous</button><span>Page {currentEventPage} of {eventPageCount}</span><button type="button" onClick={() => setEventPage(Math.min(eventPageCount, currentEventPage + 1))} disabled={currentEventPage === eventPageCount}>Next</button></div>
          </div>
        </article>

        <article className="panel payload-panel">
          <PanelHeading eyebrow="PAYLOAD" title="Synchronization" detail={recordError ? "Record feed unavailable" : undefined} />
          <div className="payload-stats"><div><strong>{status?.payload.accepted ?? "—"}</strong><span>Accepted events</span></div><div><strong>{status?.payload.rejected ?? "—"}</strong><span>Rejected events</span></div><div><strong>{recordsLoaded ? timestampLabel(latestManifest) : "—"}</strong><span>Latest manifest</span></div></div>
          <div className="record-line"><ImageIcon size={15} /><span>{recordsLoaded ? bulkRecords.length : "—"} recent manifests</span><span>{recordsLoaded ? ackRecords.length : "—"} recent acknowledgements</span></div>
          <p className="panel-note">Metadata only. Image bytes and absolute imagery paths are never shown.</p>
        </article>
      </section>

      <footer><ShieldCheck size={13} /> AVIAN Ground is observational only · Emergency actions remain in the operator CLI</footer>
    </main>
  );
}

function Metric({ title, value, state, detail, icon }: { title: string; value: string; state: "good" | "warn"; detail: string; icon: React.ReactNode }) {
  return <article className="metric-card"><div className="metric-title">{icon}<p>{title}</p></div><div className="metric-line"><strong>{value}</strong><span className={`metric-state ${state}`}>{state === "good" ? "OK" : "Attention"}</span></div><small>{detail}</small></article>;
}

function PanelHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail?: string }) {
  return <div className="panel-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>{detail ? <span className="quiet-label">{detail}</span> : null}</div>;
}

function EmptyRow({ text }: { text: string }) {
  return <div className="empty-state table-empty"><WifiOff size={17} /><span>{text}</span></div>;
}
