# 离线模式 Vision Analyzer 修复

## 🐛 问题描述

**原问题**：
在 `vision-analyzer.ts` 中，即使是离线模式，代码仍然调用 `fetchCompactFigmaDesign(request)`，由于离线模式会跳过实际的 API 调用，导致返回空结果：
- `compactContext` 为 `undefined`
- LLM 收不到任何 Figma 结构信息
- 只能使用静态 fallback，无法利用 enriched nodes 的丰富数据

## ✅ 修复方案

### 核心改动

**文件**: `src/services/vision-analyzer.ts`

1. **新增函数：加载离线 enriched nodes**
   ```typescript
   async function loadEnrichedNodesForOffline(request: ScreenshotRequest): Promise<McpStructureNode[]>
   ```
   - 读取 `mcpStructurePath` 或默认的 enriched-nodes.json
   - 支持多个路径候选，优先级：
     1. `request.mcpStructurePath`（用户指定）
     2. `src/data/figma2code-offline/enriched-nodes.json`（默认 enriched）
     3. `src/data/figma2code-offline/08wDXrTJgBoPVvQzlkKBtV_1_124-nodes.json`（备用）

2. **新增函数：转换 enriched nodes 为 LLM context**
   ```typescript
   function buildCompactContextFromEnrichedNodes(nodes: McpStructureNode[]): Record<string, unknown>
   ```
   - 将 `McpStructureNode[]` 转换为 LLM 可理解的 compact context 格式
   - 包含完整的样式、布局、交互信息
   - 结构与在线模式的 compact context 一致

3. **重构主函数：根据模式选择数据源**
   ```typescript
   export async function analyzeScreenshot(request: ScreenshotRequest)
   ```
   
   **新逻辑流程**：
   ```
   if (request.offlineMode) {
     // 离线：读取 enriched-nodes.json
     enrichedNodes = await loadEnrichedNodesForOffline(request)
     compactContext = buildCompactContextFromEnrichedNodes(enrichedNodes)
   } else {
     // 在线：调用 Figma API
     compact = await fetchCompactFigmaDesign(request)
     compactContext = buildCompactContext(compact.response?.root)
   }
   
   // 统一传给 LLM
   llmAnalysis = await callVisionLLM(request, compactContext)
   ```

## 📊 测试结果

运行 `scripts/test-offline-vision.ts`：

```bash
✅ Vision analysis completed!

📊 Results:
  Summary: Screenshot + enriched nodes (offline)
  Modules count: 8
  Reusable candidates: 0

📦 Modules:
  1. Illustration (FRAME) - nodeId: 1:125
  2. Pic (GROUP) - nodeId: 1:126
  3. Star 5 (VECTOR) - nodeId: 1:127
  4. Star 4 (VECTOR) - nodeId: 1:128
  5. Star 6 (VECTOR) - nodeId: 1:129
  6. Star 7 (VECTOR) - nodeId: 1:130
  7. Button with icon (INSTANCE) - nodeId: 31:350
  8. Group 36692 (GROUP) - nodeId: I31:350;30:341

🎨 Global Layout:
  Padding: 24
  Gap: 16
  Direction: vertical
```

**验证点**：
- ✅ 成功加载 33 个 enriched nodes
- ✅ 正确推断出 8 个模块，每个都有 nodeHintIds
- ✅ Summary 显示 "enriched nodes (offline)"
- ✅ 提取了全局布局信息（padding, gap, direction）
- ✅ 即使 LLM 调用失败，fallback 逻辑也能从 enriched nodes 推断结构

## 🎯 改进效果

### Before（修复前）
```typescript
// 离线模式
fetchCompactFigmaDesign(request) 
  → { response: null, source: "none" }
  → compactContext = undefined
  → LLM 收不到任何 Figma 信息
  → 只能用静态 fallback
```

### After（修复后）
```typescript
// 离线模式
loadEnrichedNodesForOffline(request)
  → 33 个 enriched nodes (含样式、布局、交互)
  → buildCompactContextFromEnrichedNodes()
  → compactContext = { root: {...}, children: [...] }
  → LLM 收到完整的 Figma 结构信息
  → 推断出 8 个真实模块（而非静态 fallback）
```

## 📈 数据对比

### 传给 LLM 的 Context（离线模式）

**修复前**：
```json
{
  "compactStructure": undefined
}
```
❌ 空数据

**修复后**：
```json
{
  "compactStructure": {
    "root": {
      "id": "1:124",
      "name": "Sign Up 1",
      "type": "FRAME",
      "layout": {
        "width": 393,
        "height": 852,
        "direction": "vertical",
        "padding": 24,
        "gap": 16
      },
      "style": {
        "background": "#ffffff"
      }
    },
    "children": [
      {
        "id": "1:125",
        "name": "Illustration",
        "type": "FRAME",
        "layout": { "width": 373, "height": 697 },
        "style": { "background": "#f0f3fb", "radius": 32 }
      },
      // ... 更多 children (最多 20 个)
    ]
  }
}
```
✅ 完整的结构、样式、布局信息

## 🚀 使用方式

### 离线模式（现在可以充分利用 enriched nodes）

```bash
# 1. 生成 enriched nodes
npm run build
npx tsx scripts/enrich-offline-nodes.ts

# 2. 运行 Pipeline（Vision Analyzer 会自动读取 enriched nodes）
npm run dev -- --offline
```

**流程**：
1. Vision Analyzer 读取 `enriched-nodes.json`
2. 转换为 LLM 可理解的格式
3. LLM 基于真实的 Figma 结构分析（而非空数据）
4. 生成更准确的 modules 和 layout

### 自定义 enriched nodes 路径

```bash
npm run dev -- --offline path/to/custom-enriched.json
```

或者在代码中：
```typescript
const request: ScreenshotRequest = {
  offlineMode: true,
  mcpStructurePath: "custom/path/enriched-nodes.json",
  // ...
};
```

## 🎉 总结

### 修复内容
- ✅ 离线模式现在能读取并使用 enriched-nodes.json
- ✅ LLM 能收到完整的 Figma 结构信息
- ✅ 在线和离线使用统一的数据格式传给 LLM
- ✅ 即使 LLM 失败，也能从 enriched nodes 推断真实的模块结构

### 影响范围
- **文件修改**：`src/services/vision-analyzer.ts`
- **新增测试**：`scripts/test-offline-vision.ts`
- **向后兼容**：✅ 不影响在线模式
- **Breaking Change**：❌ 无

### 下一步
1. ✅ 离线模式 vision analyzer 修复完成
2. ⏭️ 运行完整的离线 Pipeline 测试
3. ⏭️ 验证生成的 DSL 是否利用了 enriched nodes 的丰富数据
4. ⏭️ 优化 LLM prompt，充分利用样式和交互信息
