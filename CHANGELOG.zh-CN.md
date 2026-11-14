---
changelogVersion: 1
plugin: "visduo_audit-report"
version: "1.1.0"
locale: "zh-CN"
---
# Changelog

## [1.1.0]

### Added

- 增加 VictoriaLogs 的 Docker Compose 部署和 Nginx 只读反向代理说明。
- 在每条记录中写入可配置的站点标识，便于多个网关共用一个 VictoriaLogs。
- “响应数据”选择“正文和元数据”时，将客户端最终响应、流事件或任务结果发送到 VictoriaLogs。
- 保留响应长度和 SHA-256；整条记录超过写入上限时优先丢弃响应正文。
