import type { PageDsl, ReuseCandidate } from "./dsl.js";

export interface ScreenshotRequest {
  screenshotPath?: string;
  strictLive?: boolean;
  figmaNodeIds?: string[];
  figmaUrl?: string;
  mcpStructurePath?: string;
  offlineMode?: boolean;
  offlineSourcePath?: string;
  pageName?: string;
  rerunFeedbacks?: string[];
}

export interface VisualAnalysis {
  summary: string;
  structuralNotes?: string[];
  globalLayout: {
    padding?: number;
    margin?: number;
    gap?: number;
    direction?: "vertical" | "horizontal";
  };
  modules: Array<{
    name: string;
    description: string;
    nodeHintIds?: string[];
    interactions?: Array<{
      trigger: string;
      action: string;
      target?: string;
    }>;
  }>;
  reusableCandidates?: ReuseCandidate[];
}

export interface FigmaNodeMetric {
  nodeId: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  padding?: number;
  gap?: number;
  fontSize?: number;
}

export interface McpStructureNode {
  nodeId: string;
  name: string;
  type: string;
  text?: string;
  layout?: {
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    padding?: number;
    gap?: number;
    direction?: "vertical" | "horizontal";
  };
  style?: {
    background?: string;
    color?: string;
    border?: string;
    radius?: number | string;
  };
  interactions?: Array<{
    trigger: string;
    action: string;
    target?: string;
  }>;
}

export type ReviewStage = "reuse" | "dsl";

export interface PipelineState {
  request: ScreenshotRequest;
  visualAnalysis?: VisualAnalysis;
  mcpStructure?: McpStructureNode[];
  figmaMetrics?: FigmaNodeMetric[];
  dsl?: PageDsl;
  reuseCandidates?: ReuseCandidate[];
  approvedReuseCandidates?: ReuseCandidate[];
  reuseReviewDecisions?: Record<string, boolean>;
  dslReviewApproved?: boolean;
  dslReviewFeedback?: string;
  reviewStage?: ReviewStage;
  retryCount?: number;
  maxRetryCount?: number;
  shouldRetry?: boolean;
  stopProcessing?: boolean;
  waitingForReview?: boolean;
  messages: string[];
}
