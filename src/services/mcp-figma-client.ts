import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { generateMCPResponse, type MCPResponse } from "@tmegit/figma-to-code-mcp";
import fs from "node:fs/promises";
import path from "node:path";
import type { ScreenshotRequest } from "../types/state.js";

const LOG_PREFIX = "[mcp-figma-client]";
const log = (...args: unknown[]): void => console.log(LOG_PREFIX, ...args);
const DEFAULT_DIRECT_SDK_TIMEOUT_MS = 8000;
const DEFAULT_FIGMA_API_RETRY_ATTEMPTS = 3;
const DEFAULT_FIGMA_API_RETRY_DELAY_MS = 1000;

type CompactSource = "mcp-adapter" | "direct-sdk" | "figma-api" | "none";

interface CompactFetchResult {
  response: MCPResponse | null;
  source: CompactSource;
}

const cache = new Map<string, CompactFetchResult>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

async function fetchWithFigmaRetry(
  url: URL | string,
  init: RequestInit,
  context: string
): Promise<Response> {
  const maxAttempts = Math.max(
    1,
    Number.parseInt(
      process.env.FIGMA_API_RETRY_ATTEMPTS ?? String(DEFAULT_FIGMA_API_RETRY_ATTEMPTS),
      10
    ) || DEFAULT_FIGMA_API_RETRY_ATTEMPTS
  );
  const baseDelayMs = Math.max(
    100,
    Number.parseInt(
      process.env.FIGMA_API_RETRY_DELAY_MS ?? String(DEFAULT_FIGMA_API_RETRY_DELAY_MS),
      10
    ) || DEFAULT_FIGMA_API_RETRY_DELAY_MS
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const resp = await fetch(url, init);
    if (resp.status !== 429 || attempt === maxAttempts) return resp;
    const retryAfterMs = parseRetryAfterMs(resp.headers.get("retry-after"));
    const backoffMs = baseDelayMs * 2 ** (attempt - 1);
    const delayMs = retryAfterMs ?? backoffMs;
    log("figma api hit 429; retrying", { context, attempt, maxAttempts, delayMs });
    await sleep(delayMs);
  }
  throw new Error("unreachable");
}

/**
 * Prints compact response in a debug-friendly way for local inspection.
 */
function printCompactStructure(
  response: MCPResponse,
  source: Exclude<CompactSource, "none">,
  request: ScreenshotRequest
): void {
  const summary = {
    source,
    figmaUrl: request.figmaUrl,
    schema: response.schema,
    root: {
      id: response.root.id,
      type: response.root.type,
      name: response.root.name,
      childCount: response.root.children?.length ?? 0
    },
    definitionsCount: Object.keys(response.definitions ?? {}).length,
    componentSetsCount: Object.keys(response.componentSets ?? {}).length,
    tokenGroups: Object.keys(response.tokens ?? {})
  };
  log("compact structure summary", summary);
  console.log("[compact-structure-json]", JSON.stringify(response, null, 2));
}

function mapFigmaNodeToCompactV3(node: unknown): MCPResponse["root"] | null {
  if (!node || typeof node !== "object") return null;
  const figmaNode = node as {
    id?: unknown;
    type?: unknown;
    name?: unknown;
    characters?: unknown;
    children?: unknown;
  };
  if (typeof figmaNode.type !== "string") return null;
  const children = Array.isArray(figmaNode.children)
    ? figmaNode.children
        .map((child) => mapFigmaNodeToCompactV3(child))
        .filter((child): child is NonNullable<ReturnType<typeof mapFigmaNodeToCompactV3>> => !!child)
    : undefined;
  return {
    id: typeof figmaNode.id === "string" ? figmaNode.id : undefined,
    type: figmaNode.type,
    name: typeof figmaNode.name === "string" ? figmaNode.name : undefined,
    text: typeof figmaNode.characters === "string" ? figmaNode.characters : undefined,
    children
  };
}

/**
 * Parses file key from Figma file/design URL.
 */
function extractFileKey(figmaUrl?: string): string | undefined {
  if (!figmaUrl) return undefined;
  const match = figmaUrl.match(/figma\.com\/(?:file|design)\/([^/?#]+)/i);
  return match?.[1];
}

/**
 * Parses node-id from Figma URL and converts to API format (34-12 -> 34:12).
 */
function extractNodeId(figmaUrl?: string): string | undefined {
  if (!figmaUrl) return undefined;
  const match = figmaUrl.match(/[?&]node-id=([^&#]+)/i);
  if (!match) return undefined;
  return decodeURIComponent(match[1]).replace(/-/g, ":");
}

/**
 * Resolves PAT token from environment.
 */
function resolveFigmaToken(): string | undefined {
  return process.env.FIGMA_API_KEY || process.env.FIGMA_TOKEN;
}

/**
 * Builds auth headers for Figma API (OAuth first, PAT fallback).
 */
function resolveAuthHeaders(): Record<string, string> | undefined {
  const oauthToken = process.env.FIGMA_OAUTH_TOKEN;
  if (oauthToken) {
    return { Authorization: `Bearer ${oauthToken}` };
  }
  const token = resolveFigmaToken();
  if (!token) return undefined;
  return { "X-Figma-Token": token };
}

/**
 * Resolves file key from explicit env or URL-derived value.
 */
function resolveFigmaFileKey(request: ScreenshotRequest): string | undefined {
  return process.env.FIGMA_FILE_KEY || extractFileKey(request.figmaUrl);
}

/**
 * Resolves the node id used as root for design extraction/rendering.
 */
function resolveRootNodeId(request: ScreenshotRequest): string {
  return request.figmaNodeIds?.[0] || extractNodeId(request.figmaUrl) || "0:1";
}

/**
 * Sanitizes arbitrary key fragments into filesystem-safe names.
 */
function sanitize(value: string): string {
  return value.replace(/[^\w.-]+/g, "_");
}

/**
 * Creates deterministic cache key for compact design fetches.
 */
function keyForCache(request: ScreenshotRequest): string {
  return [
    resolveFigmaFileKey(request) ?? "unknown_file",
    resolveRootNodeId(request),
    resolveFigmaToken() ? "has_token" : "no_token"
  ].join("::");
}

/**
 * Attempts to extract JSON text from various MCP tool output shapes.
 */
function extractJsonString(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw !== null) {
    const maybeText = (raw as { text?: unknown }).text;
    if (typeof maybeText === "string") return maybeText;
    const maybeContent = (raw as { content?: unknown }).content;
    if (typeof maybeContent === "string") return maybeContent;
    if (Array.isArray(maybeContent)) {
      for (const item of maybeContent) {
        const text = extractJsonString(item);
        if (text) return text;
      }
    }
  }
  return null;
}

/**
 * Parses MCP design response from native object or text payload.
 */
function parseMcpResponse(raw: unknown): MCPResponse | null {
  if (!raw) return null;
  if (typeof raw === "object" && raw !== null && "schema" in raw && "root" in raw) {
    return raw as MCPResponse;
  }
  const text = extractJsonString(raw);
  if (!text) return null;
  try {
    return JSON.parse(text) as MCPResponse;
  } catch {
    return null;
  }
}

/**
 * Fetches compact design through live MCP server tool invocation.
 */
async function tryFetchViaMcpAdapter(request: ScreenshotRequest): Promise<MCPResponse | null> {
  const figmaToken = resolveFigmaToken();
  const fileKey = resolveFigmaFileKey(request);
  if (!figmaToken || !fileKey) return null;
  log("trying mcp-adapter fetch", { fileKey, rootNodeId: resolveRootNodeId(request) });

  const client = new MultiServerMCPClient({
    throwOnLoadError: false,
    onConnectionError: "ignore",
    useStandardContentBlocks: true,
    mcpServers: {
      figma: {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@tmegit/figma-to-code-mcp", "--stdio", "--json"],
        env: {
          FIGMA_API_KEY: figmaToken
        }
      }
    }
  });

  try {
    const tools = await client.getTools("figma");
    const designTool = tools.find((tool) => tool.name.includes("get_figma_design"));
    if (!designTool) {
      log("get_figma_design tool not found");
      return null;
    }

    const rootNodeId = resolveRootNodeId(request);
    const candidates: Record<string, unknown>[] = [
      { fileKey, nodeId: rootNodeId },
      { fileKey, rootNodeId },
      request.figmaUrl ? { figmaUrl: request.figmaUrl } : {},
      request.figmaUrl ? { url: request.figmaUrl } : {}
    ].filter((entry) => Object.keys(entry).length > 0);

    for (const args of candidates) {
      try {
        log("invoking get_figma_design", args);
        const output = await designTool.invoke(args);
        const parsed = parseMcpResponse(output);
        if (parsed) {
          log("mcp-adapter fetch success", { rootType: parsed.root.type, hasChildren: !!parsed.root.children?.length });
          return parsed;
        }
      } catch {
        // Try next shape, MCP tool schema can vary by version.
        log("get_figma_design invocation failed for args shape");
      }
    }
    log("mcp-adapter fetch failed for all arg shapes");
    return null;
  } finally {
    await client.close();
  }
}

/**
 * Fallback compact design fetch via direct SDK helper call.
 */
async function tryFetchViaDirectSdk(request: ScreenshotRequest): Promise<MCPResponse | null> {
  const figmaToken = resolveFigmaToken();
  const fileKey = resolveFigmaFileKey(request);
  if (!figmaToken || !fileKey) return null;

  try {
    const rootNodeId = resolveRootNodeId(request);
    const timeoutMs = Number.parseInt(
      process.env.DIRECT_SDK_TIMEOUT_MS ?? String(DEFAULT_DIRECT_SDK_TIMEOUT_MS),
      10
    );
    log("trying direct-sdk fetch", { fileKey, rootNodeId, timeoutMs });
    const sdkPromise = generateMCPResponse({
      fileKey,
      rootNodeId,
      authHeaders: { "X-Figma-Token": figmaToken },
      resolveVariables: true
    });
    const response = await Promise.race([
      sdkPromise,
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), Math.max(1000, Number.isNaN(timeoutMs) ? DEFAULT_DIRECT_SDK_TIMEOUT_MS : timeoutMs));
      })
    ]);
    if (!response) {
      log("direct-sdk fetch timed out; fallback to next source");
      return null;
    }
    log("direct-sdk fetch success", { rootType: response.root.type, hasChildren: !!response.root.children?.length });
    return response;
  } catch {
    log("direct-sdk fetch failed");
    return null;
  }
}

/**
 * Last-resort compact fetch by calling Figma REST API directly and converting
 * the returned node tree into a minimal MCPResponse-compatible structure.
 */
async function tryFetchViaFigmaApi(request: ScreenshotRequest): Promise<MCPResponse | null> {
  const fileKey = resolveFigmaFileKey(request);
  const rootNodeId = resolveRootNodeId(request);
  const authHeaders = resolveAuthHeaders();
  if (!fileKey || !authHeaders) return null;

  try {
    const endpoint = new URL(`https://api.figma.com/v1/files/${fileKey}/nodes`);
    endpoint.searchParams.set("ids", rootNodeId);
    endpoint.searchParams.set("depth", "8");
    log("trying figma-api fetch", { fileKey, rootNodeId, endpoint: endpoint.toString() });
    const resp = await fetchWithFigmaRetry(endpoint, { headers: authHeaders }, "compact-nodes");
    if (!resp.ok) {
      log("figma-api fetch failed", { status: resp.status });
      return null;
    }
    const body = (await resp.json()) as {
      nodes?: Record<string, { document?: unknown }>;
    };
    console.log("[figma-api-raw-json]", JSON.stringify(body, null, 2));
    const rootRaw = body.nodes?.[rootNodeId]?.document;
    const root = mapFigmaNodeToCompactV3(rootRaw);
    if (!root) {
      log("figma-api fetch returned no valid root document");
      return null;
    }
    const converted: MCPResponse = {
      schema: "v3",
      root
    };
    log("figma-api fetch success", { rootType: root.type, hasChildren: !!root.children?.length });
    return converted;
  } catch {
    log("figma-api fetch threw exception");
    return null;
  }
}

/**
 * Main compact design fetch API with in-memory cache and fallback chain.
 */
export async function fetchCompactFigmaDesign(
  request: ScreenshotRequest
): Promise<CompactFetchResult> {
  if (request.offlineMode) {
    log("offline mode enabled; skip live compact fetch", {
      offlineSourcePath: request.offlineSourcePath,
      mcpStructurePath: request.mcpStructurePath
    });
    return { response: null, source: "none" };
  }

  const cacheKey = keyForCache(request);
  const cached = cache.get(cacheKey);
  const debugProbeAll = process.env.DEBUG_COMPACT_FETCH_ALL !== "0";
  if (cached && !debugProbeAll) {
    log("compact design cache hit", { cacheKey, source: cached.source });
    return cached;
  }
  if (cached && debugProbeAll) {
    log("compact design cache bypassed for debug", { cacheKey, source: cached.source });
  } else {
    log("compact design cache miss", { cacheKey });
  }

  const viaMcp = await tryFetchViaMcpAdapter(request);
  if (viaMcp && debugProbeAll) {
    printCompactStructure(viaMcp, "mcp-adapter", request);
  }

  const viaFigmaApi = await tryFetchViaFigmaApi(request);
  if (viaFigmaApi && debugProbeAll) {
    printCompactStructure(viaFigmaApi, "figma-api", request);
  }

  const viaSdk = await tryFetchViaDirectSdk(request);
  if (viaSdk && debugProbeAll) {
    printCompactStructure(viaSdk, "direct-sdk", request);
  }

  const selected = viaMcp
    ? { response: viaMcp, source: "mcp-adapter" as const }
    : viaSdk
      ? { response: viaSdk, source: "direct-sdk" as const }
      : viaFigmaApi
        ? { response: viaFigmaApi, source: "figma-api" as const }
        : null;

  if (selected) {
    log("compact design selected source for llm", {
      source: selected.source,
      rootType: selected.response.root.type,
      childCount: selected.response.root.children?.length ?? 0
    });
    const result: CompactFetchResult = selected;
    cache.set(cacheKey, result);
    return result;
  }

  const result: CompactFetchResult = { response: null, source: "none" };
  log("compact design unavailable");
  cache.set(cacheKey, result);
  return result;
}

/**
 * Ensures local screenshot availability.
 * - Uses provided path if valid.
 * - Otherwise renders/downloads from live Figma API.
 */
export async function ensureLocalScreenshotPath(
  request: ScreenshotRequest
): Promise<string | undefined> {
  if (request.offlineMode) {
    return request.screenshotPath;
  }

  if (request.screenshotPath) {
    try {
      await fs.access(request.screenshotPath);
      log("using provided screenshot path", { screenshotPath: request.screenshotPath });
      return request.screenshotPath;
    } catch {
      // Fall through to auto-fetch from Figma.
      log("provided screenshot path not accessible; attempting live fetch");
    }
  }

  const fileKey = resolveFigmaFileKey(request);
  const rootNodeId = resolveRootNodeId(request);
  const authHeaders = resolveAuthHeaders();
  if (!fileKey || !authHeaders) {
    log("cannot fetch screenshot: missing fileKey or auth headers", { hasFileKey: !!fileKey, hasAuth: !!authHeaders });
    return undefined;
  }

  try {
    const endpoint = new URL(`https://api.figma.com/v1/images/${fileKey}`);
    endpoint.searchParams.set("ids", rootNodeId);
    endpoint.searchParams.set("format", "png");
    endpoint.searchParams.set("scale", "2");
    const imageMeta = await fetchWithFigmaRetry(endpoint, { headers: authHeaders }, "images-meta");
    if (!imageMeta.ok) {
      log("figma images endpoint failed", { status: imageMeta.status });
      return undefined;
    }
    const body = (await imageMeta.json()) as { images?: Record<string, string | null> };
    const imageUrl =
      body.images?.[rootNodeId] ?? Object.values(body.images ?? {}).find((entry) => !!entry) ?? null;
    if (!imageUrl) {
      log("no image url returned by figma images endpoint");
      return undefined;
    }
    const imageResp = await fetchWithFigmaRetry(imageUrl, {}, "images-download");
    if (!imageResp.ok) {
      log("downloading image url failed", { status: imageResp.status });
      return undefined;
    }
    const outputDir = path.resolve("generated-screenshots");
    await fs.mkdir(outputDir, { recursive: true });
    const fileName = `${sanitize(fileKey)}-${sanitize(rootNodeId)}.png`;
    const outputPath = path.join(outputDir, fileName);
    const data = Buffer.from(await imageResp.arrayBuffer());
    await fs.writeFile(outputPath, data);
    log("saved live screenshot", { outputPath });
    return outputPath;
  } catch {
    log("failed to auto-fetch screenshot from figma");
    return undefined;
  }
}

export { extractNodeId, extractFileKey, resolveRootNodeId };
export type { MCPResponse };
