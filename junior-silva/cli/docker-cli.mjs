#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { env, projectRoot } from "../core/environment.mjs";

const cli = path.join(projectRoot, "packages", "coding-agent", "dist", "bundle", "cli.js");
const args = [
	cli, "--tui-mode", "regular",
	"--extension", path.join(projectRoot, ".pi", "extensions", "legal-research-citation-delivery.ts"),
	"--extension", path.join(projectRoot, ".pi", "extensions", "librechat-preview-delivery.ts"),
];
if (env("PI_PROVIDER")) args.push("--provider", env("PI_PROVIDER"));
if (env("PI_MODEL")) args.push("--model", env("PI_MODEL"));
if (env("PI_THINKING")) args.push("--thinking", env("PI_THINKING"));
args.push(...process.argv.slice(2));

const child = spawn(process.execPath, args, { cwd: projectRoot, env: process.env, stdio: "inherit" });
child.on("exit", (code, signal) => process.exitCode = signal ? 1 : (code ?? 1));
