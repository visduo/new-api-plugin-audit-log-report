---
changelogVersion: 1
plugin: "visduo_audit-report"
version: "1.1.0"
locale: "en"
translations:
  zh-CN: CHANGELOG.zh-CN.md
---
# Changelog

## [1.1.0]

### Added

- Document a Docker Compose deployment and an Nginx read-only reverse proxy for VictoriaLogs.
- Store a configurable site identifier in every record so several gateways can share one VictoriaLogs.
- Send the client-visible response body, stream events or task result to VictoriaLogs when **Response data** is set to **Body and metadata**.
- Store the response length and SHA-256, and drop the response first when a record exceeds the ingest limit.
