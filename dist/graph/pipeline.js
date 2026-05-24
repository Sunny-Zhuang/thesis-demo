import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { buildDsl } from "../services/dsl-builder.js";
import { convertMcpStructureToMetrics, fetchMcpStructure } from "../services/figma-api.js";
import { applyReuseApprovals, annotateReuseCandidates } from "../services/reuse-detector.js";
import { analyzeScreenshot } from "../services/vision-analyzer.js";
const LOG_PREFIX = "[pipeline]";
const log = (...args) => console.log(LOG_PREFIX, ...args);
const GraphState = Annotation.Root({
    request: (Annotation),
    visualAnalysis: (Annotation),
    mcpStructure: (Annotation),
    figmaMetrics: (Annotation),
    dsl: (Annotation),
    reuseCandidates: (Annotation),
    approvedReuseCandidates: (Annotation),
    reuseReviewDecisions: (Annotation),
    dslReviewApproved: (Annotation),
    dslReviewFeedback: (Annotation),
    reviewStage: (Annotation),
    retryCount: (Annotation),
    maxRetryCount: (Annotation),
    shouldRetry: (Annotation),
    stopProcessing: (Annotation),
    waitingForReview: (Annotation),
    messages: (Annotation)
});
/**
 * Node: screenshot + figma context semantic understanding.
 */
async function visionNode(state) {
    log("enter vision node");
    const visualAnalysis = await analyzeScreenshot(state.request);
    const reusableCandidates = visualAnalysis.reusableCandidates ?? [];
    log("vision result", {
        moduleCount: visualAnalysis.modules.length,
        reusableCandidates: reusableCandidates.length
    });
    return {
        ...state,
        visualAnalysis,
        reuseCandidates: reusableCandidates,
        approvedReuseCandidates: undefined,
        reuseReviewDecisions: state.reuseReviewDecisions,
        shouldRetry: false,
        messages: [...state.messages, "Screenshot understanding completed"]
    };
}
/**
 * Node: applies reusable component review outcomes before enrichment.
 */
async function reuseApplyNode(state) {
    const candidates = state.reuseCandidates ?? [];
    if (!candidates.length) {
        return {
            ...state,
            waitingForReview: false,
            reviewStage: undefined,
            approvedReuseCandidates: []
        };
    }
    if (!state.reuseReviewDecisions) {
        return {
            ...state,
            waitingForReview: true,
            reviewStage: "reuse",
            messages: [...state.messages, "Waiting for reuse review decisions"]
        };
    }
    const approvedReuseCandidates = candidates.filter((candidate) => state.reuseReviewDecisions?.[candidate.id]);
    log("reuse review applied", {
        total: candidates.length,
        approved: approvedReuseCandidates.length
    });
    return {
        ...state,
        waitingForReview: false,
        reviewStage: undefined,
        approvedReuseCandidates,
        reuseCandidates: candidates.map((candidate) => ({
            ...candidate,
            approved: !!state.reuseReviewDecisions?.[candidate.id]
        })),
        messages: [...state.messages, "Reuse review decisions applied"]
    };
}
/**
 * Node: enriches structural details from MCP and derives numeric metrics.
 */
async function mcpStructureNode(state) {
    if (!state.visualAnalysis) {
        throw new Error("visualAnalysis is required before MCP structure enrichment");
    }
    log("enter mcp_enrich node");
    if (state.approvedReuseCandidates?.length) {
        log("approved reuse candidates forwarded to mcp_enrich", {
            apiUrlPlaceholder: process.env.REUSE_REVIEW_API_URL ?? "<fill REUSE_REVIEW_API_URL>",
            tokenPlaceholder: process.env.REUSE_REVIEW_API_TOKEN ? "***" : "<fill REUSE_REVIEW_API_TOKEN>",
            candidates: state.approvedReuseCandidates.map((candidate) => ({
                id: candidate.id,
                name: candidate.name
            }))
        });
    }
    const mcpStructure = await fetchMcpStructure({
        request: state.request,
        mcpStructurePath: state.request.mcpStructurePath,
        visualAnalysis: state.visualAnalysis,
        nodeIds: state.request.figmaNodeIds
    });
    const figmaMetrics = convertMcpStructureToMetrics(mcpStructure, state.request.figmaNodeIds, !state.request.strictLive);
    log("mcp_enrich result", {
        mcpStructureCount: mcpStructure.length,
        metricCount: figmaMetrics.length
    });
    return {
        ...state,
        mcpStructure,
        figmaMetrics,
        messages: [...state.messages, "MCP structure enrichment completed"]
    };
}
/**
 * Node: converts analyzed layout + metrics into hierarchical DSL.
 */
async function dslNode(state) {
    if (!state.visualAnalysis) {
        throw new Error("visualAnalysis is required before building DSL");
    }
    log("enter build_dsl node");
    let dsl = buildDsl(state.request, state.visualAnalysis, state.figmaMetrics ?? [], state.mcpStructure ?? []);
    if (state.reuseCandidates?.length) {
        dsl = annotateReuseCandidates(dsl, state.reuseCandidates);
    }
    log("build_dsl result", { childCount: dsl.children?.length ?? 0 });
    return {
        ...state,
        dsl,
        messages: [...state.messages, "Base DSL generated"]
    };
}
/**
 * Node: waits for DSL review and controls retry behavior.
 */
async function dslApplyNode(state) {
    if (!state.dsl) {
        throw new Error("dsl is required before dsl review");
    }
    if (typeof state.dslReviewApproved !== "boolean") {
        return {
            ...state,
            waitingForReview: true,
            reviewStage: "dsl",
            messages: [...state.messages, "Waiting for DSL review decision"]
        };
    }
    if (state.dslReviewApproved) {
        return {
            ...state,
            waitingForReview: false,
            reviewStage: undefined,
            shouldRetry: false,
            messages: [...state.messages, "DSL review approved"]
        };
    }
    const currentRetryCount = state.retryCount ?? 0;
    const maxRetryCount = state.maxRetryCount ?? 2;
    if (currentRetryCount >= maxRetryCount) {
        return {
            ...state,
            waitingForReview: false,
            reviewStage: undefined,
            shouldRetry: false,
            stopProcessing: true,
            messages: [...state.messages, "DSL review rejected and max retry reached"]
        };
    }
    const nextRetryCount = currentRetryCount + 1;
    const rerunFeedbacks = [
        ...(state.request.rerunFeedbacks ?? []),
        state.dslReviewFeedback || `DSL rejected at retry #${nextRetryCount}`
    ];
    log("dsl rejected, rerun scheduled", { nextRetryCount, maxRetryCount });
    return {
        ...state,
        request: {
            ...state.request,
            rerunFeedbacks
        },
        retryCount: nextRetryCount,
        waitingForReview: false,
        reviewStage: undefined,
        shouldRetry: true,
        dslReviewApproved: undefined,
        dslReviewFeedback: undefined,
        messages: [...state.messages, `DSL rejected; rerun requested (${nextRetryCount}/${maxRetryCount})`]
    };
}
/**
 * Node: applies final approved reviews onto DSL output.
 */
async function applyReviewNode(state) {
    if (!state.dsl) {
        return state;
    }
    if (!state.reuseCandidates?.length || !state.reuseReviewDecisions) {
        return {
            ...state,
            shouldRetry: false,
            messages: [...state.messages, "Final DSL produced (no reuse review changes)"]
        };
    }
    const dsl = applyReuseApprovals(state.dsl, state.reuseCandidates, state.reuseReviewDecisions);
    return {
        ...state,
        dsl: dsl,
        shouldRetry: false,
        messages: [...state.messages, "Approved reusable components were merged into DSL"]
    };
}
/**
 * Route after reuse review gate.
 */
function reuseReviewRoute(state) {
    if (state.waitingForReview && state.reviewStage === "reuse") {
        return END;
    }
    return "mcp_enrich";
}
/**
 * Route after dsl review gate.
 */
function dslReviewRoute(state) {
    if (state.waitingForReview && state.reviewStage === "dsl") {
        return END;
    }
    if (state.stopProcessing) {
        return END;
    }
    if (state.shouldRetry) {
        return "vision";
    }
    return "apply_review";
}
/**
 * Builds and compiles the LangGraph workflow for figma->dsl pipeline.
 */
export function createPipeline() {
    const workflow = new StateGraph(GraphState)
        .addNode("vision", visionNode)
        .addNode("reuse_apply_review", reuseApplyNode)
        .addNode("mcp_enrich", mcpStructureNode)
        .addNode("build_dsl", dslNode)
        .addNode("dsl_apply_review", dslApplyNode)
        .addNode("apply_review", applyReviewNode)
        .addEdge(START, "vision")
        .addEdge("vision", "reuse_apply_review")
        .addConditionalEdges("reuse_apply_review", reuseReviewRoute)
        .addEdge("mcp_enrich", "build_dsl")
        .addEdge("build_dsl", "dsl_apply_review")
        .addConditionalEdges("dsl_apply_review", dslReviewRoute)
        .addEdge("apply_review", END);
    return workflow.compile();
}
