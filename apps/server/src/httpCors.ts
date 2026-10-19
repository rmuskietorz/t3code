import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

// `t3code-fork` is the side-by-side desktop install set by T3CODE_DESKTOP_INSTANCE=fork.
export const DESKTOP_RENDERER_ORIGINS = [
  "t3code://app",
  "t3code-dev://app",
  "t3code-fork://app",
] as const;
