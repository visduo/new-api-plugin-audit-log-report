---
locale: zh-CN
---
# 请求审计

> **隐私风险提示**
>
> 本插件会把请求正文、请求元数据，以及可选的模型响应写入 VictoriaLogs，其中可能包含个人信息、商业秘密、密钥或其他敏感内容。它不是默认应启用的插件，非必要不要启用。
>
> 启用前，请确认你具有合法处理这些数据的依据，并以清晰、可理解的方式告知客户或用户：记录哪些内容、为什么记录、保存多久、谁可以访问，以及如何删除。建议只记录最小必要字段，优先使用“仅元数据”，限制访问权限和保留期，并对敏感内容脱敏。
>
> 本插件仅建议用于以下正当目的：
>
> - 安全事件调查、滥用和欺诈检测
> - 计费争议核对和用量审计
> - 经客户授权的故障排查
> - 法律法规要求的合规审计
> - 去标识化后的容量和质量分析
>
> 不得用于与上述目的无关的用户画像、营销分析、出售或共享数据，或超出授权范围的监控。因启用、配置、访问控制、保留策略或数据使用不当产生的隐私、合规和安全后果，由部署者和运营者自行承担。

将客户端请求正文、请求元数据和可选的客户端最终响应写入 VictoriaLogs，用于审计和问题排查。插件不会记录请求头、客户端 IP 或上传文件的字节。

这是一个请求处理插件，不属于渠道，也不需要厂商账号、API Key 或渠道类型。它在 `report` 阶段运行：此时客户端已经收到响应，消费/错误日志也已写入，因此写入 VictoriaLogs 失败不会影响请求本身。

默认记录请求正文和响应元数据；需要模型回答时，把“响应数据”改为“正文和元数据”。

## 工作方式

- 每个请求完成后写入一条 JSON line。
- 请求正文放在 `_msg`，响应正文放在 `response_body`，两者都可截断。
- 写入在请求路径之外执行，不阻塞客户端，也不保证 100% 不丢。

## VictoriaLogs 部署

单节点 VictoriaLogs 就足够。将以下内容保存为 `docker-compose.yml`：

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

`api_shared_net` 必须是 new-api 容器已经加入的 Docker 网络。网络名不同时，请同时修改这里和插件里的写入地址。创建数据目录并启动：

```bash
mkdir -p /www/dk_project/dk_app/victorialogs/data
docker compose up -d
```

new-api 与 VictoriaLogs 在同一 Docker 网络时，插件写入地址填 `http://victorialogs:9428/insert/jsonline`；new-api 直接跑在宿主机上时，填 `http://127.0.0.1:9428/insert/jsonline`。

### 反向代理

只需把只读查询接口 `/select/` 暴露给管理员，不要暴露 `/insert/`：

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

`proxy_pass` 不要带尾斜杠，否则 `/select/...` 会被改写。`proxy_buffering off` 用于保持 live tail 实时输出。如果宝塔自动生成了带尾斜杠的 `proxy_pass`，手动删掉即可。

审计内容可能包含 prompt 和模型回答，务必在宝塔站点设置中开启 HTTPS，并添加访问认证或 IP 白名单。后台地址是 `https://你的域名/select/vmui/`。不要反代 `/insert/`，写入只给网关使用。

## 安装

1. 从社区市场安装，或在插件页上传 `plugin.js` 并打开插件开关。
2. 在“请求插件”里新建一个实例。
3. 把“写入地址”填成 VictoriaLogs 的 JSON line 接口：new-api 和 VictoriaLogs 在同一个 Docker 网络时用 `http://victorialogs:9428/insert/jsonline`，new-api 跑在宿主机上时用 `http://127.0.0.1:9428/insert/jsonline`。
4. 把“站点标识”填成这个网关的短名称，例如 `beijing` 或客户名称；每条记录的 `site` 字段都会带上它。
5. 如果 VictoriaLogs 前面没有需要鉴权的反向代理，“Bearer 令牌”留空。
6. 需要记录模型回答时，把“响应数据”改为“正文和元数据”；默认“仅元数据”只记录状态和字节数，不记录正文。
7. 按需设为全局、按分组或绑定到渠道。没有分组和渠道限制的实例会对所有请求生效。

插件不影响任务渠道或供应商渠道的选择，也不能绑定到任务插件（61）渠道。

## 写入字段

每个请求写入一条 JSON 到 VictoriaLogs 的 `/insert/jsonline`。请求正文放在 `_msg`，在 Web UI 里可以直接全文搜索；其余字段也会被索引。VictoriaLogs 会把嵌套对象展开为点号字段，例如 `user.username` 和 `status.status`。

| 字段 | 含义 |
| --- | --- |
| `_time` | 请求开始时间，RFC 3339 |
| `_msg` | 请求正文，按“请求正文最大字节数”截断 |
| `site` | 配置的站点标识 |
| `request_id` | New API 请求 ID |
| `user.id`、`user.username` | 发起请求的用户 |
| `token.id`、`token.name` | 请求使用的 API 令牌 |
| `group`、`model`、`upstream_model` | 用户分组和模型名 |
| `path`、`format` | 客户端路径和协议 |
| `channel.id`、`channel.type`、`attempt` | 产生响应的渠道和尝试次数 |
| `status.status`、`task.status` | 响应状态或任务最终状态；选择“不发送”时没有 |
| `usage.promptTokens`、`usage.completionTokens` | 输入和输出 Token 数 |
| `cost_quota`、`cost_usd` | 本次请求结算的费用 |
| `duration_ms`、`first_response_ms` | 请求耗时 |
| `error.status`、`error.code`、`error.message` | 客户端收到的错误 |
| `request_plugins` | 其他请求插件的处理记录，JSON 字符串 |
| `body_bytes`、`body_sha256` | 完整请求正文的 UTF-8 长度和 SHA-256 |
| `truncated` | 存储的正文是否被截断 |
| `response_body` | 客户端最终响应，JSON 字符串；选择“正文和元数据”时存在 |
| `response_kind` | `body`、`events` 或 `task_result` |
| `response_bytes`、`response_sha256` | 完整响应的 UTF-8 长度和 SHA-256 |
| `response_truncated` | 存储的响应是否被截断 |
| `response_omitted` | 响应没有可读正文，或因写入上限被丢弃；仅“正文和元数据”时存在 |

插件不会记录响应头、请求头、客户端 IP 或上传文件的字节。内联图片以 `[media:N]` 占位符表示；表单、音频和二进制请求不是 JSON，因此 `_msg` 为空。

选择“正文和元数据”后，`response_body` 是 JSON 字符串，而不是嵌套对象。VictoriaLogs 仍会按文本索引它，所以可以直接搜索 `response_body:"退款"`。非流式 JSON 响应保留原结构；流式响应保存客户端最终收到的事件，并去掉 `[DONE]` 和注释；任务保存结果 URL 和文本；图片、音频等二进制响应没有可读正文，会设置 `response_omitted`。响应正文为 `null` 时，存成字符串 `null`。

记录的是协议转换后、并经过 `reply` 检查的客户端最终响应。如果 Secret Guard 遮盖了密钥，保存下来的是 `***`，不是原文。

## 配置

| 设置 | 默认值 | 含义 |
| --- | --- | --- |
| 写入地址 | 无 | VictoriaLogs JSON line 接口，必填 |
| 站点标识 | 空 | 写入每条记录的短标识；只允许字母、数字、点、下划线和连字符 |
| Bearer 令牌 | 空 | 非空时作为 `Authorization: Bearer` 请求头发送 |
| 请求正文最大字节数 | 65536 | 超出时在 UTF-8 字符边界截断，并标记 `truncated` |
| 包含请求正文 | 开 | 关闭后只存元数据和正文哈希 |
| 响应数据 | 仅元数据 | “不发送”不记录响应；“仅元数据”记录状态和字节数；“正文和元数据”还记录正文 |
| 响应正文最大字节数 | 65536 | 超出时在 UTF-8 字符边界截断，并标记 `response_truncated` |

上限按 UTF-8 字节计算，不是 JavaScript 字符数。正文被截断时，`body_bytes` 仍是完整长度，`body_sha256` 仍是完整正文的 SHA-256，方便审计比对。响应上限同理，使用 `response_bytes` 和 `response_sha256`。

整条记录超过 1 MiB 写入上限时，插件先丢弃响应正文，再丢弃请求正文，并分别标记 `response_omitted` 或 `body_omitted`。

## 运行行为

- 每个请求完成后运行一次；任务在进入最终状态时运行一次。
- 写入失败、队列满或网关重启都可能丢记录，但不会影响客户端请求的成败或延迟。插件声明了 `optional: true`，因此插件报错也不会阻止请求。
- 请求正文不是 JSON 时仍会记录，只是 `_msg` 为空。
- 即使请求没有到达任何渠道，也会记录用户、模型、路径和错误，只是没有渠道信息。
- 选择“正文和元数据”时，流式回答保存客户端最终收到的事件，不保存原始 SSE 字节。
- 非流式响应超过网关 1 MiB 捕获上限时没有正文；记录会设置 `response_omitted`，状态仍保留。

## 已知限制

- 网关最多保留 256 条待上报记录和 64 MiB 数据，超过任一上限就丢弃。
- 单次写入最多 1 MiB；超过时先丢响应正文，再丢请求正文，并标记 `response_omitted` 或 `body_omitted`。
- 一次 `report` 最多发起 4 次请求，单次 15 秒、总计 30 秒；本插件每条记录只发 1 次。
- 一次 `report` 的 JavaScript 最长运行 5 秒；写入地址太慢会超时并丢记录。
- `report` 钩子读不到请求头、客户端 IP 和上传文件的字节。
- 任务的请求正文超过 64 KiB 时插件拿不到，`_msg` 为空。
- 响应正文超过网关 1 MiB 捕获上限时插件拿不到，即使选择“正文和元数据”也没有 `response_body`。
