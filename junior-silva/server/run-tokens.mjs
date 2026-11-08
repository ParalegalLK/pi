import { randomBytes } from "node:crypto";

const tokens = new Map();

// The same address can arrive as 127.0.0.1 or ::ffff:127.0.0.1, depending on how a server listens.
export function plainAddress(address) {
	return String(address || "").replace(/^::ffff:/i, "");
}

export function bearerToken(req) {
	return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
}

// A run token ties one Pi run to one chat, and to the address that run calls from. Pi sends it with
// every tool call, so the bridge knows which chat the call is for. Tokens live only in this process.
export function createRunToken(chat, lifetimeMs, callerAddress) {
	const token = randomBytes(32).toString("hex");
	tokens.set(token, { chat, callerAddress: plainAddress(callerAddress), expiresAt: Date.now() + lifetimeMs });
	return token;
}

// A token sent from any address other than its own run's gives no chat, so a stolen one is useless.
export function chatForRunToken(token, callerAddress) {
	const entry = tokens.get(token);
	if (!entry) return undefined;
	if (Date.now() >= entry.expiresAt) {
		tokens.delete(token);
		return undefined;
	}
	return entry.callerAddress && plainAddress(callerAddress) === entry.callerAddress ? entry.chat : undefined;
}

export function revokeRunToken(token) {
	tokens.delete(token);
}
