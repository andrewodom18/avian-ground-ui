# Security policy

## Invariants

- The server must refuse non-loopback bind addresses.
- The server must reject any `Host` other than its exact configured loopback
  authority and any present `Origin` other than that same HTTP origin.
- No HTTP route may issue an AVIAN emergency command or mutate AVIAN, MAVLink,
  radios, Starshield, cameras, GPS Guard, RFD900, or video services.
- Only bulk and acknowledgement record classes may reach AVIAN, and returned
  records must be projected to publication timestamps before reaching HTTP.
- Status must be parsed as schema v1 and projected to the explicit dashboard
  DTO; raw control-socket JSON must never be returned.
- Journal queries must use fixed service units without a shell.
- Control and journal reads must remain time- and size-bounded.
- Credentials, API/access keys, authorization/bearer values, cookies,
  secret/token values, imagery paths, and JPEG bytes must not appear in API
  responses or logs.
- Offline and stale data must be visible and must not be replaced by fixtures.

## Reporting

Report security issues privately to the repository owner. Do not include live
formation keys, radio credentials, Starshield credentials, imagery, or field
locations in a report.

The project is pre-1.0. Security fixes are applied to the active `dev` branch
and released to `main` only through the operator's explicit branch workflow.
