#!/usr/bin/env bash
# Isolation check (task/plan.md, section 7; tasks P3.15 and P7.8). It attacks the walls of the running stack as a
# test user B, against a test user A's data, and prints a result for each row of the tracker's isolation
# table (task/tracker.md, section 5):
#   PASS   the wall held, and its control showed the target was really there
#   FAIL   the wall didn't hold, or a control failed, so the test proves nothing
#   LATER  not tested yet, because what it needs comes in a later task
#   INFO   a fact worth knowing
# The exit code is the number of FAIL lines.
#
#   scripts/js-isolation-check.sh --yes
#
# Run it only when nobody is using the stack. It takes about 10 minutes. It switches the bridge to a
# stand-in model (test/isolation/attack-model.mjs) with a test key, stops the runner briefly, and starts
# throwaway containers on a slot. It puts everything back when it ends. If that fails, run
# `docker compose up -d` in pi/.
#
# Needs docker with compose, python3, curl and ss on this machine, the stack started from pi/ with
# `docker compose up -d`, a bridge image built from this code, and pi/.env. It never prints a secret value.
set -u
PI_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PI_DIR" || exit 1
ISO=junior-silva/test/isolation
BRIDGE=junior-silva-v2
RUNNER=junior-silva-runner
BRIDGE_IMAGE=junior-silva-v2:local
LABEL=js.check=isolation
HOST_PORT=18991
fails=0
bridge_switched=0
runner_changed=0
test_users_made=0
declare -A ROW_RESULT ROW_LATER

declare -A ROW_LABEL=(
	[settings]="Settings of the running stack (P3.8)"
	[sandbox-users]="Sandbox: ls /data/users"
	[sandbox-other]="Sandbox: Read A's path"
	[sandbox-env]="Sandbox: env, /proc/1/environ"
	[sandbox-view]="Sandbox: ps, mounts, dmesg"
	[sandbox-writes]="Sandbox: Write to uploads, artifacts, /app, /"
	[sandbox-powers]="Sandbox: docker.sock, capabilities"
	[network-n]="Network: All N checks; 8127 works with the token"
	[network-host]="Network: Every port the host listens on, from a slot (P7.8)"
	[network-8126]="Network: Pi to bridge 8126, including /files and /v1"
	[runner]="Runner: Pi to the runner's address"
	[tools-path]="Tools: Each bridge path tool with A's path"
	[document-fetch]="Tools: public_document_fetch"
	[proxy-calls]="Model proxy: No token, other model, other route, oversized body, over budget"
	[proxy-content]="Model proxy: URL image source, web_fetch, web_search, mcp_servers, fallbacks"
	[proxy-errors]="Model proxy: Error replies"
	[answer-filter]="Answer filter"
	[links]="Links"
	[limits]="Limits"
	[stop]="Stop: hanging up removes the container"
	[fail-closed]="Fail closed"
	[images]="Images"
	[logs]="Logs"
	[browser]="Browser: two accounts, and the 29 Oct attack"
	[functional]="Functional: TESTING.md in full"
)
ROW_ORDER=(settings sandbox-users sandbox-other sandbox-env sandbox-view sandbox-writes sandbox-powers network-n network-host network-8126 runner tools-path document-fetch proxy-calls proxy-content proxy-errors answer-filter links limits stop fail-closed images logs browser functional)

record() { # record <PASS|FAIL|LATER|INFO> <row> <text>
	local verdict="$1" row="$2" text="$3"
	printf '%-5s [%s] %s\n' "$verdict" "$row" "$text"
	case "$verdict" in
		FAIL) fails=$((fails + 1)); ROW_RESULT[$row]=FAIL ;;
		PASS) [ "${ROW_RESULT[$row]:-}" = FAIL ] || ROW_RESULT[$row]=PASS ;;
		LATER) ROW_LATER[$row]="${ROW_LATER[$row]:+${ROW_LATER[$row]}; }$text"; [ -n "${ROW_RESULT[$row]:-}" ] || ROW_RESULT[$row]=LATER ;;
	esac
}
check() { # check <row> <text> <wanted> <got>
	if [ "$3" = "$4" ]; then record PASS "$1" "$2"; else record FAIL "$1" "$2: wanted [$3], got [$4]"; fi
}
stop_now() { echo "STOP  $1"; exit 2; }
wait_until() { # wait_until <seconds> <command...>
	local deadline=$(($(date +%s) + $1)); shift
	while [ "$(date +%s)" -lt "$deadline" ]; do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
	return 1
}
inspect() { docker inspect "$1" --format "$2" 2>/dev/null; }
hex() { python3 -I -c 'import secrets, sys; print(secrets.token_hex(int(sys.argv[1])))' "$1"; }
pi_containers() { docker ps -q --filter label=js.run=1 | wc -l; }
no_pi() { [ "$(pi_containers)" -eq 0 ]; }
some_pi() { [ "$(pi_containers)" -gt 0 ]; }
bridge_healthy() { [ "$(inspect "$BRIDGE" '{{.State.Health.Status}}')" = healthy ]; }
restarts() { inspect "$BRIDGE" '{{.RestartCount}}'; }
on_slot() { [ "$(inspect "$BRIDGE" "{{(index .NetworkSettings.Networks \"js-slot-$1\").IPAMConfig.IPv4Address}}")" = "10.89.$1.2" ]; }
on_all_slots() { local k; for k in $(seq 1 "$SLOTS"); do on_slot "$k" || return 1; done; }
# The runner's own health, asked from inside it with its own secret. Prints the status and the JSON.
runner_health() { docker exec "$RUNNER" node -e "fetch('http://127.0.0.1:8128/health',{headers:{authorization:'Bearer '+process.env.JS_RUNNER_SECRET}}).then(async r=>console.log(r.status, await r.text())).catch(e=>console.log('error', e.code))" 2>/dev/null; }
runner_ready() { runner_health | grep -qE "^200 .*\"slotsReady\":$SLOTS"; }
runner_log() { docker logs "$RUNNER" 2>&1; }
# A setting from .env that isn't secret.
env_plain() { python3 -I -c 'import sys
for line in open(".env", encoding="utf-8"):
    name, sep, value = line.strip().partition("=")
    if sep and name.strip() == sys.argv[1]:
        print(value.strip().strip("\"").strip("'"'"'"))' "$1" | tail -n 1; }
# curl's config line for the bridge's key, through a pipe only.
auth_config() { python3 -I -c 'for line in open(".env", encoding="utf-8"):
    name, sep, value = line.strip().partition("=")
    if sep and name.strip() == "JUNIOR_SILVA_API_KEY":
        print("header = \"Authorization: Bearer " + value.strip().strip("\"").strip("'"'"'") + "\"")'; }
# The bridge's folder names for LibreChat IDs: keyed <part>... prints the 32-character hash only.
keyed() { python3 -I -c 'import hashlib, hmac, sys
secret = ""
for line in open(".env", encoding="utf-8"):
    name, sep, value = line.strip().partition("=")
    if sep and name.strip() == "JS_IDENTITY_SECRET":
        secret = value.strip().strip("\"").strip("'"'"'")
print(hmac.new(secret.encode(), "\0".join(sys.argv[1:]).encode(), hashlib.sha256).hexdigest()[:32])' "$@"; }
json_body() { python3 -I -c 'import json, sys; print(json.dumps({"model": "junior-silva-v2", "stream": False, "messages": [{"role": "user", "content": sys.argv[1]}]}))' "$1"; }
chat() { # chat <reply file> <user id> <chat id> <text>: prints the HTTP status
	# A file, not a variable: chat usually runs inside $( ), and cleanup needs every chat it made.
	echo "$2:$3" >> "$WORK/chats.txt"
	auth_config | curl -s -K - -o "$1" -w '%{http_code}' --max-time 300 -H "Content-Type: application/json" \
		-H "x-librechat-user-id: $2" -H "x-librechat-conversation-id: $3" --data "$(json_body "$4")" "$PUBLIC_URL/v1/chat/completions"
}
answer_of() { python3 -I -c 'import json, sys
try:
    body = json.load(open(sys.argv[1]))
except Exception as error:
    print("(no JSON reply)"); raise SystemExit
choices = body.get("choices") or []
print(choices[0]["message"]["content"] if choices else "ERROR: " + str((body.get("error") or {}).get("message")))' "$1"; }
# The n-th tool result (from 0) that the attack model got back in the chat with this mark.
tool_result() { python3 -I -c 'import json, sys
best = None
for line in open(sys.argv[1]):
    record = json.loads(line)
    if record.get("mark") == sys.argv[2] and (best is None or record["results"] > best["results"]):
        best = record
index = int(sys.argv[3])
print(best["resultTexts"][index] if best and len(best["resultTexts"]) > index else "(no tool result: the attack did not run)")' "$WORK/out/model.jsonl" "$1" "$2"; }
field() { printf '%s\n' "$1" | grep -oE "(^| )$2=[^ ]*" | head -n 1 | sed -E "s/^ ?$2=//"; }
# Runs a command as user 1000 with the data folder at /d, for test folders made and removed by the check.
as_data_user() { docker run --rm --network none --user 1000:1000 --mount "type=bind,src=$DATA_ROOT,dst=/d" --entrypoint sh "$BRIDGE_IMAGE" -c "$1"; }
spike_probe() { # spike_probe <docker network options...> -- <probe.mjs arguments...>
	local options=()
	while [ "$1" != "--" ]; do options+=("$1"); shift; done; shift
	docker run --rm --label "$LABEL" "${options[@]}" --user 1000:1000 --mount "type=bind,src=$PI_DIR/scripts/spike,dst=/spike,readonly" --entrypoint node "$BRIDGE_IMAGE" /spike/probe.mjs "$@" 2>&1
}

cleanup() {
	set +e
	if [ "$bridge_switched" = 1 ]; then echo "INFO  putting the bridge's normal settings back"; docker compose up -d --no-deps "$BRIDGE" >/dev/null 2>&1; fi
	if [ "$runner_changed" = 1 ]; then echo "INFO  putting the runner back"; docker compose up -d --no-deps "$RUNNER" >/dev/null 2>&1; fi
	docker ps -aq --filter "label=$LABEL" | xargs -r docker rm -f >/dev/null 2>&1
	if [ "$test_users_made" = 1 ]; then remove_test_data; fi
	[ -n "${WORK:-}" ] && rm -rf "$WORK"
}
remove_test_data() {
	local folders="users/$PROBE_A users/$PROBE_B" pair user chat
	for user in "${CHAIN_USERS[@]}"; do folders="$folders users/$(keyed user "$user")"; done
	while IFS= read -r pair; do
		user="${pair%%:*}"; chat="${pair#*:}"
		folders="$folders audit/junior-silva-v2-$(keyed chat "$user" "$chat").jsonl"
	done < <(sort -u "$WORK/chats.txt" 2>/dev/null)
	as_data_user "cd /d && rm -rf $folders" >/dev/null 2>&1
	test_users_made=0
}

if [ "${1:-}" != "--yes" ]; then
	sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'
	echo
	echo "This check switches the running bridge to a stand-in model and stops the runner briefly."
	echo "Run it only when nobody is using the stack, with: scripts/js-isolation-check.sh --yes"
	exit 2
fi
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "=== 0. Before starting"
for command in docker python3 curl ss; do command -v "$command" >/dev/null || stop_now "$command is missing on this machine"; done
docker compose version >/dev/null 2>&1 || stop_now "docker compose is missing"
[ -f .env ] || stop_now "pi/.env is missing"
[ "$(inspect "$BRIDGE" '{{.State.Running}}')" = true ] || stop_now "the bridge isn't running: start the stack with docker compose up -d"
[ "$(inspect "$RUNNER" '{{.State.Running}}')" = true ] || stop_now "the runner isn't running: start the stack with docker compose up -d"
SLOTS="$(inspect "$RUNNER" '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^JS_SLOTS=//p')"
GATEWAY_PORT="$(inspect "$RUNNER" '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^JS_GATEWAY_PORT=//p')"
PI_IMAGE="$(inspect "$RUNNER" '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^JS_PI_IMAGE=//p')"
SLOTS="${SLOTS:-3}"; GATEWAY_PORT="${GATEWAY_PORT:-8127}"; PI_IMAGE="${PI_IMAGE:-junior-silva-pi:local}"
DATA_ROOT="$(inspect "$BRIDGE" '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}')"
PUBLIC_URL="http://$(docker port "$BRIDGE" 8126/tcp 2>/dev/null | head -n 1)"
LIBRECHAT_NETWORK="$(env_plain LIBRECHAT_NETWORK)"; LIBRECHAT_NETWORK="${LIBRECHAT_NETWORK:-librechat_default}"
RUNNER_IP="$(inspect "$RUNNER" '{{(index .NetworkSettings.Networks "js-control").IPAddress}}')"
[ -n "$DATA_ROOT" ] || stop_now "the bridge has no /data folder from the host"
wait_until 60 bridge_healthy || stop_now "the bridge isn't healthy"
wait_until 90 runner_ready || stop_now "the runner isn't ready with all $SLOTS slots: $(runner_health)"
runner_health | grep -q '"slotsInUse":0' && no_pi || stop_now "a chat is running now. Run the check when nobody is using the stack"
docker image inspect "$PI_IMAGE" >/dev/null 2>&1 || stop_now "the Pi image $PI_IMAGE is missing"
# probe-args.mjs and attack-model.mjs run from the bridge image, so they must match this checkout.
[ "$(docker run --rm --network none --entrypoint sha256sum "$BRIDGE_IMAGE" "$ISO/probe-args.mjs" "$ISO/attack-model.mjs" 2>/dev/null)" = "$(sha256sum "$ISO/probe-args.mjs" "$ISO/attack-model.mjs")" ] ||
	stop_now "the bridge image's $ISO differs from this checkout. Rebuild it: docker compose build"
WORK="$(mktemp -d)"
mkdir -p "$WORK/out" && chmod 777 "$WORK/out"
RUN_ID="$(hex 4)"
START_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PROBE_A="ffffffffffffffffffffffff1500000a"; PROBE_B="ffffffffffffffffffffffff1500000b"
PROBE_CHAT_A="ffffffffffffffffffffffff1500000c"; PROBE_CHAT_B="ffffffffffffffffffffffff1500000d"
CHAIN_USERS=("$(hex 12)" "$(hex 12)")
USER_A="${CHAIN_USERS[0]}"; USER_B="${CHAIN_USERS[1]}"
record INFO settings "stack: $SLOTS slots, gateway port $GATEWAY_PORT, Pi image $PI_IMAGE, public address $PUBLIC_URL, check $RUN_ID"

check_settings() { # check_settings <label>
	echo "=== $1"
	check settings "the bridge: read-only, all extra powers dropped, no-new-privileges" "true [ALL] [no-new-privileges:true]" "$(inspect "$BRIDGE" '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}')"
	check settings "the bridge: a memory limit, and ip_forward 0, read inside" "yes 0" "$([ "$(inspect "$BRIDGE" '{{.HostConfig.Memory}}')" -gt 0 ] && echo yes || echo no) $(docker exec "$BRIDGE" cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)"
	check settings "the bridge: user 1000, and it can't write to /app" "1000 yes" "$(docker exec "$BRIDGE" id -u) $(docker exec "$BRIDGE" sh -c 'touch /app/iso-write-test 2>&1' | grep -q 'Read-only file system' && echo yes || echo no)"
	check settings "the bridge: one published port, on 127.0.0.1" "1 yes" "$(docker port "$BRIDGE" | wc -l) $(docker port "$BRIDGE" | grep -q '127.0.0.1:' && echo yes || echo no)"
	check settings "the bridge: on js-control and on every slot at .2" "yes yes" "$(inspect "$BRIDGE" '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' | grep -qw js-control && echo yes || echo no) $(on_all_slots && echo yes || echo no)"
	check settings "the runner: only on js-control, no ports" "js-control 0" "$(inspect "$RUNNER" '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' | xargs) $(docker port "$RUNNER" | wc -l)"
	check settings "the runner: read-only, all extra powers dropped, no-new-privileges, user 1000" "true [ALL] [no-new-privileges:true] 1000:1000" "$(inspect "$RUNNER" '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.Config.User}}')"
	check settings "the runner: its only mount is docker.sock" "/var/run/docker.sock" "$(inspect "$RUNNER" '{{range .Mounts}}{{.Source}} {{end}}' | xargs)"
	local leaked
	leaked="$(comm -12 <(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' .env | tr -d = | grep -iE 'key|secret|token|password|passwd|auth|credential' | sort -u) <(inspect "$RUNNER" '{{range .Config.Env}}{{println .}}{{end}}' | cut -d= -f1 | sort -u) | grep -vx JS_RUNNER_SECRET | xargs)"
	check settings "the runner: none of .env's key names in its settings, apart from its own secret" "" "$leaked"
}
check_settings "1. Settings"

echo "=== 2. Direct probes, as user B, on a slot"
test_users_made=1
as_data_user "set -e; cd /d; for chat in users/$PROBE_A/chats/$PROBE_CHAT_A users/$PROBE_B/chats/$PROBE_CHAT_B; do mkdir -p \$chat/uploads \$chat/artifacts \$chat/workspace \$chat/sessions; done
	chmod -R 700 users/$PROBE_A users/$PROBE_B
	printf 'ISO-CANARY-A $RUN_ID\n' > users/$PROBE_A/chats/$PROBE_CHAT_A/uploads/iso-canary-a.txt
	printf 'ISO-CANARY-B $RUN_ID\n' > users/$PROBE_B/chats/$PROBE_CHAT_B/uploads/iso-canary-b.txt" || stop_now "could not make the test users' folders"
PROBE_SLOT="$SLOTS"
OTHER_SLOT=""; [ "$SLOTS" -ge 2 ] && OTHER_SLOT=1
docker run -d --name js-check-host-listener --label "$LABEL" --network host --user 1000:1000 --mount "type=bind,src=$PI_DIR/scripts/spike,dst=/spike,readonly" --entrypoint node "$BRIDGE_IMAGE" /spike/probe.mjs listen "$HOST_PORT" >/dev/null
if [ -n "$OTHER_SLOT" ]; then
	docker run -d --name js-check-other-slot --label "$LABEL" --runtime runsc --network "js-slot-$OTHER_SLOT" --ip "10.89.$OTHER_SLOT.3" --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges \
		--mount "type=bind,src=$PI_DIR/scripts/spike,dst=/spike,readonly" --entrypoint node "$BRIDGE_IMAGE" /spike/probe.mjs listen 9000 >/dev/null
fi
sleep 3
check network-n "control: the test listener on the host is up" open "$(spike_probe --network host -- net "127.0.0.1:$HOST_PORT" | awk '{print $2}')"
if [ -n "$OTHER_SLOT" ]; then
	check network-n "control: the test listener on slot $OTHER_SLOT is up, reached from the bridge" open "$(docker exec "$BRIDGE" node -e "const s=require('net').connect(9000,'10.89.$OTHER_SLOT.3');s.on('connect',()=>{console.log('open');process.exit(0)});s.on('error',e=>{console.log(e.code);process.exit(0)});setTimeout(()=>{console.log('timeout');process.exit(0)},3000)")"
else
	record INFO network-n "only 1 slot, so there's no other slot to test"
fi
internet_control="$(spike_probe -- net 1.1.1.1:443 | awk '{print $2}')"
[ "$internet_control" = open ] && record PASS network-n "control: this machine has internet, so a block from Pi is real" || record INFO network-n "this machine has no internet ($internet_control), so the internet block proves nothing here"
# Every TCP port this machine listens on, on each of its addresses (P7.8), such as another service's published
# ports. Ports open only to its own loopback are left out: a container can't reach them. The control: they
# answer from this machine itself. Prints "<target> <open or the error>" per line.
host_ports="$(python3 -I - <<'PY'
import ipaddress, socket, subprocess
from concurrent.futures import ThreadPoolExecutor
def output(*command):
    return subprocess.run(command, capture_output=True, text=True).stdout
addresses = [ipaddress.ip_address(address) for address in output("hostname", "-I").split()]
targets = set()
for line in output("ss", "-ltnH").splitlines():
    fields = line.split()
    if len(fields) < 4:
        continue
    host, _, port = fields[3].rpartition(":")
    host = host.strip("[]").split("%")[0]
    if host in ("*", "::", "0.0.0.0"):
        wanted = [address for address in addresses if host != "0.0.0.0" or address.version == 4]
    else:
        try:
            one = ipaddress.ip_address(host)
        except ValueError:
            continue
        if one.version == 6 and one.ipv4_mapped:
            one = one.ipv4_mapped
        wanted = [] if one.is_loopback or one.is_link_local else [one]
    for address in wanted:
        targets.add(f"[{address}]:{port}" if address.version == 6 else f"{address}:{port}")
def answer(target):
    host, _, port = target.rpartition(":")
    try:
        socket.create_connection((host.strip("[]"), int(port)), timeout=3).close()
        return "open"
    except OSError as error:
        return type(error).__name__
targets = sorted(targets)
with ThreadPoolExecutor(32) as pool:
    for target, result in zip(targets, pool.map(answer, targets)):
        print(target, result)
PY
)"
host_targets="$(printf '%s\n' "$host_ports" | awk 'NF {print $1}' | xargs)"
host_live="$(printf '%s\n' "$host_ports" | awk '$2 == "open"' | wc -l)"
host_quiet="$(printf '%s\n' "$host_ports" | awk 'NF && $2 != "open" {print $1 "=" $2}' | xargs)"
[ -z "$host_targets" ] || record INFO network-host "the host listens beyond its loopback on port(s) $(printf '%s\n' $host_targets | sed 's/.*://' | sort -un | xargs), on $(printf '%s\n' $host_targets | sed 's/:[0-9]*$//' | sort -u | wc -l) address(es): $(wc -w <<< "$host_targets") target(s)"
if [ "$host_live" -gt 0 ]; then
	record PASS network-host "control: $host_live of the $(wc -w <<< "$host_targets") answer from the host itself"
	# A target the host itself is refused on, by its firewall for example, is closed there: no hole, but no proof either.
	[ -z "$host_quiet" ] || record INFO network-host "the host itself gets no connection on these, so they prove nothing: $host_quiet"
else
	record FAIL network-host "control: no port answered from the host itself, so the test proves nothing"
fi
probe_input="$(python3 -I - "$PROBE_A" "$PROBE_B" "$PROBE_CHAT_A" "$PROBE_CHAT_B" "$RUN_ID" "$PROBE_SLOT" "$OTHER_SLOT" "$GATEWAY_PORT" "$HOST_PORT" "$RUNNER_IP" "$PI_IMAGE" "$host_targets" <<'PY'
import json, socket, subprocess, sys
a, b, chat_a, chat_b, run_id, slot, other, gateway_port, host_port, runner_ip, image, host_targets = sys.argv[1:]
def lines(*command):
    return subprocess.run(command, capture_output=True, text=True).stdout.split()
host_ip = (lines("hostname", "-I") or [""])[0]
blocked = [{"group": "the host (slot gateway, Docker's own address, this machine's address)", "target": t} for t in [f"10.89.{slot}.1:{host_port}", f"172.17.0.1:{host_port}"] + ([f"{host_ip}:{host_port}"] if host_ip else [])]
if other:
    blocked += [{"group": f"slot {other}: its bridge address and its Pi address", "target": t} for t in [f"10.89.{other}.2:{gateway_port}", f"10.89.{other}.3:9000"]]
blocked.append({"group": "the metadata address", "target": "169.254.169.254:80"})
blocked += [{"group": "every port the host listens on, on each of its addresses", "target": t, "row": "network-host"} for t in host_targets.split()]
for container in lines("docker", "ps", "--format", "{{.Names}}"):
    if container.startswith("js-check-") or container == "junior-silva-runner":
        continue
    addresses = subprocess.run(["docker", "inspect", container, "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}"], capture_output=True, text=True).stdout.split()
    group = "the bridge's other addresses" if container == "junior-silva-v2" else "the server's other containers"
    for address in addresses:
        if address.startswith("10.89."):
            continue
        for port in ([8126, int(gateway_port)] if container == "junior-silva-v2" else [80, 3080, 6379, 8126, 27017]):
            blocked.append({"group": group, "target": f"{address}:{port}"})
image_env = subprocess.run(["docker", "image", "inspect", image, "--format", "{{range .Config.Env}}{{println .}}{{end}}"], capture_output=True, text=True).stdout.split("\n")
expected = sorted({line.split("=")[0] for line in image_env if "=" in line} | {"JS_RUN_TOKEN", "JS_GATEWAY_URL", "JS_CHAT_ROOT", "JS_REQUEST_ID", "HOSTNAME", "HOME"})
own_root = f"/data/users/{b}/chats/{chat_b}"
print(json.dumps({
    "ownUser": b, "ownChatRoot": own_root, "ownCanary": f"{own_root}/uploads/iso-canary-b.txt", "ownCanaryText": f"ISO-CANARY-B {run_id}",
    "otherUserFolder": f"/data/users/{a}", "otherCanary": f"/data/users/{a}/chats/{chat_a}/uploads/iso-canary-a.txt",
    "expectedEnv": expected, "bridge": f"10.89.{slot}.2", "gatewayPort": int(gateway_port), "publicPort": 8126,
    "runner": f"{runner_ip}:8128", "blocked": blocked, "internet": ["1.1.1.1:443", "8.8.8.8:53"], "dnsName": "example.com",
}))
PY
)"
args_input="$(python3 -I -c 'import json, sys, uuid
print(json.dumps({"requestId": f"chatcmpl-{uuid.uuid4()}", "userHash": sys.argv[1], "chatHash": sys.argv[2], "slot": int(sys.argv[3]),
    "settings": {"hostDataRoot": sys.argv[4], "image": sys.argv[5], "slots": int(sys.argv[6]), "gatewayPort": int(sys.argv[7])},
    "name": f"js-check-probe-{sys.argv[8]}", "entrypoint": "node", "command": ["--input-type=module", "-", sys.argv[9]]}))' \
	"$PROBE_B" "$PROBE_CHAT_B" "$PROBE_SLOT" "$DATA_ROOT" "$PI_IMAGE" "$SLOTS" "$GATEWAY_PORT" "$RUN_ID" "$probe_input")"
mapfile -d '' PROBE_ARGS < <(docker run --rm --network none --entrypoint node "$BRIDGE_IMAGE" "$ISO/probe-args.mjs" "$args_input")
[ "${#PROBE_ARGS[@]}" -gt 10 ] || record FAIL sandbox-users "the probe's Docker settings could not be built"
probe_output="$(JS_RUN_TOKEN="$(hex 32)" timeout 180 docker "${PROBE_ARGS[@]}" < "$ISO/probe.mjs" 2>&1)"
probe_lines=0
while IFS= read -r line; do
	if [[ "$line" =~ ^(PASS|FAIL|INFO)\ ([a-z0-9-]+)\ (.*)$ ]]; then
		record "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "probe: ${BASH_REMATCH[3]}"
		probe_lines=$((probe_lines + 1))
	fi
done <<< "$probe_output"
[ "$probe_lines" -gt 20 ] || record FAIL sandbox-users "the probe didn't run: $(printf '%s' "$probe_output" | tail -n 3 | tr '\n' ' ' | cut -c1-300)"
check sandbox-other "control: user A's test file was on disk the whole time" yes "$(as_data_user "test -f /d/users/$PROBE_A/chats/$PROBE_CHAT_A/uploads/iso-canary-a.txt" && echo yes || echo no)"
docker rm -f js-check-host-listener js-check-other-slot >/dev/null 2>&1

echo "=== 3. Full chain, through the real bridge and runner, with the attack model"
docker run -d --name js-check-model --label "$LABEL" --network "$LIBRECHAT_NETWORK" --user 1000:1000 --mount "type=bind,src=$WORK/out,dst=/out" \
	-e ATTACK_SLOW_MS=20000 --entrypoint node "$BRIDGE_IMAGE" "$ISO/attack-model.mjs" >/dev/null
wait_until 20 sh -c "docker logs js-check-model 2>&1 | grep -q listening" || record FAIL network-n "the attack model didn't start"
bridge_switched=1
docker compose -f docker-compose.yml -f "$ISO/compose.check.yml" up -d --no-deps "$BRIDGE" >/dev/null 2>&1
wait_until 90 bridge_healthy || record FAIL network-n "the bridge didn't come back healthy with the check's settings"
check network-n "the bridge now uses the attack model, with the test key" "JS_MODEL_UPSTREAM=http://js-check-model:9100" "$(inspect "$BRIDGE" '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^JS_MODEL_UPSTREAM=')"
restarts_before="$(restarts)"
A_CHAT="iso-$RUN_ID-a1"
mark() { echo "ISO-MARK-${RUN_ID}x$1"; }
check network-n "user A's first chat is answered (this makes A's folders)" "200 ISO-HELLO-DONE" "$(chat "$WORK/a1.json" "$USER_A" "$A_CHAT" "ISO-HELLO $(mark a1) Please summarise a lease clause.") $(answer_of "$WORK/a1.json")"
A_HASH="$(keyed user "$USER_A")"; A_CHAT_HASH="$(keyed chat "$USER_A" "$A_CHAT")"
A_FILE="/data/users/$A_HASH/chats/$A_CHAT_HASH/uploads/iso-canary-a.txt"
as_data_user "printf 'ISO-CANARY-A $RUN_ID\n' > /d/users/$A_HASH/chats/$A_CHAT_HASH/uploads/iso-canary-a.txt" || record FAIL tools-path "could not put user A's test file in A's chat"

status="$(chat "$WORK/b1.json" "$USER_B" "iso-$RUN_ID-b1" "ISO-PUBLISH $(mark b1) Please prepare a short note on a lease clause.")"
answer="$(answer_of "$WORK/b1.json")"
link="$(printf '%s' "$answer" | grep -oE 'https?://[^ )]+/files/[^ )]+' | head -n 1)"
note="$([ -n "$link" ] && curl -s "$PUBLIC_URL/files/${link#*/files/}")"
check network-n "8127 works with the token from its slot: B's Pi published its own note with the bridge's tool, and the link downloads it" "200 yes" "$status $(printf '%s' "$note" | grep -qF "ISO-NOTE $(mark b1)" && echo yes || echo no)"

status="$(chat "$WORK/b2.json" "$USER_B" "iso-$RUN_ID-b2" "ISO-OTHERPATH $(mark b2) Please review this lease. PATH=$A_FILE")"
publish_result="$(tool_result "$(mark b2)" 0)"; review_result="$(tool_result "$(mark b2)" 1)"; bash_result="$(tool_result "$(mark b2)" 2)"
check tools-path "B's run asked the bridge to publish user A's file: refused" yes "$(printf '%s' "$publish_result" | grep -qF 'File not found in this chat.' && echo yes || echo "no: ${publish_result:0:160}")"
check tools-path "B's run asked the bridge to review user A's file: refused" yes "$(printf '%s' "$review_result" | grep -qF 'File not found in this chat.' && echo yes || echo "no: ${review_result:0:160}")"
check tools-path "both refusals were logged by the bridge" yes "$([ "$(docker logs --since "$START_TIME" "$BRIDGE" 2>&1 | grep -c 'Refused a file for chat')" -ge 2 ] && echo yes || echo no)"
check sandbox-other "through Pi's bash too: user A's file isn't there, and only one user folder is" "1 absent" "$(field "$bash_result" USERS) $(field "$bash_result" OTHER)"
check sandbox-other "control: user A's test file was on disk during B's run" yes "$(as_data_user "test -f /d/users/$A_HASH/chats/$A_CHAT_HASH/uploads/iso-canary-a.txt" && echo yes || echo no)"

status="$(chat "$WORK/b3.json" "$USER_B" "iso-$RUN_ID-b3" "ISO-PROXY $(mark b3) Please draft a short clause.")"
proxy_result="$(tool_result "$(mark b3)" 0)"
case_status() { printf '%s\n' "$proxy_result" | sed -n "s/^CASE=$1 STATUS=\([^ ]*\).*/\1/p" | head -n 1; }
check proxy-calls "control: B's own token works for a plain model call" 200 "$(case_status valid)"
check proxy-calls "no token, a wrong token, another model, another route, a body over 32 MB: refused" "401 401 400 404 413" "$(case_status no-token) $(case_status wrong-token) $(case_status other-model) $(case_status other-route) $(case_status oversized)"
record LATER proxy-calls "over budget: the per-run budget is on the later list"
check proxy-content "a URL image, a web search tool, a web fetch tool, mcp_servers, fallbacks: refused" "400 400 400 400 400" "$(case_status url-image) $(case_status web-search) $(case_status web-fetch) $(case_status mcp-servers) $(case_status fallbacks)"
check proxy-errors "an upstream error that repeats the key reaches Pi with the key removed" "401 yes" "$(case_status echo-key) $(printf '%s\n' "$proxy_result" | grep '^CASE=echo-key' | grep -qF '[removed]' && echo yes || echo no)"
check proxy-errors "no reply to B's calls contains the bridge's key" no "$(python3 -I -c 'import sys
text = sys.stdin.read()
print("yes" if "isolation-check-test-key-not-real" in text else "no")' <<< "$proxy_result")"

status="$(chat "$WORK/b4.json" "$USER_B" "iso-$RUN_ID-b4" "ISO-MANYCALLS $(mark b4) Please draft a short clause.")"
many_result="$(tool_result "$(mark b4)" 0)"
check limits "24 tool calls at once with one token: the 16 allowed are answered, the rest refused" "24 16 8" "$(field "$many_result" CALLS) $(field "$many_result" OK) $(field "$many_result" LIMITED)"
check limits "the bridge didn't restart" "$restarts_before" "$(restarts)"

bomb() { # bomb <MEMORY|FORK> <mark>: runs B's bomb while user A's slow chat runs on another slot
	local name="$1" bomb_mark="$2" a_file="$WORK/a-$2.json" a_pid=""
	local before; before="$(runner_log | grep -cE 'ended: exit')"
	if [ "$SLOTS" -ge 2 ]; then
		chat "$a_file" "$USER_A" "iso-$RUN_ID-a-$bomb_mark" "ISO-SLOW $(mark "a$bomb_mark") Please summarise a lease clause." > "$WORK/a-$bomb_mark.status" &
		a_pid=$!
		wait_until 30 some_pi
	fi
	local b_status
	b_status="$(chat "$WORK/b-$bomb_mark.json" "$USER_B" "iso-$RUN_ID-$bomb_mark" "ISO-$name $(mark "$bomb_mark") Please draft a short clause.")"
	local bomb_result; bomb_result="$(tool_result "$(mark "$bomb_mark")" 0)"
	if [ -n "$a_pid" ]; then wait "$a_pid"; else chat "$a_file" "$USER_A" "iso-$RUN_ID-a-$bomb_mark" "ISO-HELLO $(mark "a$bomb_mark") Please summarise a lease clause." > "$WORK/a-$bomb_mark.status"; fi
	wait_until 30 no_pi
	# It ran if the bomb's own result came back, or if B's sandbox ended with an error. A's run ends with exit 0.
	local ran="no"
	if [ "$bomb_result" != "(no tool result: the attack did not run)" ] || runner_log | grep -E 'ended: exit' | tail -n "+$((before + 1))" | grep -vqE 'ended: exit 0,'; then ran=yes; fi
	record INFO limits "$name bomb: B got $b_status; the bomb's own result: $(printf '%s' "$bomb_result" | tr '\n' ' ' | cut -c1-120); the runner: $(runner_log | grep -E 'ended: exit' | tail -n 2 | sed -E 's/.*ended: //' | tr '\n' ';')"
	check limits "$name bomb: it ran in B's sandbox, the bridge didn't restart, user A's chat finished, and no container is left" "yes $restarts_before 200 0" "$ran $(restarts) $(cat "$WORK/a-$bomb_mark.status") $(pi_containers)"
}
bomb MEMORY memory
bomb FORK fork
record LATER limits "disk fill: needs the folder size watchdog (P3.13)"
record LATER limits "huge output and line flood: need P1.12, and would hurt the live bridge today"

before_stops="$(runner_log | grep -c 'the bridge asked to stop it')"
auth_config | curl -s -K - -o /dev/null --max-time 120 -H "Content-Type: application/json" -H "x-librechat-user-id: $USER_B" -H "x-librechat-conversation-id: iso-$RUN_ID-b7" \
	--data "$(json_body "ISO-HOLD $(mark b7) Please draft a short clause.")" "$PUBLIC_URL/v1/chat/completions" &
holder=$!
echo "$USER_B:iso-$RUN_ID-b7" >> "$WORK/chats.txt"
wait_until 30 some_pi; sleep 2
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
check stop "after the client hung up, the container was gone within 15 s, through the runner's stop" "yes 1" "$(wait_until 15 no_pi && echo yes || echo no) $(($(runner_log | grep -c 'the bridge asked to stop it') - before_stops))"

echo "=== 4. Download links"
status="$(chat "$WORK/b8.json" "$USER_B" "iso-$RUN_ID-b8" "ISO-PUBLISH $(mark b8) Please prepare a short note on a lease clause.")"
link="$(answer_of "$WORK/b8.json" | grep -oE 'https?://[^ )]+/files/[^ )]+' | head -n 1)"
local_link="$PUBLIC_URL/files/${link#*/files/}"
http_status() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
check links "control: the fresh link downloads" 200 "$(http_status "$local_link")"
tampered="$(python3 -I - "$local_link" "$A_HASH" "$A_CHAT_HASH" <<'PY'
import sys
from urllib.parse import urlsplit
link, other_user, other_chat = sys.argv[1:]
parts = urlsplit(link)
base = f"{parts.scheme}://{parts.netloc}"
_, files, signature, user, chat, operation, name = parts.path.split("/")
exp = parts.query.split("=", 1)[1]
def url(signature=signature, user=user, chat=chat, operation=operation, name=name, exp=exp):
    return f"{base}/files/{signature}/{user}/{chat}/{operation}/{name}?exp={exp}"
flip = lambda text: text[:-1] + ("0" if text[-1] != "0" else "1")
for variant in [url(signature=flip(signature)), url(user=other_user), url(chat=other_chat), url(name="x" + name), url(exp=str(int(exp) + 1000)),
                url(name="..%2F..%2F..%2Fetc%2Fpasswd"), f"{base}/files/%ff/a/b", f"{base}/files/a%zz/b/c/d/e"]:
    print(variant)
PY
)"
codes="$(while IFS= read -r variant; do http_status "$variant"; echo; done <<< "$tampered" | xargs)"
check links "a changed signature, user, chat, name or expiry, path traversal and bad % encoding: all refused" "404 404 404 404 404 404 404 404" "$codes"
check links "the bridge stayed up" "$restarts_before 200" "$(restarts) $(http_status "$PUBLIC_URL/health")"
expiry="$(printf '%s' "$local_link" | sed -n 's/.*?exp=\([0-9]*\).*/\1/p')"
while [ "$(date +%s)" -le "${expiry:-0}" ]; do sleep 1; done
check links "after its expiry, the same link gets 410" 410 "$(http_status "$local_link")"

marked="$(docker logs --since "$START_TIME" "$BRIDGE" 2>&1 | grep -c "ISO-MARK-$RUN_ID"; runner_log | grep -c "ISO-MARK-$RUN_ID"; as_data_user "grep -l 'ISO-MARK-$RUN_ID' /d/audit/*.jsonl 2>/dev/null | wc -l")"
check logs "the client text in every message never appears in the bridge's, runner's or audit logs" "0 0 0" "$(printf '%s\n' "$marked" | xargs)"
check logs "control: those logs did record this check's runs" "yes yes" "$([ "$(docker logs --since "$START_TIME" "$BRIDGE" 2>&1 | grep -c 'Refused a file for chat')" -ge 2 ] && echo yes || echo no) $(runner_log | grep -q 'started on slot' && echo yes || echo no)"

echo "=== 5. Fail closed"
runner_changed=1
docker compose stop "$RUNNER" >/dev/null 2>&1
status="$(chat "$WORK/f1.json" "$USER_B" "iso-$RUN_ID-f1" "ISO-HELLO $(mark f1) Please summarise a lease clause.")"
check fail-closed "runner stopped: the chat gets the usual error, and no Pi runs, in the bridge or anywhere else" "500 no 0" "$status $(docker top "$BRIDGE" -o args 2>/dev/null | grep -q 'cli.js' && echo yes || echo no) $(pi_containers)"
docker compose start "$RUNNER" >/dev/null 2>&1
wait_until 120 runner_ready || record FAIL fail-closed "the runner didn't come back ready"
docker compose -f docker-compose.yml -f "$ISO/compose.no-image.yml" up -d --no-deps "$RUNNER" >/dev/null 2>&1
wait_until 60 sh -c "docker exec $RUNNER true"
sleep 3
check fail-closed "Pi image missing: the runner's health says so" yes "$(runner_health | grep -qE '^503 .*"image":false' && echo yes || echo no)"
status="$(chat "$WORK/f2.json" "$USER_B" "iso-$RUN_ID-f2" "ISO-HELLO $(mark f2) Please summarise a lease clause.")"
check fail-closed "Pi image missing: the chat gets the usual error, and no container runs" "500 0" "$status $(pi_containers)"
docker compose up -d --no-deps "$RUNNER" >/dev/null 2>&1
wait_until 120 runner_ready && runner_changed=0 || record FAIL fail-closed "the runner didn't come back ready with its normal settings"
unit="$(docker run --rm --network none --user 1000:1000 --tmpfs /tmp --tmpfs /data:uid=1000 -e JUNIOR_SILVA_API_KEY=test-only -e JUNIOR_SILVA_PUBLIC_URL=http://127.0.0.1:8132 \
	--entrypoint node "$BRIDGE_IMAGE" --test --test-name-pattern="refuses to start|health reports gVisor" \
	junior-silva/test/runner.test.mjs junior-silva/test/container-runs.test.mjs junior-silva/test/chat-scope.test.mjs junior-silva/test/download-links.test.mjs junior-silva/test/chat-context.test.mjs 2>&1)"
check fail-closed "gVisor missing, and missing or weak secrets: their tests pass (runner, bridge, identity, links, model setup)" "7 0" "$(printf '%s\n' "$unit" | sed -n 's/^ℹ pass //p') $(printf '%s\n' "$unit" | sed -n 's/^ℹ fail //p')"

echo "=== 6. The Pi image"
docker history --no-trunc --format '{{.CreatedBy}}' "$PI_IMAGE" > "$WORK/history.txt"
docker image inspect "$PI_IMAGE" > "$WORK/inspect.json"
container="$(docker create --label "$LABEL" "$PI_IMAGE")"
while IFS= read -r line; do
	[[ "$line" =~ ^(PASS|FAIL)\ images\ (.*)$ ]] && record "${BASH_REMATCH[1]}" images "${BASH_REMATCH[2]}"
done < <(docker export "$container" | python3 -I "$ISO/image-scan.py" .env "$WORK/history.txt" "$WORK/inspect.json" 2>&1)
docker rm -f "$container" >/dev/null 2>&1

echo "=== 7. Putting everything back"
docker compose up -d --no-deps "$BRIDGE" >/dev/null 2>&1
wait_until 90 bridge_healthy && bridge_switched=0 || record FAIL settings "the bridge didn't come back healthy with its normal settings"
check settings "the bridge is back on the real model setup" "" "$(inspect "$BRIDGE" '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^JS_MODEL_UPSTREAM=http://js-check-model')"
docker rm -f js-check-model >/dev/null 2>&1
remove_test_data
check settings "test users and their folders removed" "0" "$(as_data_user "ls -d /d/users/$PROBE_A /d/users/$PROBE_B /d/users/$A_HASH /d/users/$(keyed user "$USER_B") 2>/dev/null | wc -l")"
wait_until 120 on_all_slots
check_settings "Settings again, after putting back"
check settings "nothing left over: no check or Pi containers" "0 0" "$(docker ps -aq --filter "label=$LABEL" | wc -l) $(docker ps -aq --filter label=js.run=1 | wc -l)"

record LATER answer-filter "comes with P3.9"
record LATER document-fetch "comes with P3.10"
record LATER browser "done by hand in LibreChat with two accounts: see TESTING.md"
record LATER functional "comes with P6"
record INFO fail-closed "gVisor missing is tested by the runner's own test, not on the live stack"

echo
echo "=== Summary, by row of the tracker's isolation table (task/tracker.md, section 5)"
for row in "${ROW_ORDER[@]}"; do
	result="${ROW_RESULT[$row]:-not run}"
	later=""
	[ "$result" = PASS ] && [ -n "${ROW_LATER[$row]:-}" ] && later=" (later: ${ROW_LATER[$row]})"
	[ "$result" = LATER ] && later=" (${ROW_LATER[$row]})"
	printf '%-7s %s%s\n' "$result" "${ROW_LABEL[$row]}" "$later"
done
echo "failures: $fails"
exit "$fails"
