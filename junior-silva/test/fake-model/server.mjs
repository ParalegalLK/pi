// Test only: a pretend Anthropic Messages API, and a pretend Gemini API (P3.17). It follows a script instead
// of thinking, records every request it gets, and costs nothing. Real Pi, and the model proxy, talk to it as
// to Anthropic on /v1/messages, and as to Gemini on /models/<model>:streamGenerateContent. The Anthropic stream
// format comes from the P0 spike (scripts/spike/fake-bridge.mjs), and the Gemini one from Pi's captured calls,
// both of which real Pi accepted.
//
// Script steps, one per model call:
//   { text }                  a normal answer
//   { tool, input }           a tool call, matched to the tool name Pi lists
//   { text, cutOff: true }    stops with max_tokens
//   { text, streamError }     some text, then Anthropic's stream error event
//   { status, error }         an HTTP error, such as 401 or 529
//   { hold: true }            never answers
import { createServer } from "node:http";

function sendJson(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
	res.end(body);
}

function sseEvent(res, type, data) {
	res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

// Pi lists MCP tools under their own names, or with a server prefix such as "server__name". Anthropic's
// format lists tools directly, Gemini's inside functionDeclarations.
function listedToolName(body, wanted) {
	const tools = Array.isArray(body.tools) ? body.tools : [];
	const names = tools.flatMap((tool) => (Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations : [tool])).map((tool) => tool.name);
	return names.find((name) => name === wanted || name.endsWith(`__${wanted}`)) ?? wanted;
}

// Gemini's path names the model: /models/<model>:streamGenerateContent.
export const GEMINI_PATH = /^\/models\/([A-Za-z0-9._-]+):streamGenerateContent$/;

// Gemini streams one JSON answer per "data:" line. A tool call is a functionCall part.
function streamGeminiAnswer(res, body, step, number, model) {
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	const parts = [];
	if (step.text !== undefined) parts.push({ text: step.text });
	if (step.tool) parts.push({ functionCall: { name: listedToolName(body, step.tool), args: step.input ?? {} } });
	const chunk = { candidates: [{ content: { role: "model", parts }, finishReason: step.cutOff ? "MAX_TOKENS" : "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }, modelVersion: model, responseId: `fake_${number}` };
	res.end(`data: ${JSON.stringify(chunk)}\n\n`);
}

function streamAnswer(res, body, step, number) {
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	sseEvent(res, "message_start", {
		message: { id: `msg_fake_${number}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
	});
	let index = 0;
	if (step.text !== undefined) {
		sseEvent(res, "content_block_start", { index, content_block: { type: "text", text: "" } });
		sseEvent(res, "content_block_delta", { index, delta: { type: "text_delta", text: step.text } });
	}
	if (step.streamError) {
		res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: step.streamError })}\n\n`);
		res.end();
		return;
	}
	if (step.text !== undefined) {
		sseEvent(res, "content_block_stop", { index });
		index += 1;
	}
	if (step.tool) {
		sseEvent(res, "content_block_start", { index, content_block: { type: "tool_use", id: `toolu_fake_${number}_${index}`, name: listedToolName(body, step.tool), input: {} } });
		sseEvent(res, "content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.input ?? {}) } });
		sseEvent(res, "content_block_stop", { index });
	}
	const stopReason = step.tool ? "tool_use" : step.cutOff ? "max_tokens" : "end_turn";
	sseEvent(res, "message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } });
	sseEvent(res, "message_stop", {});
	res.end();
}

export async function startFakeModel({ host = "127.0.0.1", port = 0 } = {}) {
	const requests = [];
	let steps = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const raw = Buffer.concat(chunks).toString("utf8");
		let body;
		try {
			body = JSON.parse(raw);
		} catch {
			body = undefined;
		}
		const record = { method: req.method, path: req.url, headers: { ...req.headers }, body, raw, closedEarly: false };
		requests.push(record);
		// The caller hung up before the answer was finished, for example after a Stop.
		res.on("close", () => { if (!res.writableEnded) record.closedEarly = true; });
		const pathname = new URL(req.url || "/", "http://fake-model.invalid").pathname;
		const gemini = GEMINI_PATH.exec(pathname);
		if (req.method !== "POST" || (pathname !== "/v1/messages" && !gemini) || !body) {
			return sendJson(res, 404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
		}
		const step = steps.shift() ?? { text: "FAKE-MODEL-HAS-NO-MORE-STEPS" };
		if (step.hold) return;
		// An HTTP error in the format of the API that was called: { type, message } for Anthropic, and
		// { code, message, status } for Gemini.
		if (step.status) return sendJson(res, step.status, gemini ? { error: step.error } : { type: "error", error: step.error });
		if (gemini) return streamGeminiAnswer(res, body, step, requests.length, gemini[1]);
		streamAnswer(res, body, step, requests.length);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, resolve);
	});
	return {
		url: `http://${host}:${server.address().port}`,
		requests,
		// Replaces the steps and clears the records, so each test starts fresh.
		script(next) {
			steps = [...next];
			requests.length = 0;
		},
		close() {
			server.closeAllConnections();
			return new Promise((resolve) => server.close(resolve));
		},
	};
}
