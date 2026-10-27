import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequestTrace, redactTraceValue } from "../core/trace.mjs";

test("request trace records lifecycle, usage, delivery, and redacts secrets", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "junior-silva-traces-"));
	const oldTraceLogs = process.env.JUNIOR_SILVA_TRACE_LOGS;
	const oldLogRoot = process.env.JUNIOR_SILVA_LOG_ROOT;
	const oldSecret = process.env.TRACE_TEST_SECRET;
	process.env.JUNIOR_SILVA_TRACE_LOGS = "true";
	process.env.JUNIOR_SILVA_LOG_ROOT = root;
	process.env.TRACE_TEST_SECRET = "server-secret-value";

	try {
		const trace = createRequestTrace({ requestId: "chatcmpl-trace-test", sessionId: "pi-session", conversationKey: "conversation", source: "openai", model: "junior-silva-v2", provider: "anthropic", thinking: "medium" });
		await trace.start({ original_query: "Review this agreement. Bearer server-secret-value", stream: true });
		await trace.attachments([{ original_name: "agreement.pdf", stored_path: "/data/uploads/hash.pdf", size_bytes: 1234, sha256: "hash", new_this_request: true }], 1);
		await trace.toolStart({ toolCallId: "call-1", toolName: "rag_chat_research", args: { question: "Contract risk", api_key: "server-secret-value" } });
		await trace.toolUpdate({ toolCallId: "call-1", toolName: "rag_chat_research", partialResult: { content: "Searching" } });
		await trace.toolEnd({ toolCallId: "call-1", toolName: "rag_chat_research", durationMs: 42, isError: false, result: { content: "Complete", artifact: { name: "answer.md", download_url: "https://example.test/file?token=server-secret-value" } } });
		await trace.assistantMessage({ role: "assistant", provider: "anthropic", model: "claude-sonnet-5-5", stopReason: "stop", usage: { input: 10, output: 20, cacheRead: 5, cacheWrite: 1, reasoning: 4, totalTokens: 40 }, content: [{ type: "text", text: "Done" }] });
		const delivery = trace.delivery();
		await trace.finish({ outcome: "completed", answer: "Finished", usage: { prompt_tokens: 16, completion_tokens: 20, total_tokens: 40 }, elapsedMs: 100, artifacts: delivery.artifacts, previews: delivery.previews });

		const traceJson = JSON.parse(await readFile(trace.traceFile, "utf8"));
		const events = await readFile(path.join(trace.directory, "events.jsonl"), "utf8");
		assert.equal(traceJson.trace.outcome, "completed");
		assert.equal(traceJson.request.attachments[0].original_name, "agreement.pdf");
		assert.equal(traceJson.tool_calls[0].duration_ms, 42);
		assert.equal(traceJson.llm_calls[0].usage.total_tokens, 40);
		assert.equal(traceJson.final.usage.total_tokens, 40);
		assert.match(events, /tool_started/);
		assert.doesNotMatch(JSON.stringify(traceJson), /server-secret-value/);
		assert.match(JSON.stringify(traceJson), /\[REDACTED\]/);
	} finally {
		if (oldSecret === undefined) delete process.env.TRACE_TEST_SECRET;
		else process.env.TRACE_TEST_SECRET = oldSecret;
		if (oldLogRoot === undefined) delete process.env.JUNIOR_SILVA_LOG_ROOT;
		else process.env.JUNIOR_SILVA_LOG_ROOT = oldLogRoot;
		if (oldTraceLogs === undefined) delete process.env.JUNIOR_SILVA_TRACE_LOGS;
		else process.env.JUNIOR_SILVA_TRACE_LOGS = oldTraceLogs;
		await rm(root, { recursive: true, force: true });
	}
});

test("redaction removes credential-shaped values from nested payloads", () => {
	const value = redactTraceValue({ authorization: "Bearer token-value", url: "https://example.test/file?signature=abc123" });
	assert.equal(value.authorization, "[REDACTED]");
	assert.equal(value.url, "https://example.test/file?signature=[REDACTED]");
});
