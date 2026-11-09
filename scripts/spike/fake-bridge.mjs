#!/usr/bin/env node
// Stand-in for the bridge in the gVisor spike (task/plan.md, P0.4). It holds no
// keys. It plays a fake Anthropic model and a fake /internal/mcp, and logs what
// Pi sent to <log>, so the spike can check it.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.SPIKE_BRIDGE_PORT || 8127);
const LOG = process.env.SPIKE_BRIDGE_LOG || "/out/bridge.log";
const TOKEN = process.env.SPIKE_TOKEN || "spike-token";
const MCP_TOOL = "rag_chat_research";

function log(entry) {
	appendFileSync(LOG, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function send(res, status, value) {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(value));
}

function sseEvent(res, type, data) {
	res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

let messageCount = 0;

function streamMessage(res, model, blocks, stopReason) {
	messageCount += 1;
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	sseEvent(res, "message_start", {
		message: { id: `msg_spike_${messageCount}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } },
	});
	blocks.forEach((block, index) => {
		if (block.text !== undefined) {
			sseEvent(res, "content_block_start", { index, content_block: { type: "text", text: "" } });
			sseEvent(res, "content_block_delta", { index, delta: { type: "text_delta", text: block.text } });
		} else {
			sseEvent(res, "content_block_start", { index, content_block: { type: "tool_use", id: `toolu_spike_${messageCount}_${index}`, name: block.name, input: {} } });
			sseEvent(res, "content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
		}
		sseEvent(res, "content_block_stop", { index });
	});
	sseEvent(res, "message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } });
	sseEvent(res, "message_stop", {});
	res.end();
}

function contentBlocks(message) {
	return Array.isArray(message?.content) ? message.content : [{ type: "text", text: String(message?.content ?? "") }];
}

// Tool results that came after the most recent real user prompt in this request.
function toolResultsSincePrompt(messages) {
	let count = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const blocks = contentBlocks(messages[index]);
		if (messages[index].role === "user" && blocks.some((block) => block.type === "text")) break;
		count += blocks.filter((block) => block.type === "tool_result").length;
	}
	return count;
}

async function fakeModel(req, res, url) {
	const body = JSON.parse(await readBody(req));
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const text = JSON.stringify(messages);
	const toolNames = (body.tools || []).map((tool) => tool.name);
	const mcpName = toolNames.find((name) => name === MCP_TOOL || name.endsWith(`__${MCP_TOOL}`));
	const secondPrompt = text.includes("SPIKE-PROMPT-2");
	const done = toolResultsSincePrompt(messages);
	log({
		kind: "model",
		path: url.pathname,
		query: url.search,
		tokenMatches: req.headers["x-api-key"] === TOKEN,
		anthropicVersion: req.headers["anthropic-version"] || null,
		anthropicBeta: req.headers["anthropic-beta"] || null,
		bodyKeys: Object.keys(body).sort(),
		model: body.model,
		toolNames,
		mcpListed: Boolean(mcpName),
		sawPrompt1: text.includes("SPIKE-PROMPT-1"),
		secondPrompt,
		toolResultsSincePrompt: done,
	});
	if (url.pathname !== "/model/anthropic/v1/messages") return send(res, 404, { error: "Unknown model route" });
	if (secondPrompt) return streamMessage(res, body.model, [{ text: "SPIKE-DONE-2" }], "end_turn");
	if (done === 0) {
		return streamMessage(res, body.model, [{ name: "bash", input: { command: 'printf spike-output > "$JUNIOR_SILVA_WORKSPACE_ROOT/from-pi-bash.txt" && node --version' } }], "tool_use");
	}
	if (done === 1 && mcpName) {
		return streamMessage(res, body.model, [{ name: mcpName, input: { question: "spike question", delivery_mode: "supporting_work_product" } }], "tool_use");
	}
	return streamMessage(res, body.model, [{ text: mcpName ? "SPIKE-DONE-1" : "SPIKE-DONE-1-NO-MCP" }], "end_turn");
}

const mcpTools = [{
	name: MCP_TOOL,
	description: "Spike stand-in for legal research.",
	inputSchema: { type: "object", properties: { question: { type: "string" }, delivery_mode: { type: "string" } }, required: ["question"] },
}];

async function fakeMcp(req, res) {
	const message = JSON.parse(await readBody(req));
	log({ kind: "mcp", method: message.method, tool: message.params?.name || null, tokenMatches: req.headers.authorization === `Bearer ${TOKEN}` });
	const reply = (result) => send(res, 200, { jsonrpc: "2.0", id: message.id, result });
	if (message.method === "initialize") {
		return reply({ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "spike-fake-bridge", version: "1.0.0" } });
	}
	if (message.method === "notifications/initialized") return send(res, 202, {});
	if (message.method === "ping") return reply({});
	if (message.method === "tools/list") return reply({ tools: mcpTools });
	if (message.method === "resources/list") return reply({ resources: [] });
	if (message.method === "resources/templates/list") return reply({ resourceTemplates: [] });
	if (message.method === "prompts/list") return reply({ prompts: [] });
	if (message.method === "tools/call") return reply({ content: [{ type: "text", text: "Spike research result." }] });
	if (message.id !== undefined) return send(res, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
	return send(res, 202, {});
}

createServer(async (req, res) => {
	try {
		const url = new URL(req.url || "/", "http://spike.invalid");
		if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok" });
		if (req.method === "POST" && url.pathname.startsWith("/model/")) return await fakeModel(req, res, url);
		if (req.method === "POST" && url.pathname === "/internal/mcp") return await fakeMcp(req, res);
		return send(res, 404, { error: "Not found" });
	} catch (error) {
		log({ kind: "error", message: String(error?.message || error) });
		if (!res.headersSent) send(res, 500, { error: "Spike bridge error" });
		else res.end();
	}
}).listen(PORT, "0.0.0.0", () => log({ kind: "listening", port: PORT }));
