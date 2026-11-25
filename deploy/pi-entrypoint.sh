#!/bin/bash
# Start-up script for the Pi sandbox image (task/plan.md, sections 3.5 and 3.10, task P3.2).
# It runs first in every Pi container: it checks the settings the runner passes, fills Pi's
# settings folder, makes this message's folder, then starts Pi in its place.
#
# Settings, all passed by the runner:
#   JS_RUN_TOKEN    this run's token, 64 hex characters. Pi sends it to the bridge as its key.
#   JS_GATEWAY_URL  the bridge on this container's own network: http://10.89.<slot>.2:<port>
#   JS_CHAT_ROOT    this chat's folder, /data/users/<user>/chats/<chat>, with its 4 folders mounted
#   JS_REQUEST_ID   this message's ID: chatcmpl-<uuid>
# If anything is wrong, it stops with exit code 64 before Pi starts. It never prints the token.
set -euo pipefail

SETTINGS=/run/pi-agent
SEED=/app/deploy/pi-agent-seed
PI_CLI=/app/packages/coding-agent/dist/bundle/cli.js
EXTENSIONS=/app/.pi/extensions

refuse() {
	echo "pi-entrypoint: $1. Pi was not started." >&2
	exit 64
}

# A folder that is really there, and not a link to somewhere else.
real_folder() {
	[[ -d "$1" && ! -L "$1" ]]
}

token_pattern='^[0-9a-f]{64}$'
octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
gateway_pattern="^http://10\.89\.${octet}\.2:([0-9]{1,5})$"
chat_pattern='^/data/users/[0-9a-f]{32}/chats/[0-9a-f]{32}$'
request_pattern='^chatcmpl-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

[[ "${JS_RUN_TOKEN:-}" =~ $token_pattern ]] || refuse "JS_RUN_TOKEN is missing, or isn't a run token"
[[ "${JS_GATEWAY_URL:-}" =~ $gateway_pattern ]] || refuse "JS_GATEWAY_URL must be http://10.89.<slot>.2:<port>"
port="${BASH_REMATCH[2]}"
((10#$port >= 1 && 10#$port <= 65535)) || refuse "JS_GATEWAY_URL has no valid port"
[[ "${JS_CHAT_ROOT:-}" =~ $chat_pattern ]] || refuse "JS_CHAT_ROOT must be /data/users/<user>/chats/<chat>"
[[ "${JS_REQUEST_ID:-}" =~ $request_pattern ]] || refuse "JS_REQUEST_ID must be chatcmpl-<uuid>"

real_folder "$JS_CHAT_ROOT" || refuse "this chat's folder is missing"
for name in uploads artifacts workspace sessions; do
	real_folder "$JS_CHAT_ROOT/$name" || refuse "this chat's $name folder is missing"
done
[[ -w "$JS_CHAT_ROOT/workspace" && -w "$JS_CHAT_ROOT/sessions" ]] || refuse "this chat's workspace and sessions folders must be writable"

# Pi locks files in its settings folder for every model call, so it must be writable. It must
# also start empty: a fresh in-memory folder, never one shared with another run.
real_folder "$SETTINGS" && [[ -w "$SETTINGS" ]] || refuse "$SETTINGS must be a writable folder"
[[ -z "$(ls -A "$SETTINGS")" ]] || refuse "$SETTINGS must start empty"

cp "$SEED/settings.json" "$SEED/auth.json" "$SETTINGS/"
# The key is the text $JS_RUN_TOKEN, which Pi fills in from its environment for each call, so the
# token itself is never written to disk.
# Both providers point at the bridge, and Pi uses the one the runner names. The bridge's model proxy keeps
# every route but its own provider's closed.
printf '{"providers":{"anthropic":{"baseUrl":"%s/model/anthropic","apiKey":"$JS_RUN_TOKEN"},"google":{"baseUrl":"%s/model/google","apiKey":"$JS_RUN_TOKEN"}}}\n' "$JS_GATEWAY_URL" "$JS_GATEWAY_URL" > "$SETTINGS/models.json"

# This message's folder. A link planted here by an earlier run is refused, not followed.
requests="$JS_CHAT_ROOT/workspace/requests"
if [[ -e "$requests" || -L "$requests" ]]; then
	real_folder "$requests" || refuse "workspace/requests isn't a real folder"
else
	mkdir -m 700 "$requests"
fi
request="$requests/$JS_REQUEST_ID"
[[ ! -e "$request" && ! -L "$request" ]] || refuse "this message's folder already exists"
mkdir -m 700 "$request"

export PI_CODING_AGENT_DIR="$SETTINGS"
export PI_CODING_AGENT_SESSION_DIR="$JS_CHAT_ROOT/sessions"
export JUNIOR_SILVA_WORKSPACE_ROOT="$request"

# The 4 hosted extensions are named here, as the bridge names them today. The runner adds the
# rest: --mode json --approve --session-id ... --provider ... --model ...
exec node "$PI_CLI" \
	--extension "$EXTENSIONS/junior-silva-legal-context.ts" \
	--extension "$EXTENSIONS/junior-silva-scope-guard.ts" \
	--extension "$EXTENSIONS/legal-research-citation-delivery.ts" \
	--extension "$EXTENSIONS/librechat-preview-delivery.ts" \
	"$@"
