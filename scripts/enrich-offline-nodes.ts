/**
 * 增强离线 JSON 数据质量的脚本
 * 从 raw_metadata.json 提取更多 MCP 字段
 */

import fs from "node:fs/promises";
import { enrichFigmaNodes } from "../src/services/figma-enrich.js";

async function enrichOfflineData(inputPath: string, outputPath: string) {
  const raw = await fs.readFile(inputPath, "utf-8");
  const parsed = JSON.parse(raw);

  const enrichedNodes = enrichFigmaNodes(parsed);

  if (!enrichedNodes.length) {
    throw new Error(`No nodes could be enriched from ${inputPath}`);
  }

  await fs.writeFile(
    outputPath,
    JSON.stringify({ nodes: enrichedNodes }, null, 2),
    "utf-8"
  );

  console.log(`✅ Enriched ${enrichedNodes.length} nodes`);
  console.log(`📁 Output: ${outputPath}`);
}

// CLI usage
const inputPath = process.argv[2] ?? "src/data/figma2code-offline/raw_metadata.json";
const outputPath = process.argv[3] ?? "src/data/figma2code-offline/enriched-nodes.json";

enrichOfflineData(inputPath, outputPath).catch(console.error);
