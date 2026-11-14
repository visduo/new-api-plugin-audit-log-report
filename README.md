---
translations:
  zh-CN: README.zh-CN.md
---
# Audit Report

> **Privacy warning**
>
> This plugin writes request bodies, request metadata and, optionally, model responses to VictoriaLogs. Those records can contain personal data, trade secrets, credentials or other sensitive information. It is not a plugin to enable by default; do not enable it unless necessary.
>
> Before enabling it, make sure you have a lawful basis for processing the data, and tell your customers or users clearly what is recorded, why, how long it is kept, who can access it and how it is deleted. Record only the minimum data you need, prefer **Metadata only**, restrict access and retention, and redact sensitive content.
>
> Appropriate uses are limited to:
>
> - security incident investigation, abuse detection and fraud detection
> - billing dispute review and usage auditing
> - customer-authorized troubleshooting
> - compliance audits required by law
> - de-identified capacity and quality analysis
>
> Do not use it for unrelated profiling, marketing analysis, selling or sharing data, or monitoring beyond the authorized scope. The deployer and operator are responsible for any privacy, compliance or security consequences of enabling it or of its configuration, access control, retention or data use.

Writes the client request body, request metadata and, optionally, the client-visible response to VictoriaLogs for auditing and troubleshooting. The plugin does not record request headers, the client IP or the bytes of uploaded files.

This is a request processing plugin. It is not a channel and needs no vendor account, API key or channel type. It runs at the `report` stage, after the client has the response and the consume or error log is written. An ingest failure therefore never changes the request.

By default the plugin records the request body and response metadata. Set **Response data** to **Body and metadata** to include the model answer.

## How it works

- It writes one JSON line per finished request.
- The request body goes to `_msg`; the response body goes to `response_body`. Both can be truncated.
- Ingest runs off the request path. It does not delay the client and is not guaranteed to be lossless.

## VictoriaLogs deployment

A single-node container is enough. Save this as `docker-compose.yml`:

```yaml
services:
  victorialogs:
    image: victoriametrics/victoria-logs:latest
    container_name: victorialogs
    command:
      - --storageDataPath=/vlogs
      - --retentionPeriod=90d
      - --retention.maxDiskSpaceUsageBytes=50GiB
      - --httpListenAddr=:9428
    ports:
      - "127.0.0.1:9428:9428"
    volumes:
      - /www/dk_project/dk_app/victorialogs/data:/vlogs
    restart: always
    networks:
      - api_shared_net
    healthcheck:
      test: ["CMD", "/victoria-logs-prod", "-healthcheck"]
      interval: 30s
      timeout: 5s
      retries: 3

networks:
  api_shared_net:
    external: true
```

`api_shared_net` must be the Docker network the new-api container has already joined. If your network has another name, change it here and use the same name in the plugin endpoint. Create the data directory and start the container:

```bash
mkdir -p /www/dk_project/dk_app/victorialogs/data
docker compose up -d
```

Use `http://victorialogs:9428/insert/jsonline` when new-api shares the network, or `http://127.0.0.1:9428/insert/jsonline` when new-api runs on the host.

### Reverse proxy

Expose only the read-only `/select/` endpoints to administrators. Do not expose `/insert/`:

```nginx
location /select/ {
    proxy_pass http://127.0.0.1:9428;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    add_header Cache-Control "no-store" always;
}

location / {
    return 404;
}
```

Keep `proxy_pass` without a trailing slash; otherwise `/select/...` is rewritten. `proxy_buffering off` keeps live tail streaming. If the panel generates a `proxy_pass` with a trailing slash, remove it.

Audit records can contain prompts and model answers. Enable HTTPS for the site and add authentication or an IP allowlist. The admin page is `https://your-domain/select/vmui/`. Do not proxy `/insert/`; only the gateway should write.

## Channel setup

1. Install the plugin from the community marketplace, or upload `plugin.js` on the plugin page and switch it on.
2. Add a request plugin instance under **Request plugins**.
3. Set **Ingest URL** to the VictoriaLogs JSON line endpoint: `http://victorialogs:9428/insert/jsonline` when new-api shares the Docker network, or `http://127.0.0.1:9428/insert/jsonline` when it runs on the host.
4. Set **Site** to a short identifier for this gateway, such as `beijing` or a customer name. Every record carries it in the `site` field.
5. Leave **Bearer token** empty unless a reverse proxy in front of VictoriaLogs requires it.
6. Set **Response data** to **Body and metadata** when the audit needs the model answer. The default, **Metadata only**, records status and byte counts but not the body.
7. Bind the instance globally, to the groups to audit, or to the channels that need it. An instance with no groups or channels runs on every request.

The instance does not affect task or provider channel selection and cannot be bound to a Task Plugin (61) channel.

## Stored fields

Each request writes one JSON object to VictoriaLogs at `/insert/jsonline`. The request body is stored in `_msg`, which the web UI searches by default; the other fields are indexed too. VictoriaLogs flattens nested objects into dotted fields such as `user.username` and `status.status`.

| Field | Meaning |
| --- | --- |
| `_time` | Request start time, RFC 3339 |
| `_msg` | Request body, cut at **Maximum request body bytes** |
| `site` | The configured site identifier |
| `request_id` | New API request ID |
| `user.id`, `user.username` | The user who sent the request |
| `token.id`, `token.name` | The API token used for the request |
| `group`, `model`, `upstream_model` | The user group and the model names |
| `path`, `format` | The client path and protocol |
| `channel.id`, `channel.type`, `attempt` | The channel that produced the response and the attempt number |
| `status.status`, `task.status` | The response status or the task's final state; absent with **None** |
| `usage.promptTokens`, `usage.completionTokens` | Input and output token counts |
| `cost_quota`, `cost_usd` | The cost settled for this request |
| `duration_ms`, `first_response_ms` | Request timing |
| `error.status`, `error.code`, `error.message` | The error the client received |
| `request_plugins` | What other request plugins did, as a JSON string |
| `body_bytes`, `body_sha256` | The full request body's UTF-8 length and SHA-256 |
| `truncated` | The stored body was cut |
| `response_body` | The client-visible response, a JSON string; present with **Body and metadata** |
| `response_kind` | `body`, `events` or `task_result` |
| `response_bytes`, `response_sha256` | The full response's UTF-8 length and SHA-256 |
| `response_truncated` | The stored response was cut |
| `response_omitted` | The response had no readable body or was dropped to fit the ingest limit; present with **Body and metadata** |

The plugin does not record response headers, request headers, the client IP or the bytes of uploaded files. Inline images appear as `[media:N]` placeholders. A form, audio or binary request body is not JSON, so its `_msg` is empty.

With **Body and metadata**, `response_body` is a JSON string, not a nested object. VictoriaLogs still indexes it as text, so `response_body:"refund"` searches the response. A non-stream JSON response keeps its JSON shape inside the string. A stream keeps the client-visible events, with `[DONE]` and comments left out. A task keeps its result URLs and texts. A binary response, such as an image or audio file, has no readable body and sets `response_omitted`. An empty response body is stored as the string `null`.

The record holds the client-visible response after protocol conversion and after any `reply` checks. If Secret Guard masks a secret, the stored response contains `***`, not the original text.

## Configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| Ingest URL | none | The VictoriaLogs JSON line endpoint; required |
| Site | empty | A short identifier stored in every record; letters, digits, dot, underscore and hyphen |
| Bearer token | empty | Sent as an `Authorization: Bearer` header when set |
| Maximum request body bytes | 65536 | A longer body is cut at a UTF-8 character boundary and marked `truncated` |
| Include request body | on | Turn off to store metadata and the body hash only |
| Response data | Metadata only | `None` records no response data; `Metadata only` records status and byte counts; `Body and metadata` also records the body |
| Maximum response body bytes | 65536 | A longer response is cut at a UTF-8 character boundary and marked `response_truncated` |

The body limit counts UTF-8 bytes, not JavaScript characters. A body that is cut keeps its full length in `body_bytes` and the SHA-256 of the full body in `body_sha256`, so an auditor can tell two records apart even when the stored text is identical. The response limit works the same way with `response_bytes` and `response_sha256`.

When the whole record would exceed the 1 MiB ingest limit, the plugin drops the response body first, then the request body, and marks the record with `response_omitted` or `body_omitted`.

## Runtime behaviour

- The plugin runs once per finished request; a task runs it once when the task reaches its final state.
- Ingest is best-effort. A failed request, a full queue or a gateway restart can lose a record, but it never fails or delays the client request. The plugin declares `optional: true`, so a plugin error does not stop the request either.
- A request whose body is not JSON is still recorded, with an empty `_msg`.
- A request that never reached a channel still records the user, model, path and error, but has no channel.
- With **Body and metadata**, a streamed answer is stored as its client-visible events, not as raw SSE bytes.
- A non-stream response over the gateway's 1 MiB capture limit has no body; the record sets `response_omitted` and keeps the status.

## Known limits

- The gateway keeps at most 256 finished reports and 64 MiB of their data. Past either limit, a report is dropped.
- One ingest request may carry at most 1 MiB. A record over that limit drops the response body first, then the request body, and marks `response_omitted` or `body_omitted`.
- One `report` call may make 4 fetches, with 15 seconds per fetch and 30 seconds in total. This plugin uses one fetch per record.
- One `report` call runs JavaScript for at most 5 seconds. A slow ingest endpoint can hit that limit and lose the record.
- The `report` hook cannot read the request headers, the client IP, or the bytes of uploaded files.
- A task's request body over 64 KiB is not available to the plugin, so `_msg` is empty for that task.
- A response body over the gateway's 1 MiB capture limit is not available, so `response_body` is absent even with **Body and metadata**.
