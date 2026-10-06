import vm from "node:vm";
import { booleanEnv } from "../core/environment.mjs";

const FORBIDDEN = /\b(?:require|import|process|globalThis|fetch|XMLHttpRequest|WebSocket|http|https|net|tls|child_process|fs|worker_threads|Function|eval|constructor)\b/i;

// This is intentionally a small, data-only evaluator—not a shell. It has no
// filesystem, network, process, module loader, or artifact write capability.
export async function runDataCode(args, { onProgress = () => {} } = {}) {
	if (!booleanEnv("CODE_RUNNER_ENABLED")) throw new Error("Code runner is disabled by the administrator.");
	const code = String(args.code || "").trim();
	if (!code || code.length > 12_000) throw new Error("Code must be between 1 and 12,000 characters.");
	if (FORBIDDEN.test(code)) throw new Error("This data-only runner does not allow modules, process access, network access, filesystem access, or dynamic evaluation.");
	onProgress("Running an isolated data transformation…");
	const input = JSON.parse(JSON.stringify(args.input ?? {}));
	const sandbox = Object.create(null);
	Object.assign(sandbox, { input, JSON, Math, Number, String, Boolean, Array, Object, Date, RegExp, result: undefined });
	vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
	new vm.Script(`"use strict"; result = (() => { ${code}\n })();`, { filename: "data-transform.js" }).runInContext(sandbox, { timeout: 1_500 });
	const result = JSON.parse(JSON.stringify(sandbox.result));
	const serialized = JSON.stringify(result);
	if (serialized.length > 256_000) throw new Error("Result exceeds the 256 KB limit.");
	return { result, summary: "Completed an isolated, data-only JavaScript transformation." };
}
