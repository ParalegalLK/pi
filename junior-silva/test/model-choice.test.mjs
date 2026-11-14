import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModelChoices, modelChoice, piModelsCatalog, THINKING_LEVELS } from "../server/model-choice.mjs";

// The models users may pick for each message, and each one's effort levels (task/plan.md 3.8, P3.18).
// The levels come from Pi's own catalog in the image, so these tests run inside the bridge image.
const KEYS = { ANTHROPIC_API_KEY: "test-anthropic-key", GEMINI_API_KEY: "test-gemini-key" };
const BOTH = { ...KEYS, PI_PROVIDER: "anthropic", PI_MODEL: "claude-opus-5-5", JS_ALLOWED_MODELS: "google/gemini-3.8-flash, anthropic/claude-opus-5-5" };

test("Pi's thinking levels, from least to most", () => {
	assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("without JS_ALLOWED_MODELS, the default model is the only one, as before P3.18", () => {
	const choices = loadModelChoices({ ...KEYS, PI_PROVIDER: "google", PI_MODEL: "gemini-3.8-flash", PI_THINKING: "high" });
	assert.deepEqual([...choices.models.keys()], ["google/gemini-3.8-flash"]);
	assert.deepEqual(modelChoice({}, choices), { provider: "google", model: "gemini-3.8-flash", thinking: "high", name: "Gemini 3.8 Flash" });
	assert.throws(() => modelChoice({ "x-pi-model": "anthropic/claude-opus-5-5" }, choices), (error) => error.status === 400 && /chosen model isn't available/.test(error.message));
});

test("the picker's list: each allowed model with its own levels from Pi's catalog, and nothing else", () => {
	const { models } = piModelsCatalog(loadModelChoices(BOTH));
	assert.deepEqual(models.map((model) => `${model.provider}/${model.id}`), ["anthropic/claude-opus-5-5", "google/gemini-3.8-flash"]);
	assert.deepEqual(models[0].thinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
	assert.deepEqual(models[1].thinkingLevels, ["low", "medium", "high"]);
	assert.equal(models[0].name, "Claude Opus 5.5");
	assert.equal(models[1].name, "Gemini 3.8 Flash");
	assert.equal(models[1].images, true);
	for (const model of models) {
		assert.deepEqual(Object.keys(model).sort(), ["contextWindow", "id", "images", "maxTokens", "name", "provider", "reasoning", "thinkingLevels"], "only what the picker shows");
	}
});

test("a message's choice: the picked model and level, or the default", () => {
	const choices = loadModelChoices({ ...BOTH, PI_THINKING: "xhigh" });
	assert.deepEqual(modelChoice({ "x-pi-model": "google/gemini-3.8-flash", "x-pi-thinking": "low" }, choices), { provider: "google", model: "gemini-3.8-flash", thinking: "low", name: "Gemini 3.8 Flash" });
	assert.equal(modelChoice({ "x-pi-model": "anthropic/claude-opus-5-5", "x-pi-thinking": "max" }, choices).thinking, "max");
	assert.equal(modelChoice({ "x-pi-model": " google/gemini-3.8-flash " }, choices).model, "gemini-3.8-flash", "spaces around the header don't matter");
	assert.equal(modelChoice({}, choices).thinking, "xhigh", "no choice: the default model at PI_THINKING");
	assert.equal(modelChoice({ "x-pi-model": "google/gemini-3.8-flash" }, choices).thinking, "high", "a model without PI_THINKING's level gets its nearest, as Pi does");
	assert.equal(modelChoice({}, loadModelChoices(BOTH)).thinking, "medium", "no PI_THINKING: medium");
});

test("choices that aren't allowed get 400 with fixed text, which never repeats what was sent", () => {
	const choices = loadModelChoices(BOTH);
	for (const [label, headers, expected] of [
		["a level Gemini doesn't have", { "x-pi-model": "google/gemini-3.8-flash", "x-pi-thinking": "max" }, /^That effort level isn't available for Gemini 3\.8 Flash\. Choose one of: low, medium, high\.$/],
		["off, which neither model has", { "x-pi-thinking": "off" }, /isn't available for Claude Opus 5\.5\. Choose one of: low, medium, high, xhigh, max\./],
		["a made-up level", { "x-pi-thinking": "ultra<script>" }, /isn't available for Claude Opus 5\.5/],
		["a model in Pi's catalog but not allowed", { "x-pi-model": "anthropic/claude-sonnet-5-5" }, /^The chosen model isn't available here\. Choose another model\.$/],
		["a provider with no route", { "x-pi-model": "openai/gpt-6.1-sol" }, /chosen model isn't available/],
		["not a provider/model pair", { "x-pi-model": "<script>alert(1)</script>" }, /chosen model isn't available/],
		["two values joined, as Node does for a repeated header", { "x-pi-model": "google/gemini-3.8-flash, anthropic/claude-opus-5-5" }, /chosen model isn't available/],
	]) {
		assert.throws(() => modelChoice(headers, choices), (error) => {
			assert.equal(error.status, 400, label);
			assert.match(error.message, expected, label);
			assert.doesNotMatch(error.message, /script|ultra|sonnet|openai/i, `${label}: what the request sent isn't repeated`);
			return true;
		}, label);
	}
});

test("the model settings are checked at start, naming the setting to fix", () => {
	for (const [label, settings, expected] of [
		["a default provider with no route", { ...KEYS, PI_PROVIDER: "openai", PI_MODEL: "gpt-6.1-sol" }, /PI_PROVIDER must be anthropic or google/],
		["no default model", { ...KEYS, PI_PROVIDER: "anthropic" }, /PI_MODEL is not configured in \.env/],
		["not a provider/model pair", { ...BOTH, JS_ALLOWED_MODELS: "gemini-3.8-flash" }, /isn't a provider\/model pair/],
		["a provider the proxy has no route for", { ...BOTH, JS_ALLOWED_MODELS: "anthropic/claude-opus-5-5,openai/gpt-6.1-sol" }, /no route for openai/],
		["a model Pi's catalog doesn't know", { ...BOTH, JS_ALLOWED_MODELS: "anthropic/claude-opus-5-5,anthropic/claude-made-up" }, /anthropic\/claude-made-up isn't in Pi's model catalog/],
		["a missing key", { ...BOTH, GEMINI_API_KEY: "" }, /GEMINI_API_KEY is not configured in \.env\. google\/gemini-3\.8-flash needs it\./],
		["a default that isn't allowed", { ...BOTH, PI_MODEL: "claude-sonnet-5-5" }, /JS_ALLOWED_MODELS must include them/],
		["an unknown default level", { ...BOTH, PI_THINKING: "ultra" }, /PI_THINKING must be one of Pi's levels/],
	]) assert.throws(() => loadModelChoices(settings), expected, label);
});
