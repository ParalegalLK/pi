import assert from "node:assert/strict";
import test from "node:test";
import { addAssistantUsage, createUsageTotals, openAiUsage, requestsStreamUsage } from "../server/usage.mjs";

test("assistant usage aggregates Pi token fields into an OpenAI-compatible usage object", () => {
	const totals = createUsageTotals();
	addAssistantUsage(totals, {
		input: 120,
		output: 45,
		cacheRead: 80,
		cacheWrite: 10,
		reasoning: 12,
		totalTokens: 255,
	});
	addAssistantUsage(totals, { input: 20, output: 15, totalTokens: 35 });

	assert.deepEqual(openAiUsage(totals), {
		prompt_tokens: 230,
		completion_tokens: 60,
		total_tokens: 290,
		prompt_tokens_details: { cached_tokens: 80 },
		completion_tokens_details: { reasoning_tokens: 12 },
	});
});

test("usage is omitted when Pi did not report token metadata", () => {
	assert.equal(openAiUsage(createUsageTotals()), undefined);
});

test("stream usage is opt-in through standard or LibreChat request fields", () => {
	assert.equal(requestsStreamUsage({ stream_options: { include_usage: true } }), true);
	assert.equal(requestsStreamUsage({ streamUsage: true }), true);
	assert.equal(requestsStreamUsage({ stream: true }), false);
});
