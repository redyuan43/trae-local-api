# Trae Local API

将 Trae 账号能力变成本地 OpenAI/Anthropic 兼容 API 服务，让 Claude Code、Cursor、Cline 等第三方工具直接调用 Trae Agent v3 后端。

支持四个 Trae 版本:Trea CN、TRAE SOLO CN、Trae SG(国际版)、TRAE SOLO(国际版)。

> 分享给 API 使用者时，请直接提供 [API_GUIDE.md](./API_GUIDE.md)。
> 该文档包含访问密码、协议、模型、多模态、费用统计和远程连接说明。

## 功能

- 自动解密四版本认证数据(CN/SOLO/SOLO-SG 使用 tc 加密,SG 使用明文 JSON)
- 提供 OpenAI (`/v1/chat/completions`) 和 Anthropic (`/v1/messages`) 兼容接口
- Token 过期自动刷新，自动保存到 `.env`
- Claude/OpenAI 模型名自动映射到 Trae 模型配置
- 支持流式输出
- 直接调用 Trae Agent v3 后端，不操作 IDE 窗口或剪贴板
- 通过 Trae 云端资源 API 支持 OpenAI/Anthropic 标准图片输入
- 校验服务端实际采用的模型配置，避免静默路由到其他模型
- 完整支持 Claude Code 工具调用(tool_use content block)
- 自适应 CN/SG 两种 SSE 事件格式(CN 带 `event:output` 前缀,SG 大部分 data 行无 event 前缀)

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置版本(可选)

在 `.env` 中设置 `TRAE_EDITION`(不设置默认 `cn`):

| 值 | 对应 IDE | storage.json 路径 | 加密格式 |
|----|----------|-------------------|----------|
| `cn` | Trae CN 国内版 | Windows: `%APPDATA%\Trae CN\User`; Linux: `~/.config/Trae CN/User` | tc 加密 |
| `solo` | TRAE SOLO CN 独立部署版 | Windows: `%APPDATA%\TRAE SOLO CN\User`; Linux: `~/.config/TRAE SOLO CN/User` | tc 加密 |
| `sg` | Trae 国际版 | Windows: `%APPDATA%\Trae\User`; Linux: `~/.config/Trae/User` | 明文 JSON |
| `solo-sg` | TRAE SOLO 国际版 | Windows: `%APPDATA%\TRAE SOLO\User`; Linux: `~/.config/TRAE SOLO/User` | tc 加密 |

> SG 版 `storage.json` 中认证字段为明文 JSON，其他三版均为 `tc` 加密。

### 3. 一键启动

```bash
# Windows 双击即可
start.bat

# 或命令行
npm start
```

首次运行会自动从对应 IDE 的 `storage.json` 解密认证数据并保存到 `.env`，之后直接读取 `.env` 启动。

### 4. 连接 Claude Code

```powershell
$env:ANTHROPIC_BASE_URL = "http://localhost:9220"
$env:ANTHROPIC_API_KEY = "YOUR_API_KEY"
claude
```

### 5. 连接 Cursor

- Base URL: `http://localhost:9220/v1`
- API Key: `.env` 中配置的 `API_KEY`
- Model: `auto`

### 6. Python 调用

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:9220/v1", api_key="YOUR_API_KEY")

response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

### 7. 图片调用

当前确认支持图片输入的 Trae 配置:

- `kimi-k2.7-code`
- `glm-5v-turbo`

OpenAI 格式使用 Base64 Data URL:

```python
import base64
from openai import OpenAI

client = OpenAI(base_url="http://localhost:9220/v1", api_key="YOUR_API_KEY")
image = base64.b64encode(open("image.png", "rb").read()).decode()

response = client.chat.completions.create(
    model="kimi-k2.7-code",
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "请描述这张图片"},
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{image}"},
            },
        ],
    }],
)

print(response.choices[0].message.content)
```

Anthropic `/v1/messages` 接受标准 `type: image`、`source.type: base64` 内容块。
图片会由本服务直接上传到 Trae 云端，再以 `image_id` 调用 Agent v3，不依赖
Trae IDE 窗口或本地 IPC。

限制:

- 仅支持 JPEG、PNG、GIF、WebP。
- 每次请求最多 5 张图片，单张解码后最大 3 MB。
- 图片宽高范围为 14 到 8192 像素。
- 暂不代为下载 HTTP(S) 图片 URL。
- 图片请求指定文本模型时返回 400，不自动切换模型。

## 手动解密

```bash
npm run setup
```

解密本机 Trae CN 配置并保存到 `.env`。

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/status` | 服务状态 |
| GET | `/v1/models` | 模型列表 |
| POST | `/v1/chat/completions` | OpenAI 格式对话 |
| POST | `/v1/messages` | Anthropic 格式对话 |
| POST | `/v1/messages/count_tokens` | Anthropic Token 估算 |
| GET | `/usage` | 本机费用看板 |
| GET | `/v1/usage/costs` | 本机费用统计 JSON |

## 模型选择

`GET /v1/models` 会从 Trae 账号的实时配置接口读取 IDE 中可见的模型，而不是返回写死列表。当前账号中的关键配置名包括:

| IDE 显示名 | 请求时的精确配置名 | 图片输入 |
|------------|--------------------|----------|
| Kimi-K2.7-Code | `kimi-k2.7-code` | 支持 |
| GLM-5V-Turbo | `glm-5v-turbo` | 支持 |
| GLM-5.2 | `glm-5.2` | 不支持 |
| DeepSeek-V4-Flash 正式版 | `DeepSeek-V4-Flash-Official` | 不支持 |
| DeepSeek-V4-Pro | `deepseek-V4-Pro` | 以实时模型目录为准 |
| DeepSeek-V4-Flash | `DeepSeek-V4-Flash` | 以实时模型目录为准 |

本项目直接调用 `/api/agent/v3/create_agent_task`，请求时使用 Trae 界面对应的精确配置名。服务会检查返回的 `model_config.config_name` 是否与请求一致；不一致时直接报错，不会把降级后的响应伪装成目标模型。

`/v1/models` 中:

- `selectable_in_ide: true`:该账号可在 Trae IDE 中选择。
- `selectable_via_agent_api: true`:可通过 Agent v3 直连路径调用。
- `input_modalities`:该配置接受的输入类型，例如 `["text", "image"]`。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TRAE_EDITION` | Trae 版本 (cn/solo/sg/solo-sg) | cn |
| `TRAE_TOKEN` | 解密后的 JWT Token | (自动生成) |
| `TRAE_REFRESH_TOKEN` | 刷新用 Token | (自动生成) |
| `TRAE_USER_ID` | 用户 ID | (自动生成) |
| `TRAE_API_HOST` | Token 刷新服务地址(随版本自动设置) | (自动生成) |
| `API_KEY` | 本服务的 API Key | 首次配置时自动生成 |
| `PORT` | 监听端口 | 9220 |
| `HOST` | 监听地址 | 127.0.0.1 |
| `TRAE_DATA_DIR` | Trae `User` 配置目录，覆盖自动探测 | (自动探测) |
| `TRAE_AGENT_API_URL` | Agent v3 后端地址 | `https://console.enterprise.trae.cn/api/agent/v3/create_agent_task` |
| `TRAE_RESOURCE_API_BASE` | Trae 图片资源 API 地址 | `https://console.enterprise.trae.cn` |
| `TRAE_DEVICE_ID` | 覆盖自动读取的 Trae 设备 ID | (自动读取) |
| `TRAE_MACHINE_ID` | 覆盖自动生成的稳定机器 ID | (自动生成) |
| `MAX_CONTEXT_TOKENS` | 发送前的上下文截断阈值 | 90000 |

## 企业费用统计 API

先从已登录的 Chrome 企业控制台同步一次只读会话:

```bash
npm run sync:enterprise-session
```

本机页面可直接调用，无需 `Authorization` 或 API Key:

```bash
curl http://127.0.0.1:9220/v1/usage/costs
```

```js
const usage = await fetch('http://127.0.0.1:9220/v1/usage/costs')
  .then(response => response.json());

console.log(usage.billing.remaining_amount);
console.log(usage.estimate.remaining_tokens);
console.log(usage.tokens.cache_hit_ratio);
```

该接口仅接受本机回环地址和本地页面 Origin，响应不包含企业 Cookie、
用户邮箱、用户 ID 或租户 ID。金额字段来自企业用量管理接口；Token
余额为按照当前周期实际模型结构、折扣和缓存情况计算的估值。

## 前置条件

- Node.js >= 18
- 已安装并登录任一 Trae IDE:Trea CN / TRAE SOLO CN / Trae(国际版) / TRAE SOLO(国际版)
- 对应 IDE 的用户配置目录下存在 `globalStorage/storage.json`

## 项目结构

```
trae-local-api/
├── start.bat              # 一键启动脚本
├── setup.js               # 自动解密配置
├── src/
│   ├── server.js          # Express 服务器
│   ├── auth.js            # 认证管理
│   ├── trae-decrypt.js    # tc 加密解密
│   ├── trae-client.js     # 模型目录与路由
│   ├── trae-agent-client.js # Agent v3 直连客户端
│   ├── trae-resource-client.js # Trae 云端图片上传
│   ├── image-utils.js     # 图片解析、校验与 CRC32
│   ├── openai-format.js   # OpenAI 格式转换
│   └── anthropic-format.js # Anthropic 格式转换
├── test/                  # Node 内置测试
└── .env                   # 自动生成的配置
```

## tc 加密协议

Trae CN / TRAE SOLO CN / TRAE SOLO(国际版) 对本地存储的认证数据使用自定义的 "tc" 加密格式:

1. Base64 解码 → `[6B Header][32B RandomBytes][N EncryptedData]`
2. Header `0x74 0x63` ("tc") 标识 AES 类型
3. 密钥派生：`SHA-512(RandomBytes)` → XOR 盐值 → `SHA-512` → Key(16B) + IV(16B)
4. AES-128-CBC 解密 → `[64B SHA-512 Hash][Plaintext JSON]`
5. 哈希验证 → 明文 `{ token, refreshToken, userId, ... }`

> **Trae SG(国际版)例外**:该版本 `iCubeAuthInfo://icube.cloudide` 字段直接存储明文 JSON,无需解密,`trae-decrypt.js` 中会自动识别并跳过解密流程。
