# AVIAN Ground UI

A lightweight, read-only field dashboard for AVIAN ground devices. It surfaces
live agent readiness, mesh peers, selected underlays, MAVLink freshness, radio
health, payload synchronization, warnings, and bounded sanitized service logs.
Status refreshes every 10 seconds, while the heavier log and record feeds
refresh every 30 seconds; background tabs pause polling and manual refresh is
always available. Active warnings expand in place, and the bounded 200-entry
event view supports search, severity/service filters, ordering, and pagination.

![AVIAN ground network preview](public/avian-ground-preview.png)

## Safety boundary

- The HTTP listener is hard-limited to loopback addresses.
- Every request must use the exact configured loopback `Host`; browser `Origin`
  headers, when present, must match that same HTTP origin. This blocks DNS
  rebinding and cross-origin reads of the local service.
- The API contains only health, status, record-listing, and fixed AVIAN journal
  queries. There is no emergency-command or mutation route.
- Status is parsed and projected into a fixed display schema. Peer addresses,
  endpoint identifiers, command state, raw radio-device details, and source
  error strings never cross the browser boundary.
- Only bulk and acknowledgement records can be queried. Responses contain only
  publication timestamps; record IDs, sources, payloads, paths, and image bytes
  are discarded by the bridge.
- AVIAN control messages, responses, journal bytes, log lines, record limits,
  concurrent browser fetches, and timeouts are bounded.
- The journal command is invoked directly with fixed units and arguments; no
  shell or caller-supplied command text is used.
- Credential markers, authorization/bearer values, imagery paths, and JPEG data
  are defensively redacted from normalized status errors and journal messages.
- Missing or stale sources appear as offline/degraded and are never replaced by
  sample values.
- The dashboard is a separate process and failure domain from `mesh-agent`.

The bridge runs as the existing `avian` service user because AVIAN's command-
capable control socket is intentionally owner-only. The bridge code exposes no
command request, but the process remains trusted ground software and is kept on
loopback with a restrictive systemd sandbox.

## Architecture

```text
Browser on ground device
        │ HTTP 127.0.0.1:4178 (read only)
        ▼
avian-ground-ui (Rust)
        ├── /run/avian/control.sock  status + record listing only
        ├── journalctl               fixed AVIAN units, bounded + sanitized
        └── ground-dist/             exported React dashboard
```

The Sites/vinext project under `app/` produces both the development preview and
the static bundle used by the local Rust service. The operational page is local
only because a hosted page cannot safely or reliably access a device-local Unix
socket.

## Development

Requirements:

- Node.js 22.13 or newer
- Rust 1.91.1 or newer

```sh
npm ci
npm run lint
npm test
cargo fmt --all --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --locked
```

`npm test` performs the vinext build, exports `ground-dist/`, rejects source or
development-only paths in the rendered HTML, and checks the rendered shell.
The `rolldown` override is intentionally pinned to 1.2.4 because the 1.2.5
package references two unpublished native bindings and breaks clean Linux
`npm ci`; remove the override only after the upstream package is complete.

Run the operational server locally:

```sh
npm run export:ground
cargo run --locked -- --assets ground-dist --control-socket /run/avian/control.sock
```

Open [http://127.0.0.1:4178/](http://127.0.0.1:4178/).

## Remote operator access

Keep the service on loopback and use an SSH tunnel when the browser runs on a
separate operator laptop:

```sh
ssh -N -L 4178:127.0.0.1:4178 operator@ground-device
```

Then open [http://127.0.0.1:4178/](http://127.0.0.1:4178/) on the laptop. The
dashboard and AVIAN services continue running if the laptop link is removed,
but an SSH tunnel cannot migrate between Ethernet, Wi-Fi, and overlay paths;
reconnect it through a currently reachable device address. The UI is not a
ground-device network dependency and its loss does not stop mesh operation.

`jq` is not required. Operators may install it for interactive shell filtering,
but the service, installer, checks, and runbooks rely only on their declared
Rust, Node.js, system, and Python tooling.

## Linux installation

Install AVIAN first, then:

```sh
sudo ./deploy/install.sh --enable
```

For a Pi without Node/Rust build tooling, build elsewhere and supply
`--bin-dir` and `--assets-dir`. The installer creates no network exposure and
preserves AVIAN, stardogOS, MAVLink, radio, RFD900, GPS Guard, and video paths.

Useful checks:

```sh
systemctl status avian-ground-ui.service
curl --fail http://127.0.0.1:4178/api/v1/health
journalctl -u avian-ground-ui.service --since today
```

## API

| Route | Purpose | Bounds |
| --- | --- | --- |
| `GET /api/v1/health` | Bridge health and read-only declaration | Fixed response |
| `GET /api/v1/status` | Fixed, display-only AVIAN status projection | schema v1, 3 s / 1 MiB |
| `GET /api/v1/records?class=bulk&limit=20` | Publication timestamps only | bulk/ack allowlist, 1–100 |
| `GET /api/v1/logs?lines=80` | AVIAN mesh/link service journal | fixed units, 1–200 lines / 1 MiB |

All API responses are non-cacheable and carry restrictive browser security
headers. Static assets are served from the same origin. Requests with any other
authority receive HTTP 421; requests with a foreign origin receive HTTP 403.
