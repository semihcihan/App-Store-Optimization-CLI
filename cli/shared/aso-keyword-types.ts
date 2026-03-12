export type FailedKeywordStage = "popularity" | "enrichment";

export interface FailedKeyword {
  keyword: string;
  stage: FailedKeywordStage;
  reasonCode: string;
  message: string;
  statusCode?: number;
  retryable: boolean;
  attempts: number;
  requestId?: string;
}
