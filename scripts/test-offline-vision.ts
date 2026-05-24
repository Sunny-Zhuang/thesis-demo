/**
 * 测试离线模式下 vision analyzer 是否能正确读取 enriched nodes
 */

import { analyzeScreenshot } from "../src/services/vision-analyzer.js";
import type { ScreenshotRequest } from "../src/types/state.js";

async function testOfflineVisionAnalysis() {
  console.log("🧪 Testing offline vision analysis with enriched nodes...\n");

  const request: ScreenshotRequest = {
    screenshotPath: "src/data/figma2code-offline/08wDXrTJgBoPVvQzlkKBtV_1_124.png",
    offlineMode: true,
    mcpStructurePath: "src/data/figma2code-offline/enriched-nodes.json",
    rerunFeedbacks: []
  };

  try {
    const result = await analyzeScreenshot(request);

    console.log("✅ Vision analysis completed!\n");
    console.log("📊 Results:");
    console.log("  Summary:", result.summary);
    console.log("  Modules count:", result.modules.length);
    console.log("  Reusable candidates:", result.reusableCandidates?.length ?? 0);
    console.log("\n📦 Modules:");
    result.modules.forEach((module, i) => {
      console.log(`  ${i + 1}. ${module.name}`);
      console.log(`     - Description: ${module.description}`);
      console.log(`     - Node hints: ${module.nodeHintIds?.join(", ") ?? "none"}`);
      console.log(`     - Interactions: ${module.interactions?.length ?? 0}`);
    });

    console.log("\n🎨 Global Layout:");
    console.log("  Padding:", result.globalLayout.padding);
    console.log("  Gap:", result.globalLayout.gap);
    console.log("  Direction:", result.globalLayout.direction);

    if (result.reusableCandidates?.length) {
      console.log("\n♻️  Reusable Candidates:");
      result.reusableCandidates.forEach((candidate, i) => {
        console.log(`  ${i + 1}. ${candidate.name}`);
        console.log(`     Reason: ${candidate.reason}`);
      });
    }

    console.log("\n✨ Test PASSED: Vision analyzer successfully used enriched nodes in offline mode!");
  } catch (error) {
    console.error("❌ Test FAILED:", error);
    process.exit(1);
  }
}

testOfflineVisionAnalysis().catch(console.error);
