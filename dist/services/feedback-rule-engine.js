/**
 * Deep-clones DSL node parts that are mutated by rule application.
 */
function cloneNode(node) {
    return {
        ...node,
        layout: node.layout ? { ...node.layout } : undefined,
        props: node.props ? { ...node.props } : undefined,
        interactions: node.interactions ? [...node.interactions] : undefined,
        children: node.children?.map(cloneNode)
    };
}
/**
 * DFS walker utility used by all rule transformers.
 */
function walk(node, visit, parent) {
    visit(node, parent);
    node.children?.forEach((child) => walk(child, visit, node));
}
/**
 * Applies ratio-based numeric scaling with lower bound.
 */
function reduceNumeric(value, ratio, min = 0) {
    return Math.max(min, Math.round(value * ratio));
}
/**
 * Rule primitive: scale all layout gaps.
 */
function applyGapRule(dsl, ratio) {
    walk(dsl, (node) => {
        if (typeof node.layout?.gap === "number") {
            node.layout.gap = reduceNumeric(node.layout.gap, ratio, 2);
        }
    });
}
/**
 * Rule primitive: scale all paddings.
 */
function applyPaddingRule(dsl, ratio) {
    walk(dsl, (node) => {
        if (typeof node.layout?.padding === "number") {
            node.layout.padding = reduceNumeric(node.layout.padding, ratio, 0);
        }
    });
}
/**
 * Checks whether module contains button-like child controls.
 */
function hasButtonChild(node) {
    return (node.children?.some((child) => child.type === "Button" || (typeof child.ref === "string" && child.ref.includes("Button"))) ??
        false);
}
/**
 * Rule primitive: align modules that contain button controls.
 */
function applyButtonAlignRule(dsl, align) {
    walk(dsl, (node) => {
        if (!hasButtonChild(node))
            return;
        node.layout = {
            ...(node.layout ?? {}),
            align
        };
    });
}
/**
 * Rule primitive: wraps non-module children into sub-modules for finer granularity.
 */
function applyFineGrainModuleSplitRule(dsl) {
    walk(dsl, (node) => {
        if (!node.children?.length || node.type !== "Module")
            return;
        // Avoid wrapping nodes that were already split in a previous pass.
        if (node.name?.match(/Part\d+$/))
            return;
        const hasNonModuleChild = node.children.some((child) => child.type !== "Module");
        if (!hasNonModuleChild)
            return;
        node.children = node.children.map((child, index) => {
            if (child.type === "Module") {
                return child;
            }
            return {
                type: "Module",
                name: `${node.name ?? "Module"}Part${index + 1}`,
                children: [child]
            };
        });
    });
}
/**
 * Returns true when any regex pattern matches the input text.
 */
function includesAny(text, patterns) {
    return patterns.some((pattern) => pattern.test(text));
}
/**
 * Applies NLP-lite feedback rules and returns transformed DSL + applied rule IDs.
 */
export function applyFeedbackRules(inputDsl, rerunFeedbacks) {
    const dsl = cloneNode(inputDsl);
    const appliedRules = [];
    const ctx = {
        rawText: (rerunFeedbacks ?? []).join("\n").toLowerCase()
    };
    if (!ctx.rawText.trim()) {
        return { dsl, appliedRules };
    }
    if (includesAny(ctx.rawText, [
        /间距减小/,
        /缩小间距/,
        /reduce gap/,
        /smaller gap/,
        /spacing smaller/,
        /更紧凑/
    ])) {
        applyGapRule(dsl, 0.75);
        appliedRules.push("reduce_gap_25_percent");
    }
    if (includesAny(ctx.rawText, [
        /间距增大/,
        /增大间距/,
        /increase gap/,
        /larger gap/,
        /spacing larger/,
        /更疏/
    ])) {
        applyGapRule(dsl, 1.25);
        appliedRules.push("increase_gap_25_percent");
    }
    if (includesAny(ctx.rawText, [
        /padding减小/,
        /缩小内边距/,
        /reduce padding/,
        /smaller padding/
    ])) {
        applyPaddingRule(dsl, 0.8);
        appliedRules.push("reduce_padding_20_percent");
    }
    if (includesAny(ctx.rawText, [
        /按钮.*左对齐/,
        /button.*left/,
        /左侧按钮/
    ])) {
        applyButtonAlignRule(dsl, "start");
        appliedRules.push("button_align_start");
    }
    if (includesAny(ctx.rawText, [
        /按钮.*右对齐/,
        /button.*right/,
        /右侧按钮/
    ])) {
        applyButtonAlignRule(dsl, "end");
        appliedRules.push("button_align_end");
    }
    if (includesAny(ctx.rawText, [
        /模块拆分/,
        /拆分模块/,
        /更细粒度/,
        /fine-grained module/,
        /granularity higher/
    ])) {
        applyFineGrainModuleSplitRule(dsl);
        appliedRules.push("fine_grain_module_split");
    }
    return { dsl, appliedRules };
}
