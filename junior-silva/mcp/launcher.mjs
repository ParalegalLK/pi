#!/usr/bin/env node
import readline from "node:readline";
import { dispatchMcpRequest } from "./server.mjs";

const gateway = String(process.env.JUNIOR_SILVA_MCP_GATEWAY_URL || "").trim();
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

async function forward(message) {
	if (!gateway) return dispatchMcpRequest(message, { onProgress: send });
	const response = await fetch(gateway, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(message),
		signal: AbortSignal.timeout(1_220_000),
	});
	if (response.status === 202) return undefined;
	if (!response.ok) throw new Error("The local legal-tool gateway is unavailable.");
	return response.json();
}

function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
lines.on("line", (line) => {
	if (!line.trim()) return;
	try { void forward(JSON.parse(line)).then((value) => { if (value) send(value); }).catch(() => send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "The local legal-tool gateway is unavailable." } })); } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid MCP request." } }); }
});
