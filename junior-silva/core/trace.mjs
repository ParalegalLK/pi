import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { booleanEnv, dataRoot, env } from "./environment.mjs";

const REDACTED = "[REDACTED]";
const DEFAULT_MAX_VALUE_BYTES = 256 * 1024;
const SENSITIVE_QUERY_VALUE = /([?&](?:api[_-]?key|authorization|secret|token|password|signature|x-amz-signature)=)[^&#\s]+/gi;
const DIRECT_SECRET = /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{16,})\b/g;

function isSensitiveKey(key) {
	const normalized = String(key || "").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
	return /(?:^|_)(?:api_key|authorization|secret|password|credential|cookie|signature|access_token|refresh_token|id_token|bearer_token|token)(?:$|_)/.test(normalized);
}

function timestamp() {
	return new Date().toISOString();
}

function nonNegative(value) {
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? number : 0;
}

function logRoot() {
	return path.resolve(env("JUNIOR_SILVA_LOG_ROOT", path.join(dataRoot, "logs")));
}

function maxValueBytes() {
	const configured = Number(env("JUNIOR_SILVA_LOG_MAX_VALUE_BYTES", String(DEFAULT_MAX_VALUE_BYTES)));
	return Number.isFinite(configured) && configured >= 1024 ? configured : DEFAULT_MAX_VALUE_BYTES;
}

function secretValues() {
	return Object.entries(process.env)
		.filter(([key, value]) => isSensitiveKey(key) && typeof value === "string" && value.length >= 8)
		.map(([, value]) => value)
		.sort((left, right) => right.length - left.length);
}

function redactText(value) {
	let output = String(value || "");
	for (const secret of secretValues()) output = output.split(secret).join(REDACTED);
	return output.replace(SENSITIVE_QUERY_VALUE, `$1${REDACTED}`).replace(DIRECT_SECRET, REDACTED);
}

function truncateText(value, limit) {
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes <= limit) return value;
	const preview = Buffer.from(value, "utf8").subarray(0, limit).toString("utf8");
	return {
		truncated: true,
		original_bytes: bytes,
		sha256: createHash("sha256").update(value).digest("hex"),
		preview,
	};
}

export function redactTraceValue(value, { limit = maxValueBytes(), key = "" } = {}) {
	if (isSensitiveKey(key)) return REDACTED;
	if (typeof value === "string") return truncateText(redactText(value), limit);
	if (value === null || typeof value !== "object") return value;
	if (Buffer.isBuffer(value)) return { binary: true, bytes: value.length, sha256: createHash("sha256").update(value).digest("hex") };
	if (Array.isArray(value)) return value.map((item) => redactTraceValue(item, { limit }));
	const output = {};
	for (const [childKey, childValue] of Object.entries(value)) output[childKey] = redactTraceValue(childValue, { limit, key: childKey });
	return output;
}

function assistantUsage(message) {
	const usage = message?.usage;
	if (!usage || typeof usage !== "object") return undefined;
	return {
		input_tokens: nonNegative(usage.input),
		output_tokens: nonNegative(usage.output),
		cache_read_tokens: nonNegative(usage.cacheRead),
		cache_write_tokens: nonNegative(usage.cacheWrite),
		reasoning_tokens: nonNegative(usage.reasoning),
		total_tokens: nonNegative(usage.totalTokens),
	};
}

function artifactReferences(value, found = [], depth = 0) {
	if (!value || typeof value !== "object" || depth > 8) return found;
	if (Array.isArray(value)) {
		for (const item of value) artifactReferences(item, found, depth + 1);
		return found;
	}
	const candidate = value;
	if (typeof candidate.download_url === "string") {
		found.push({
			name: typeof candidate.name === "string" ? candidate.name : undefined,
			media_type: typeof candidate.media_type === "string" ? candidate.media_type : undefined,
			download_url: redactTraceValue(candidate.download_url),
		});
	}
	for (const child of Object.values(candidate)) artifactReferences(child, found, depth + 1);
	return found;
}

function uniqueArtifacts(value) {
	const seen = new Set();
	return artifactReferences(value).filter((artifact) => {
		const key = `${artifact.name || ""}|${artifact.download_url || ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function createRequestTrace({ requestId = `trace-${randomUUID()}`, sessionId, conversationKey, source = "openai", model, provider, thinking } = {}) {
	if (!booleanEnv("JUNIOR_SILVA_TRACE_LOGS", true)) return createNoopTrace(requestId);
	const startedAt = timestamp();
	const startedAtMs = Date.now();
	const directory = path.join(logRoot(), "traces", startedAt.slice(0, 10), safeSegment(requestId));
	const eventsFile = path.join(directory, "events.jsonl");
	const traceFile = path.join(directory, "trace.json");
	const state = {
		schema_version: 1,
		trace: {
			request_id: requestId,
			session_id: sessionId || undefined,
			conversation_key: conversationKey || undefined,
			source,
			started_at: startedAt,
			ended_at: undefined,
			outcome: "running",
			elapsed_ms: undefined,
		},
		request: { model, provider, thinking, original_query: undefined, attachments: [], retained_attachment_count: 0 },
		timeline: [],
		llm_calls: [],
		tool_calls: [],
		final: undefined,
	};
	const toolCalls = new Map();
	let queue = Promise.resolve();

	function enqueue(task) {
		queue = queue.then(task).catch((error) => console.error(`[junior-silva-v2][trace] ${error?.message || error}`));
		return queue;
	}

	function event(type, fields = {}) {
		const record = { sequence: state.timeline.length + 1, at: timestamp(), type, ...fields };
		state.timeline.push(record);
		return enqueue(async () => {
			await mkdir(directory, { recursive: true });
			await appendFile(eventsFile, `${JSON.stringify(redactTraceValue(record))}\n`, "utf8");
		});
	}

	function writeSnapshot() {
		return enqueue(async () => {
			await mkdir(directory, { recursive: true });
			await writeFile(traceFile, `${JSON.stringify(redactTraceValue(state), null, 2)}\n`, "utf8");
		});
	}

	return {
		requestId,
		directory,
		traceFile,
		start(request = {}) {
			state.request = { ...state.request, ...redactTraceValue(request) };
			event("request_started", { request_id: requestId });
			return writeSnapshot();
		},
		attachments(attachments, retainedAttachmentCount = 0) {
			state.request.attachments = redactTraceValue(attachments);
			state.request.retained_attachment_count = nonNegative(retainedAttachmentCount);
			return event("attachments_recorded", { count: attachments.length, retained_attachment_count: retainedAttachmentCount });
		},
		attempt(status, fields = {}) {
			return event(`pi_attempt_${status}`, redactTraceValue(fields));
		},
		toolStart(input = {}) {
			const call = {
				id: input.toolCallId,
				parent_id: input.parentToolCallId,
				name: input.toolName,
				started_at: timestamp(),
				status: "running",
				request: redactTraceValue(input.args),
				updates: [],
			};
			toolCalls.set(input.toolCallId, call);
			state.tool_calls.push(call);
			return event("tool_started", { tool_call_id: call.id, tool: call.name, parent_tool_call_id: call.parent_id });
		},
		toolUpdate(input = {}) {
			const call = toolCalls.get(input.toolCallId);
			if (call) call.updates.push(redactTraceValue(input.partialResult));
			return event("tool_updated", { tool_call_id: input.toolCallId, tool: input.toolName });
		},
		toolEnd(input = {}) {
			const call = toolCalls.get(input.toolCallId);
			const response = redactTraceValue(input.result);
			if (call) {
				call.ended_at = timestamp();
				call.duration_ms = input.durationMs;
				call.status = input.isError ? "error" : "completed";
				call.response = response;
				call.artifacts = uniqueArtifacts(input.result);
			} else {
				state.tool_calls.push({ id: input.toolCallId, name: input.toolName, status: input.isError ? "error" : "completed", duration_ms: input.durationMs, response, artifacts: uniqueArtifacts(input.result) });
			}
			return event(input.isError ? "tool_error" : "tool_completed", { tool_call_id: input.toolCallId, tool: input.toolName, duration_ms: input.durationMs });
		},
		assistantMessage(message) {
			if (message?.role !== "assistant") return;
			const call = {
				at: timestamp(),
				provider: message.provider,
				model: message.model,
				stop_reason: message.stopReason,
				usage: assistantUsage(message),
				response: redactTraceValue(message),
			};
			state.llm_calls.push(call);
			return event("llm_response", { provider: call.provider, model: call.model, usage: call.usage });
		},
		delivery() {
			const artifacts = uniqueArtifacts(state.tool_calls.flatMap((call) => call.artifacts || []));
			const previews = state.tool_calls.filter((call) => /(?:^|__)librechat_prepare_document_preview$/.test(String(call.name || ""))).map((call) => ({
				tool_call_id: call.id,
				status: call.status,
				duration_ms: call.duration_ms,
			}));
			return { artifacts, previews };
		},
		finish({ outcome = "completed", answer, usage, elapsedMs, error, artifacts = [], previews = [] } = {}) {
			state.trace.ended_at = timestamp();
			state.trace.outcome = outcome;
			state.trace.elapsed_ms = Math.max(nonNegative(elapsedMs), Date.now() - startedAtMs);
			state.final = redactTraceValue({ answer, usage, error, artifacts, previews });
			event(`request_${outcome}`, { elapsed_ms: elapsedMs, tool_count: state.tool_calls.length, llm_call_count: state.llm_calls.length });
			return writeSnapshot();
		},
		flush() { return queue; },
	};
}

function createNoopTrace(requestId) {
	const done = Promise.resolve();
	return {
		requestId,
		directory: undefined,
		traceFile: undefined,
		start: () => done,
		attachments: () => done,
		attempt: () => done,
		toolStart: () => done,
		toolUpdate: () => done,
		toolEnd: () => done,
		assistantMessage: () => done,
		delivery: () => ({ artifacts: [], previews: [] }),
		finish: () => done,
		flush: () => done,
	};
}

function safeSegment(value) {
	return String(value || "trace").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "trace";
}
