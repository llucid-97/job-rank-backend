import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLlmDecision } from "../src/modules/provider-proxy/llm-decision.js";

const questions = {
  interest: { type: "choice", criteria: { yes: "Matches", no: "Does not match" } },
  fit: { type: "score", criteria: ["Low", "Medium", "High"] },
};

function validAnswers() {
  return {
    interest: { type: "choice", choice: "yes", probabilities: { yes: 0.8, no: 0.2 } },
    fit: { type: "score", score: 1 },
  };
}

// The provider may wrap JSON in prose, and braces inside quoted content do not delimit JSON.
test("extracts complete answers from prefaced, fenced JSON containing braces in strings", () => {
  const answers = { ...validAnswers(), note: undefined };
  const payload = JSON.stringify({ description: "Text with {braces} and a quoted \"}\"", answers });
  assert.deepEqual(parseLlmDecision(`Model response:\n\`\`\`json\n${payload}\n\`\`\``, questions), validAnswers());
});

// Missing or unrelated answers must not become partial ranking results.
test("rejects missing and extra question IDs", () => {
  const answers = validAnswers();
  assert.throws(() => parseLlmDecision(JSON.stringify({ answers: { interest: answers.interest } }), questions));
  assert.throws(() => parseLlmDecision(JSON.stringify({ answers: { ...answers, unrelated: answers.fit } }), questions));
});

// A choice distribution must use exactly the requested labels and a recognized choice.
test("rejects invalid choices and category sets", () => {
  const answers = validAnswers();
  for (const interest of [
    { ...answers.interest, choice: "maybe" },
    { ...answers.interest, probabilities: { yes: 1 } },
    { ...answers.interest, probabilities: { yes: 0.7, no: 0.2, maybe: 0.1 } },
  ]) {
    assert.throws(() => parseLlmDecision(JSON.stringify({ answers: { ...answers, interest } }), questions));
  }
});

// Reject values that cannot be interpreted as finite, normalized probabilities.
test("rejects non-finite, out-of-range and unnormalized probabilities", () => {
  const answers = validAnswers();
  for (const probabilities of [{ yes: -0.1, no: 1.1 }, { yes: 0.8, no: 0.8 }, { yes: "0.8", no: 0.2 }]) {
    assert.throws(() => parseLlmDecision(JSON.stringify({ answers: { ...answers, interest: { ...answers.interest, probabilities } } }), questions));
  }
  const nonFinite = JSON.stringify({ answers }).replace('"yes":0.8', '"yes":1e400');
  assert.throws(() => parseLlmDecision(nonFinite, questions));
});

// Score answers use the zero-based ordered rubric and may not leave its range.
test("accepts an in-range ordinal score and rejects values outside its rubric", () => {
  const answers = validAnswers();
  assert.deepEqual(parseLlmDecision(JSON.stringify({ answers }), questions), answers);
  for (const score of [-1, 3, "1"]) {
    assert.throws(() => parseLlmDecision(JSON.stringify({ answers: { ...answers, fit: { type: "score", score } } }), questions));
  }
});

// Invalid or excessive provider text fails closed rather than supplying default answers.
test("rejects malformed and oversized text", () => {
  assert.throws(() => parseLlmDecision('{"answers":{', questions));
  assert.throws(() => parseLlmDecision(" ".repeat(131073) + JSON.stringify({ answers: validAnswers() }), questions));
});
