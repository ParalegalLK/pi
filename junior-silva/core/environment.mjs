import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadDotEnv(filename) {
	let text;
	try { text = readFileSync(filename, "utf8"); } catch { return; }
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator < 1) continue;
		const name = line.slice(0, separator).trim();
		let value = line.slice(separator + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		if (!(name in process.env)) process.env[name] = value;
	}
}

loadDotEnv(path.join(projectRoot, ".env"));

export function env(name, fallback = "") { return process.env[name]?.trim() || fallback; }
export function requiredEnv(name) {
	const value = env(name);
	if (!value) throw new Error(`${name} is not configured in .env`);
	return value;
}
export function booleanEnv(name, fallback = false) {
	const value = env(name);
	if (!value) return fallback;
	return /^(?:1|true|yes|on)$/i.test(value);
}

export const dataRoot = path.resolve(env("JUNIOR_SILVA_DATA_ROOT", path.join(projectRoot, "junior-silva")));
export const artifactsRoot = path.resolve(env("JUNIOR_SILVA_ARTIFACT_ROOT", path.join(dataRoot, "artifacts")));
export const uploadsRoot = path.resolve(env("JUNIOR_SILVA_UPLOAD_ROOT", path.join(dataRoot, "uploads")));
export const workspaceRoot = path.resolve(env("JUNIOR_SILVA_WORKSPACE_ROOT", path.join(dataRoot, "workspace")));

export { projectRoot };
