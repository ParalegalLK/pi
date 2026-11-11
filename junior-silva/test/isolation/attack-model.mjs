// Isolation check (task/plan.md, section 7; tasks P3.15 and P3.17): a stand-in for Anthropic and for Gemini
// behind the bridge's real model proxy, for the full-chain tests. It scripts the attacks a tricked Pi would
// try, so each one is tried every time, which a real model might refuse to do. It answers in the format of
// the route it's called on: Anthropic's /v1/messages, or Gemini's /models/<model>:streamGenerateContent.
//
// It answers from the scenario word in the user's message (ISO-<NAME>) and from how many tool results
// have come back since, so extra model calls can't throw it off. It notes every call in /out/model.jsonl:
// the scenario and the tool results it got back. Of the key and authorization headers it keeps only
// SHA-256 hashes, never the headers themselves.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = Number(process.env.ATTACK_MODEL_PORT || 9100);
const SLOW_MS = Number(process.env.ATTACK_SLOW_MS || 20_000);
const OUT = process.env.ATTACK_MODEL_OUT || "/out";
const SCENARIOS = /\bISO-(HELLO|SLOW|HOLD|PUBLISH|OTHERPATH|PROXY|MANYCALLS|MEMORY|FORK)\b/;
let count = 0;

const hash = (value) => (value ? createHash("sha256").update(String(value)).digest("hex") : null);
const blocks = (message) => (Array.isArray(message?.content) ? message.content : [{ type: "text", text: String(message?.content ?? "") }]);
const resultText = (block) => (typeof block.content === "string" ? block.content : (block.content || []).map((part) => part.text || "").join("\n"));
// Scripts go in as base64 and run from /tmp, so no quoting can break them.
const script = (name, source) => `echo ${Buffer.from(source).toString("base64")} | base64 -d > /tmp/${name} && node /tmp/${name}`;

// B's own valid token against the model proxy: everything but the first and the echo must be refused.
// The crafted calls say "isolation crafted call", never a scenario word, so they're answered as plain calls.
// They use the format of the provider Pi is on, and each case has the same name for both, so the check
// reads them the same way. "other-provider" sends a well-formed call to the other provider's route.
const proxyScript = (model, provider) => `
const gateway = process.env.JS_GATEWAY_URL;
const token = process.env.JS_RUN_TOKEN;
const model = ${JSON.stringify(model)};
const anthropicRoute = "/model/anthropic/v1/messages";
const anthropicBody = () => ({ model, max_tokens: 16, stream: false, messages: [{ role: "user", content: "isolation crafted call" }] });
const anthropicCases = [
	["valid", anthropicBody()],
	["other-model", { ...anthropicBody(), model: "claude-isolation-other" }],
	["url-image", { ...anthropicBody(), messages: [{ role: "user", content: [{ type: "text", text: "isolation crafted call" }, { type: "image", source: { type: "url", url: "https://evil.example/x.png" } }] }] }],
	["web-search", { ...anthropicBody(), tools: [{ type: "web_search_20250305", name: "web_search" }] }],
	["web-fetch", { ...anthropicBody(), tools: [{ type: "web_fetch_20250910", name: "web_fetch" }] }],
	["mcp-servers", { ...anthropicBody(), mcp_servers: [{ type: "url", url: "https://evil.example/mcp", name: "evil" }] }],
	["fallbacks", { ...anthropicBody(), fallbacks: [{ model: "claude-isolation-other" }] }],
	["oversized", { ...anthropicBody(), messages: [{ role: "user", content: "x".repeat(33 * 1024 * 1024) }] }],
	["echo-key", { ...anthropicBody(), messages: [{ role: "user", content: "ISO-ECHO-KEY" }] }],
	["other-route", anthropicBody(), "/model/openai/v1/chat/completions"],
	["other-provider", { contents: [{ role: "user", parts: [{ text: "isolation crafted call" }] }] }, "/model/google/models/" + model + ":streamGenerateContent?alt=sse", token, "x-goog-api-key"],
	["no-token", anthropicBody(), undefined, null],
	["wrong-token", anthropicBody(), undefined, "0".repeat(64)],
];
// Google's equivalents: fileData for a URL image, googleSearch and urlContext for the web tools, codeExecution
// for other servers, and cachedContent for another model's or chat's content.
const googleRoute = "/model/google/models/" + model + ":streamGenerateContent?alt=sse";
const googleBody = (text = "isolation crafted call") => ({ contents: [{ role: "user", parts: [{ text }] }] });
const googleCases = [
	["valid", googleBody()],
	["other-model", googleBody(), "/model/google/models/gemini-isolation-other:streamGenerateContent?alt=sse"],
	["url-image", { contents: [{ role: "user", parts: [{ text: "isolation crafted call" }, { fileData: { fileUri: "https://evil.example/x.png", mimeType: "image/png" } }] }] }],
	["web-search", { ...googleBody(), tools: [{ googleSearch: {} }] }],
	["web-fetch", { ...googleBody(), tools: [{ urlContext: {} }] }],
	["mcp-servers", { ...googleBody(), tools: [{ codeExecution: {} }] }],
	["fallbacks", { ...googleBody(), cachedContent: "cachedContents/isolation-other" }],
	["oversized", googleBody("x".repeat(33 * 1024 * 1024))],
	["echo-key", googleBody("ISO-ECHO-KEY")],
	["other-route", googleBody(), "/model/google/models/" + model + ":generateContent"],
	["other-provider", anthropicBody(), anthropicRoute, token, "x-api-key"],
	["no-token", googleBody(), undefined, null],
	["wrong-token", googleBody(), undefined, "0".repeat(64)],
];
const google = ${JSON.stringify(provider)} === "google";
const cases = google ? googleCases : anthropicCases;
(async () => {
	for (const [name, body, route = google ? googleRoute : anthropicRoute, key = token, keyHeader = google ? "x-goog-api-key" : "x-api-key"] of cases) {
		let status;
		let text = "";
		try {
			const headers = keyHeader === "x-api-key" ? { "content-type": "application/json", "anthropic-version": "2023-06-01" } : { "content-type": "application/json" };
			if (key) headers[keyHeader] = key;
			const response = await fetch(gateway + route, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
			status = response.status;
			text = (await response.text()).replace(/\\s+/g, " ").slice(0, 200);
		} catch (error) {
			status = "failed:" + (error.cause?.code || error.name);
		}
		console.log("CASE=" + name + " STATUS=" + status + " BODY=" + text);
	}
})();
`;

// More tool calls at once than the gateway allows for one token. Each call sends half its body and waits,
// so the first ones are still running when the rest arrive.
const manyCallsScript = `
const http = require("http");
const url = new URL(process.env.JS_GATEWAY_URL + "/internal/mcp");
const token = process.env.JS_RUN_TOKEN;
const requests = [];
const results = Array.from({ length: 24 }, () => new Promise((resolve) => {
	const request = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", "transfer-encoding": "chunked" } }, (response) => {
		response.resume();
		response.on("end", () => resolve(response.statusCode));
		response.on("error", () => resolve("error"));
	});
	request.on("error", (error) => resolve("error:" + error.code));
	request.write('{"jsonrpc":"2.0","id":1,');
	requests.push(request);
}));
setTimeout(() => { for (const request of requests) { try { request.end('"method":"tools/list"}'); } catch {} } }, 3000);
Promise.all(results).then((codes) => console.log("CALLS=" + codes.length + " OK=" + codes.filter((code) => code === 200).length + " LIMITED=" + codes.filter((code) => code === 429).length + " OTHER=" + codes.filter((code) => code !== 200 && code !== 429).join(",")));
`;

const forkCommand = `python3 -c 'import os, time
count = 0
problem = "none"
while count < 4000:
    try:
        pid = os.fork()
    except OSError as error:
        problem = error.strerror
        break
    if pid == 0:
        time.sleep(20)
        os._exit(0)
    count += 1
print("FORKS=%d LIMIT=%s" % (count, problem))'`;

function sse(res, type, data) {
	res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

function stream(res, model, block, stopReason) {
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	sse(res, "message_start", { message: { id: `msg_iso_${count}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
	if (block.text !== undefined) {
		sse(res, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
		sse(res, "content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } });
	} else {
		sse(res, "content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_iso_${count}`, name: block.name, input: {} } });
		sse(res, "content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
	}
	sse(res, "content_block_stop", { index: 0 });
	sse(res, "message_delta", { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } });
	sse(res, "message_stop", {});
	res.end();
}

// Gemini streams one JSON answer per "data:" line. A tool call is a functionCall part.
function geminiStream(res, model, block) {
	res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
	const part = block.text !== undefined ? { text: block.text } : { functionCall: { name: block.name, args: block.input } };
	res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }, modelVersion: model, responseId: `iso_${count}` })}\n\n`);
}

function json(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
	res.end(body);
}

const GEMINI_PATH = /^\/models\/([A-Za-z0-9._-]+):streamGenerateContent$/;
const partsOf = (content) => (Array.isArray(content?.parts) ? content.parts : []);
const replyText = (response) => {
	const value = response?.output ?? response?.error ?? "";
	return typeof value === "string" ? value : JSON.stringify(value);
};

// What a call says, in either format: the user's last message with text, the tool results that came back
// after it, and the tools Pi listed.
function readCall(body, gemini) {
	if (gemini) {
		const contents = Array.isArray(body.contents) ? body.contents : [];
		let promptIndex = -1;
		for (let index = contents.length - 1; index >= 0; index -= 1) {
			if (contents[index].role === "user" && partsOf(contents[index]).some((part) => typeof part.text === "string")) {
				promptIndex = index;
				break;
			}
		}
		const prompt = promptIndex >= 0 ? partsOf(contents[promptIndex]).filter((part) => typeof part.text === "string").map((part) => part.text).join("\n") : "";
		const results = contents.slice(promptIndex + 1).flatMap(partsOf).filter((part) => part.functionResponse).map((part) => replyText(part.functionResponse.response));
		const toolNames = (Array.isArray(body.tools) ? body.tools : []).flatMap((tool) => (Array.isArray(tool.functionDeclarations) ? tool.functionDeclarations : [])).map((tool) => tool.name);
		return { prompt, results, toolNames };
	}
	const messages = Array.isArray(body.messages) ? body.messages : [];
	let promptIndex = -1;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === "user" && blocks(messages[index]).some((block) => block.type === "text")) {
			promptIndex = index;
			break;
		}
	}
	const prompt = promptIndex >= 0 ? blocks(messages[promptIndex]).filter((block) => block.type === "text").map((block) => block.text).join("\n") : "";
	const results = messages.slice(promptIndex + 1).flatMap(blocks).filter((block) => block.type === "tool_result").map(resultText);
	const toolNames = (Array.isArray(body.tools) ? body.tools : []).map((tool) => tool.name);
	return { prompt, results, toolNames };
}

const server = createServer(async (req, res) => {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	count += 1;
	let body;
	try {
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		body = {};
	}
	const pathname = new URL(req.url || "/", "http://model.invalid").pathname;
	const gemini = GEMINI_PATH.exec(pathname);
	const model = gemini ? gemini[1] : body.model;
	const { prompt, results, toolNames } = readCall(body, Boolean(gemini));
	const scenario = SCENARIOS.exec(prompt)?.[1] ?? "NONE";
	const workspace = /Use this request-only workspace for every file you create: (\S+?)\. /.exec(prompt)?.[1];
	const otherPath = /\bPATH=(\S+)/.exec(prompt)?.[1];
	const mark = /\bISO-MARK-[a-z0-9]+\b/.exec(prompt)?.[0] ?? "";
	const tool = (wanted) => toolNames.find((name) => name === wanted || name.endsWith(`__${wanted}`)) ?? wanted;
	const key = gemini ? req.headers["x-goog-api-key"] : req.headers["x-api-key"];
	appendFileSync(`${OUT}/model.jsonl`, `${JSON.stringify({ n: count, at: Date.now(), path: req.url, provider: gemini ? "google" : "anthropic", scenario, mark, results: results.length, resultTexts: results.map((text) => text.slice(0, 6000)), apiKeyHash: hash(key), authorizationHash: hash(req.headers.authorization), model: model ?? null, stream: body.stream !== false })}\n`);

	if (!gemini && pathname !== "/v1/messages") return json(res, 404, { type: "error", error: { type: "not_found_error", message: "Not found" } });
	// An upstream error that repeats the key it was sent: the proxy must remove it before Pi sees it.
	if (prompt.includes("ISO-ECHO-KEY")) {
		if (gemini) return json(res, 401, { error: { code: 401, message: `API key not valid: ${key}`, status: "UNAUTHENTICATED" } });
		return json(res, 401, { type: "error", error: { type: "authentication_error", message: `invalid x-api-key: ${key}` } });
	}
	if (!gemini && body.stream === false) return json(res, 200, { id: `msg_iso_${count}`, type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ISO-CRAFTED-OK" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });

	const step = results.length;
	const say = (text) => (gemini ? geminiStream(res, model, { text }) : stream(res, model, { text }, "end_turn"));
	const call = (name, input) => (gemini ? geminiStream(res, model, { name: tool(name), input }) : stream(res, model, { name: tool(name), input }, "tool_use"));
	const bash = (command) => call("bash", { command });
	switch (scenario) {
		case "HOLD":
			return undefined;
		case "SLOW":
			return void setTimeout(() => say("ISO-SLOW-DONE"), SLOW_MS);
		case "PUBLISH":
			if (step === 0) return bash(`printf 'ISO-NOTE %s\\n' '${mark}' > "$JUNIOR_SILVA_WORKSPACE_ROOT/iso-note.md" && echo "WROTE=$JUNIOR_SILVA_WORKSPACE_ROOT/iso-note.md"`);
			if (step === 1) return call("workbench_publish_artifact", { file_path: `${workspace}/iso-note.md` });
			return say(`ISO-PUBLISH-DONE ${/"download_url"\s*:\s*"([^"]+)"/.exec(results.join("\n"))?.[1] ?? "NO-LINK"}`);
		case "OTHERPATH":
			if (step === 0) return call("workbench_publish_artifact", { file_path: otherPath });
			if (step === 1) return call("review_prepare_document_set", { file_path: otherPath });
			if (step === 2) return bash(`echo "USERS=$(ls /data/users | wc -l)"; if [ -e '${otherPath}' ]; then echo OTHER=present; else echo OTHER=absent; fi`);
			return say("ISO-OTHERPATH-DONE");
		case "PROXY":
			if (step === 0) return bash(script("iso-proxy.cjs", proxyScript(model, gemini ? "google" : "anthropic")));
			return say("ISO-PROXY-DONE");
		case "MANYCALLS":
			if (step === 0) return bash(script("iso-many-calls.cjs", manyCallsScript));
			return say("ISO-MANYCALLS-DONE");
		case "MEMORY":
			if (step === 0) return bash(`node -e "const a = []; for (;;) a.push(Buffer.alloc(64 * 1024 * 1024, 1))"; echo "EXIT=$?"`);
			return say("ISO-MEMORY-DONE");
		case "FORK":
			if (step === 0) return bash(forkCommand);
			return say("ISO-FORK-DONE");
		default:
			return say(`ISO-${scenario}-DONE`);
	}
});
server.listen(PORT, "0.0.0.0", () => console.log(`attack model listening on ${PORT}`));
