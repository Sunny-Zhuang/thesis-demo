# Figma 数据增强架构

## 架构概览

统一使用 **enriched nodes** 格式，不再依赖 MCP adapter。

```
                  ┌─────────────────────────┐
                  │   Figma 数据源          │
                  └───────┬─────────────────┘
                          │
            ┌─────────────┴─────────────┐
            │                           │
      在线模式                      离线模式
            │                           │
            ▼                           ▼
   ┌────────────────┐         ┌────────────────┐
   │ Figma API      │         │ raw_metadata   │
   │ GET /nodes     │         │ .json 文件     │
   │ (depth=10,     │         └────────┬───────┘
   │  geometry=true)│                  │
   └────────┬───────┘                  │
            │                          │
            └────────┬─────────────────┘
                     ▼
          ┌──────────────────────┐
          │ enrichFigmaNodes()   │
          │ (figma-enrich.ts)    │
          └──────────┬───────────┘
                     │
                     ▼
          ┌──────────────────────┐
          │ Enriched Nodes JSON  │
          │ • 完整样式           │
          │ • 精确布局           │
          │ • 交互信息           │
          └──────────┬───────────┘
                     │
                     ▼
          ┌──────────────────────┐
          │ DSL Builder          │
          │ (大模型处理)          │
          └──────────────────────┘
```

## 核心文件

### 1. `src/services/figma-enrich.ts`

**核心增强逻辑**，将 Figma raw JSON 转换为增强节点：

```typescript
export function enrichFigmaNodes(rawData: unknown): McpStructureNode[]
```

**输入格式**（支持两种）:
- `{ document: {...} }` - Figma file API 返回
- `{ nodes: { "nodeId": { document: {...} } } }` - Figma nodes API 返回

**输出格式**:
```typescript
McpStructureNode[] = [
  {
    nodeId: string,
    name: string,
    type: string,
    text?: string,
    layout: {
      width, height, x, y,
      gap, padding, direction
    },
    style: {
      background: "#ffffff",
      color: "#000000",
      border: "1px solid #000000",
      radius: 32
    },
    interactions: [
      { trigger, action, target }
    ]
  }
]
```

### 2. `src/services/figma-api.ts`

**主服务接口**，统一处理在线和离线数据获取：

- `fetchEnrichedNodesFromFigmaApi()` - 在线获取并 enrich
- `loadNodesFromFile()` - 加载本地文件（自动识别 raw/enriched 格式）
- `fetchMcpStructure()` - 主入口，优先级：API > 本地文件

**关键改进**：
- ✅ 不再使用 MCP adapter
- ✅ 直接调用 Figma API（`/v1/files/{key}/nodes`）
- ✅ 使用 `depth=10, geometry=paths` 获取完整数据
- ✅ 统一使用 `enrichFigmaNodes()` 处理

### 3. `scripts/enrich-offline-nodes.ts`

**离线数据处理脚本**：

```bash
npx tsx scripts/enrich-offline-nodes.ts [input.json] [output.json]
```

默认：
- 输入：`src/data/figma2code-offline/raw_metadata.json`
- 输出：`src/data/figma2code-offline/enriched-nodes.json`

## 使用方式

### 离线模式（推荐用于开发测试）

1. **准备 raw JSON**：将 Figma API 返回或导出的数据保存为 `raw_metadata.json`

2. **运行 enrich 脚本**：
```bash
npm run build
npx tsx scripts/enrich-offline-nodes.ts
```

3. **运行 Pipeline**：
```bash
npm run dev -- --offline
```

### 在线模式（生产环境）

**前提**：配置环境变量
```bash
export FIGMA_API_KEY=your_figma_pat
# 或
export FIGMA_OAUTH_TOKEN=your_oauth_token
```

**使用**：
```bash
npm run dev -- "https://www.figma.com/design/xxx?node-id=34-12"
```

**流程**：
1. 自动调用 Figma API 获取完整节点数据（`/v1/files/{key}/nodes?depth=10&geometry=paths`）
2. 自动用 `enrichFigmaNodes()` 处理
3. 传给 DSL builder 生成代码

### Strict Live 模式

强制使用在线数据，禁止任何本地 fallback：

```bash
npm run dev -- --strict-live "https://www.figma.com/design/xxx?node-id=34-12"
```

## 数据格式对比

### 旧的 MCP 格式（已废弃）
```json
{
  "schema": "v3",
  "root": {
    "id": "1:124",
    "type": "FRAME",
    "name": "Sign Up 1",
    "children": [...]
  }
}
```
❌ 只有基础节点树，**没有样式和布局细节**

### 新的 Enriched 格式（统一标准）
```json
{
  "nodes": [
    {
      "nodeId": "1:124",
      "name": "Sign Up 1",
      "type": "FRAME",
      "layout": {
        "width": 393,
        "height": 852,
        "x": -3801,
        "y": -426
      },
      "style": {
        "background": "#ffffff"
      },
      "interactions": []
    }
  ]
}
```
✅ **完整的设计实现细节**

## 优势

### 统一性
- 在线和离线使用**完全相同**的数据格式
- 一套 enrich 逻辑，两种使用场景

### 数据丰富度
- ✅ 样式：background, color, border, radius
- ✅ 布局：width, height, x, y, gap, padding, direction
- ✅ 交互：trigger, action, target
- ✅ 文本：characters 内容

### 简化架构
- ❌ 移除了 MCP adapter 依赖
- ❌ 移除了 `@langchain/mcp-adapters`
- ❌ 移除了 `MultiServerMCPClient`
- ✅ 直接调用 Figma API
- ✅ 更轻量、更可控

### 可扩展性
- 易于添加新的 Figma 字段（variables, effects, constraints 等）
- 易于适配其他设计工具的数据格式

## 环境变量

```bash
# Figma 认证（二选一）
FIGMA_API_KEY=figd_xxx              # Personal Access Token
FIGMA_OAUTH_TOKEN=xxx               # OAuth Token (优先级更高)

# 可选配置
FIGMA_FILE_KEY=xxx                  # 默认文件 key
FIGMA_API_RETRY_ATTEMPTS=3          # API 重试次数
FIGMA_API_RETRY_DELAY_MS=1000       # 重试延迟（毫秒）
```

## 下一步

1. ✅ 统一架构完成
2. ⏭️ 运行完整 Pipeline 测试
3. ⏭️ 优化 DSL builder 利用更丰富的样式数据
4. ⏭️ 添加更多 Figma 字段（variables, effects 等）
