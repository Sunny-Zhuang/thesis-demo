import fs from "node:fs/promises";
import { enrichFigmaNodes } from "./figma-enrich.js";
const LOG_PREFIX = "[figma-api]";
const log = (...args) => console.log(LOG_PREFIX, ...args);
const DEFAULT_FIGMA_API_RETRY_ATTEMPTS = 3;
const DEFAULT_FIGMA_API_RETRY_DELAY_MS = 1000;
const cache = new Map();
/**
 * Simple fuzzy matcher between visual module name and structure node name.
 */
function moduleMatchesNode(moduleName, node) {
    const left = moduleName.toLowerCase();
    const right = node.name.toLowerCase();
    return right.includes(left) || left.includes(right);
}
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, Math.max(0, ms));
    });
}
function parseRetryAfterMs(value) {
    if (!value)
        return null;
    const seconds = Number.parseInt(value, 10);
    if (Number.isFinite(seconds) && seconds >= 0)
        return seconds * 1000;
    const dateMs = Date.parse(value);
    if (!Number.isNaN(dateMs))
        return Math.max(0, dateMs - Date.now());
    return null;
}
async function fetchWithFigmaRetry(url, init, context) {
    const maxAttempts = Math.max(1, Number.parseInt(process.env.FIGMA_API_RETRY_ATTEMPTS ?? String(DEFAULT_FIGMA_API_RETRY_ATTEMPTS), 10) || DEFAULT_FIGMA_API_RETRY_ATTEMPTS);
    const baseDelayMs = Math.max(100, Number.parseInt(process.env.FIGMA_API_RETRY_DELAY_MS ?? String(DEFAULT_FIGMA_API_RETRY_DELAY_MS), 10) || DEFAULT_FIGMA_API_RETRY_DELAY_MS);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const resp = await fetch(url, init);
        if (resp.status !== 429 || attempt === maxAttempts)
            return resp;
        const retryAfterMs = parseRetryAfterMs(resp.headers.get("retry-after"));
        const backoffMs = baseDelayMs * 2 ** (attempt - 1);
        const delayMs = retryAfterMs ?? backoffMs;
        log("figma api hit 429; retrying", { context, attempt, maxAttempts, delayMs });
        await sleep(delayMs);
    }
    throw new Error("unreachable");
}
/**
 * Parses file key from Figma file/design URL.
 */
function extractFileKey(figmaUrl) {
    if (!figmaUrl)
        return undefined;
    const match = figmaUrl.match(/figma\.com\/(?:file|design)\/([^/?#]+)/i);
    return match?.[1];
}
/**
 * Parses node-id from Figma URL and converts to API format (34-12 -> 34:12).
 */
function extractNodeId(figmaUrl) {
    if (!figmaUrl)
        return undefined;
    const match = figmaUrl.match(/[?&]node-id=([^&#]+)/i);
    if (!match)
        return undefined;
    return decodeURIComponent(match[1]).replace(/-/g, ":");
}
/**
 * Resolves PAT token from environment.
 */
function resolveFigmaToken() {
    return process.env.FIGMA_API_KEY || process.env.FIGMA_TOKEN;
}
/**
 * Builds auth headers for Figma API (OAuth first, PAT fallback).
 */
function resolveAuthHeaders() {
    const oauthToken = process.env.FIGMA_OAUTH_TOKEN;
    if (oauthToken) {
        return { Authorization: `Bearer ${oauthToken}` };
    }
    const token = resolveFigmaToken();
    if (!token)
        return undefined;
    return { "X-Figma-Token": token };
}
/**
 * Resolves file key from explicit env or URL-derived value.
 */
function resolveFigmaFileKey(request) {
    return process.env.FIGMA_FILE_KEY || extractFileKey(request.figmaUrl);
}
/**
 * Resolves the node id used as root for design extraction/rendering.
 */
function resolveRootNodeId(request) {
    return request.figmaNodeIds?.[0] || extractNodeId(request.figmaUrl) || "0:1";
}
/**
 * Creates deterministic cache key for enriched node fetches.
 */
function keyForCache(request) {
    return [
        resolveFigmaFileKey(request) ?? "unknown_file",
        resolveRootNodeId(request),
        resolveFigmaToken() ? "has_token" : "no_token"
    ].join("::");
}
/**
 * 从 Figma API 获取完整的 raw JSON（包含样式、布局等完整信息）
 * 然后用 enrich 处理成增强节点
 */
async function fetchEnrichedNodesFromFigmaApi(request) {
    const fileKey = resolveFigmaFileKey(request);
    const rootNodeId = resolveRootNodeId(request);
    const authHeaders = resolveAuthHeaders();
    if (!fileKey || !authHeaders) {
        log("cannot fetch from figma api: missing fileKey or auth headers", {
            hasFileKey: !!fileKey,
            hasAuth: !!authHeaders
        });
        return null;
    }
    try {
        // 使用 Figma nodes API，获取完整的节点数据（包括样式、布局等）
        // depth=10 获取更深的节点树，geometry=true 获取样式和布局信息
        const endpoint = new URL(`https://api.figma.com/v1/files/${fileKey}/nodes`);
        endpoint.searchParams.set("ids", rootNodeId);
        endpoint.searchParams.set("depth", "10");
        endpoint.searchParams.set("geometry", "paths"); // 获取几何和样式信息
        log("fetching from figma api", {
            fileKey,
            rootNodeId,
            endpoint: endpoint.toString()
        });
        const resp = await fetchWithFigmaRetry(endpoint, { headers: authHeaders }, "nodes-fetch");
        if (!resp.ok) {
            log("figma api fetch failed", { status: resp.status, statusText: resp.statusText });
            return null;
        }
        const rawData = await resp.json();
        log("figma api raw data received", {
            hasNodes: !!rawData.nodes,
            nodeCount: rawData.nodes ? Object.keys(rawData.nodes).length : 0
        });
        // 使用 enrich 函数处理 raw JSON
        const enrichedNodes = enrichFigmaNodes(rawData);
        if (!enrichedNodes.length) {
            log("no enriched nodes extracted from figma api response");
            return null;
        }
        log("figma api fetch success", {
            enrichedNodeCount: enrichedNodes.length,
            topLevelTypes: enrichedNodes.slice(0, 5).map(n => n.type)
        });
        return enrichedNodes;
    }
    catch (error) {
        log("figma api fetch threw exception", { error });
        return null;
    }
}
/**
 * Loads local JSON structure file (enriched format).
 */
async function loadNodesFromFile(path) {
    try {
        const raw = await fs.readFile(path, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed.nodes && Array.isArray(parsed.nodes)) {
            log("loaded enriched nodes from file", { path, count: parsed.nodes.length });
            return parsed.nodes;
        }
        // 如果文件不是 enriched format，尝试作为 raw format 处理
        log("file is not enriched format, attempting to enrich", { path });
        const enrichedNodes = enrichFigmaNodes(parsed);
        log("enriched nodes from raw file", { count: enrichedNodes.length });
        return enrichedNodes;
    }
    catch (error) {
        log("failed to load nodes from file", { path, error });
        return [];
    }
}
/**
 * 主入口：获取增强的节点数据
 * 优先级：Figma API (enrich) -> 本地文件
 */
async function fetchEnrichedNodes(request) {
    if (request.offlineMode) {
        log("offline mode enabled; skip live fetch", {
            offlineSourcePath: request.offlineSourcePath,
            mcpStructurePath: request.mcpStructurePath
        });
        return { nodes: [], source: "none" };
    }
    const cacheKey = keyForCache(request);
    const cached = cache.get(cacheKey);
    if (cached) {
        log("enriched nodes cache hit", { cacheKey, source: cached.source, count: cached.nodes.length });
        return cached;
    }
    log("enriched nodes cache miss", { cacheKey });
    // 尝试从 Figma API 获取并 enrich
    const figmaNodes = await fetchEnrichedNodesFromFigmaApi(request);
    if (figmaNodes && figmaNodes.length > 0) {
        const result = { nodes: figmaNodes, source: "figma-api" };
        cache.set(cacheKey, result);
        log("using figma api source", { count: figmaNodes.length });
        return result;
    }
    log("figma api fetch failed or returned no nodes");
    const result = { nodes: [], source: "none" };
    cache.set(cacheKey, result);
    return result;
}
/**
 * Fetches structure nodes for current request.
 * Priority: live Figma API (enriched) -> local file (enriched or raw).
 */
export async function fetchMcpStructure(input) {
    const enrichedResult = await fetchEnrichedNodes(input.request);
    const apiNodes = enrichedResult.nodes;
    log("fetched enriched nodes", {
        source: enrichedResult.source,
        count: apiNodes.length,
        strictLive: input.request.strictLive,
        offlineMode: input.request.offlineMode
    });
    if (input.request.strictLive && !apiNodes.length) {
        throw new Error("strict-live enabled: no live Figma enriched nodes returned; refusing local/mock fallback.");
    }
    // 如果 API 没有返回数据，尝试从本地文件加载
    const fileNodes = input.mcpStructurePath ? await loadNodesFromFile(input.mcpStructurePath) : [];
    const nodes = apiNodes.length ? apiNodes : fileNodes;
    log("node source selected", {
        fromApi: apiNodes.length > 0,
        fileNodeCount: fileNodes.length,
        selectedCount: nodes.length
    });
    if (!nodes.length) {
        log("no nodes available from any source");
        return [];
    }
    // 根据 visual analysis 过滤匹配的节点
    const matched = [];
    for (const module of input.visualAnalysis.modules) {
        const byHint = nodes.filter((node) => module.nodeHintIds?.includes(node.nodeId));
        if (byHint.length) {
            matched.push(...byHint);
            continue;
        }
        matched.push(...nodes.filter((node) => moduleMatchesNode(module.name, node)));
    }
    // Dedupe and keep relevant subset inferred from screenshot understanding.
    const seen = new Set();
    const deduped = matched.filter((node) => {
        if (seen.has(node.nodeId))
            return false;
        seen.add(node.nodeId);
        return true;
    });
    log("matched nodes after visual filtering", {
        matched: matched.length,
        deduped: deduped.length
    });
    return deduped;
}
/**
 * Converts structure nodes into numeric metric view used by DSL builder.
 * Can synthesize fallback metrics when explicit values are absent.
 */
export function convertMcpStructureToMetrics(nodes, nodeIds, allowSyntheticFallback = true) {
    if (!nodes.length) {
        log("no structure nodes for metrics", {
            allowSyntheticFallback,
            nodeIdsCount: nodeIds?.length ?? 0
        });
        if (!allowSyntheticFallback) {
            return [];
        }
        return (nodeIds ?? []).map((nodeId, index) => ({
            nodeId,
            width: index % 2 === 0 ? 320 : 160,
            height: index % 2 === 0 ? 48 : 40,
            x: 24,
            y: 24 + index * 60,
            padding: 12,
            gap: 8,
            fontSize: 14
        }));
    }
    const metrics = nodes.map((node) => ({
        nodeId: node.nodeId,
        width: node.layout?.width,
        height: node.layout?.height,
        x: node.layout?.x,
        y: node.layout?.y,
        padding: node.layout?.padding,
        gap: node.layout?.gap,
        fontSize: node.type === "TEXT" ? 14 : undefined
    }));
    log("generated metrics from structure nodes", { count: metrics.length });
    return metrics;
}
