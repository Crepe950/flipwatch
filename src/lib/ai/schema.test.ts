import { describe, expect, it } from "vitest";
import { AiRequestError } from "./errors";
import { EVALUATION_JSON_SCHEMA, normalizeEvaluation, parseEvaluationOutput, rawEvaluationSchema } from "./schema";

const VALID = {
  verdict: "good",
  dealScore: 72,
  estimatedResaleLow: 450,
  estimatedResaleHigh: 520,
  suggestedOffer: 340,
  summary: "Clean PS5 priced under local comps.",
  reasons: ["Priced 15% below the median of comparable listings"],
  redFlags: [],
  questionsForSeller: ["Does it include the original controller?"],
};

describe("EVALUATION_JSON_SCHEMA", () => {
  it("is a strict structured-output schema that requires every field", () => {
    expect(EVALUATION_JSON_SCHEMA.additionalProperties).toBe(false);
    expect([...EVALUATION_JSON_SCHEMA.required].sort()).toEqual(Object.keys(EVALUATION_JSON_SCHEMA.properties).sort());
    expect(EVALUATION_JSON_SCHEMA.properties.verdict.enum).toEqual(["great", "good", "fair", "pass"]);
    expect(EVALUATION_JSON_SCHEMA.properties.suggestedOffer.type).toEqual(["number", "null"]);
    // Structured outputs reject numeric/length constraints; they must not leak into the schema.
    expect(JSON.stringify(EVALUATION_JSON_SCHEMA)).not.toMatch(/"(minimum|maximum|maxItems|minLength|maxLength)"/);
  });
});

describe("parseEvaluationOutput", () => {
  it("converts major-unit money to integer cents", () => {
    const result = parseEvaluationOutput(JSON.stringify({ ...VALID, estimatedResaleLow: 449.99, suggestedOffer: 339.5 }));
    expect(result).toMatchObject({
      verdict: "good",
      dealScore: 72,
      estimatedResaleLowCents: 44999,
      estimatedResaleHighCents: 52000,
      suggestedOfferCents: 33950,
    });
  });

  it("clamps and rounds the deal score", () => {
    expect(parseEvaluationOutput(JSON.stringify({ ...VALID, dealScore: 150 })).dealScore).toBe(100);
    expect(parseEvaluationOutput(JSON.stringify({ ...VALID, dealScore: -12 })).dealScore).toBe(0);
    expect(parseEvaluationOutput(JSON.stringify({ ...VALID, dealScore: 72.6 })).dealScore).toBe(73);
    expect(parseEvaluationOutput(JSON.stringify({ ...VALID, dealScore: "64" })).dealScore).toBe(64);
  });

  it("swaps an inverted resale range and nulls negative or absurd amounts", () => {
    const swapped = parseEvaluationOutput(JSON.stringify({ ...VALID, estimatedResaleLow: 600, estimatedResaleHigh: 500 }));
    expect(swapped.estimatedResaleLowCents).toBe(50000);
    expect(swapped.estimatedResaleHighCents).toBe(60000);

    const nonsense = parseEvaluationOutput(JSON.stringify({ ...VALID, estimatedResaleLow: -5, estimatedResaleHigh: 1e12, suggestedOffer: "n/a" }));
    expect(nonsense.estimatedResaleLowCents).toBeNull();
    expect(nonsense.estimatedResaleHighCents).toBeNull();
    expect(nonsense.suggestedOfferCents).toBeNull();
  });

  it("accepts money written as strings", () => {
    const result = parseEvaluationOutput(JSON.stringify({ ...VALID, estimatedResaleLow: "$1,250", estimatedResaleHigh: "1400.50" }));
    expect(result.estimatedResaleLowCents).toBe(125000);
    expect(result.estimatedResaleHighCents).toBe(140050);
  });

  it("never suggests offering more than the asking price", () => {
    expect(parseEvaluationOutput(JSON.stringify({ ...VALID, suggestedOffer: 500 }), { askingPriceCents: 40000 }).suggestedOfferCents).toBe(40000);
    expect(parseEvaluationOutput(JSON.stringify({ ...VALID, suggestedOffer: 300 }), { askingPriceCents: 40000 }).suggestedOfferCents).toBe(30000);
    expect(parseEvaluationOutput(JSON.stringify({ ...VALID, suggestedOffer: 10 }), { askingPriceCents: 0 }).suggestedOfferCents).toBeNull();
    expect(parseEvaluationOutput(JSON.stringify({ ...VALID, suggestedOffer: 300 }), { askingPriceCents: null }).suggestedOfferCents).toBe(30000);
  });

  it("caps, cleans and de-duplicates the lists", () => {
    const result = parseEvaluationOutput(
      JSON.stringify({
        ...VALID,
        reasons: ["- One", "2. Two", "Three", "three", "", "  ", "Four", "Five", "Six", "2019 model year"],
        redFlags: "Seller asks for e-transfer deposit",
        questionsForSeller: ["A?", "B?", "C?", "D?", "E?", 7],
      }),
    );
    expect(result.reasons).toEqual(["One", "Two", "Three", "Four", "Five"]);
    expect(result.redFlags).toEqual(["Seller asks for e-transfer deposit"]);
    expect(result.questionsForSeller).toEqual(["A?", "B?", "C?", "D?"]);
    expect(parseEvaluationOutput(JSON.stringify({ ...VALID, reasons: ["2019 model year"] })).reasons).toEqual(["2019 model year"]);
  });

  it("limits the summary to two sentences and falls back when it is empty", () => {
    const long = parseEvaluationOutput(JSON.stringify({ ...VALID, summary: "First point. Second point! Third point? Fourth." }));
    expect(long.summary).toBe("First point. Second point!");

    const empty = parseEvaluationOutput(JSON.stringify({ ...VALID, summary: "   " }));
    expect(empty.summary).toBe(VALID.reasons[0]);
  });

  it("normalises verdict casing and tolerates code fences", () => {
    const fenced = "```json\n" + JSON.stringify({ ...VALID, verdict: " GREAT " }) + "\n```";
    expect(parseEvaluationOutput(fenced).verdict).toBe("great");
  });

  it("rejects malformed JSON and invalid required fields", () => {
    expect(() => parseEvaluationOutput("not json")).toThrow(AiRequestError);
    expect(() => parseEvaluationOutput(JSON.stringify({ ...VALID, verdict: "amazing" }))).toThrow(/verdict/);
    expect(() => parseEvaluationOutput(JSON.stringify({ ...VALID, dealScore: "high" }))).toThrow(/dealScore/);
    expect(() => parseEvaluationOutput("[]")).toThrow(AiRequestError);
  });
});

describe("normalizeEvaluation", () => {
  it("keeps valid input intact", () => {
    const raw = rawEvaluationSchema.parse(VALID);
    expect(normalizeEvaluation(raw)).toEqual({
      verdict: "good",
      dealScore: 72,
      estimatedResaleLowCents: 45000,
      estimatedResaleHighCents: 52000,
      suggestedOfferCents: 34000,
      summary: VALID.summary,
      reasons: VALID.reasons,
      redFlags: [],
      questionsForSeller: VALID.questionsForSeller,
    });
  });
});
