use std::collections::BTreeSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context};
use axum::extract::{DefaultBodyLimit, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use clap::Parser;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use tokio::process::Command;
use tokio::time::timeout;
use tower::limit::ConcurrencyLimitLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

const LOCAL_PROTOCOL_VERSION: u16 = 1;
const CONTROL_TIMEOUT: Duration = Duration::from_secs(3);
const JOURNAL_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_CONTROL_BYTES: usize = 1_048_576;
const MAX_LOG_BYTES: usize = 1_048_576;
const MAX_LOG_LINES: usize = 200;
const MAX_LOG_MESSAGE_CHARS: usize = 512;
const MAX_CONNECTION_CODE_CHARS: usize = 8_192;
const MAX_SETUP_BODY_BYTES: usize = 16_384;

#[derive(Debug, Parser)]
#[command(name = "avian-ground-ui", version, about)]
struct Args {
    #[arg(long, default_value = "127.0.0.1:4178")]
    bind: SocketAddr,
    #[arg(long, default_value = "/run/avian/control.sock")]
    control_socket: PathBuf,
    #[arg(long, default_value = "/usr/local/share/avian-ground-ui")]
    assets: PathBuf,
    #[arg(long, default_value = "/usr/bin/journalctl")]
    journalctl: PathBuf,
    #[arg(long)]
    disable_journal: bool,
}

#[derive(Clone)]
struct AppState {
    avian: AvianClient,
    journalctl: Option<Arc<PathBuf>>,
    authority: Arc<str>,
}

#[derive(Clone)]
struct AvianClient {
    socket: Arc<PathBuf>,
    max_message_bytes: usize,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    detail: String,
}

impl ApiError {
    fn bad_request(detail: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "invalid_request",
            detail: detail.into(),
        }
    }

    fn unavailable(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code,
            detail: detail.into(),
        }
    }

    fn forbidden(detail: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "setup_forbidden",
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectRequest {
    code: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectionCode {
    schema_version: u16,
    formation_id: String,
    aircraft: ConnectionAircraft,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConnectionAircraft {
    name: String,
    endpoint_id: String,
    addresses: Vec<ConnectionAddress>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ConnectionAddress {
    underlay: String,
    address: SocketAddr,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            Json(json!({ "code": self.code, "detail": self.detail })),
        )
            .into_response();
        response.headers_mut().insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store, max-age=0"),
        );
        response
    }
}

#[derive(Debug, Deserialize)]
struct RecordQuery {
    class: String,
    #[serde(default = "default_record_limit")]
    limit: u16,
}

#[derive(Debug, Deserialize)]
struct LogQuery {
    #[serde(default = "default_log_lines")]
    lines: usize,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
struct LogEntry {
    timestamp_ms: u64,
    unit: String,
    priority: u8,
    message: String,
}

#[derive(Debug, Deserialize)]
struct StatusInput {
    schema_version: u16,
    ready: bool,
    node: NodeInput,
    peers: Vec<PeerInput>,
    underlays: std::collections::BTreeMap<String, UnderlayInput>,
    mavlink: MavlinkInput,
    payload: PayloadInput,
    radio: RadioInput,
    last_errors: Vec<StatusErrorInput>,
}

#[derive(Debug, Deserialize)]
struct NodeInput {
    name: String,
    uptime_ms: u64,
}

#[derive(Debug, Deserialize)]
struct PeerInput {
    name: String,
    connected: bool,
    selected_underlay: Option<String>,
    last_transition_at_ms: u64,
}

#[derive(Debug, Deserialize, Serialize)]
struct UnderlayInput {
    reachable: bool,
    last_observed_at_ms: Option<u64>,
    latency_ms: Option<f64>,
    loss_ratio: Option<f64>,
    goodput_bps: Option<u64>,
    stability: Option<f64>,
}

#[derive(Debug, Deserialize, Serialize)]
struct MavlinkInput {
    required: bool,
    connected: bool,
    target_system_id: Option<u8>,
    last_message_at_ms: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
struct PayloadInput {
    accepted: u64,
    rejected: u64,
}

#[derive(Debug, Deserialize, Serialize)]
struct RadioInput {
    required: bool,
    fresh: bool,
    last_observation_at_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct StatusErrorInput {
    component: String,
    detail: String,
    at_ms: u64,
}

#[derive(Debug, Serialize)]
struct DashboardStatus {
    schema_version: u16,
    ready: bool,
    node: DashboardNode,
    peers: Vec<DashboardPeer>,
    underlays: std::collections::BTreeMap<String, UnderlayInput>,
    mavlink: MavlinkInput,
    payload: PayloadInput,
    radio: RadioInput,
    last_errors: Vec<DashboardStatusError>,
}

#[derive(Debug, Serialize)]
struct DashboardNode {
    name: String,
    uptime_ms: u64,
}

#[derive(Debug, Serialize)]
struct DashboardPeer {
    name: String,
    connected: bool,
    selected_underlay: Option<String>,
    last_transition_at_ms: u64,
}

#[derive(Debug, Serialize)]
struct DashboardStatusError {
    component: String,
    detail: String,
    at_ms: u64,
}

#[derive(Debug, Deserialize)]
struct RecordInput {
    record: RecordBodyInput,
}

#[derive(Debug, Deserialize)]
struct RecordBodyInput {
    published_at_ms: u64,
}

#[derive(Debug, Serialize)]
struct DashboardRecord {
    published_at_ms: u64,
}

#[derive(Debug, Deserialize)]
struct TelemetryRecordInput {
    record: TelemetryRecordBodyInput,
}

#[derive(Debug, Deserialize)]
struct TelemetryRecordBodyInput {
    source: String,
    published_at_ms: u64,
    expires_at_ms: Option<u64>,
    payload: Value,
}

#[derive(Debug, Deserialize)]
struct AircraftTelemetryInput {
    source: String,
    timestamp_ms: u64,
    latitude_deg: f64,
    longitude_deg: f64,
    altitude: AircraftAltitudeInput,
    velocity_ned_mps: [f32; 3],
    attitude_rpy_deg: [f32; 3],
    battery_remaining: Option<f32>,
    control_link_quality: Option<f32>,
    armed: bool,
    landed: Option<bool>,
    failsafe: bool,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
struct AircraftAltitudeInput {
    msl_m: f64,
    agl_m: Option<f64>,
    above_launch_m: f64,
}

#[derive(Debug, Serialize, PartialEq)]
struct DashboardAircraftTelemetry {
    source: String,
    observed_at_ms: u64,
    synchronized_at_ms: u64,
    expires_at_ms: Option<u64>,
    latitude_deg: f64,
    longitude_deg: f64,
    position_available: bool,
    altitude: AircraftAltitudeInput,
    velocity_ned_mps: [f32; 3],
    attitude_rpy_deg: [f32; 3],
    battery_remaining: Option<f32>,
    control_link_quality: Option<f32>,
    armed: bool,
    landed: Option<bool>,
    failsafe: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    validate_args(&args)?;
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "avian_ground_ui=info,tower_http=info".into()),
        )
        .with_target(false)
        .compact()
        .init();

    let state = AppState {
        avian: AvianClient {
            socket: Arc::new(args.control_socket),
            max_message_bytes: MAX_CONTROL_BYTES,
        },
        journalctl: (!args.disable_journal).then(|| Arc::new(args.journalctl)),
        authority: Arc::from(args.bind.to_string()),
    };
    let index = args.assets.join("index.html");
    let static_files = ServeDir::new(args.assets).not_found_service(ServeFile::new(index));
    let app = Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/status", get(agent_status))
        .route("/api/v1/aircraft", get(aircraft))
        .route("/api/v1/records", get(records))
        .route("/api/v1/logs", get(logs))
        .route("/api/v1/connections", post(connect_aircraft))
        .fallback_service(static_files)
        .layer(DefaultBodyLimit::max(MAX_SETUP_BODY_BYTES))
        .layer(ConcurrencyLimitLayer::new(64))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            enforce_local_request,
        ))
        .layer(TraceLayer::new_for_http())
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("permissions-policy"),
            HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
        ))
        .layer(SetResponseHeaderLayer::if_not_present(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static(
                "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
            ),
        ))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(args.bind)
        .await
        .with_context(|| format!("binding loopback dashboard at {}", args.bind))?;
    tracing::info!(address = %args.bind, "AVIAN ground dashboard listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("serving AVIAN ground dashboard")?;
    Ok(())
}

async fn enforce_local_request(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if let Err(status) = validate_request_headers(request.headers(), &state.authority) {
        let detail = if status == StatusCode::MISDIRECTED_REQUEST {
            "invalid request authority"
        } else {
            "cross-origin requests are not allowed"
        };
        return (status, detail).into_response();
    }
    next.run(request).await
}

fn validate_request_headers(headers: &HeaderMap, authority: &str) -> Result<(), StatusCode> {
    if headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        != Some(authority)
    {
        return Err(StatusCode::MISDIRECTED_REQUEST);
    }
    if let Some(value) = headers.get(header::ORIGIN) {
        let origin = value.to_str().map_err(|_| StatusCode::FORBIDDEN)?;
        if origin != format!("http://{authority}") {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    Ok(())
}

fn validate_args(args: &Args) -> anyhow::Result<()> {
    if !args.bind.ip().is_loopback() {
        bail!("the ground dashboard must bind to a loopback address");
    }
    if !args.assets.join("index.html").is_file() {
        bail!("dashboard assets must contain index.html");
    }
    if args.journalctl.is_relative() {
        bail!("journalctl path must be absolute");
    }
    Ok(())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn health() -> impl IntoResponse {
    api_json(json!({
        "schema_version": 1,
        "service": "avian-ground-ui",
        "observed_at_ms": unix_time_ms(),
        "read_only": true,
        "operations_read_only": true,
        "connection_setup": true
    }))
}

async fn connect_aircraft(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ConnectRequest>,
) -> Result<Response, ApiError> {
    if headers
        .get("x-avian-setup")
        .and_then(|value| value.to_str().ok())
        != Some("1")
    {
        return Err(ApiError::forbidden("missing local setup confirmation"));
    }
    let connection = decode_connection_code(&request.code)?;
    let body = state
        .avian
        .request(json!({
            "type": "configure_peer",
            "formation_id": connection.formation_id,
            "name": connection.aircraft.name,
            "endpoint_id": connection.aircraft.endpoint_id,
            "addresses": connection.aircraft.addresses
        }))
        .await?;
    if body.get("type").and_then(Value::as_str) == Some("error") {
        let detail = body
            .get("detail")
            .and_then(Value::as_str)
            .map(sanitize_message)
            .unwrap_or_else(|| "aircraft connection was rejected".to_owned());
        return Err(ApiError::bad_request(detail));
    }
    if body.get("type").and_then(Value::as_str) != Some("peer_configured") {
        return Err(control_error(body));
    }
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .map(sanitize_message)
        .ok_or_else(|| {
            ApiError::unavailable(
                "invalid_control_response",
                "configured peer name is missing",
            )
        })?;
    let connected = body
        .get("connected")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            ApiError::unavailable(
                "invalid_control_response",
                "configured peer connection state is missing",
            )
        })?;
    Ok(api_json(json!({ "name": name, "connected": connected })))
}

fn decode_connection_code(value: &str) -> Result<ConnectionCode, ApiError> {
    let value = value.trim();
    if value.len() > MAX_CONNECTION_CODE_CHARS {
        return Err(ApiError::bad_request("connection code is too long"));
    }
    let encoded = value
        .strip_prefix("AVIAN1.")
        .ok_or_else(|| ApiError::bad_request("connection code must start with AVIAN1."))?;
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| ApiError::bad_request("connection code encoding is invalid"))?;
    if decoded.len() > MAX_CONNECTION_CODE_CHARS {
        return Err(ApiError::bad_request(
            "decoded connection code is too large",
        ));
    }
    let connection: ConnectionCode = serde_json::from_slice(&decoded)
        .map_err(|_| ApiError::bad_request("connection code contents are invalid"))?;
    if connection.schema_version != 1 {
        return Err(ApiError::bad_request(
            "connection code version is not supported",
        ));
    }
    if !valid_setup_identifier(&connection.formation_id)
        || !valid_setup_identifier(&connection.aircraft.name)
    {
        return Err(ApiError::bad_request(
            "connection code contains an invalid formation or aircraft name",
        ));
    }
    if connection.aircraft.endpoint_id.len() != 64
        || !connection
            .aircraft
            .endpoint_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(ApiError::bad_request(
            "connection code contains an invalid aircraft identity",
        ));
    }
    if connection.aircraft.addresses.is_empty() || connection.aircraft.addresses.len() > 8 {
        return Err(ApiError::bad_request(
            "connection code must contain 1-8 aircraft addresses",
        ));
    }
    for address in &connection.aircraft.addresses {
        if !matches!(
            address.underlay.as_str(),
            "silvus" | "ethernet" | "wifi" | "satellite" | "other"
        ) || address.address.port() == 0
            || !valid_connection_ip(address.address.ip())
        {
            return Err(ApiError::bad_request(
                "connection code contains an invalid aircraft address",
            ));
        }
    }
    Ok(connection)
}

fn valid_connection_ip(value: std::net::IpAddr) -> bool {
    match value {
        std::net::IpAddr::V4(value) => {
            !value.is_unspecified()
                && !value.is_multicast()
                && !value.is_loopback()
                && !value.is_broadcast()
        }
        std::net::IpAddr::V6(value) => value.to_ipv4_mapped().map_or_else(
            || !value.is_unspecified() && !value.is_multicast() && !value.is_loopback(),
            |mapped| valid_connection_ip(mapped.into()),
        ),
    }
}

fn valid_setup_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

async fn agent_status(State(state): State<AppState>) -> Result<Response, ApiError> {
    let body = state
        .avian
        .request(json!({ "type": "status", "require_ready": false }))
        .await?;
    if body.get("type").and_then(Value::as_str) != Some("status") {
        return Err(control_error(body));
    }
    let status = body
        .get("status")
        .cloned()
        .ok_or_else(|| ApiError::unavailable("invalid_control_response", "status is missing"))?;
    let status: StatusInput = serde_json::from_value(status).map_err(|_| {
        ApiError::unavailable("invalid_control_response", "status schema is invalid")
    })?;
    let status = project_status(status)?;
    Ok(api_json(json!({ "status": status })))
}

async fn records(
    State(state): State<AppState>,
    Query(query): Query<RecordQuery>,
) -> Result<Response, ApiError> {
    if !is_allowed_record_class(&query.class) {
        return Err(ApiError::bad_request("unsupported record class"));
    }
    if !(1..=100).contains(&query.limit) {
        return Err(ApiError::bad_request("record limit must be 1-100"));
    }
    let body = state
        .avian
        .request(json!({
            "type": "list_records",
            "class": query.class,
            "limit": query.limit
        }))
        .await?;
    if body.get("type").and_then(Value::as_str) != Some("records") {
        return Err(control_error(body));
    }
    let records = body
        .get("records")
        .cloned()
        .ok_or_else(|| ApiError::unavailable("invalid_control_response", "records are missing"))?;
    let records: Vec<RecordInput> = serde_json::from_value(records).map_err(|_| {
        ApiError::unavailable("invalid_control_response", "record schema is invalid")
    })?;
    let records = project_records(records, query.limit);
    Ok(api_json(json!({ "records": records })))
}

async fn aircraft(State(state): State<AppState>) -> Result<Response, ApiError> {
    let body = state
        .avian
        .request(json!({
            "type": "list_records",
            "class": "telemetry",
            "limit": 100
        }))
        .await?;
    if body.get("type").and_then(Value::as_str) != Some("records") {
        return Err(control_error(body));
    }
    let records = body
        .get("records")
        .cloned()
        .ok_or_else(|| ApiError::unavailable("invalid_control_response", "records are missing"))?;
    let records: Vec<TelemetryRecordInput> = serde_json::from_value(records).map_err(|_| {
        ApiError::unavailable(
            "invalid_control_response",
            "telemetry record schema is invalid",
        )
    })?;
    Ok(api_json(json!({
        "aircraft": project_aircraft_records(records),
        "observed_at_ms": unix_time_ms()
    })))
}

fn project_records(records: Vec<RecordInput>, limit: u16) -> Vec<DashboardRecord> {
    records
        .into_iter()
        .take(usize::from(limit))
        .map(|view| DashboardRecord {
            published_at_ms: view.record.published_at_ms,
        })
        .collect()
}

fn is_allowed_record_class(class: &str) -> bool {
    matches!(class, "acknowledgement" | "bulk")
}

fn project_aircraft_records(records: Vec<TelemetryRecordInput>) -> Vec<DashboardAircraftTelemetry> {
    let mut sources = BTreeSet::new();
    records
        .into_iter()
        .filter_map(|view| {
            let kind = view.record.payload.get("kind")?.as_str()?;
            if kind != "telemetry" {
                return None;
            }
            let telemetry: AircraftTelemetryInput =
                serde_json::from_value(view.record.payload.get("value")?.clone()).ok()?;
            if telemetry.source != view.record.source
                || !valid_aircraft_telemetry(&telemetry)
                || !sources.insert(telemetry.source.clone())
            {
                return None;
            }
            Some(DashboardAircraftTelemetry {
                source: sanitize_message(&telemetry.source),
                observed_at_ms: telemetry.timestamp_ms,
                synchronized_at_ms: view.record.published_at_ms,
                expires_at_ms: view.record.expires_at_ms,
                latitude_deg: telemetry.latitude_deg,
                longitude_deg: telemetry.longitude_deg,
                // GLOBAL_POSITION_INT can use exact 0,0 as the no-position
                // sentinel before the flight controller has a usable fix.
                // Preserve the numeric fields for schema stability, but make
                // the ambiguity explicit to the operator projection.
                position_available: telemetry.latitude_deg != 0.0 || telemetry.longitude_deg != 0.0,
                altitude: telemetry.altitude,
                velocity_ned_mps: telemetry.velocity_ned_mps,
                attitude_rpy_deg: telemetry.attitude_rpy_deg,
                battery_remaining: telemetry.battery_remaining,
                control_link_quality: telemetry.control_link_quality,
                armed: telemetry.armed,
                landed: telemetry.landed,
                failsafe: telemetry.failsafe,
            })
        })
        .collect()
}

fn valid_aircraft_telemetry(value: &AircraftTelemetryInput) -> bool {
    value.source.len() <= 128
        && !value.source.is_empty()
        && value.latitude_deg.is_finite()
        && (-90.0..=90.0).contains(&value.latitude_deg)
        && value.longitude_deg.is_finite()
        && (-180.0..=180.0).contains(&value.longitude_deg)
        && value.altitude.msl_m.is_finite()
        && value
            .altitude
            .agl_m
            .is_none_or(|altitude| altitude.is_finite() && altitude >= 0.0)
        && value.altitude.above_launch_m.is_finite()
        && value.velocity_ned_mps.iter().all(|item| item.is_finite())
        && value.attitude_rpy_deg.iter().all(|item| item.is_finite())
        && value
            .battery_remaining
            .is_none_or(|item| item.is_finite() && (0.0..=1.0).contains(&item))
        && value
            .control_link_quality
            .is_none_or(|item| item.is_finite() && (0.0..=1.0).contains(&item))
}

fn project_status(input: StatusInput) -> Result<DashboardStatus, ApiError> {
    if input.schema_version != 1 {
        return Err(ApiError::unavailable(
            "invalid_control_response",
            "unsupported status schema version",
        ));
    }
    if input.peers.len() > 1_000 || input.underlays.len() > 100 || input.last_errors.len() > 100 {
        return Err(ApiError::unavailable(
            "invalid_control_response",
            "status collection limit exceeded",
        ));
    }
    let mut underlays = std::collections::BTreeMap::new();
    for (name, value) in input.underlays {
        underlays.insert(sanitize_message(&name), value);
    }
    Ok(DashboardStatus {
        schema_version: input.schema_version,
        ready: input.ready,
        node: DashboardNode {
            name: sanitize_message(&input.node.name),
            uptime_ms: input.node.uptime_ms,
        },
        peers: input
            .peers
            .into_iter()
            .map(|peer| DashboardPeer {
                name: sanitize_message(&peer.name),
                connected: peer.connected,
                selected_underlay: peer.selected_underlay.map(|value| sanitize_message(&value)),
                last_transition_at_ms: peer.last_transition_at_ms,
            })
            .collect(),
        underlays,
        mavlink: input.mavlink,
        payload: input.payload,
        radio: input.radio,
        last_errors: input
            .last_errors
            .into_iter()
            .map(|error| DashboardStatusError {
                component: sanitize_message(&error.component),
                detail: sanitize_message(&error.detail),
                at_ms: error.at_ms,
            })
            .collect(),
    })
}

async fn logs(
    State(state): State<AppState>,
    Query(query): Query<LogQuery>,
) -> Result<Response, ApiError> {
    if !(1..=MAX_LOG_LINES).contains(&query.lines) {
        return Err(ApiError::bad_request(format!(
            "log lines must be 1-{MAX_LOG_LINES}"
        )));
    }
    let Some(journalctl) = state.journalctl.as_deref() else {
        return Ok(api_json(json!({ "available": false, "entries": [] })));
    };
    let entries = read_journal(journalctl, query.lines).await?;
    Ok(api_json(json!({ "available": true, "entries": entries })))
}

fn api_json(value: Value) -> Response {
    let mut response = Json(value).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    response
}

impl AvianClient {
    async fn request(&self, body: Value) -> Result<Value, ApiError> {
        let encoded = serde_json::to_vec(&json!({
            "protocol_version": LOCAL_PROTOCOL_VERSION,
            "body": body
        }))
        .map_err(|_| {
            ApiError::unavailable("request_encoding_failed", "could not encode request")
        })?;
        if encoded.len() > self.max_message_bytes {
            return Err(ApiError::bad_request("encoded request is too large"));
        }

        let mut stream = timeout(CONTROL_TIMEOUT, UnixStream::connect(self.socket.as_path()))
            .await
            .map_err(|_| {
                ApiError::unavailable("control_timeout", "AVIAN control connection timed out")
            })?
            .map_err(|error| {
                ApiError::unavailable(
                    "control_unavailable",
                    format!("AVIAN control socket unavailable ({})", error.kind()),
                )
            })?;
        timeout(CONTROL_TIMEOUT, stream.write_all(&encoded))
            .await
            .map_err(|_| ApiError::unavailable("control_timeout", "AVIAN control write timed out"))?
            .map_err(|error| {
                ApiError::unavailable(
                    "control_write_failed",
                    format!("control write failed ({})", error.kind()),
                )
            })?;
        stream.shutdown().await.map_err(|error| {
            ApiError::unavailable(
                "control_write_failed",
                format!("control shutdown failed ({})", error.kind()),
            )
        })?;

        let mut encoded_response = Vec::new();
        timeout(
            CONTROL_TIMEOUT,
            (&mut stream)
                .take(self.max_message_bytes.saturating_add(1) as u64)
                .read_to_end(&mut encoded_response),
        )
        .await
        .map_err(|_| ApiError::unavailable("control_timeout", "AVIAN control response timed out"))?
        .map_err(|error| {
            ApiError::unavailable(
                "control_read_failed",
                format!("control read failed ({})", error.kind()),
            )
        })?;
        if encoded_response.len() > self.max_message_bytes {
            return Err(ApiError::unavailable(
                "control_response_too_large",
                "AVIAN control response exceeded the local limit",
            ));
        }
        let envelope: Value = serde_json::from_slice(&encoded_response).map_err(|_| {
            ApiError::unavailable("invalid_control_response", "AVIAN returned invalid JSON")
        })?;
        if envelope.get("protocol_version").and_then(Value::as_u64)
            != Some(u64::from(LOCAL_PROTOCOL_VERSION))
        {
            return Err(ApiError::unavailable(
                "invalid_control_response",
                "AVIAN returned an unsupported protocol version",
            ));
        }
        envelope.get("body").cloned().ok_or_else(|| {
            ApiError::unavailable("invalid_control_response", "AVIAN response body is missing")
        })
    }
}

fn control_error(body: Value) -> ApiError {
    let detail = body
        .get("detail")
        .and_then(Value::as_str)
        .map(sanitize_message)
        .unwrap_or_else(|| "AVIAN returned an unexpected response".to_owned());
    ApiError::unavailable("control_request_failed", detail)
}

async fn read_journal(path: &Path, lines: usize) -> Result<Vec<LogEntry>, ApiError> {
    let line_count = lines.to_string();
    let mut child = Command::new(path)
        .args([
            "--no-pager",
            "--output=json",
            "--reverse",
            "--unit=avian-mesh-agent.service",
            "--unit=avian-link-monitor.service",
            "--lines",
            &line_count,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            ApiError::unavailable(
                "journal_unavailable",
                format!("journal unavailable ({})", error.kind()),
            )
        })?;
    let mut stdout = child.stdout.take().ok_or_else(|| {
        ApiError::unavailable("journal_unavailable", "journal output unavailable")
    })?;
    let mut encoded = Vec::new();
    let read_result = timeout(
        JOURNAL_TIMEOUT,
        (&mut stdout)
            .take(MAX_LOG_BYTES.saturating_add(1) as u64)
            .read_to_end(&mut encoded),
    )
    .await;
    match read_result {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => {
            let _ = child.kill().await;
            return Err(ApiError::unavailable(
                "journal_read_failed",
                format!("journal read failed ({})", error.kind()),
            ));
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(ApiError::unavailable(
                "journal_timeout",
                "journal query timed out",
            ));
        }
    }
    if encoded.len() > MAX_LOG_BYTES {
        let _ = child.kill().await;
        return Err(ApiError::unavailable(
            "journal_response_too_large",
            "journal output exceeded the local limit",
        ));
    }
    let status = timeout(JOURNAL_TIMEOUT, child.wait())
        .await
        .map_err(|_| ApiError::unavailable("journal_timeout", "journal query did not exit"))?
        .map_err(|error| {
            ApiError::unavailable(
                "journal_wait_failed",
                format!("journal wait failed ({})", error.kind()),
            )
        })?;
    if !status.success() {
        return Err(ApiError::unavailable(
            "journal_query_failed",
            "journal query returned a failure status",
        ));
    }
    Ok(parse_journal(&encoded, lines))
}

fn parse_journal(encoded: &[u8], limit: usize) -> Vec<LogEntry> {
    encoded
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .take(limit)
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .filter_map(|entry| {
            let message = entry.get("MESSAGE")?.as_str()?;
            let timestamp_ms = entry
                .get("__REALTIME_TIMESTAMP")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or_default()
                / 1_000;
            let priority = entry
                .get("PRIORITY")
                .and_then(Value::as_str)
                .and_then(|value| value.parse::<u8>().ok())
                .unwrap_or(6);
            let unit = entry
                .get("_SYSTEMD_UNIT")
                .and_then(Value::as_str)
                .unwrap_or("avian")
                .trim_end_matches(".service");
            Some(LogEntry {
                timestamp_ms,
                unit: sanitize_message(unit),
                priority,
                message: sanitize_message(message),
            })
        })
        .collect()
}

fn sanitize_message(value: &str) -> String {
    let lowercase = value.to_ascii_lowercase();
    if [
        "password",
        "passwd",
        "authorization",
        "cookie",
        "secret",
        "token",
        "api_key",
        "api-key",
        "apikey",
        "access_key",
        "access-key",
        "accesskey",
        "credential",
        "bearer",
        "private key",
        "private_key",
        "private-key",
    ]
    .iter()
    .any(|marker| lowercase.contains(marker))
    {
        return "[redacted potentially sensitive log entry]".to_owned();
    }
    if lowercase.contains("data:image/") || lowercase.contains("/9j/") {
        return "[redacted image data]".to_owned();
    }
    let has_image_extension = [
        ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp", ".dng", ".raw",
    ]
    .iter()
    .any(|extension| lowercase.contains(extension));
    if lowercase.contains("/imagery/")
        || lowercase.contains("\\imagery\\")
        || (has_image_extension && (lowercase.contains('/') || lowercase.contains('\\')))
    {
        return "[redacted imagery path]".to_owned();
    }
    value
        .chars()
        .filter(|character| !character.is_control() || *character == '\t')
        .take(MAX_LOG_MESSAGE_CHARS)
        .collect()
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn default_record_limit() -> u16 {
    20
}

fn default_log_lines() -> usize {
    80
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use tokio::net::UnixListener;

    #[test]
    fn logs_are_bounded_and_sensitive_values_are_redacted() {
        assert_eq!(
            sanitize_message("request password=hunter2"),
            "[redacted potentially sensitive log entry]"
        );
        assert_eq!(
            sanitize_message("saved /home/rolex/imagery/pi/image.jpg"),
            "[redacted imagery path]"
        );
        for message in [
            "api_key=abc",
            "Authorization: Bearer abc",
            "credential value",
            r"saved C:\\field\\capture.jpeg",
            "saved /field/capture.png",
            "data:image/jpeg;base64,/9j/abc",
        ] {
            assert!(sanitize_message(message).starts_with("[redacted"));
        }
        assert_eq!(
            sanitize_message(&"x".repeat(1_000)).len(),
            MAX_LOG_MESSAGE_CHARS
        );
    }

    #[test]
    fn journal_json_is_normalized_without_unknown_fields() {
        let encoded = br#"{"MESSAGE":"peer recovered","PRIORITY":"5","__REALTIME_TIMESTAMP":"2000000","_SYSTEMD_UNIT":"avian-mesh-agent.service","EXTRA":"ignored"}
"#;
        assert_eq!(
            parse_journal(encoded, 10),
            vec![LogEntry {
                timestamp_ms: 2_000,
                unit: "avian-mesh-agent".into(),
                priority: 5,
                message: "peer recovered".into(),
            }]
        );
    }

    #[test]
    fn record_classes_are_read_only_and_do_not_expose_commands() {
        for class in ["acknowledgement", "bulk"] {
            assert!(is_allowed_record_class(class));
        }
        for class in [
            "emergency",
            "command",
            "mission",
            "telemetry",
            "../telemetry",
            "",
        ] {
            assert!(!is_allowed_record_class(class));
        }
    }

    #[test]
    fn aircraft_projection_keeps_latest_valid_snapshot_per_source() {
        let records: Vec<TelemetryRecordInput> = serde_json::from_value(json!([
            {
                "record_id": "telemetry/mel-stardog",
                "record": {
                    "source": "mel-stardog",
                    "published_at_ms": 2_000,
                    "expires_at_ms": 4_000,
                    "payload": {
                        "kind": "telemetry",
                        "value": {
                            "source": "mel-stardog",
                            "timestamp_ms": 1_950,
                            "latitude_deg": 27.9506,
                            "longitude_deg": -82.4572,
                            "altitude": {"msl_m": 120.0, "agl_m": 42.0, "above_launch_m": 40.0},
                            "velocity_ned_mps": [10.0, 2.0, -1.0],
                            "attitude_rpy_deg": [1.0, 2.0, 90.0],
                            "battery_remaining": 0.75,
                            "control_link_quality": 0.8,
                            "armed": true,
                            "landed": false,
                            "failsafe": false
                        }
                    }
                }
            },
            {
                "record_id": "telemetry/mel-stardog-old",
                "record": {
                    "source": "mel-stardog",
                    "published_at_ms": 1_000,
                    "expires_at_ms": 3_000,
                    "payload": {
                        "kind": "telemetry",
                        "value": {
                            "source": "mel-stardog",
                            "timestamp_ms": 950,
                            "latitude_deg": 0.0,
                            "longitude_deg": 0.0,
                            "altitude": {"msl_m": 1.0, "agl_m": null, "above_launch_m": 0.0},
                            "velocity_ned_mps": [0.0, 0.0, 0.0],
                            "attitude_rpy_deg": [0.0, 0.0, 0.0],
                            "battery_remaining": null,
                            "control_link_quality": null,
                            "armed": false,
                            "landed": true,
                            "failsafe": false
                        }
                    }
                }
            }
        ]))
        .unwrap();
        let projected = project_aircraft_records(records);
        assert_eq!(projected.len(), 1);
        assert_eq!(projected[0].source, "mel-stardog");
        assert_eq!(projected[0].observed_at_ms, 1_950);
        assert_eq!(projected[0].synchronized_at_ms, 2_000);
        assert!(projected[0].position_available);
        assert_eq!(projected[0].battery_remaining, Some(0.75));
        assert!(projected[0].armed);
    }

    #[test]
    fn aircraft_projection_marks_zero_position_unavailable() {
        let records: Vec<TelemetryRecordInput> = serde_json::from_value(json!([{
            "record": {
                "source": "mel-stardog",
                "published_at_ms": 2_000,
                "expires_at_ms": 4_000,
                "payload": {
                    "kind": "telemetry",
                    "value": {
                        "source": "mel-stardog",
                        "timestamp_ms": 1_950,
                        "latitude_deg": 0.0,
                        "longitude_deg": 0.0,
                        "altitude": {"msl_m": 1.0, "agl_m": null, "above_launch_m": 0.0},
                        "velocity_ned_mps": [0.0, 0.0, 0.0],
                        "attitude_rpy_deg": [0.0, 0.0, 0.0],
                        "battery_remaining": null,
                        "control_link_quality": null,
                        "armed": false,
                        "landed": null,
                        "failsafe": false
                    }
                }
            }
        }]))
        .unwrap();

        let projected = project_aircraft_records(records);
        assert_eq!(projected.len(), 1);
        assert!(!projected[0].position_available);
    }

    #[test]
    fn aircraft_projection_rejects_mismatched_or_invalid_telemetry() {
        let record = |source: &str, payload_source: &str, latitude: f64| {
            serde_json::from_value::<TelemetryRecordInput>(json!({
                "record": {
                    "source": source,
                    "published_at_ms": 2_000,
                    "expires_at_ms": 4_000,
                    "payload": {
                        "kind": "telemetry",
                        "value": {
                            "source": payload_source,
                            "timestamp_ms": 1_950,
                            "latitude_deg": latitude,
                            "longitude_deg": -82.0,
                            "altitude": {"msl_m": 120.0, "agl_m": null, "above_launch_m": 40.0},
                            "velocity_ned_mps": [0.0, 0.0, 0.0],
                            "attitude_rpy_deg": [0.0, 0.0, 0.0],
                            "battery_remaining": null,
                            "control_link_quality": null,
                            "armed": false,
                            "landed": null,
                            "failsafe": false
                        }
                    }
                }
            }))
            .unwrap()
        };
        assert!(project_aircraft_records(vec![record("air-a", "air-b", 27.0)]).is_empty());
        assert!(project_aircraft_records(vec![record("air-a", "air-a", 127.0)]).is_empty());
    }

    #[test]
    fn local_request_headers_block_dns_rebinding_and_cross_origin_reads() {
        assert_eq!(
            validate_request_headers(&HeaderMap::new(), "127.0.0.1:4178"),
            Err(StatusCode::MISDIRECTED_REQUEST)
        );
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:4178"));
        assert_eq!(validate_request_headers(&headers, "127.0.0.1:4178"), Ok(()));

        headers.insert(header::HOST, HeaderValue::from_static("attacker.example"));
        assert_eq!(
            validate_request_headers(&headers, "127.0.0.1:4178"),
            Err(StatusCode::MISDIRECTED_REQUEST)
        );

        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:4178"));
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://attacker.example"),
        );
        assert_eq!(
            validate_request_headers(&headers, "127.0.0.1:4178"),
            Err(StatusCode::FORBIDDEN)
        );
        headers.insert(header::ORIGIN, HeaderValue::from_static("null"));
        assert_eq!(
            validate_request_headers(&headers, "127.0.0.1:4178"),
            Err(StatusCode::FORBIDDEN)
        );
        headers.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://127.0.0.1:4178"),
        );
        assert_eq!(validate_request_headers(&headers, "127.0.0.1:4178"), Ok(()));

        let mut ipv6 = HeaderMap::new();
        ipv6.insert(header::HOST, HeaderValue::from_static("[::1]:4178"));
        assert_eq!(validate_request_headers(&ipv6, "[::1]:4178"), Ok(()));
    }

    #[test]
    fn connection_code_is_bounded_strict_and_contains_no_formation_secret() {
        let bundle = json!({
            "schema_version": 1,
            "formation_id": "mission-alpha",
            "aircraft": {
                "name": "aircraft-001",
                "endpoint_id": "a".repeat(64),
                "addresses": [
                    {"underlay": "ethernet", "address": "192.0.2.4:9000"},
                    {"underlay": "satellite", "address": "198.51.100.7:9000"}
                ]
            }
        });
        let code = format!(
            "AVIAN1.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&bundle).unwrap())
        );
        let decoded = decode_connection_code(&code).unwrap();
        assert_eq!(decoded.formation_id, "mission-alpha");
        assert_eq!(decoded.aircraft.name, "aircraft-001");
        assert_eq!(decoded.aircraft.addresses.len(), 2);

        let mut with_secret = bundle;
        with_secret["formation_key"] = json!("must-not-be-accepted");
        let code = format!(
            "AVIAN1.{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&with_secret).unwrap())
        );
        assert!(decode_connection_code(&code).is_err());
        assert!(decode_connection_code(&format!(
            "AVIAN1.{}",
            "a".repeat(MAX_CONNECTION_CODE_CHARS)
        ))
        .is_err());
    }

    #[test]
    fn connection_code_rejects_loopback_and_unknown_underlays() {
        for (underlay, address) in [
            ("ethernet", "127.0.0.1:9000"),
            ("ethernet", "255.255.255.255:9000"),
            ("ethernet", "[::ffff:127.0.0.1]:9000"),
            ("unknown", "192.0.2.4:9000"),
        ] {
            let bundle = json!({
                "schema_version": 1,
                "formation_id": "mission-alpha",
                "aircraft": {
                    "name": "aircraft-001",
                    "endpoint_id": "a".repeat(64),
                    "addresses": [{"underlay": underlay, "address": address}]
                }
            });
            let code = format!(
                "AVIAN1.{}",
                URL_SAFE_NO_PAD.encode(serde_json::to_vec(&bundle).unwrap())
            );
            assert!(decode_connection_code(&code).is_err());
        }
    }

    #[test]
    fn browser_projection_omits_addresses_credentials_payloads_and_images() {
        let input: StatusInput = serde_json::from_value(json!({
            "schema_version": 1,
            "ready": true,
            "node": {"name": "ground", "role": "ground", "endpoint_id": "secret-hash", "started_at_ms": 1, "uptime_ms": 2},
            "peers": [{
                "name": "aircraft", "endpoint_id": "peer-hash",
                "addresses": [{"underlay": "satellite", "address": "10.0.0.9:7777"}],
                "connected": true, "last_transition_at_ms": 3, "selected_underlay": "satellite"
            }],
            "underlays": {"satellite": {"reachable": true, "last_observed_at_ms": 4, "latency_ms": 42.0, "loss_ratio": 0.01, "goodput_bps": 1000, "stability": 0.9, "error": "api_key=hidden"}},
            "mavlink": {"required": true, "connected": true, "target_system_id": 1, "last_message_at_ms": 5, "last_error": "token=hidden"},
            "telemetry": {"published": 1, "last_published_at_ms": 5, "last_error": null},
            "payload": {"accepted": 2, "rejected": 0, "last_event_at_ms": 5, "last_error": "/field/secret.jpg"},
            "commands": {"mode": "disabled", "accepted": 0, "rejected": 0, "last_command_at_ms": null, "last_result": null},
            "radio": {"required": true, "fresh": true, "api_healthy": true, "max_age_ms": 5000, "last_observation_at_ms": 5, "devices": [{"name":"radio","model":"x","firmware":"y","api_fresh":true,"neighbors":1,"error":"credential=hidden"}], "degradation_reasons": []},
            "last_errors": [{"component": "payload", "detail": "saved /field/image.jpeg", "at_ms": 6}]
        })).unwrap();
        let encoded = serde_json::to_string(&project_status(input).unwrap()).unwrap();
        for forbidden in [
            "10.0.0.9",
            "secret-hash",
            "peer-hash",
            "api_key",
            "token=",
            "credential=",
            "/field/",
            "devices",
            "commands",
            "telemetry",
            "endpoint_id",
            "addresses",
        ] {
            assert!(
                !encoded.contains(forbidden),
                "leaked {forbidden}: {encoded}"
            );
        }
        assert!(encoded.contains("[redacted imagery path]"));

        let records: Vec<RecordInput> = serde_json::from_value(json!([{
            "record_id": "record-hash",
            "record": {"published_at_ms": 7, "source": "source-hash", "payload": {"jpeg": "/9j/secret", "path": "/field/image.jpg"}}
        }])).unwrap();
        let encoded = serde_json::to_string(&project_records(records, 20)).unwrap();
        for forbidden in ["record-hash", "source-hash", "payload", "/9j/", "/field/"] {
            assert!(
                !encoded.contains(forbidden),
                "leaked {forbidden}: {encoded}"
            );
        }
        assert_eq!(encoded, r#"[{"published_at_ms":7}]"#);
    }

    #[tokio::test]
    async fn control_client_uses_versioned_read_only_status_request() {
        let directory = tempdir().unwrap();
        let socket = directory.path().join("control.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).await.unwrap();
            let request: Value = serde_json::from_slice(&request).unwrap();
            assert_eq!(request["protocol_version"], 1);
            assert_eq!(request["body"]["type"], "status");
            assert_eq!(request["body"]["require_ready"], false);
            stream
                .write_all(
                    br#"{"protocol_version":1,"body":{"type":"status","status":{"ready":true}}}"#,
                )
                .await
                .unwrap();
        });
        let client = AvianClient {
            socket: Arc::new(socket),
            max_message_bytes: 4_096,
        };
        let response = client
            .request(json!({ "type": "status", "require_ready": false }))
            .await
            .unwrap();
        assert_eq!(response["status"]["ready"], true);
        server.await.unwrap();
    }
}
