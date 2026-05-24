import { applyFeedbackRules } from "./feedback-rule-engine.js";
/**
 * Builds quick lookup map for node metrics by node id.
 */
function metricMap(metrics) {
    return new Map(metrics.map((metric) => [metric.nodeId, metric]));
}
/**
 * Builds one module-level DSL node using visual hints + structural metrics.
 */
function buildModuleNode(module, metricsById, structureById) {
    const firstMetric = module.nodeHintIds?.[0] ? metricsById.get(module.nodeHintIds[0]) : undefined;
    const firstStructure = module.nodeHintIds?.[0]
        ? structureById.get(module.nodeHintIds[0])
        : undefined;
    if (module.name === "SearchBar") {
        return {
            type: "Module",
            name: module.name,
            layout: {
                direction: "horizontal",
                align: "center",
                justify: "space-between",
                padding: firstMetric?.padding,
                gap: firstMetric?.gap ?? 12,
                height: firstMetric?.height,
                width: firstMetric?.width
            },
            props: {
                background: firstStructure?.style?.background,
                border: firstStructure?.style?.border,
                radius: firstStructure?.style?.radius
            },
            children: [
                {
                    type: "Input",
                    ref: "antd.Input",
                    props: {
                        placeholder: "Search",
                        color: firstStructure?.style?.color
                    }
                },
                {
                    type: "Button",
                    ref: "antd.Button",
                    props: {
                        text: "Go",
                        type: "primary",
                        color: firstStructure?.style?.color
                    },
                    interactions: firstStructure?.interactions ?? module.interactions
                }
            ]
        };
    }
    return {
        type: "Module",
        name: module.name,
        layout: {
            direction: "vertical",
            padding: firstMetric?.padding,
            gap: firstMetric?.gap ?? 8
        },
        props: {
            background: firstStructure?.style?.background,
            border: firstStructure?.style?.border,
            radius: firstStructure?.style?.radius
        },
        children: [
            {
                type: "Module",
                name: "ResultCard",
                layout: {
                    padding: firstMetric?.padding,
                    gap: firstMetric?.gap
                },
                children: [
                    {
                        type: "Text",
                        ref: "antd.Typography.Text",
                        props: {
                            text: "Result title",
                            color: firstStructure?.style?.color
                        }
                    }
                ]
            },
            {
                type: "Module",
                name: "ResultCard",
                layout: {
                    padding: firstMetric?.padding,
                    gap: firstMetric?.gap
                },
                children: [
                    {
                        type: "Text",
                        ref: "antd.Typography.Text",
                        props: {
                            text: "Result title",
                            color: firstStructure?.style?.color
                        }
                    }
                ]
            }
        ]
    };
}
/**
 * Builds final page DSL and applies feedback-driven post-processing rules.
 */
export function buildDsl(request, analysis, figmaMetrics, mcpStructure = []) {
    const byId = metricMap(figmaMetrics);
    const structureById = new Map(mcpStructure.map((node) => [node.nodeId, node]));
    const modules = analysis.modules.map((module) => buildModuleNode(module, byId, structureById));
    const baseDsl = {
        type: "Page",
        metadata: {
            source: "figma+screenshot",
            screenshotId: request.screenshotPath ?? request.figmaUrl ?? "unknown",
            confidence: 0.72
        },
        layout: {
            padding: analysis.globalLayout.padding ?? 24,
            margin: analysis.globalLayout.margin,
            justify: "start",
            gap: analysis.globalLayout.gap ?? 16,
            direction: analysis.globalLayout.direction ?? "vertical"
        },
        children: modules
    };
    const { dsl, appliedRules } = applyFeedbackRules(baseDsl, request.rerunFeedbacks);
    dsl.metadata = {
        ...(dsl.metadata ?? {}),
        rerunFeedbacks: request.rerunFeedbacks ?? [],
        appliedFeedbackRules: appliedRules
    };
    return dsl;
}
