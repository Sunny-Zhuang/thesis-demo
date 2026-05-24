import fs from "node:fs/promises";
import path from "node:path";
import { fetchCompactFigmaDesign } from "./mcp-figma-client.js";
import { z } from "zod";
const LOG_PREFIX = "[vision-analyzer]";
const log = (...args) => console.log(LOG_PREFIX, ...args);
const interactionSchema = z.object({
    trigger: z.string(),
    action: z.string(),
    target: z.string().optional()
});
const moduleSchema = z.object({
    name: z.string(),
    description: z.string(),
    nodeHintIds: z.array(z.string()).optional(),
    interactions: z.array(interactionSchema).optional()
});
const reusableCandidateSchema = z.object({
    name: z.string(),
    reason: z.string(),
    nodePaths: z.array(z.string()).optional()
});
const visionLlmSchema = z.object({
    summary: z.string().optional(),
    structuralNotes: z.array(z.string()).optional(),
    globalLayout: z
        .object({
        padding: z.number().optional(),
        margin: z.number().optional(),
        gap: z.number().optional(),
        direction: z.enum(["vertical", "horizontal"]).optional()
    })
        .optional(),
    modules: z.array(moduleSchema).optional(),
    reusableCandidates: z.array(reusableCandidateSchema).optional()
});
const DEFAULT_VISION_LLM_MODEL = "gpt-4o-mini";
function extractJsonPayload(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return null;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        // Continue with JSON block extraction.
    }
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
        try {
            return JSON.parse(fenced[1]);
        }
        catch {
            // Continue with object extraction.
        }
    }
    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
        const maybeJson = trimmed.slice(objectStart, objectEnd + 1);
        try {
            return JSON.parse(maybeJson);
        }
        catch {
            return null;
        }
    }
    return null;
}
function normalizeReusableCandidates(raw) {
    if (!raw?.length)
        return [];
    return raw.map((item, index) => ({
        id: `vision_reuse_${index + 1}_${item.name}`.replace(/\W+/g, "_"),
        name: item.name,
        reason: item.reason,
        nodePaths: item.nodePaths ?? []
    }));
}
function buildCompactContext(root) {
    if (!root)
        return undefined;
    return {
        root: {
            id: root.id,
            name: root.name,
            type: root.type,
            layout: root.layout,
            style: root.style
        },
        children: (root.children ?? []).slice(0, 20).map((child) => ({
            id: child.id,
            name: child.name,
            type: child.type,
            layout: child.layout,
            style: child.style,
            interactions: child.interactions
        }))
    };
}
/**
 * 将 enriched nodes 转换为 LLM 可理解的 compact context 格式
 */
function buildCompactContextFromEnrichedNodes(nodes) {
    if (!nodes.length)
        return undefined;
    // 找到根节点（通常是第一个 FRAME 或 CANVAS）
    const rootNode = nodes[0];
    // 转换 layout direction
    const convertDirection = (dir) => {
        if (dir === "horizontal")
            return "row";
        if (dir === "vertical")
            return "column";
        return undefined;
    };
    return {
        root: {
            id: rootNode.nodeId,
            name: rootNode.name,
            type: rootNode.type,
            layout: {
                width: rootNode.layout?.width,
                height: rootNode.layout?.height,
                direction: convertDirection(rootNode.layout?.direction),
                padding: rootNode.layout?.padding,
                gap: rootNode.layout?.gap
            },
            style: rootNode.style
        },
        children: nodes.slice(1, 21).map((node) => ({
            id: node.nodeId,
            name: node.name,
            type: node.type,
            layout: {
                width: node.layout?.width,
                height: node.layout?.height,
                direction: convertDirection(node.layout?.direction),
                padding: node.layout?.padding,
                gap: node.layout?.gap
            },
            style: node.style,
            interactions: node.interactions
        }))
    };
}
function inferModulesFromCompact(root) {
    if (!root?.children?.length)
        return [];
    return root.children.slice(0, 8).map((child) => ({
        name: child.name || child.type || "Module",
        description: `Inferred from compact Figma node (${child.type})`,
        nodeHintIds: child.id ? [child.id] : undefined,
        interactions: child.interactions?.map((entry) => ({
            trigger: entry.trigger,
            action: entry.action,
            target: entry.destination
        }))
    }));
}
function mergeModulesWithCompact(llmModules, compactModules) {
    if (!llmModules?.length)
        return compactModules;
    const merged = [...llmModules];
    const usedNodeIds = new Set(merged.flatMap((module) => module.nodeHintIds ?? []).filter((nodeId) => !!nodeId));
    const lowerNameMap = new Map(compactModules.map((item) => [item.name.toLowerCase(), item]));
    for (const module of merged) {
        if (module.nodeHintIds?.length)
            continue;
        const byName = lowerNameMap.get(module.name.toLowerCase());
        if (byName?.nodeHintIds?.length) {
            module.nodeHintIds = byName.nodeHintIds;
            module.interactions = module.interactions ?? byName.interactions;
            byName.nodeHintIds.forEach((id) => usedNodeIds.add(id));
        }
    }
    for (const compactModule of compactModules) {
        const id = compactModule.nodeHintIds?.[0];
        if (!id || usedNodeIds.has(id))
            continue;
        if (!merged.some((entry) => entry.name.toLowerCase() === compactModule.name.toLowerCase())) {
            merged.push(compactModule);
            usedNodeIds.add(id);
        }
    }
    return merged;
}
async function callVisionLLM(request, compactContext) {
    const apiUrl = process.env.VISION_LLM_API_URL;
    const token = process.env.VISION_LLM_TOKEN;
    const model = process.env.VISION_LLM_MODEL ?? DEFAULT_VISION_LLM_MODEL;
    // 如果没有配置 API URL 或 Token，跳过 LLM 调用
    if (!apiUrl || !token) {
        log("llm not configured, skipping", { hasUrl: !!apiUrl, hasToken: !!token });
        return null;
    }
    log("using llm api", { url: apiUrl, model });
    let screenshotBase64;
    if (request.screenshotPath) {
        try {
            const bytes = await fs.readFile(request.screenshotPath);
            screenshotBase64 = bytes.toString("base64");
        }
        catch {
            // Keep request valid even without screenshot bytes.
        }
    }
    try {
        const llmInput = {
            figmaUrl: request.figmaUrl,
            screenshotPath: request.screenshotPath,
            screenshotBase64,
            compactStructure: compactContext,
            rerunFeedbacks: request.rerunFeedbacks ?? []
        };
        const modelCandidates = [model];
        for (const modelCandidate of modelCandidates) {
            const resp = await fetch(apiUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({
                    model: modelCandidate,
                    messages: [
                        {
                            role: "system",
                            content: "You are a senior UI analyzer. Return only valid JSON that matches this schema exactly: " +
                                '{"summary":"string?","structuralNotes":["string"]?,"globalLayout":{"padding":"number?","margin":"number?","gap":"number?","direction":"vertical|horizontal?"}?,"modules":[{"name":"string","description":"string","nodeHintIds":["string"]?,"interactions":[{"trigger":"string","action":"string","target":"string?"}]?}]?,"reusableCandidates":[{"name":"string","reason":"string","nodePaths":["string"]?}]?}.'
                        },
                        {
                            role: "user",
                            content: `Analyze this Figma screenshot context and output JSON only:\n${JSON.stringify(llmInput)}`
                        }
                    ]
                })
            });
            const contentType = resp.headers.get("content-type") ?? "";
            if (!resp.ok) {
                const failureBody = await resp.text().catch(() => "");
                const shouldFallbackModel = false; // 单模型模式，不使用 fallback
                if (shouldFallbackModel) {
                    log("llm model access denied; no fallback configured", {
                        deniedModel: modelCandidate
                    });
                    continue;
                }
                log("llm call failed", {
                    status: resp.status,
                    model: modelCandidate,
                    contentType,
                    bodyPreview: failureBody.slice(0, 400)
                });
                return null;
            }
            if (!contentType.toLowerCase().includes("application/json")) {
                const rawText = await resp.text().catch(() => "");
                log("llm call returned non-json response", {
                    model: modelCandidate,
                    contentType,
                    bodyPreview: rawText.slice(0, 400)
                });
                return null;
            }
            const json = (await resp.json());
            const contentRaw = json.choices?.[0]?.message?.content;
            const content = typeof contentRaw === "string"
                ? contentRaw
                : Array.isArray(contentRaw)
                    ? contentRaw
                        .map((entry) => entry && typeof entry === "object" && typeof entry.text === "string" ? entry.text : "")
                        .filter(Boolean)
                        .join("\n")
                    : undefined;
            const payload = typeof content === "string" ? extractJsonPayload(content) : null;
            const parsed = visionLlmSchema.safeParse(payload);
            if (!parsed.success) {
                log("llm response invalid schema", {
                    model: modelCandidate,
                    issues: parsed.error.issues.map((issue) => issue.path.join(".")),
                    hasContent: typeof content === "string",
                    contentPreview: typeof content === "string" ? content.slice(0, 300) : undefined
                });
                return null;
            }
            return parsed.data;
        }
        return null;
    }
    catch (error) {
        const details = error && typeof error === "object"
            ? {
                message: "message" in error ? String(error.message) : undefined,
                name: "name" in error ? String(error.name) : undefined,
                cause: "cause" in error && error.cause
                    ? String(error.cause)
                    : undefined
            }
            : { message: String(error) };
        log("llm call threw exception", details);
        return null;
    }
}
/**
 * 加载离线 enriched nodes 数据
 */
async function loadEnrichedNodesForOffline(request) {
    if (!request.offlineMode)
        return [];
    // 尝试从 request 中指定的路径加载
    const pathCandidates = [];
    if (request.mcpStructurePath) {
        pathCandidates.push(request.mcpStructurePath);
    }
    // 默认离线路径
    pathCandidates.push(path.resolve("src/data/figma2code-offline/enriched-nodes.json"), path.resolve("src/data/figma2code-offline/08wDXrTJgBoPVvQzlkKBtV_1_124-nodes.json"));
    for (const filePath of pathCandidates) {
        try {
            const raw = await fs.readFile(filePath, "utf-8");
            const parsed = JSON.parse(raw);
            if (parsed.nodes && Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
                log("loaded enriched nodes for offline mode", {
                    path: filePath,
                    count: parsed.nodes.length
                });
                return parsed.nodes;
            }
        }
        catch (error) {
            // 继续尝试下一个路径
            continue;
        }
    }
    log("no enriched nodes found for offline mode", { triedPaths: pathCandidates });
    return [];
}
/**
 * Produces high-level visual understanding for downstream DSL generation.
 * Strategy:
 * 1) Prefer LLM understanding for semantic structure + reusable candidates.
 * 2) Blend compact live Figma structure for concrete relations.
 * 3) For offline mode, use enriched nodes from local files.
 * 4) Fall back to deterministic baseline when neither source is available.
 */
export async function analyzeScreenshot(request) {
    log("start analyze", {
        screenshotPath: request.screenshotPath,
        figmaUrl: request.figmaUrl,
        strictLive: request.strictLive,
        offlineMode: request.offlineMode
    });
    if (request.screenshotPath) {
        await fs.access(request.screenshotPath);
    }
    // 根据模式选择数据源
    let compactContext;
    let root;
    if (request.offlineMode) {
        // 离线模式：读取 enriched-nodes.json
        const enrichedNodes = await loadEnrichedNodesForOffline(request);
        if (enrichedNodes.length > 0) {
            compactContext = buildCompactContextFromEnrichedNodes(enrichedNodes);
            log("using enriched nodes for offline vision analysis", {
                nodeCount: enrichedNodes.length
            });
        }
    }
    else {
        // 在线模式：使用 Figma API
        const compact = await fetchCompactFigmaDesign(request);
        root = compact.response?.root;
        compactContext = buildCompactContext(root);
        log("compact fetch result", {
            source: compact.source,
            hasRoot: !!root,
            childCount: root?.children?.length ?? 0
        });
    }
    const llmAnalysis = await callVisionLLM(request, compactContext);
    if (llmAnalysis) {
        log("llm vision response received", {
            moduleCount: llmAnalysis.modules?.length ?? 0,
            reusableCount: llmAnalysis.reusableCandidates?.length ?? 0
        });
    }
    const feedbackNotes = request.rerunFeedbacks?.filter(Boolean) ?? [];
    const lastFeedback = feedbackNotes.length ? feedbackNotes[feedbackNotes.length - 1] : undefined;
    // 如果有 compact context（在线或离线），尝试提取结构信息
    if (compactContext && compactContext.root) {
        const rootFromContext = compactContext.root;
        const childrenFromContext = (compactContext.children ?? []);
        // 构建一个兼容的 root 对象用于后续处理
        const rootForInference = {
            ...rootFromContext,
            children: childrenFromContext
        };
        const compactModules = inferModulesFromCompact(rootForInference);
        const inferredModules = mergeModulesWithCompact(llmAnalysis?.modules, compactModules);
        const sourceSummary = request.offlineMode
            ? "enriched nodes (offline)"
            : "compact Figma analysis (online)";
        return {
            summary: [
                llmAnalysis?.summary ?? `Screenshot + ${sourceSummary}`,
                lastFeedback ? `User rerun feedback: ${lastFeedback}` : ""
            ]
                .filter(Boolean)
                .join(". "),
            structuralNotes: llmAnalysis?.structuralNotes,
            globalLayout: {
                padding: llmAnalysis?.globalLayout?.padding ??
                    (typeof rootFromContext.layout?.padding === "number" ? rootFromContext.layout.padding : 24),
                margin: llmAnalysis?.globalLayout?.margin,
                gap: llmAnalysis?.globalLayout?.gap ??
                    (typeof rootFromContext.layout?.gap === "number" ? rootFromContext.layout.gap : 16),
                direction: llmAnalysis?.globalLayout?.direction ??
                    (rootFromContext.layout?.direction === "row" ? "horizontal" : "vertical")
            },
            modules: inferredModules.length
                ? inferredModules
                : [
                    {
                        name: "MainModule",
                        description: "Fallback module from Figma structure"
                    }
                ],
            reusableCandidates: normalizeReusableCandidates(llmAnalysis?.reusableCandidates)
        };
    }
    if (request.strictLive) {
        throw new Error("strict-live enabled: failed to fetch compact live Figma structure for screenshot analysis.");
    }
    log("using static fallback visual analysis");
    return {
        summary: llmAnalysis?.summary ??
            (lastFeedback
                ? `Top search section + content list with cards. User rerun feedback: ${lastFeedback}`
                : "Top search section + content list with cards"),
        structuralNotes: llmAnalysis?.structuralNotes,
        globalLayout: {
            padding: llmAnalysis?.globalLayout?.padding ?? 24,
            margin: llmAnalysis?.globalLayout?.margin,
            gap: llmAnalysis?.globalLayout?.gap ?? 16,
            direction: llmAnalysis?.globalLayout?.direction ?? "vertical"
        },
        modules: llmAnalysis?.modules?.length
            ? llmAnalysis.modules
            : [
                {
                    name: "SearchBar",
                    description: "Input + primary action button",
                    nodeHintIds: request.figmaNodeIds?.slice(0, 2),
                    interactions: [
                        {
                            trigger: "onClick",
                            action: "OPEN_MODAL",
                            target: "confirm_modal"
                        }
                    ]
                },
                {
                    name: "ResultList",
                    description: "A vertical list of item cards",
                    nodeHintIds: request.figmaNodeIds?.slice(2)
                }
            ],
        reusableCandidates: normalizeReusableCandidates(llmAnalysis?.reusableCandidates)
    };
}
