#!/usr/bin/env node
// Reads Pi's JSON output and the fake bridge's log, and prints "key=value" lines
// for js-spike.sh. Args: <pi-output.jsonl> <bridge.log> <started-at-ms>
import { readFileSync } from "node:fs";

const [outputFile, logFile, startedAt] = process.argv.slice(2);

function jsonLines(file) {
	let text = "";
	try { text = readFileSync(file, "utf8"); } catch { return []; }
	return text.split("\n").filter(Boolean).flatMap((line) => {
		try { return [JSON.parse(line)]; } catch { return []; }
	});
}

const events = jsonLines(outputFile);
const entries = jsonLines(logFile).filter((entry) => entry.at >= Number(startedAt));
const models = entries.filter((entry) => entry.kind === "model");
const toolsList = entries.find((entry) => entry.kind === "mcp" && entry.method === "tools/list");
const toolEnds = events.filter((event) => event.type === "tool_execution_end");
const finals = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant");
const lastFinal = finals.at(-1)?.message;
const finalText = (lastFinal?.content || []).filter((part) => part.type === "text").map((part) => part.text).join("");
const first = models[0];

const values = {
	model_requests: models.length,
	first_model_ms: first ? first.at - Number(startedAt) : -1,
	tools_list_ms: toolsList ? toolsList.at - Number(startedAt) : -1,
	first_request_lists_mcp: Boolean(first?.mcpListed),
	token_matches: Boolean(first?.tokenMatches),
	saw_prompt_1: models.some((entry) => entry.sawPrompt1),
	bash_ok: toolEnds.some((event) => event.toolName === "bash" && !event.isError),
	mcp_ok: toolEnds.some((event) => String(event.toolName).endsWith("rag_chat_research") && !event.isError),
	final_text: JSON.stringify(finalText.slice(0, 80)),
	stop_reason: lastFinal?.stopReason ?? "none",
	error_message: JSON.stringify(String(lastFinal?.errorMessage ?? "").slice(0, 160)),
	model_query: first?.query ?? "",
	anthropic_beta: first?.anthropicBeta ?? "",
	body_keys: (first?.bodyKeys ?? []).join(","),
	tool_names: (first?.toolNames ?? []).join(","),
};
for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);
