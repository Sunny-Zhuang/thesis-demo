import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { createPipeline } from "./graph/pipeline.js";
import { ensureLocalScreenshotPath } from "./services/mcp-figma-client.js";
import { enrichFigmaNodes } from "./services/figma-enrich.js";
const LOG_PREFIX = "[thesis-demo]";
const log = (...args) => console.log(LOG_PREFIX, ...args);
const DEFAULT_OFFLINE_DATA_PATH = "src/data/figma2code_rows_test_offset0_length1.json";
/**
 * Wraps readline lifecycle so every interactive block safely closes handles.
 */
async function withReadline(fn) {
    const rl = readline.createInterface({ input, output });
    try {
        return await fn(rl);
    }
    finally {
        rl.close();
    }
}
/**
 * Collects yes/no decisions for detected reusable component candidates.
 */
async function collectReviewDecisions(state) {
    const decisions = {};
    await withReadline(async (rl) => {
        for (const candidate of state.reuseCandidates ?? []) {
            const answer = await rl.question(`Approve reusable component "${candidate.name}" (${candidate.reason})? [y/N]: `);
            decisions[candidate.id] = /^y(es)?$/i.test(answer.trim());
        }
    });
    log("reuse review decisions", decisions);
    return decisions;
}
/**
 * Ensures the DSL output directory exists before writing generated files.
 */
async function ensureOutputDir() {
    const dir = path.resolve("generated-dsl");
    await fs.mkdir(dir, { recursive: true });
    return dir;
}
/**
 * Persists one attempt's DSL output as a timestamped JSON artifact.
 */
async function writeDslFile(dsl, attempt) {
    const outputDir = await ensureOutputDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(outputDir, `dsl-attempt-${attempt}-${timestamp}.json`);
    await fs.writeFile(filePath, `${JSON.stringify(dsl, null, 2)}\n`, "utf-8");
    return filePath;
}
/**
 * Collects DSL approval result and optional rerun feedback.
 */
async function collectDslReviewDecision(dslFilePath) {
    return withReadline(async (rl) => {
        const approve = await rl.question(`Approve DSL at "${dslFilePath}"? [y/N]: `);
        if (/^y(es)?$/i.test(approve.trim())) {
            return { approved: true };
        }
        const feedback = await rl.question("DSL rejected. Provide feedback for rerun (optional): ");
        return { approved: false, feedback: feedback.trim() || undefined };
    });
}
/**
 * Executes one LangGraph run and resolves all review gates interactively.
 */
async function runOneAttempt(initialState) {
    log("starting graph attempt", {
        strictLive: initialState.request.strictLive,
        figmaUrl: initialState.request.figmaUrl,
        screenshotPath: initialState.request.screenshotPath
    });
    const graph = createPipeline();
    let state = initialState;
    while (true) {
        state = (await graph.invoke(state));
        log("graph pass completed", {
            waitingForReview: state.waitingForReview,
            reviewStage: state.reviewStage,
            retryCount: state.retryCount,
            stopProcessing: state.stopProcessing,
            messages: state.messages
        });
        if (state.waitingForReview && state.reviewStage === "reuse") {
            state = {
                ...state,
                reuseReviewDecisions: await collectReviewDecisions(state)
            };
            continue;
        }
        if (state.waitingForReview && state.reviewStage === "dsl") {
            const dslFilePath = await writeDslFile(state.dsl, (state.retryCount ?? 0) + 1);
            const dslReview = await collectDslReviewDecision(dslFilePath);
            state = {
                ...state,
                dslReviewApproved: dslReview.approved,
                dslReviewFeedback: dslReview.feedback
            };
            continue;
        }
        if (!state.waitingForReview) {
            break;
        }
    }
    if (!state.dsl) {
        throw new Error("Pipeline finished without producing DSL.");
    }
    log("attempt completed", {
        messages: state.messages,
        hasDsl: !!state.dsl,
        stopProcessing: state.stopProcessing
    });
    return state;
}
function sanitize(value) {
    return value.replace(/[^\w.-]+/g, "_");
}
// 已移除旧的 mapProcessedNodeToMcp 函数，统一使用 enrichFigmaNodes
async function buildRequestFromOfflineFigma2Code(offlinePath, strictLiveInput) {
    const resolvedPath = path.resolve(offlinePath);
    const raw = await fs.readFile(resolvedPath, "utf-8");
    const parsed = JSON.parse(raw);
    const row = parsed.rows?.[0]?.row;
    if (!row) {
        throw new Error(`Offline data file has no rows[0].row: ${resolvedPath}`);
    }
    const nodeId = row.node_id;
    const sampleKey = `${row.filekey ?? "unknown"}_${sanitize(nodeId ?? "unknown")}`;
    const outputDir = path.resolve("src/data/figma2code-offline");
    await fs.mkdir(outputDir, { recursive: true });
    const screenshotPathCandidate = path.join(outputDir, `${sampleKey}.png`);
    let screenshotPath;
    try {
        await fs.access(screenshotPathCandidate);
        screenshotPath = screenshotPathCandidate;
        log("reusing offline screenshot cache", { screenshotPath });
    }
    catch {
        const imageUrl = row.root?.src;
        if (imageUrl) {
            try {
                const imageResp = await fetch(imageUrl);
                if (imageResp.ok) {
                    const imageBytes = Buffer.from(await imageResp.arrayBuffer());
                    await fs.writeFile(screenshotPathCandidate, imageBytes);
                    screenshotPath = screenshotPathCandidate;
                    log("downloaded offline screenshot", { screenshotPath, imageUrl });
                }
                else {
                    log("offline screenshot download failed with status", { status: imageResp.status });
                }
            }
            catch (error) {
                log("offline screenshot download failed; continue without screenshot", { error });
            }
        }
        else {
            log("offline row has no root.src; continue without screenshot", {
                offlineSourcePath: resolvedPath
            });
        }
    }
    let mcpStructurePath;
    if (row.processed_metadata) {
        try {
            const processed = JSON.parse(row.processed_metadata);
            // 使用统一的 enrich 函数处理
            const nodes = enrichFigmaNodes(processed);
            if (nodes.length) {
                mcpStructurePath = path.join(outputDir, `${sampleKey}-nodes.json`);
                await fs.writeFile(mcpStructurePath, `${JSON.stringify({ nodes }, null, 2)}\n`, "utf-8");
                log("enriched offline nodes", { count: nodes.length, path: mcpStructurePath });
            }
        }
        catch (error) {
            log("failed to parse processed_metadata into local nodes", { error });
        }
    }
    return {
        screenshotPath,
        strictLive: false,
        figmaUrl: row.page_url,
        figmaNodeIds: nodeId ? [nodeId] : undefined,
        mcpStructurePath,
        offlineMode: true,
        offlineSourcePath: resolvedPath,
        rerunFeedbacks: [],
        pageName: strictLiveInput ? "offline-ignore-strict-live" : undefined
    };
}
/**
 * CLI entrypoint:
 * - parse args
 * - build request
 * - run graph
 * - orchestrate human review loop
 */
async function run() {
    const rawArgs = process.argv.slice(2);
    const strictLive = rawArgs.includes("--strict-live");
    const offlineFlagIndex = rawArgs.findIndex((arg) => arg === "--offline");
    let offlinePath;
    const argsWithoutModeFlags = [...rawArgs];
    if (offlineFlagIndex >= 0) {
        const maybePath = rawArgs[offlineFlagIndex + 1];
        offlinePath = maybePath && !maybePath.startsWith("--") ? maybePath : DEFAULT_OFFLINE_DATA_PATH;
        argsWithoutModeFlags.splice(offlineFlagIndex, maybePath && !maybePath.startsWith("--") ? 2 : 1);
    }
    const positionalArgs = argsWithoutModeFlags.filter((arg) => arg !== "--strict-live");
    const arg2 = positionalArgs[0];
    const arg3 = positionalArgs[1];
    const arg4 = positionalArgs[2];
    // 输入可以解析json和sigma url，后期实验需要用json格式
    const isUrl = (value) => !!value && (value.startsWith("http") || value.startsWith("figma://"));
    const isJsonPath = (value) => !!value && value.toLowerCase().endsWith(".json");
    const screenshotPath = arg2 && !isUrl(arg2) ? arg2 : undefined;
    const figmaUrl = isUrl(arg2) ? arg2 : isUrl(arg3) ? arg3 : isUrl(arg4) ? arg4 : undefined;
    const mcpStructurePath = isJsonPath(arg2) ? arg2 : isJsonPath(arg3) ? arg3 : isJsonPath(arg4) ? arg4 : undefined;
    log("parsed args", {
        rawArgs,
        strictLive,
        offlineMode: !!offlinePath,
        offlinePath,
        screenshotPath,
        figmaUrl,
        mcpStructurePath
    });
    if (!offlinePath && !screenshotPath && !figmaUrl) {
        throw new Error("Usage: npm run dev -- [--strict-live] <screenshot-path|figma-url> [mcp-structure-json-path|figma-url]\n" +
            "   or: npm run dev -- --offline [src/data/figma2code_rows_test_offset0_length1.json]");
    }
    if (!offlinePath && strictLive && !figmaUrl) {
        throw new Error("strict-live requires a figma-url input.");
    }
    const baseRequest = offlinePath
        ? await buildRequestFromOfflineFigma2Code(offlinePath, strictLive)
        : (() => {
            const nodeIdMatch = figmaUrl?.match(/[?&]node-id=([^&#]+)/i);
            const nodeId = nodeIdMatch ? decodeURIComponent(nodeIdMatch[1]).replace(/-/g, ":") : undefined;
            return {
                screenshotPath,
                strictLive,
                mcpStructurePath,
                figmaUrl,
                figmaNodeIds: nodeId ? [nodeId] : ["1:1", "1:2", "1:3", "1:4"],
                rerunFeedbacks: []
            };
        })();
    const effectiveScreenshotPath = await ensureLocalScreenshotPath(baseRequest);
    if (effectiveScreenshotPath) {
        baseRequest.screenshotPath = effectiveScreenshotPath;
        if (!screenshotPath) {
            console.log(`Auto-fetched screenshot from Figma: ${effectiveScreenshotPath}`);
        }
    }
    else if (strictLive) {
        throw new Error("strict-live enabled: failed to fetch screenshot from live Figma.");
    }
    const baseState = {
        request: {
            ...baseRequest
        },
        retryCount: 0,
        maxRetryCount: 2,
        messages: []
    };
    log("running graph workflow", { request: baseState.request });
    const finalState = await runOneAttempt(baseState);
    const finalDslPath = await writeDslFile(finalState.dsl, (finalState.retryCount ?? 0) + 1);
    console.log(`\nFinal DSL file: ${finalDslPath}`);
    if (finalState.stopProcessing) {
        console.log("\nDSL review rejected and max retry reached. Workflow ended.");
        return;
    }
    console.log("\nDSL approved and workflow finished.");
}
run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
