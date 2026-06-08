# ADR 0004 — Retire LAN hub self-healing; cloud healthcheck + LB topology

Status: Accepted (SCP-149)
Relates to: SCP-146 (fan-out bus), SCP-148 (topic isolation), SCP-126, ADR 0003 (multi-tenant auth)

## Context

The local-first `scope serve` hub (`src/hub.js`) self-heals on a single
machine. It assumes every node is a peer on one host, with no load balancer and
no shared backing store. That assumption is wrong in the cloud, where N
stateless Node nodes sit behind a load balancer over a shared Postgres log.

## Decision

In the **hosted** deployment we retire single-host self-healing and move
liveness to the load balancer + a `/healthz` endpoint. The local CLI hub keeps
`hub.js` unchanged — this ADR scopes the cloud path only.

### What `hub.js` does, and what replaces it in the cloud

| `hub.js` mechanism | Purpose on LAN | Cloud replacement |
| --- | --- | --- |
| Port-race binding (`ensureHub` walks `DEFAULT_HUB_PORT..+RANGE`, handles `EADDRINUSE`) | Let many sibling processes converge on one hub on one host | Each node binds one fixed port (`$PORT`); the LB fans traffic across nodes. No racing — nodes are independent replicas. |
| `probeHub` / `findRunningHub` port scan | Discover an already-running hub | Service discovery is the LB + DNS / service mesh. Nodes never discover each other; they coordinate only through the shared Postgres log + the fan-out bus. |
| Bonjour / mDNS discovery file (`~/.scope-hub/hub.json`) | Zero-config LAN discovery | Not applicable. Clients hit a stable hosted URL; auth (ADR 0003) identifies the tenant. |
| `startHubWatchdog` (re-elects a hub when the owner dies) | Survive the hub process exiting on a shared host | The LB healthchecks `/healthz`, drains failed nodes, and the orchestrator (k8s / ECS) restarts them. Re-election is replaced by stateless horizontal scaling. |
| `installShutdownHandlers` clearing the discovery file | Avoid probing a dead port | Graceful drain: node fails `/healthz` (or returns 503 on `SIGTERM`), LB stops routing, in-flight SSE connections close, client reconnects (`retry: 2000`) and lands on a healthy node. |

### `/healthz` contract (`src/realtime/healthz.js`)

A node is **healthy (200)** only when BOTH hold:

1. **Postgres reachable** — `SELECT 1` round-trips within a bounded timeout. A
   hung DB reads as unhealthy, never as a hung healthcheck.
2. **LISTEN connection live** — the node's dedicated `LISTEN` client
   (`bus.listening()`, SCP-146) is connected. A node whose LISTEN dropped still
   serves REST/SSE but **silently stops fanning out other nodes' writes** to its
   SSE clients. That is the dangerous failure mode the watchdog used to catch on
   LAN; in the cloud the LB must pull such a node from rotation. Returns **503**
   with `{ status, checks: { db, listen } }` otherwise.

## Load balancer requirements for long-lived SSE

The `/events` stream (SCP-148) is a long-lived `text/event-stream`. The LB must:

- **No response buffering.** Stream bytes through immediately — buffering breaks
  SSE. (The handler already sets `X-Accel-Buffering: no` for nginx; the LB must
  honor the equivalent.)
- **Idle/read timeout > keepalive interval.** The stream emits a `: keepalive`
  comment every 20s; the LB idle timeout must exceed that (≥ 60s recommended) or
  it will sever healthy streams.
- **No sticky sessions required.** Fan-out goes through the bus, so any node can
  serve any tenant's SSE connection. Clients may reconnect to a different node
  freely; the SSE `hello` frame re-seeds the cursor (SCP-148) and the client
  pulls anything missed. Avoid stickiness so draining is clean.
- **Graceful drain on deploy/scale-down.** On `SIGTERM`, fail `/healthz` and let
  open streams close; clients auto-reconnect via the `retry:` directive.
- **HTTP/1.1 (or h2) with chunked transfer**, request timeout disabled for the
  SSE route specifically.

## Consequences

- Cloud nodes are stateless and independently restartable; capacity is a
  horizontal-scale + quota concern (SCP-150 / SCP-127), not a self-heal one.
- `hub.js` stays the local-only path; nothing in the cloud path imports it.
- Correctness now depends on the LB honoring the SSE requirements above — these
  are deployment config, captured here so they aren't rediscovered in an outage.
