import { randomBytes } from "node:crypto";

const tokens = new Map();

// The same address can arrive as 127.0.0.1 or ::ffff:127.0.0.1, depending on how a server listens.
export function plainAddress(address) {
	return String(address || "").replace(/^::ffff:/i, "");
}

export function bearerToken(req) {
	return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
}

// A run token ties one Pi run to one chat, to the address that run calls from, and to the model it was
// started with, { provider, id } (P3.18). Pi sends it with every tool and model call, so the bridge knows
// which chat a call is for, and the model proxy allows only that run's model. Tokens live only in this
// process.
export function createRunToken(chat, lifetimeMs, callerAddress, model) {
	const token = randomBytes(32).toString("hex");
	tokens.set(token, { chat, model, callerAddress: plainAddress(callerAddress), expiresAt: Date.now() + lifetimeMs });
	return token;
}

// The run a token belongs to: its chat and its model. A token sent from any address other than its own
// run's gives nothing, so a stolen one is useless.
export function runForToken(token, callerAddress) {
	const entry = tokens.get(token);
	if (!entry) return undefined;
	if (Date.now() >= entry.expiresAt) {
		tokens.delete(token);
		return undefined;
	}
	return entry.callerAddress && plainAddress(callerAddress) === entry.callerAddress ? { chat: entry.chat, model: entry.model } : undefined;
}

export function chatForRunToken(token, callerAddress) {
	return runForToken(token, callerAddress)?.chat;
}

export function revokeRunToken(token) {
	tokens.delete(token);
}
