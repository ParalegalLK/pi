#!/usr/bin/env bash
# Runs inside the sandbox: seeds Pi's settings folder on tmpfs, makes the request
# folder, then starts Pi. This is a first version of deploy/pi-entrypoint.sh from
# task/plan.md section 3.5. Pi must have a writable settings folder, or every
# model call fails.
set -eu

mkdir -p "$PI_CODING_AGENT_DIR" "$JUNIOR_SILVA_WORKSPACE_ROOT"
printf '{"cacheWarming":"off"}\n' > "$PI_CODING_AGENT_DIR/settings.json"
printf '{}\n' > "$PI_CODING_AGENT_DIR/auth.json"
printf '{"providers":{"anthropic":{"baseUrl":"%s/model/anthropic","apiKey":"$JS_RUN_TOKEN"}}}\n' "$JS_GATEWAY_URL" > "$PI_CODING_AGENT_DIR/models.json"

exec node /app/packages/coding-agent/dist/bundle/cli.js "$@"
