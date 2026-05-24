export type Direction = "vertical" | "horizontal";

export interface Interaction {
  trigger: string;
  action: string;
  target?: string;
  payload?: Record<string, unknown>;
}

export interface LayoutSpec {
  padding?: number;
  margin?: number;
  gap?: number;
  direction?: Direction;
  align?: string;
  justify?: string;
  width?: number | string;
  height?: number | string;
}

export interface DslNode {
  type: string;
  name?: string;
  ref?: string;
  props?: Record<string, unknown>;
  layout?: LayoutSpec;
  interactions?: Interaction[];
  children?: DslNode[];
  reusable?: boolean;
  reusableCandidateId?: string;
  reusability?: {
    candidateId: string;
    status: "pending_review" | "approved" | "rejected";
  };
}

export interface PageDsl extends DslNode {
  type: "Page";
  metadata?: {
    source?: string;
    screenshotId?: string;
    confidence?: number;
    rerunFeedbacks?: string[];
    appliedFeedbackRules?: string[];
  };
}

export interface ReuseCandidate {
  id: string;
  name: string;
  reason: string;
  nodePaths: string[];
  approved?: boolean;
}
