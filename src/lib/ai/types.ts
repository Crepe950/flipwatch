export interface AiStatus {
  configured: boolean;
  model: string;
  message?: string;
}

export interface EvaluateListingOptions {
  /** Search the evaluation is for; defaults to the most recent search the listing matched. */
  searchId?: number | null;
  /** Clock override (tests): anchors the comparable-listings window and "today" in the prompt. */
  now?: Date;
  /** The user is waiting (the "Run AI analysis" button): reading the listing page may use Facebook's reserve budget. */
  interactive?: boolean;
}

export type OutreachTone = "friendly" | "direct" | "professional";

export interface OutreachOptions {
  offerCents?: number | null;
  tone?: OutreachTone;
  /** Include a couple of questions about condition/history. */
  askQuestions?: boolean;
}

export interface OutreachDraft {
  message: string;
  aiGenerated: boolean;
}
