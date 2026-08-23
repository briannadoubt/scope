# Local dogfood telemetry

The local dogfood build includes temporary operational logging for calibrating
the agent coordination workflow before release. It is enabled by default for
every CLI invocation and hub request on the machine and writes to
`~/.scope/dogfood/usage.ndjson`. Active agents pick it up on their next Scope
invocation; they do not need environment changes or a restart.

```bash
scope dogfood status
```

Use `scope dogfood enable --log <path>` to choose another local destination.
`SCOPE_DOGFOOD_LOG` remains available as a per-process override.

Every CLI invocation and hub HTTP request appends one schema-versioned NDJSON
record containing only:

- timestamp, CLI/protocol/event-format versions;
- `cli` or `http` surface and command/route-template name;
- success/error outcome, stable error code or HTTP status, and duration;
- a one-way truncated hash of the workspace identifier;
- booleans indicating JSON, request-id, revision, model, or replay usage.

Scope does **not** log arguments, ticket titles or descriptions, comments,
message bodies, agent ids, request paths containing ids, query values, headers,
credentials, response data, or raw filesystem paths. The directory and file
are created with user-only permissions. Logging errors are swallowed so
telemetry cannot break a Scope operation.

Summarize command frequency, failures, average latency, and p95 latency:

```bash
npm run dogfood:report -- "$HOME/.scope/dogfood/usage.ndjson"
npm run dogfood:report -- "$HOME/.scope/dogfood/usage.ndjson" --json
```

For a live view, use `tail -f "$HOME/.scope/dogfood/usage.ndjson"`. To pause
collection without deleting accumulated data, run `scope dogfood disable`.
Run `scope dogfood enable` to resume. At the end of the calibration period,
disable collection, stop the dogfood hub, remove the local NDJSON/config files,
and delete the temporary instrumentation from source before release.
