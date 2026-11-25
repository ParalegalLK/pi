import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { MODEL_PROVIDERS } from "./model-proxy.mjs";

// Which models LibreChat users may pick for each message, and the effort levels each one supports
// (task/plan.md 3.8, P3.18). A model counts only if the model proxy has a route for its provider, that
// provider's key is set, and Pi's own catalog in this image knows it. Effort levels come from Pi too, so
// the picker offers exactly what each model accepts.

// Pi's thinking levels, from least to most (pi --thinking).
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
// provider/id, as LibreChat's picker sends it in X-Pi-Model and JS_ALLOWED_MODELS lists it.
const MODEL_KEY = /^([a-z][a-z0-9-]{0,31})\/([A-Za-z0-9._:-]{1,128})$/;

// Fixed text only: LibreChat shows these messages to the user word for word, so they never repeat
// what the request sent.
function rejected(message) {
	return Object.assign(new Error(message), { status: 400 });
}

function catalogModel(provider, id) {
	const model = getBuiltinModel(provider, id);
	return model && model.provider === provider && model.id === id ? model : undefined;
}

// What LibreChat's picker gets for one model. `entry` is Pi's own record, kept here and never sent.
function describe(model) {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: Boolean(model.reasoning),
		thinkingLevels: getSupportedThinkingLevels(model),
		images: Array.isArray(model.input) && model.input.includes("image"),
		entry: model,
	};
}

// Reads the model settings once, at start. Throws, with the setting to fix, when they can't work.
// PI_PROVIDER and PI_MODEL are the default, for a message that names no model. Without JS_ALLOWED_MODELS,
// the default is the only model, as before P3.18.
export function loadModelChoices(settings = process.env) {
	const read = (name) => String(settings[name] ?? "").trim();
	const defaultProvider = read("PI_PROVIDER") || "anthropic";
	if (!Object.hasOwn(MODEL_PROVIDERS, defaultProvider)) {
		throw new Error(`PI_PROVIDER must be ${Object.keys(MODEL_PROVIDERS).join(" or ")}. Pi's model calls go through the bridge's model proxy, which has no route for other providers.`);
	}
	const defaultId = read("PI_MODEL");
	if (!defaultId) throw new Error("PI_MODEL is not configured in .env");
	const defaultKey = `${defaultProvider}/${defaultId}`;
	const listed = read("JS_ALLOWED_MODELS");
	const keys = listed ? listed.split(",").map((item) => item.trim()).filter(Boolean) : [defaultKey];
	const models = new Map();
	for (const key of keys) {
		const match = MODEL_KEY.exec(key);
		if (!match) throw new Error(`JS_ALLOWED_MODELS has "${key}", which isn't a provider/model pair such as google/gemini-3.8-flash.`);
		const [, provider, id] = match;
		if (!Object.hasOwn(MODEL_PROVIDERS, provider)) {
			throw new Error(`JS_ALLOWED_MODELS has ${key}, but the model proxy has no route for ${provider}. It has routes for ${Object.keys(MODEL_PROVIDERS).join(" and ")}.`);
		}
		const keySetting = MODEL_PROVIDERS[provider].keySetting;
		if (!read(keySetting)) throw new Error(`${keySetting} is not configured in .env. ${key} needs it.`);
		const model = catalogModel(provider, id);
		if (!model) throw new Error(`${key} isn't in Pi's model catalog in this image, so Pi can't use it.`);
		models.set(key, describe(model));
	}
	if (!models.has(defaultKey)) throw new Error(`PI_PROVIDER and PI_MODEL (${defaultKey}) are the default model, so JS_ALLOWED_MODELS must include them.`);
	const defaultThinking = read("PI_THINKING");
	if (defaultThinking && !THINKING_LEVELS.includes(defaultThinking)) throw new Error(`PI_THINKING must be one of Pi's levels: ${THINKING_LEVELS.join(", ")}.`);
	return { models, defaultKey, defaultThinking };
}

function header(headers, name) {
	const value = headers?.[name];
	return typeof value === "string" ? value.trim() : "";
}

// The model and effort level for one message, from LibreChat's picker (X-Pi-Model, X-Pi-Thinking), or the
// default. A model that isn't allowed, or a level the model doesn't support, is refused with a 400.
export function modelChoice(headers, choices) {
	const model = choices.models.get(header(headers, "x-pi-model") || choices.defaultKey);
	if (!model) throw rejected("The chosen model isn't available here. Choose another model.");
	const level = header(headers, "x-pi-thinking");
	if (level && !model.thinkingLevels.includes(level)) {
		throw rejected(`That effort level isn't available for ${model.name}. Choose one of: ${model.thinkingLevels.join(", ")}.`);
	}
	// With no level chosen: PI_THINKING, or medium, moved to the nearest level this model has, as Pi does.
	const thinking = level || clampThinkingLevel(model.entry, choices.defaultThinking || "medium");
	return { provider: model.provider, model: model.id, thinking, name: model.name };
}

// GET /v1/pi/models: what LibreChat's picker lists, grouped by provider. LibreChat filters it again with
// its own allowed list.
export function piModelsCatalog(choices) {
	const models = [...choices.models.values()]
		.map(({ entry, ...shown }) => shown)
		.sort((left, right) => left.provider.localeCompare(right.provider) || left.name.localeCompare(right.name));
	return { models };
}
