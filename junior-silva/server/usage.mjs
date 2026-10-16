function nonNegativeNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : 0;
}

export function createUsageTotals() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		totalTokens: 0,
	};
}

export function addAssistantUsage(totals, usage) {
	if (!usage || typeof usage !== "object") return totals;
	totals.inputTokens += nonNegativeNumber(usage.input);
	totals.outputTokens += nonNegativeNumber(usage.output);
	totals.cacheReadTokens += nonNegativeNumber(usage.cacheRead);
	totals.cacheWriteTokens += nonNegativeNumber(usage.cacheWrite);
	totals.reasoningTokens += nonNegativeNumber(usage.reasoning);
	totals.totalTokens += nonNegativeNumber(usage.totalTokens);
	return totals;
}

export function openAiUsage(totals) {
	if (!totals || !Object.values(totals).some((value) => value > 0)) return undefined;
	const promptTokens = totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
	const completionTokens = totals.outputTokens;
	return {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: totals.totalTokens || promptTokens + completionTokens,
		prompt_tokens_details: { cached_tokens: totals.cacheReadTokens },
		completion_tokens_details: { reasoning_tokens: totals.reasoningTokens },
	};
}

export function requestsStreamUsage(body) {
	return body?.streamUsage === true || body?.stream_options?.include_usage === true;
}
