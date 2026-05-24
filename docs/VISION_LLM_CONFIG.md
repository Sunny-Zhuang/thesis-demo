# Vision LLM 配置指南

## 🔍 问题：LLM 调用失败

如果看到错误：
```
[vision-analyzer] llm call failed {
  status: 403,
  message: "This token has no access to model gpt-4o-mini"
}
```

这说明 API token 没有访问当前配置模型的权限。

## ✅ 解决方案

### 方案 1: 使用环境变量配置模型（推荐）

在 `.env` 文件中添加：

```bash
# Vision LLM 配置
VISION_LLM_API_URL="https://ergouzi.life/v1/chat/completions"
VISION_LLM_TOKEN="your-api-token-here"
VISION_LLM_MODEL="gpt-3.5-turbo"  # 使用你有权限访问的模型
```

**可用模型列表**（根据你的 API 提供商）：
- `gpt-3.5-turbo` - 最通用，速度快
- `gpt-4o` - 更强大
- `gpt-4o-mini` - 需要特定权限
- `gpt-4-turbo` - 需要特定权限

### 方案 2: 修改代码中的默认值

编辑 `src/services/vision-analyzer.ts`:

```typescript
const DEFAULT_VISION_LLM_MODEL = "gpt-3.5-turbo"; // 改为你有权限的模型
const FALLBACK_VISION_LLM_MODEL = "gpt-3.5-turbo";
```

### 方案 3: 临时跳过 LLM 调用

如果暂时不需要 LLM 分析，可以设置环境变量：

```bash
# 在 .env 中注释掉或删除
# VISION_LLM_TOKEN=""
```

这样 Vision Analyzer 会直接使用 enriched nodes 的 fallback 逻辑，仍然可以工作。

## 🔄 Fallback 机制

当前代码有自动 fallback 机制：

1. **尝试主模型** → `gpt-4o-mini`（如果配置）
2. **如果失败且是 403** → 自动尝试 `gpt-3.5-turbo`
3. **如果 LLM 完全失败** → 使用 enriched nodes 推断结构

## 🧪 测试配置

测试 LLM 配置是否正确：

```bash
# 1. 更新 .env 文件
echo 'VISION_LLM_MODEL="gpt-3.5-turbo"' >> .env

# 2. 重新编译
npm run build

# 3. 测试离线模式
npx tsx scripts/test-offline-vision.ts
```

## 📊 当前默认配置

```typescript
// src/services/vision-analyzer.ts
DEFAULT_VISION_LLM_API_URL = "https://ergouzi.life/chat/completions"
DEFAULT_VISION_LLM_MODEL = "gpt-4o-mini"
FALLBACK_VISION_LLM_MODEL = "gpt-3.5-turbo"  // ✅ 已修复
```

## ✨ 推荐配置（针对你的 API）

创建或更新 `.env`:

```bash
# Vision LLM - 使用最稳定的配置
VISION_LLM_API_URL="https://ergouzi.life/v1/chat/completions"
VISION_LLM_TOKEN="sk-7T9ohVgZYSOFbBSgPfyHeOBKAAk58vhq8CC1QvrGBjvLcbeR"
VISION_LLM_MODEL="gpt-3.5-turbo"

# 如果你的 token 有 gpt-4o 权限，可以使用更强的模型：
# VISION_LLM_MODEL="gpt-4o"
```

## 🎯 验证是否生效

运行测试后，应该看到：

```
✅ 如果 LLM 调用成功：
[vision-analyzer] llm vision response received {
  moduleCount: X,
  reusableCount: Y
}

✅ 如果使用 fallback（也是正常的）：
Summary: Screenshot + enriched nodes (offline)
Modules count: 8
```

两种情况都能正常工作！
