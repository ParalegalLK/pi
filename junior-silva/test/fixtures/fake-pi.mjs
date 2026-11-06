// Test only: a stand-in for Pi's program, so the bridge's handling of a run can be tested with no
// model. It acts out the scenario named in the user's message and notes what it did for the test.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const prompt = process.argv.at(-1);
const workspace = process.env.JUNIOR_SILVA_WORKSPACE_ROOT;
const dataRoot = process.env.JUNIOR_SILVA_DATA_ROOT;
const isRepair = prompt.startsWith("A requested deliverable exists");

// A repair run's prompt doesn't repeat the user's message, so the first run leaves the details.
const stateFile = path.join(dataRoot, `fake-pi-${path.basename(workspace)}.json`);
if (!isRepair) writeFileSync(stateFile, JSON.stringify({ scenario: /SCENARIO-([A-Z_]+)/.exec(prompt)?.[1] ?? "OK", tag: /TAG-(\w+)/.exec(prompt)?.[1] ?? "" }));
const { scenario, tag } = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { scenario: "OK", tag: "" };

const note = (details) => appendFileSync(path.join(dataRoot, "fake-pi.jsonl"), `${JSON.stringify({ at: Date.now(), pid: process.pid, tag, scenario, isRepair, workspace, ...details })}\n`);
const say = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const answer = (text, stopReason = "stop", errorMessage) => say({ type: "message_end", message: { role: "assistant", stopReason, errorMessage, content: text ? [{ type: "text", text }] : [] } });
// Keeps running until something stops it, and cleans up after a failed test.
const hang = () => setTimeout(() => process.exit(9), 60_000);
const toolRouteStatus = async () => (await fetch(process.env.JUNIOR_SILVA_MCP_GATEWAY_URL, {
	method: "POST",
	headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.JS_RUN_TOKEN}` },
	body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
})).status;
const writeDeliverable = () => writeFileSync(path.join(workspace, "deliverable.md"), "# Rescued note\n");

const scenarios = {
	OK: () => answer("FAKE-ANSWER"),
	HANG: hang,
	STUCK: async () => {
		process.on("SIGTERM", async () => note({ event: "after-stop", toolRouteStatus: await toolRouteStatus() }));
		hang();
		note({ event: "ready", toolRouteStatus: await toolRouteStatus() });
	},
	LEFTOVER: () => {
		const leftover = spawn("sleep", ["60"], { detached: true, stdio: "inherit" });
		leftover.unref();
		note({ event: "ready", leftover: leftover.pid });
		hang();
	},
	RESCUE: () => {
		if (isRepair) return answer("I looked at the file again.");
		writeDeliverable();
		answer("I wrote the note.");
	},
	STOP_IN_REPAIR: () => {
		if (isRepair) return hang();
		writeDeliverable();
		answer("I wrote the note.");
	},
	FAIL_PARTIAL: () => answer("HALF-AN-ANSWER", "error", "SECRET-UPSTREAM-TEXT\nsecond line"),
	FAIL_EMPTY: () => answer("", "error", "401 SECRET-UPSTREAM-TEXT"),
	CUT_OFF: () => answer("A-LONG-ANSWER", "length"),
	RETRIED: () => {
		answer("", "error", "overloaded");
		answer("FAKE-ANSWER");
	},
	GUARD: () => say({ type: "message_end", message: { role: "custom", customType: "junior-silva-scope", content: "GUARD-MESSAGE" } }),
	NO_TEXT: () => answer(""),
};

note({ event: "started" });
await scenarios[scenario]();
