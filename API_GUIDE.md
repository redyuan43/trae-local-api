# Trae Local API 使用手册

本文档面向 API 使用者。服务维护者完成 Trae 登录和部署后，可以把本文档
直接发给其他用户。

## 服务地址

默认监听地址:

```text
http://127.0.0.1:9220
```

不同协议使用不同的 Base URL:

| 客户端协议 | Base URL |
|---|---|
| OpenAI | `http://SERVER:9220/v1` |
| Anthropic | `http://SERVER:9220` |

将 `SERVER` 替换为服务所在机器的 IP 或域名。

## 访问密码

模型相关 API 使用 `.env` 中的 `API_KEY` 作为访问密码。支持以下两种请求头:

```http
Authorization: Bearer YOUR_API_KEY
```

或者:

```http
x-api-key: YOUR_API_KEY
```

不要把服务端 `.env`、Trae Token、Refresh Token 或企业会话文件发给 API
使用者。只需要单独提供 API 地址和 `API_KEY`。

## 接口列表

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/v1/status` | API Key | 服务和 Trae 登录状态 |
| `GET` | `/v1/models` | API Key | 当前账号实时可用模型 |
| `POST` | `/v1/chat/completions` | API Key | OpenAI Chat Completions |
| `POST` | `/v1/messages` | API Key | Anthropic Messages |
| `POST` | `/v1/messages/count_tokens` | API Key | Anthropic Token 粗略估算 |
| `GET` | `/usage` | 无 | 本机费用看板 |
| `GET` | `/v1/usage/costs` | 无，仅本机 | 企业费用和 Token 统计 |

费用接口不会因为模型 API 对外分享而自动开放。`/v1/usage/costs` 强制要求
请求来自服务所在机器的回环地址。

## 快速自检

### 服务状态

```bash
curl http://SERVER:9220/v1/status \
  -H "Authorization: Bearer YOUR_API_KEY"
```

正常响应:

```json
{
  "status": "ok",
  "edition": "cn",
  "transport": "direct-agent-v3",
  "has_token": true,
  "port": 9220
}
```

### 查询模型

```bash
curl http://SERVER:9220/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

模型列表来自当前 Trae 账号的实时配置，不是项目内写死的数据。调用模型时
优先使用返回结果中的 `id`。

重要字段:

```json
{
  "id": "DeepSeek-V4-Flash-Official",
  "display_name": "DeepSeek-V4-Flash 正式版",
  "context_window": 96000,
  "max_output_tokens": 16000,
  "input_modalities": ["text"],
  "selectable_via_agent_api": true
}
```

## OpenAI 协议

### 非流式请求

```bash
curl http://SERVER:9220/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "DeepSeek-V4-Flash-Official",
    "messages": [
      {"role": "user", "content": "用一句话介绍你自己"}
    ],
    "stream": false,
    "max_tokens": 1024
  }'
```

### 流式请求

```bash
curl -N http://SERVER:9220/v1/chat/completions \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.2",
    "messages": [
      {"role": "user", "content": "写一个 Node.js HTTP 服务"}
    ],
    "stream": true
  }'
```

### Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://SERVER:9220/v1",
    api_key="YOUR_API_KEY",
)

response = client.chat.completions.create(
    model="DeepSeek-V4-Flash-Official",
    messages=[{"role": "user", "content": "你好"}],
)

print(response.choices[0].message.content)
```

服务当前处理的主要 OpenAI 请求字段:

| 字段 | 说明 |
|---|---|
| `model` | Trae 精确配置名或兼容别名 |
| `messages` | `system`、`user`、`assistant` 消息 |
| `stream` | 是否返回 SSE 流 |
| `max_tokens` | 最大输出 Token |
| `tools` | OpenAI Function Tool 定义 |

`temperature`、`top_p` 等参数目前不会保证原样传递到 Trae 模型。

## Anthropic 协议

### Messages 请求

```bash
curl http://SERVER:9220/v1/messages \
  -H "x-api-key: YOUR_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "DeepSeek-V4-Flash-Official",
    "max_tokens": 1024,
    "messages": [
      {"role": "user", "content": "你好"}
    ]
  }'
```

支持:

- `system`
- `messages`
- `stream`
- `max_tokens`
- `tools`
- `tool_use` 和 `tool_result` 内容块
- Base64 图片内容块

工具调用由服务转换成 Trae 可处理的提示格式，再转换回 Anthropic
`tool_use` 内容块。它与 Anthropic 官方原生工具调用不是完全相同的实现。

### Claude Code

Linux/macOS:

```bash
export ANTHROPIC_BASE_URL="http://SERVER:9220"
export ANTHROPIC_API_KEY="YOUR_API_KEY"
claude
```

PowerShell:

```powershell
$env:ANTHROPIC_BASE_URL = "http://SERVER:9220"
$env:ANTHROPIC_API_KEY = "YOUR_API_KEY"
claude
```

## 模型选择

以下是 2026-08-17 在当前 Trae 企业账号中确认可通过 Agent v3 读取到的
常用配置。其他账号的可见模型可能不同，最终以 `/v1/models` 为准。

| 显示名 | 请求使用的 `model` | 上下文 | 输入 |
|---|---|---:|---|
| DeepSeek-V4-Flash 正式版 | `DeepSeek-V4-Flash-Official` | 96K | 文本 |
| DeepSeek-V4-Pro | `deepseek-V4-Pro` | 96K | 文本 |
| DeepSeek-V4-Flash | `DeepSeek-V4-Flash` | 96K | 文本 |
| GLM-5.2 | `glm-5.2` | 100K | 文本 |
| GLM-5V-Turbo | `glm-5v-turbo` | 100K | 文本、图片 |
| Kimi-K2.7-Code | `kimi-k2.7-code` | 100K | 文本、图片 |
| Qwen3.7-Plus | `qwen-3.7-plus` | 100K | 文本、图片 |
| MiniMax-M3 | `minimax-m3` | 100K | 文本、图片 |
| Doubao-Seed-2.1-Pro | `Doubao-Seed-2.1-pro` | 100K | 文本、图片 |
| Doubao-Seed-Code | `Doubao_1_6` | 100K | 文本、图片 |

企业自定义模型也可能出现在 `/v1/models` 中。这些配置属于部署账号，
不保证在另一 Trae 账号中存在。

### 兼容别名

为了让 Claude Code、Cursor 等客户端无需修改固定模型名，服务提供以下映射:

| 客户端请求名 | 实际 Trae 配置 |
|---|---|
| `auto` | `DeepSeek-V4-Flash-Official` |
| `claude-opus-4-7` | `DeepSeek-V4-Flash-Official` |
| `claude-opus-4-6` | `DeepSeek-V4-Flash-Official` |
| `claude-sonnet-4-6` | `DeepSeek-V4-Flash-Official` |
| `claude-sonnet-4-5` | `DeepSeek-V4-Flash-Official` |
| `gpt-4o` | `deepseek-V4-Pro` |
| `gpt-4.1` | `deepseek-V4-Pro` |
| `gpt-4o-mini` | `DeepSeek-V4-Flash-Official` |

这些名称只是客户端兼容别名。例如请求 `gpt-4o` 并不表示调用 OpenAI
GPT-4o，实际调用的是表中对应的 Trae 模型。服务会校验 Trae 返回的
`model_config.config_name`，发现静默降级或错误路由时直接报错。

## 图片输入

图片能力以 `/v1/models` 返回的 `input_modalities` 为准。

OpenAI 格式:

```json
{
  "model": "kimi-k2.7-code",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "描述图片"},
      {
        "type": "image_url",
        "image_url": {
          "url": "data:image/png;base64,BASE64_DATA"
        }
      }
    ]
  }]
}
```

Anthropic 格式:

```json
{
  "model": "glm-5v-turbo",
  "max_tokens": 1024,
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "描述图片"},
      {
        "type": "image",
        "source": {
          "type": "base64",
          "media_type": "image/png",
          "data": "BASE64_DATA"
        }
      }
    ]
  }]
}
```

限制:

- JPEG、PNG、GIF、WebP。
- 每次最多 5 张图片。
- 单张图片解码后不超过 3 MB。
- 宽高必须在 14 到 8192 像素之间。
- 不支持由服务下载远程 HTTP(S) 图片。
- 文本模型收到图片时返回 `400`，不会自动换模型。

## 费用统计

费用看板:

```text
http://127.0.0.1:9220/usage
```

费用 JSON:

```bash
curl http://127.0.0.1:9220/v1/usage/costs
```

主要字段:

```text
billing.quota_amount
billing.used_amount
billing.remaining_amount
billing.reset_at
tokens.raw_total
tokens.billed_total
tokens.cache_hit_ratio
estimate.remaining_tokens
models
```

金额是企业控制台返回的精确值。剩余 Token 是依据当前周期模型组合、
折扣和缓存情况换算的估值，不是固定 Token 钱包余额。

## 分享到其他设备

服务默认只监听 `127.0.0.1`。需要让局域网或 Tailscale 中的其他设备调用时，
在服务端 `.env` 设置:

```dotenv
HOST=0.0.0.0
PORT=9220
API_KEY=替换为足够长的随机密码
```

然后重启服务。客户端使用:

```text
OpenAI Base URL:   http://服务端地址:9220/v1
Anthropic Base URL: http://服务端地址:9220
API Key:           服务端提供的 API_KEY
```

安全建议:

- 必须设置强 `API_KEY`。
- 不要公开 `.env` 和企业会话文件。
- 互联网访问应在前面增加 HTTPS 反向代理。
- 使用防火墙或 Tailscale ACL 限制访问来源。
- 费用统计接口保持本机访问，不应作为共享 API 暴露。

## 常见错误

| HTTP 状态 | 常见原因 |
|---:|---|
| `400` | 请求格式错误、模型不支持图片、模型被禁用 |
| `401` | API Key 错误 |
| `404` | 路径不存在 |
| `429` | Trae 上游限流或额度限制 |
| `502` | Trae 上游失败、模型路由不一致 |
| `503` | 企业费用会话缺失或已过期 |

费用会话过期后，服务维护者在已登录企业控制台的机器上执行:

```bash
npm run sync:enterprise-session
```

