/**
 * Figma 节点增强服务
 * 将 Figma API 返回的 raw JSON 转换为包含样式、布局、交互的增强节点
 */

import type { McpStructureNode } from "../types/state.js";

interface RawFigmaNode {
  id?: string;
  name?: string;
  type?: string;
  characters?: string;
  layoutMode?: string;
  itemSpacing?: number;
  paddingLeft?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  fills?: Array<{
    type: string;
    color?: { r: number; g: number; b: number; a: number };
  }>;
  strokes?: Array<{
    type: string;
    color?: { r: number; g: number; b: number; a: number };
  }>;
  strokeWeight?: number;
  cornerRadius?: number;
  absoluteBoundingBox?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  interactions?: Array<{
    trigger?: { type: string };
    action?: { type: string; destinationId?: string };
  }>;
  children?: RawFigmaNode[];
}

const LOG_PREFIX = "[figma-enrich]";
const log = (...args: unknown[]): void => console.log(LOG_PREFIX, ...args);

function rgbaToHex(r: number, g: number, b: number, a: number): string {
  const toHex = (n: number) => Math.round(n * 255).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}${a < 1 ? toHex(a) : ""}`;
}

function extractStyles(node: RawFigmaNode) {
  const background = node.fills?.[0]?.color
    ? rgbaToHex(
        node.fills[0].color.r,
        node.fills[0].color.g,
        node.fills[0].color.b,
        node.fills[0].color.a
      )
    : undefined;

  const border = node.strokes?.[0]?.color
    ? `${node.strokeWeight ?? 1}px solid ${rgbaToHex(
        node.strokes[0].color.r,
        node.strokes[0].color.g,
        node.strokes[0].color.b,
        node.strokes[0].color.a
      )}`
    : undefined;

  return {
    background,
    color: node.type === "TEXT" && node.fills?.[0]?.color
      ? rgbaToHex(
          node.fills[0].color.r,
          node.fills[0].color.g,
          node.fills[0].color.b,
          node.fills[0].color.a
        )
      : undefined,
    border,
    radius: node.cornerRadius
  };
}

function extractInteractions(node: RawFigmaNode) {
  return node.interactions?.map(interaction => ({
    trigger: interaction.trigger?.type ?? "UNKNOWN",
    action: interaction.action?.type ?? "UNKNOWN",
    target: interaction.action?.destinationId
  }));
}

/**
 * 递归转换 Figma raw 节点为增强的 MCP 结构节点
 */
function mapRawNodeToEnrichedMcp(node: RawFigmaNode): McpStructureNode[] {
  const nodeId = node.id ?? `${node.type}:${node.name ?? "unknown"}`;

  const enriched: McpStructureNode = {
    nodeId,
    name: node.name ?? node.type ?? "UNKNOWN",
    type: node.type ?? "UNKNOWN",
    text: node.characters,
    layout: {
      width: node.absoluteBoundingBox?.width,
      height: node.absoluteBoundingBox?.height,
      x: node.absoluteBoundingBox?.x,
      y: node.absoluteBoundingBox?.y,
      gap: node.itemSpacing,
      padding: node.paddingLeft ?? node.paddingTop,
      direction:
        node.layoutMode === "HORIZONTAL" ? "horizontal" :
        node.layoutMode === "VERTICAL" ? "vertical" :
        undefined
    },
    style: extractStyles(node),
    interactions: extractInteractions(node)
  };

  const children = node.children?.flatMap(child => mapRawNodeToEnrichedMcp(child)) ?? [];
  return [enriched, ...children];
}

/**
 * 从 Figma API 返回的 raw JSON 中提取增强节点
 *
 * @param rawData - Figma API 返回的完整数据（包含 document 或 nodes 字段）
 * @returns 增强后的 MCP 结构节点列表
 */
export function enrichFigmaNodes(rawData: unknown): McpStructureNode[] {
  if (!rawData || typeof rawData !== "object") {
    log("invalid raw data format", { type: typeof rawData });
    return [];
  }

  // 处理两种格式：
  // 1. { document: {...} } - 来自 Figma file API 或离线 raw_metadata.json
  // 2. { nodes: { "nodeId": { document: {...} } } } - 来自 Figma nodes API
  const data = rawData as {
    document?: RawFigmaNode;
    nodes?: Record<string, { document?: RawFigmaNode }>;
  };

  let rootNode: RawFigmaNode | undefined;

  if (data.document) {
    rootNode = data.document;
  } else if (data.nodes) {
    // 从 nodes 中取第一个有效的 document
    const nodeEntries = Object.values(data.nodes);
    rootNode = nodeEntries.find(entry => entry?.document)?.document;
  }

  if (!rootNode) {
    log("no valid document node found in raw data");
    return [];
  }

  const enrichedNodes = mapRawNodeToEnrichedMcp(rootNode);
  log("enriched nodes", { count: enrichedNodes.length });

  return enrichedNodes;
}

export type { RawFigmaNode };
