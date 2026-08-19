# AVIAN Ground UI

A lightweight, read-only field dashboard for AVIAN ground devices. The UI is
kept outside the flight-critical agent and will surface live status, peers,
underlay health, payload activity, warnings, and sanitized service logs.

The `main` branch contains the initial visual foundation. Active implementation
is developed on `dev` in accordance with the repository workflow.

## Safety boundary

- observational routes only;
- no emergency command or radio/terminal mutation controls;
- loopback listener by default;
- bounded AVIAN control requests and fixed journal queries;
- stale or unavailable data is shown explicitly and is never fabricated.

## Frontend development

Node.js 22.13 or newer is required.

```sh
npm install
npm run dev
npm test
```

The operational bridge and systemd installation are implemented on `dev`.
