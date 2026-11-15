const DEFAULT_MAX_BODY_BYTES = 65536;
const MAX_BODY_BYTES = 524288;
const DEFAULT_MAX_RESPONSE_BYTES = 65536;
const MAX_RESPONSE_BYTES = 524288;
const FETCH_BODY_LIMIT = 1048576;

export const meta = {
    apiVersion: 1,
    key: "visduo_audit-log-report",
    name: { en: "Audit Report", zh: "请求审计报告" },
    description: {
        en: "Writes request bodies and optional model responses to VictoriaLogs for auditing",
        zh: "将请求正文和可选的模型响应写入 VictoriaLogs，用于审计",
    },
    version: "1.4.0",
    author: { name: "多栈科技" },
    website: "https://www.echostack.net/",
    optional: true,
    configSchema: {
        type: "object",
        required: ["endpoint"],
        properties: {
            endpoint: {
                type: "string",
                format: "url",
                title: { en: "Ingest URL", zh: "写入地址" },
                description: {
                    en: "VictoriaLogs JSON line endpoint, for example http://127.0.0.1:9428/insert/jsonline",
                    zh: "VictoriaLogs JSON line 接口，例如 http://127.0.0.1:9428/insert/jsonline",
                },
                maxLength: 2048,
            },
            bearerToken: {
                type: "string",
                format: "password",
                title: { en: "Bearer token", zh: "Bearer 令牌" },
                description: {
                    en: "Sent as the Authorization header when not empty",
                    zh: "非空时作为 Authorization 请求头发送",
                },
                default: "",
                maxLength: 4096,
            },
            site: {
                type: "string",
                title: { en: "Site", zh: "站点标识" },
                description: {
                    en: "Stored in every record as site, for example site name",
                    zh: "写入每条记录的 site 字段，例如站点名称",
                },
                default: "",
                maxLength: 128,
                pattern: "^[A-Za-z0-9._-]*$",
            },
            maxBodyBytes: {
                type: "integer",
                title: { en: "Maximum request body bytes", zh: "请求正文最大字节数" },
                description: {
                    en: "A longer body is cut and marked truncated; its full length and SHA-256 are kept",
                    zh: "超出时截断并标记 truncated；仍保留完整长度和 SHA-256",
                },
                default: 65536,
                minimum: 1024,
                maximum: 524288,
                unit: "byte",
            },
            includeRequestBody: {
                type: "boolean",
                title: { en: "Include request body", zh: "包含请求正文" },
                description: {
                    en: "Store the request body; turn off to store metadata and its hash only",
                    zh: "存储请求正文；关闭时只存元数据和哈希",
                },
                default: true,
            },
            responseMode: {
                type: "string",
                title: { en: "Response data", zh: "响应数据" },
                description: {
                    en: "What to send from the client-visible response",
                    zh: "发送客户端最终响应中的哪些内容",
                },
                enum: ["none", "meta", "body"],
                enumTitles: [
                    { en: "None", zh: "不发送" },
                    { en: "Metadata only", zh: "仅元数据" },
                    { en: "Body and metadata", zh: "正文和元数据" },
                ],
                default: "meta",
            },
            maxResponseBytes: {
                type: "integer",
                title: { en: "Maximum response body bytes", zh: "响应正文最大字节数" },
                description: {
                    en: "A longer response is cut and marked truncated; its full length and SHA-256 are kept",
                    zh: "超出时截断并标记 truncated；仍保留完整长度和 SHA-256",
                },
                default: 65536,
                minimum: 1024,
                maximum: 524288,
                unit: "byte",
                visibleWhen: { responseMode: "body" },
            },
        },
    },
    samples: [
        {
            name: { en: "A short chat request", zh: "一个简短的对话请求" },
            lang: "en",
            format: "openai",
            body: {
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: "What is in this request?" }],
            },
        },
        {
            name: { en: "A short chat request", zh: "一个简短的对话请求" },
            lang: "zh",
            format: "openai",
            body: {
                model: "gpt-4o-mini",
                messages: [{ role: "user", content: "这个请求里有什么？" }],
            },
        },
    ],
};

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
    return typeof value === "number" && isFinite(value) ? value : null;
}

function integerInRange(value, fallback, minimum, maximum) {
    if (typeof value !== "number" || !isFinite(value)) return fallback;
    const rounded = Math.round(value);
    if (rounded < minimum) return minimum;
    if (rounded > maximum) return maximum;
    return rounded;
}

function trimText(value) {
    return typeof value === "string" ? value.trim() : "";
}

function requestBodyText(body) {
    if (body === undefined || body === null) return null;
    try {
        return JSON.stringify(body);
    } catch (error) {
        return null;
    }
}

function hasOwn(value, name) {
    return Object.prototype.hasOwnProperty.call(value, name);
}

function utf8Length(text) {
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) {
            bytes += 1;
        } else if (code < 0x800) {
            bytes += 2;
        } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
            bytes += 4;
            i++;
        } else {
            bytes += 3;
        }
    }
    return bytes;
}

function cutUTF8(text, maxBytes) {
    if (utf8Length(text) <= maxBytes) return {text: text, truncated: false};
    let bytes = 0;
    let end = 0;
    while (end < text.length) {
        const code = text.charCodeAt(end);
        const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff && end + 1 < text.length ? 4 : 3;
        if (bytes + size > maxBytes) break;
        bytes += size;
        end += size === 4 ? 2 : 1;
    }
    return {text: text.slice(0, end), truncated: true};
}

function isoTime(milliseconds) {
    const value = finiteNumber(milliseconds);
    if (value === null) return null;
    const date = new Date(value);
    if (isNaN(date.getTime())) return null;
    return date.toISOString();
}

function userField(user) {
    if (!isObject(user)) return null;
    return {
        id: finiteNumber(user.id),
        username: typeof user.username === "string" ? user.username : null,
    };
}

function tokenField(token) {
    if (!isObject(token)) return null;
    return {
        id: finiteNumber(token.id),
        name: typeof token.name === "string" ? token.name : null,
    };
}

function channelField(channel) {
    if (!isObject(channel)) return null;
    return {
        id: finiteNumber(channel.id),
        type: finiteNumber(channel.type),
    };
}

function usageField(usage) {
    if (!isObject(usage)) return null;
    const result = {};
    for (const name of Object.keys(usage)) {
        const value = finiteNumber(usage[name]);
        if (value !== null) result[name] = value;
    }
    return Object.keys(result).length > 0 ? result : null;
}

function errorField(error) {
    if (!isObject(error)) return null;
    const code = error.code;
    return {
        status: finiteNumber(error.status),
        code: typeof code === "string" || typeof code === "number" ? code : null,
        type: typeof error.type === "string" ? error.type : null,
        message: typeof error.message === "string" ? error.message : null,
    };
}

function requestPluginsField(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    return entries;
}

function responseField(response) {
    if (!isObject(response)) return null;
    return {
        status: finiteNumber(response.status),
        contentType: typeof response.contentType === "string" ? response.contentType : null,
        stream: response.stream === true,
        bytes: finiteNumber(response.bytes),
        truncated: response.truncated === true,
    };
}

function responsePayload(response, task, mode, maxBytes) {
    if (mode !== "body") {
        return { kind: null, text: null, bytes: null, sha256: null, truncated: false, omitted: false };
    }

    const hostTruncated = isObject(response) && response.truncated === true;
    let kind = null;
    let full = null;
    if (isObject(response) && Array.isArray(response.events) && response.events.length > 0) {
        kind = "events";
        full = JSON.stringify(response.events);
    } else if (isObject(response) && hasOwn(response, "body") && response.body !== undefined) {
        kind = response.stream === true ? "events" : "body";
        full = JSON.stringify(response.body);
    } else if (isObject(task) && isObject(task.result)) {
        kind = "task_result";
        full = JSON.stringify(task.result);
    }

    if (full === null) {
        return { kind: null, text: null, bytes: null, sha256: null, truncated: hostTruncated, omitted: true };
    }

    const cut = cutUTF8(full, maxBytes);
    return {
        kind: kind,
        text: cut.text,
        bytes: utf8Length(full),
        sha256: utils.sha256(full),
        truncated: cut.truncated || hostTruncated,
        omitted: false,
    };
}

function taskField(task) {
    if (!isObject(task)) return null;
    return {
        id: typeof task.id === "string" ? task.id : null,
        status: typeof task.status === "string" ? task.status : null,
        reason: typeof task.reason === "string" ? task.reason : null,
        finishedAt: finiteNumber(task.finishedAt),
    };
}

function configOf(ctx) {
    const config = isObject(ctx) && isObject(ctx.config) ? ctx.config : {};
    return {
        endpoint: trimText(config.endpoint),
        bearerToken: trimText(config.bearerToken),
        site: trimText(config.site),
        maxBodyBytes: integerInRange(config.maxBodyBytes, DEFAULT_MAX_BODY_BYTES, 1024, MAX_BODY_BYTES),
        includeRequestBody: config.includeRequestBody !== false,
        responseMode: config.responseMode === "none" || config.responseMode === "body" ? config.responseMode : "meta",
        maxResponseBytes: integerInRange(config.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1024, MAX_RESPONSE_BYTES),
    };
}

function buildRecord(ctx, record) {
    const config = configOf(ctx);
    const bodyText = requestBodyText(record && record.request ? record.request.body : null);
    const response = record ? record.response : null;
    const task = record ? record.task : null;
    const fullBytes = bodyText === null ? null : utf8Length(bodyText);
    let keptBody = null;
    let truncated = false;

    if (config.includeRequestBody && bodyText !== null) {
        const cut = cutUTF8(bodyText, config.maxBodyBytes);
        keptBody = cut.text;
        truncated = cut.truncated;
    }
    const responseData = responsePayload(response, task, config.responseMode, config.maxResponseBytes);

    const result = {
        _time: isoTime(record ? record.startedAt : null),
        _msg: keptBody === null ? "" : keptBody,
        plugin_version: meta.version,
        site: config.site,
        request_id: record && typeof record.requestId === "string" ? record.requestId : "",
        user: userField(record ? record.user : null),
        token: tokenField(record ? record.token : null),
        group: ctx && typeof ctx.group === "string" ? ctx.group : null,
        model: ctx && typeof ctx.model === "string" ? ctx.model : "",
        upstream_model: ctx && typeof ctx.upstreamModel === "string" ? ctx.upstreamModel : null,
        path: ctx && typeof ctx.path === "string" ? ctx.path : "",
        format: ctx && typeof ctx.format === "string" ? ctx.format : "",
        channel: channelField(ctx ? ctx.channel : null),
        attempt: ctx ? finiteNumber(ctx.attempt) : null,
        usage: usageField(record ? record.usage : null),
        cost_quota: record && isObject(record.cost) ? finiteNumber(record.cost.quota) : null,
        cost_usd: record && isObject(record.cost) ? finiteNumber(record.cost.usd) : null,
        duration_ms: record ? finiteNumber(record.durationMs) : null,
        first_response_ms: record ? finiteNumber(record.firstResponseMs) : null,
        error: errorField(record ? record.error : null),
        request_plugins: requestPluginsField(record ? record.requestPlugins : null),
        body_bytes: fullBytes,
        body_sha256: bodyText === null ? null : utils.sha256(bodyText),
        truncated: truncated,
    };

    if (config.responseMode !== "none") {
        result.status = responseField(response);
        result.task = taskField(task);
    }
    if (config.responseMode === "body") {
        if (responseData.text !== null) {
            result.response_body = responseData.text;
            result.response_kind = responseData.kind;
        }
        result.response_bytes = responseData.bytes;
        result.response_sha256 = responseData.sha256;
        result.response_truncated = responseData.truncated;
        result.response_omitted = responseData.omitted;
    }
    if (bodyText !== null && !config.includeRequestBody) {
        result.body_omitted = true;
    }
    if (result._time === null) delete result._time;
    return result;
}

function dropResponseBody(built) {
    if (!hasOwn(built, "response_body")) return false;
    delete built.response_body;
    delete built.response_kind;
    built.response_omitted = true;
    return true;
}

function dropRequestBody(built) {
    if (built._msg === "") return false;
    built._msg = "";
    built.body_omitted = true;
    built.truncated = true;
    return true;
}

export function validateConfig(config) {
    const endpoint = trimText(config && config.endpoint);
    if (endpoint === "") throw new Error("Ingest URL is required");
    if (!/^https?:\/\//i.test(endpoint)) {
        throw new Error("Ingest URL must start with http:// or https://");
    }
    if (endpoint.length > 2048) throw new Error("Ingest URL is too long");
    const site = trimText(config && config.site);
    if (site.length > 128) throw new Error("Site is too long");
    if (!/^[A-Za-z0-9._-]*$/.test(site)) {
        throw new Error("Site may contain only letters, digits, dot, underscore and hyphen");
    }
}

export function buildAuditRecord(ctx, record) {
    return buildRecord(ctx, record);
}

export function report(ctx, record) {
    const config = configOf(ctx);
    if (config.endpoint === "") return;

    let payload;
    let built;
    try {
        built = buildRecord(ctx, record);
        payload = JSON.stringify(built);
    } catch (error) {
        return;
    }
    if (utf8Length(payload) > FETCH_BODY_LIMIT && dropResponseBody(built)) {
        payload = JSON.stringify(built);
    }
    if (utf8Length(payload) > FETCH_BODY_LIMIT && dropRequestBody(built)) {
        payload = JSON.stringify(built);
    }
    if (utf8Length(payload) > FETCH_BODY_LIMIT) return;

    const headers = {
        "Content-Type": "application/x-ndjson",
    };
    if (config.bearerToken !== "") {
        headers.Authorization = "Bearer " + config.bearerToken;
    }

    let response;
    try {
        response = utils.fetch({
            url: config.endpoint,
            method: "POST",
            headers: headers,
            body: payload,
        });
    } catch (error) {
        console.log("VictoriaLogs ingest failed: transport error");
        throw new Error("VictoriaLogs ingest failed");
    }
    if (response.status < 200 || response.status >= 300) {
        console.log("VictoriaLogs ingest failed with status " + response.status);
        throw new Error("VictoriaLogs ingest failed");
    }
}
