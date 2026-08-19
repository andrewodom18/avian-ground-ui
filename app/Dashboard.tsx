"use client";

import {
  Activity,
  AlertTriangle,
  Battery,
  CheckCircle2,
  ChevronDown,
  Image as ImageIcon,
  Link2,
  MapPin,
  Plane,
  Radio,
  RefreshCw,
  Satellite,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  WifiOff,
  X,
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
  node: { name: string; role: "ground" | "aircraft" | "observer"; uptime_ms: number };
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
type AircraftTelemetry = {
  source: string;
  observed_at_ms: number;
  synchronized_at_ms: number;
  expires_at_ms: number | null;
  latitude_deg: number;
  longitude_deg: number;
  position_available: boolean;
  altitude: { msl_m: number; agl_m: number | null; above_launch_m: number };
  velocity_ned_mps: [number, number, number];
  attitude_rpy_deg: [number, number, number];
  battery_remaining: number | null;
  control_link_quality: number | null;
  armed: boolean;
  landed: boolean | null;
  failsafe: boolean;
};
type EventItem = { key: string; at: number; priority: number; source: string; text: string };
type EventLevel = "all" | "warning" | "error" | "info";
type EventOrder = "newest" | "oldest";
type MetricState = "good" | "warn" | "stale";
type ConnectionResult = { name: string; connected: boolean };
type RemovalResult = { name: string; removed: true };

const AIRCRAFT_POLL_INTERVAL_MS = 2_000;
const AIRCRAFT_FRESH_MS = 5_000;
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
  if (!isObject(value.node) || typeof value.node.name !== "string"
    || !["ground", "aircraft", "observer"].includes(String(value.node.role))
    || typeof value.node.uptime_ms !== "number") return false;
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

function decodeLogResponse(value: unknown): { available: boolean; entries: LogEntry[] } {
  if (!isObject(value) || !Array.isArray(value.entries) || !value.entries.every((entry) => isObject(entry)
    && typeof entry.timestamp_ms === "number" && typeof entry.unit === "string"
    && typeof entry.priority === "number" && typeof entry.message === "string")) {
    throw new Error("Ground bridge returned an invalid log response");
  }
  return { available: typeof value.available === "boolean" ? value.available : true, entries: value.entries as LogEntry[] };
}

function decodeRecordResponse(value: unknown): { records: RecordView[] } {
  if (!isObject(value) || !Array.isArray(value.records) || !value.records.every((record) => isObject(record)
    && typeof record.published_at_ms === "number")) {
    throw new Error("Ground bridge returned an invalid record response");
  }
  return { records: value.records as RecordView[] };
}

function isAircraftTelemetry(value: unknown): value is AircraftTelemetry {
  return isObject(value) && typeof value.source === "string"
    && typeof value.observed_at_ms === "number" && typeof value.synchronized_at_ms === "number"
    && isNumberOrNull(value.expires_at_ms) && typeof value.latitude_deg === "number"
    && typeof value.longitude_deg === "number" && typeof value.position_available === "boolean"
    && isObject(value.altitude)
    && typeof value.altitude.msl_m === "number" && isNumberOrNull(value.altitude.agl_m)
    && typeof value.altitude.above_launch_m === "number"
    && Array.isArray(value.velocity_ned_mps) && value.velocity_ned_mps.length === 3
    && value.velocity_ned_mps.every((item) => typeof item === "number" && Number.isFinite(item))
    && Array.isArray(value.attitude_rpy_deg) && value.attitude_rpy_deg.length === 3
    && value.attitude_rpy_deg.every((item) => typeof item === "number" && Number.isFinite(item))
    && isNumberOrNull(value.battery_remaining) && isNumberOrNull(value.control_link_quality)
    && typeof value.armed === "boolean" && (value.landed === null || typeof value.landed === "boolean")
    && typeof value.failsafe === "boolean";
}

function decodeAircraftResponse(value: unknown): { aircraft: AircraftTelemetry[]; observed_at_ms: number } {
  if (!isObject(value) || typeof value.observed_at_ms !== "number" || !Array.isArray(value.aircraft)
    || !value.aircraft.every(isAircraftTelemetry)) {
    throw new Error("Ground bridge returned an invalid aircraft response");
  }
  return { aircraft: value.aircraft, observed_at_ms: value.observed_at_ms };
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

function decodeConnectionResponse(value: unknown): ConnectionResult {
  if (!isObject(value) || typeof value.name !== "string" || typeof value.connected !== "boolean") {
    throw new Error("Ground bridge returned an invalid connection response");
  }
  return { name: value.name, connected: value.connected };
}

function decodeConnectionListResponse(value: unknown): { connections: string[] } {
  if (!isObject(value) || !Array.isArray(value.connections) || !value.connections.every((name) => typeof name === "string")) {
    throw new Error("Ground bridge returned an invalid saved-aircraft response");
  }
  return { connections: value.connections };
}

function decodeRemovalResponse(value: unknown): RemovalResult {
  if (!isObject(value) || typeof value.name !== "string" || value.removed !== true) {
    throw new Error("Ground bridge returned an invalid removal response");
  }
  return { name: value.name, removed: true };
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

function clockLabel(timestamp: number | null): string {
  if (!timestamp) return "never";
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function feetLabel(metres: number | null): string {
  return metres == null ? "—" : `${Math.round(metres * 3.28084).toLocaleString()} ft`;
}

function percentLabel(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function groundSpeedKnots(velocity: [number, number, number]): string {
  return `${(Math.hypot(velocity[0], velocity[1]) * 1.94384).toFixed(1)} kt`;
}

function headingLabel(yaw: number): string {
  return `${Math.round(((yaw % 360) + 360) % 360)}°`;
}

function eventLevel(priority: number): Exclude<EventLevel, "all"> {
  if (priority <= 3) return "error";
  if (priority === 4) return "warning";
  return "info";
}

export function Dashboard() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [aircraft, setAircraft] = useState<AircraftTelemetry[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [bulkRecords, setBulkRecords] = useState<RecordView[]>([]);
  const [ackRecords, setAckRecords] = useState<RecordView[]>([]);
  const [bridgeError, setBridgeError] = useState<string | null>(null);
  const [aircraftError, setAircraftError] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [logsLoaded, setLogsLoaded] = useState(false);
  const [logAvailable, setLogAvailable] = useState(true);
  const [aircraftLoaded, setAircraftLoaded] = useState(false);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [lastStatusAt, setLastStatusAt] = useState<number | null>(null);
  const [aircraftPollAt, setAircraftPollAt] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [eventLevelFilter, setEventLevelFilter] = useState<EventLevel>("all");
  const [eventSourceFilter, setEventSourceFilter] = useState("all");
  const [eventQuery, setEventQuery] = useState("");
  const [eventOrder, setEventOrder] = useState<EventOrder>("newest");
  const [eventPage, setEventPage] = useState(1);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connectionCode, setConnectionCode] = useState("");
  const [connectionPending, setConnectionPending] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [connectionResult, setConnectionResult] = useState<ConnectionResult | null>(null);
  const [savedConnections, setSavedConnections] = useState<string[]>([]);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [connectionListError, setConnectionListError] = useState<string | null>(null);
  const [removeConfirmName, setRemoveConfirmName] = useState<string | null>(null);
  const [removalPending, setRemovalPending] = useState<string | null>(null);
  const [removalResult, setRemovalResult] = useState<RemovalResult | null>(null);
  const statusInFlight = useRef(false);
  const aircraftInFlight = useRef(false);
  const secondaryInFlight = useRef(false);
  const hiddenAircraftNames = useRef(new Set<string>());
  const dataVisibilityRevision = useRef(0);
  const connectionField = useRef<HTMLTextAreaElement>(null);

  const openConnection = useCallback(() => {
    setConnectionError(null);
    setConnectionResult(null);
    setRemovalResult(null);
    setRemoveConfirmName(null);
    setConnectionOpen(true);
  }, []);

  const loadStatus = useCallback(async () => {
    if (statusInFlight.current) return;
    statusInFlight.current = true;
    try {
      const response = await fetchJson("/api/v1/status", decodeStatusResponse);
      setStatus({
        ...response.status,
        peers: response.status.peers.filter((peer) => !hiddenAircraftNames.current.has(peer.name)),
      });
      setLastStatusAt(Date.now());
      setBridgeError(null);
    } catch (error) {
      setBridgeError(fetchErrorLabel(error, "AVIAN status"));
    } finally {
      statusInFlight.current = false;
    }
  }, []);

  const loadAircraft = useCallback(async () => {
    if (aircraftInFlight.current) return;
    aircraftInFlight.current = true;
    try {
      const response = await fetchJson("/api/v1/aircraft", decodeAircraftResponse);
      setAircraft(response.aircraft.filter((item) => !hiddenAircraftNames.current.has(item.source)));
      setAircraftLoaded(true);
      setAircraftError(null);
    } catch (error) {
      setAircraftError(fetchErrorLabel(error, "Aircraft telemetry"));
    } finally {
      setAircraftPollAt(Date.now());
      aircraftInFlight.current = false;
    }
  }, []);

  const loadSecondary = useCallback(async () => {
    if (secondaryInFlight.current) return;
    secondaryInFlight.current = true;
    const visibilityRevision = dataVisibilityRevision.current;
    try {
      const results = await Promise.allSettled([
        fetchJson("/api/v1/logs?lines=200", decodeLogResponse),
        fetchJson("/api/v1/records?class=bulk&limit=20", decodeRecordResponse),
        fetchJson("/api/v1/records?class=acknowledgement&limit=20", decodeRecordResponse),
      ]);
      if (results[0].status === "fulfilled") {
        setLogs(results[0].value.entries);
        setLogsLoaded(true);
        setLogAvailable(results[0].value.available);
        setLogError(null);
      } else {
        setLogError(fetchErrorLabel(results[0].reason, "Service logs"));
      }
      if (visibilityRevision === dataVisibilityRevision.current) {
        if (results[1].status === "fulfilled") setBulkRecords(results[1].value.records);
        if (results[2].status === "fulfilled") setAckRecords(results[2].value.records);
        if (results[1].status === "fulfilled" && results[2].status === "fulfilled") {
          setRecordsLoaded(true);
          setRecordError(null);
        } else {
          const failures = [
            results[1].status === "rejected" ? fetchErrorLabel(results[1].reason, "Payload manifests") : null,
            results[2].status === "rejected" ? fetchErrorLabel(results[2].reason, "Payload acknowledgements") : null,
          ].filter((value): value is string => value !== null);
          setRecordError(failures.join("; "));
        }
      }
    } finally {
      secondaryInFlight.current = false;
    }
  }, []);

  const loadConnections = useCallback(async () => {
    try {
      const response = await fetchJson("/api/v1/connections", decodeConnectionListResponse);
      setSavedConnections(response.connections);
      setConnectionsLoaded(true);
      setConnectionListError(null);
    } catch (error) {
      setConnectionsLoaded(true);
      setConnectionListError(fetchErrorLabel(error, "Saved aircraft"));
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([loadStatus(), loadAircraft(), loadSecondary()]);
    setRefreshing(false);
  }, [loadAircraft, loadSecondary, loadStatus]);

  const connectAircraft = useCallback(async () => {
    const code = connectionCode.trim();
    if (!code) {
      setConnectionError("Paste the AVIAN connection code supplied with the aircraft");
      return;
    }
    setConnectionPending(true);
    setConnectionError(null);
    setConnectionResult(null);
    setRemovalResult(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch("/api/v1/connections", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-avian-setup": "1" },
        body: JSON.stringify({ code }),
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = isObject(payload) && typeof payload.detail === "string" ? payload.detail : `HTTP ${response.status}`;
        throw new Error(detail);
      }
      const result = decodeConnectionResponse(payload);
      hiddenAircraftNames.current.delete(result.name);
      dataVisibilityRevision.current += 1;
      setConnectionResult(result);
      setConnectionCode("");
      await Promise.all([loadStatus(), loadAircraft(), loadSecondary(), loadConnections()]);
    } catch (error) {
      setConnectionError(fetchErrorLabel(error, "Aircraft connection"));
    } finally {
      window.clearTimeout(timer);
      setConnectionPending(false);
    }
  }, [connectionCode, loadAircraft, loadConnections, loadSecondary, loadStatus]);

  const removeAircraft = useCallback(async (name: string) => {
    setRemovalPending(name);
    setConnectionError(null);
    setConnectionResult(null);
    setRemovalResult(null);
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`/api/v1/connections/${encodeURIComponent(name)}`, {
        method: "DELETE",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "x-avian-setup": "1" },
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const detail = isObject(payload) && typeof payload.detail === "string" ? payload.detail : `HTTP ${response.status}`;
        throw new Error(detail);
      }
      const result = decodeRemovalResponse(payload);
      hiddenAircraftNames.current.add(result.name);
      dataVisibilityRevision.current += 1;
      setRemovalResult(result);
      setRemoveConfirmName(null);
      setSavedConnections((current) => current.filter((value) => value !== result.name));
      setStatus((current) => current ? {
        ...current,
        peers: current.peers.filter((peer) => peer.name !== result.name),
      } : current);
      setAircraft((current) => current.filter((item) => item.source !== result.name));
      setBulkRecords([]);
      setAckRecords([]);
      setRecordsLoaded(true);
      setRecordError(null);
      await Promise.all([loadStatus(), loadAircraft(), loadSecondary(), loadConnections()]);
    } catch (error) {
      setConnectionError(fetchErrorLabel(error, "Aircraft removal"));
    } finally {
      window.clearTimeout(timer);
      setRemovalPending(null);
    }
  }, [loadAircraft, loadConnections, loadSecondary, loadStatus]);

  useEffect(() => {
    if (!connectionOpen) return;
    const timer = window.setTimeout(() => void loadConnections(), 0);
    connectionField.current?.focus();
    return () => window.clearTimeout(timer);
  }, [connectionOpen, loadConnections]);

  useEffect(() => {
    if (!connectionOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !connectionPending && removalPending === null) setConnectionOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [connectionOpen, connectionPending, removalPending]);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void refresh(), 0);
    const statusTimer = window.setInterval(() => {
      if (!document.hidden) void loadStatus();
    }, STATUS_POLL_INTERVAL_MS);
    const aircraftTimer = window.setInterval(() => {
      if (!document.hidden) void loadAircraft();
    }, AIRCRAFT_POLL_INTERVAL_MS);
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
      window.clearInterval(aircraftTimer);
      window.clearInterval(secondaryTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadAircraft, loadSecondary, loadStatus, refresh]);

  const disconnected = status?.peers.filter((peer) => !peer.connected) ?? [];
  const connected = (status?.peers.length ?? 0) - disconnected.length;
  const { liveAircraft, staleAircraft } = useMemo(() => {
    const fresh = (item: AircraftTelemetry) => !aircraftError && aircraftPollAt != null
      && Math.max(0, aircraftPollAt - item.observed_at_ms) <= AIRCRAFT_FRESH_MS;
    return { liveAircraft: aircraft.filter(fresh), staleAircraft: aircraft.filter((item) => !fresh(item)) };
  }, [aircraft, aircraftError, aircraftPollAt]);
  const warnings = useMemo(() => {
    const values: string[] = [];
    if (!status && !bridgeError) values.push("Waiting for the first live AVIAN status snapshot");
    if (bridgeError) values.push(bridgeError);
    if (aircraftError) values.push(aircraftError);
    if (logError) values.push(logError);
    if (recordError) values.push(recordError);
    if (status && !status.ready) values.push("Agent acceptance requirements are not fully met");
    if (disconnected.length) values.push(`${disconnected.length} configured peer${disconnected.length === 1 ? " is" : "s are"} unavailable`);
    if (status?.mavlink.required && !status.mavlink.connected) values.push("Required MAVLink connection is unavailable");
    if (status?.radio.required && !status.radio.fresh) values.push("Required radio observation is stale or unhealthy");
    if (aircraftLoaded && aircraft.length === 0) values.push("No aircraft telemetry has synchronized through the AVIAN mesh");
    for (const item of staleAircraft) values.push(`${item.source} telemetry is stale; showing the last synchronized snapshot`);
    for (const item of aircraft.filter((value) => !value.position_available)) values.push(`${item.source} position is unavailable; verify GPS/EKF before flight`);
    for (const item of aircraft.filter((value) => value.failsafe)) values.push(`${item.source} reports an active flight-controller failsafe`);
    return values;
  }, [aircraft, aircraftError, aircraftLoaded, bridgeError, disconnected.length, logError, recordError, staleAircraft, status]);

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
  const displayedConnectionResult = connectionResult && status?.peers.some(
    (peer) => peer.name === connectionResult.name && peer.connected,
  ) ? { ...connectionResult, connected: true } : connectionResult;
  const localMetricState: MetricState = bridgeError && status ? "stale" : status?.ready ? "good" : "warn";
  const aircraftMetricState: MetricState = liveAircraft.length > 0 && staleAircraft.length === 0 ? "good"
    : aircraft.length > 0 ? "stale" : "warn";
  const setupPending = connectionPending || removalPending !== null;

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
            {bridgeError ? (status ? "Local bridge interrupted" : "Local bridge offline") : status ? `Live · ${status.node.name}` : "Connecting to local bridge"}
            <span className="sync-time">{bridgeError && lastStatusAt ? `Last live ${clockLabel(lastStatusAt)}` : status && lastStatusAt ? `Snapshot ${clockLabel(lastStatusAt)}` : "Auto refresh 10s"}</span>
          </div>
          {status?.node.role === "ground" ? <button className="connect-button" type="button" onClick={openConnection}>
            <Link2 size={14} /> Manage aircraft
          </button> : null}
          <button className="refresh-button" type="button" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? "spinning" : ""} /> Refresh now
          </button>
        </div>
      </header>

      {connectionOpen ? (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !setupPending) setConnectionOpen(false); }}>
          <section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
            <div className="dialog-heading">
              <div><p className="eyebrow">AIRCRAFT SETUP</p><h2 id="connection-title">Manage aircraft connections</h2></div>
              <button type="button" aria-label="Close aircraft setup" onClick={() => setConnectionOpen(false)} disabled={setupPending}><X size={17} /></button>
            </div>
            <div className="dialog-body">
              <p>Connect this device to the aircraft network, then paste the <strong>AVIAN1</strong> code supplied with the drone.</p>
              <ol><li>Power on the aircraft computer.</li><li>Join its local or approved overlay network.</li><li>Paste the code and connect.</li></ol>
              <label className="connection-field"><span>Aircraft connection code</span><textarea ref={connectionField} value={connectionCode} onChange={(event) => setConnectionCode(event.target.value)} placeholder="AVIAN1.…" rows={4} spellCheck={false} autoCapitalize="none" autoCorrect="off" disabled={setupPending} /></label>
              <p className="connection-privacy"><ShieldCheck size={14} /> The code contains routing details only. Formation credentials stay in the local AVIAN agent.</p>
              {connectionError ? <p className="connection-message error" role="alert"><AlertTriangle size={15} />{connectionError}</p> : null}
              {displayedConnectionResult ? <p className={`connection-message ${displayedConnectionResult.connected ? "success" : "pending"}`} role="status">{displayedConnectionResult.connected ? <CheckCircle2 size={15} /> : <RefreshCw size={15} className="spinning" />}{displayedConnectionResult.connected ? `${displayedConnectionResult.name} is connected` : `${displayedConnectionResult.name} was saved; AVIAN is attempting the first connection`}</p> : null}
              {removalResult ? <p className="connection-message success" role="status"><CheckCircle2 size={15} />{removalResult.name} was removed; its overview data is hidden</p> : null}
              <section className="saved-connections" aria-labelledby="saved-connections-title">
                <div className="saved-connections-heading"><div><strong id="saved-connections-title">Saved aircraft</strong><small>Code-added direct peers on this ground device</small></div><button type="button" onClick={() => void loadConnections()} disabled={setupPending}><RefreshCw size={13} /> Refresh</button></div>
                {connectionListError ? <p className="saved-connections-error" role="alert"><AlertTriangle size={14} />{connectionListError}</p> : savedConnections.length ? <ul>{savedConnections.map((name) => {
                  const connectedPeer = status?.peers.find((peer) => peer.name === name);
                  const confirming = removeConfirmName === name;
                  const removing = removalPending === name;
                  return <li key={name}><span><strong>{name}</strong><small>{connectedPeer?.connected ? "Connected" : "Saved locally"}</small></span><div>{confirming ? <><button type="button" className="cancel-removal" onClick={() => setRemoveConfirmName(null)} disabled={removing}>Cancel</button><button type="button" className="confirm-removal" onClick={() => void removeAircraft(name)} disabled={removing}>{removing ? <RefreshCw size={13} className="spinning" /> : <Trash2 size={13} />}{removing ? "Removing…" : "Confirm remove"}</button></> : <button type="button" className="remove-connection" onClick={() => { setRemoveConfirmName(name); setConnectionError(null); setRemovalResult(null); }} disabled={setupPending}><Trash2 size={13} /> Remove</button>}</div></li>;
                })}</ul> : <p className="saved-connections-empty">{connectionsLoaded ? "No connection-code aircraft are saved." : "Loading saved aircraft…"}</p>}
                <p className="saved-connections-note">Removal deletes the saved direct peer, stops outbound retries, and hides that aircraft&apos;s synchronized data from this overview. It does not erase local records or revoke formation access. Paste its code again to restore the view.</p>
              </section>
            </div>
            <div className="dialog-actions"><button type="button" className="secondary-action" onClick={() => setConnectionOpen(false)} disabled={setupPending}>Close</button><button type="button" className="primary-action" onClick={() => void connectAircraft()} disabled={setupPending || !connectionCode.trim()}>{connectionPending ? <RefreshCw size={14} className="spinning" /> : <Link2 size={14} />}{connectionPending ? "Connecting…" : "Connect aircraft"}</button></div>
          </section>
        </div>
      ) : null}

      {status?.node.role === "ground" && status.peers.length === 0 ? <section className="setup-callout"><div><Link2 size={19} /><span><strong>No direct aircraft peers saved</strong><small>Add a connection code so this ground agent can initiate and retry the link.</small></span></div><button type="button" onClick={openConnection}>Connect aircraft</button></section> : null}

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
        <Metric title="Ground agent" value={status ? (status.ready ? "Ready" : "Degraded") : "Unavailable"} state={localMetricState} detail={status ? `Uptime ${durationLabel(status.node.uptime_ms)}` : "Waiting for local bridge"} icon={<ShieldCheck size={17} />} />
        <Metric title="Configured peers" value={status ? `${connected} / ${status.peers.length}` : "—"} state={bridgeError && status ? "stale" : status && !disconnected.length ? "good" : "warn"} detail={!status ? "Waiting for live peer status" : disconnected.length ? `${disconnected.length} reconnect in progress` : status.peers.length ? "All configured peers connected" : "No outbound direct peers saved"} icon={<Activity size={17} />} />
        <Metric title="Aircraft feed" value={aircraftLoaded ? `${liveAircraft.length} live` : "Waiting"} state={aircraftMetricState} detail={staleAircraft.length ? `${staleAircraft.length} last-known snapshot${staleAircraft.length === 1 ? "" : "s"}` : liveAircraft.length ? "Mesh telemetry current" : "No synchronized aircraft yet"} icon={<Plane size={17} />} />
        <Metric title="Radio monitor" value={!status ? "—" : !status.radio.required ? "Optional" : status.radio.fresh ? "Healthy" : "Degraded"} state={bridgeError && status ? "stale" : status && (status.radio.fresh || !status.radio.required) ? "good" : "warn"} detail={!status ? "Waiting for live radio status" : !status.radio.required ? "Passive underlay monitoring" : status.radio.fresh ? "Observation current" : "Required observation unavailable"} icon={<Satellite size={17} />} />
      </section>

      <section className="content-grid">
        <article className="panel aircraft-panel">
          <PanelHeading eyebrow="FLIGHT" title="Synchronized aircraft telemetry" detail="Mesh refresh 2s" />
          {aircraft.length ? <div className="aircraft-grid">{aircraft.map((item) => {
            const fresh = liveAircraft.some((value) => value.source === item.source);
            return <section className={`aircraft-card ${fresh ? "live" : "stale"} ${item.failsafe ? "failsafe" : ""}`} key={item.source}>
              <div className="aircraft-title"><div><Plane size={18} /><strong>{item.source}</strong></div><span>{fresh ? "Live" : "Last known"}</span></div>
              <div className="flight-primary">
                <div><small>Altitude MSL</small><strong>{feetLabel(item.altitude.msl_m)}</strong></div>
                <div><small>{item.altitude.agl_m == null ? "Above launch" : "Altitude AGL"}</small><strong>{feetLabel(item.altitude.agl_m ?? item.altitude.above_launch_m)}</strong></div>
                <div><small>Ground speed</small><strong>{groundSpeedKnots(item.velocity_ned_mps)}</strong></div>
                <div><small>Heading</small><strong>{headingLabel(item.attitude_rpy_deg[2])}</strong></div>
              </div>
              <div className="flight-secondary">
                <span><Battery size={14} /> Battery <b>{percentLabel(item.battery_remaining)}</b></span>
                <span><Radio size={14} /> Control link <b>{percentLabel(item.control_link_quality)}</b></span>
                <span className={item.position_available ? "" : "attention"}><MapPin size={14} /> {item.position_available ? `${item.latitude_deg.toFixed(5)}, ${item.longitude_deg.toFixed(5)}` : "Position unavailable"}</span>
              </div>
              <div className="flight-flags">
                <span className={item.armed ? "attention" : ""}>{item.armed ? "Armed" : "Disarmed"}</span>
                <span>{item.landed == null ? "Landed state unknown" : item.landed ? "Landed" : "Airborne"}</span>
                <span className={item.failsafe ? "danger" : ""}>{item.failsafe ? "Failsafe active" : "No failsafe"}</span>
                <time>{fresh ? "Observed" : "Last observed"} {clockLabel(item.observed_at_ms)}</time>
              </div>
            </section>;
          })}</div> : <div className="empty-state aircraft-empty"><Plane size={19} /><span>{aircraftError ? "Aircraft feed unavailable" : aircraftLoaded ? "No aircraft telemetry has synchronized yet" : "Waiting for AVIAN mesh telemetry"}</span></div>}
          <p className="panel-note">Telemetry is read from the local ground agent. A link drop preserves the last synchronized snapshot as stale; removing the aircraft clears it from this overview.</p>
        </article>

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
          <PanelHeading eyebrow="EVENTS" title="Warnings and logs" detail={logError ? "Showing last available feed" : !logAvailable ? "Local journal disabled" : `${events.length} loaded`} />
          <div className="event-controls" aria-label="Event filters">
            <label className="event-search"><span>Search</span><input type="search" value={eventQuery} onChange={(event) => { setEventQuery(event.target.value); setEventPage(1); }} placeholder="Message or service" /></label>
            <label><span>Severity</span><select value={eventLevelFilter} onChange={(event) => { setEventLevelFilter(event.target.value as EventLevel); setEventPage(1); }}><option value="all">All</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Info</option></select></label>
            <label><span>Service</span><select value={eventSourceFilter} onChange={(event) => { setEventSourceFilter(event.target.value); setEventPage(1); }}><option value="all">All services</option>{eventSources.map((source) => <option value={source} key={source}>{source}</option>)}</select></label>
            <label><span>Order</span><select value={eventOrder} onChange={(event) => { setEventOrder(event.target.value as EventOrder); setEventPage(1); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>
            {filtersActive ? <button className="clear-filters" type="button" onClick={() => { setEventLevelFilter("all"); setEventSourceFilter("all"); setEventQuery(""); setEventPage(1); }}>Clear filters</button> : null}
          </div>
          {pagedEvents.length ? <ol className="event-list">{pagedEvents.map((event) => (
            <li key={event.key}><time>{eventTimeLabel(event.at)}</time><span className={`event-level ${eventLevel(event.priority)}`}>{eventLevel(event.priority)}</span><p><b>{event.source}</b>{event.text}</p></li>
          ))}</ol> : <div className="empty-state event-empty"><TerminalSquare size={18} /><span>{filtersActive ? "No events match the current filters" : logError ? "Service logs unavailable" : logsLoaded ? "No recent warnings or logs" : "Waiting for service logs"}</span></div>}
          <div className="event-pagination" aria-label="Event pages">
            <span>{filteredEvents.length ? `${pageStart + 1}–${Math.min(pageStart + EVENT_PAGE_SIZE, filteredEvents.length)} of ${filteredEvents.length}` : "0 events"}</span>
            <div><button type="button" onClick={() => setEventPage(Math.max(1, currentEventPage - 1))} disabled={currentEventPage === 1}>Previous</button><span>Page {currentEventPage} of {eventPageCount}</span><button type="button" onClick={() => setEventPage(Math.min(eventPageCount, currentEventPage + 1))} disabled={currentEventPage === eventPageCount}>Next</button></div>
          </div>
        </article>

        <article className="panel payload-panel">
          <PanelHeading eyebrow="PAYLOAD" title="Synchronization" detail={recordError ? "Record feed unavailable" : undefined} />
          <div className="payload-stats"><div><strong>{recordsLoaded ? bulkRecords.length : "—"}</strong><span>Recent manifests</span></div><div><strong>{recordsLoaded ? ackRecords.length : "—"}</strong><span>Recent acknowledgements</span></div><div><strong>{recordsLoaded ? timestampLabel(latestManifest) : "—"}</strong><span>Latest manifest</span></div></div>
          <div className="record-line"><ImageIcon size={15} /><span>Replicated AVIAN metadata</span><span>No image bytes</span></div>
          <p className="panel-note">Metadata only. Image bytes and absolute imagery paths are never shown. Records from removed aircraft are excluded.</p>
        </article>
      </section>

      <footer><ShieldCheck size={13} /> Flight operations are observational only · Connection setup changes local mesh membership</footer>
    </main>
  );
}

function Metric({ title, value, state, detail, icon }: { title: string; value: string; state: MetricState; detail: string; icon: React.ReactNode }) {
  return <article className="metric-card"><div className="metric-title">{icon}<p>{title}</p></div><div className="metric-line"><strong>{value}</strong><span className={`metric-state ${state}`}>{state === "good" ? "OK" : state === "stale" ? "Stale" : "Attention"}</span></div><small>{detail}</small></article>;
}

function PanelHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail?: string }) {
  return <div className="panel-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>{detail ? <span className="quiet-label">{detail}</span> : null}</div>;
}

function EmptyRow({ text }: { text: string }) {
  return <div className="empty-state table-empty"><WifiOff size={17} /><span>{text}</span></div>;
}
