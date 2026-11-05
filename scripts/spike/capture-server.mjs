#!/usr/bin/env node
// Stand-in for Junior Silva that LibreChat calls, for checks L in task/plan.md.
// It answers with canned text and costs nothing. It logs what LibreChat really
// sends: ID headers and message shapes. It never logs the Authorization header.
//
// Send these words in a chat to pick a behaviour:
//   SLOW     Streams for 60 s, for the Stop button test (L6)
//   FAIL500  Returns HTTP 500, to count repeats (L8)
//   LONG     Returns a long reply, to fill the context (L5)
//   PREVIEW  Returns images and previews pointing at the leak listener (L10)
//
// A second port plays an outside host. Anything the browser fetches from it is
// logged as kind "leak", which shows what could leak with no click.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.CAPTURE_PORT || 8126);
const LEAK_PORT = Number(process.env.CAPTURE_LEAK_PORT || 18998);
const LOG = process.env.CAPTURE_LOG || "/out/capture.log";
const TITLE_MODEL = process.env.CAPTURE_TITLE_MODEL || "junior-silva-title";
const LEAK_HOST = `http://localhost:${LEAK_PORT}/leak`;
// Previews run in a frame served from a public host, and browsers can block a public
// page from reaching localhost, which would look like a pass. So previews use a real
// outside address, and these requests are read from the browser's Network tab.
const PUBLIC_TEST_URL = "https://www.gstatic.com/generate_204";
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

function log(entry) {
	const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
	appendFileSync(LOG, `${line}\n`);
	console.log(line);
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

function partShape(part) {
	if (typeof part === "string") return { type: "text", chars: part.length };
	const nested = part.image_url || part.file || part.input_file || {};
	const data = part.text ?? part.file_data ?? nested.url ?? nested.file_data ?? "";
	return {
		type: part.type,
		chars: String(data).length,
		dataPrefix: typeof data === "string" && part.type !== "text" ? data.slice(0, 40) : undefined,
		filename: part.filename || nested.filename || undefined,
	};
}

function messageShape(message) {
	const parts = Array.isArray(message.content) ? message.content : [message.content ?? ""];
	return { role: message.role, parts: parts.map(partShape), extraKeys: Object.keys(message).filter((key) => !["role", "content"].includes(key)) };
}

function latestUserText(messages) {
	const latest = [...messages].reverse().find((message) => message.role === "user");
	if (!latest) return "";
	if (typeof latest.content === "string") return latest.content;
	if (!Array.isArray(latest.content)) return "";
	return latest.content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n");
}

const previewReply = [
	"Preview test.",
	"",
	`![inline image](${LEAK_HOST}/markdown-inline-image)`,
	"",
	"![reference image][spike-ref]",
	"",
	`[spike-ref]: ${LEAK_HOST}/markdown-reference-image`,
	"",
	':::artifact{identifier="spike-no-csp" type="text/html" title="Spike without CSP"}',
	"````html",
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>No CSP</title></head><body><h1>Without CSP</h1><img src="${PUBLIC_TEST_URL}?spike=artifact-image-no-csp" alt=""><div style="background:url(${PUBLIC_TEST_URL}?spike=artifact-css-no-csp)">text</div></body></html>`,
	"````",
	":::",
	"",
	':::artifact{identifier="spike-with-csp" type="text/html" title="Spike with CSP"}',
	"````html",
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>CSP</title></head><body><h1>With CSP</h1><img src="${PUBLIC_TEST_URL}?spike=artifact-image-csp" alt=""><div style="background:url(${PUBLIC_TEST_URL}?spike=artifact-css-csp)">text</div></body></html>`,
	"````",
	":::",
].join("\n");

const longReply = Array.from({ length: 1500 }, (_, index) => `word${index}`).join(" ");

let requestCount = 0;

function chunk(id, model, delta, finish = null) {
	return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function replyWhole(res, id, model, text, streaming) {
	if (!streaming) {
		return send(res, 200, { id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
	}
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	res.write(chunk(id, model, { role: "assistant", content: text }));
	res.write(chunk(id, model, {}, "stop"));
	res.end("data: [DONE]\n\n");
	return undefined;
}

function replySlow(req, res, id, model, seq) {
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	res.write(chunk(id, model, { role: "assistant", content: "Slow reply" }));
	const started = Date.now();
	let finished = false;
	const timer = setInterval(() => {
		if (Date.now() - started >= 60_000) {
			finished = true;
			clearInterval(timer);
			res.write(chunk(id, model, {}, "stop"));
			res.end("data: [DONE]\n\n");
			return;
		}
		res.write(chunk(id, model, { content: " ." }));
	}, 1000);
	res.on("close", () => {
		clearInterval(timer);
		log({ kind: "closed", seq, afterMs: Date.now() - started, finished });
	});
}

async function chat(req, res) {
	const body = JSON.parse(await readBody(req));
	requestCount += 1;
	const seq = requestCount;
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const text = latestUserText(messages);
	log({
		kind: "chat",
		seq,
		userHeader: req.headers["x-librechat-user-id"] ?? null,
		conversationHeader: req.headers["x-librechat-conversation-id"] ?? null,
		bodyUser: body.user ?? null,
		bodyConversationId: body.conversationId ?? null,
		model: body.model,
		stream: body.stream ?? null,
		bodyKeys: Object.keys(body).sort(),
		messageCount: messages.length,
		messages: messages.map(messageShape),
		latestTextStart: text.slice(0, 300),
	});
	const id = `chatcmpl-spike-${seq}`;
	const streaming = body.stream === true;
	if (body.model === TITLE_MODEL) return replyWhole(res, id, body.model, "Spike Title", streaming);
	if (text.includes("FAIL500")) return send(res, 500, { error: { message: "Spike failure", type: "spike" } });
	if (text.includes("SLOW")) return replySlow(req, res, id, body.model, seq);
	if (text.includes("LONG")) return replyWhole(res, id, body.model, longReply, streaming);
	if (text.includes("PREVIEW")) return replyWhole(res, id, body.model, previewReply, streaming);
	return replyWhole(res, id, body.model, `Spike reply ${seq}`, streaming);
}

createServer(async (req, res) => {
	try {
		const url = new URL(req.url || "/", "http://spike.invalid");
		if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok" });
		if (req.method === "GET" && url.pathname === "/v1/models") {
			log({ kind: "models", userHeader: req.headers["x-librechat-user-id"] ?? null, conversationHeader: req.headers["x-librechat-conversation-id"] ?? null });
			return send(res, 200, { object: "list", data: [{ id: "junior-silva-v2", object: "model", created: 0, owned_by: "spike" }] });
		}
		if (req.method === "POST" && url.pathname === "/v1/chat/completions") return await chat(req, res);
		log({ kind: "other", method: req.method, path: url.pathname });
		return send(res, 404, { error: { message: "Not found" } });
	} catch (error) {
		log({ kind: "error", message: String(error?.message || error) });
		if (!res.headersSent) send(res, 500, { error: { message: "Capture server error" } });
		else res.end();
	}
}).listen(PORT, "0.0.0.0", () => log({ kind: "listening", port: PORT }));

createServer((req, res) => {
	log({ kind: "leak", path: req.url, origin: req.headers.origin ?? null, referer: req.headers.referer ?? null, fetchDest: req.headers["sec-fetch-dest"] ?? null });
	res.writeHead(200, { "Content-Type": "image/png", "Content-Length": PIXEL.length, "Cache-Control": "no-store" });
	res.end(PIXEL);
}).listen(LEAK_PORT, "0.0.0.0", () => log({ kind: "listening", port: LEAK_PORT }));
