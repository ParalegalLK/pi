#!/usr/bin/env bash
# gVisor spike for task/plan.md, task P0.4: checks V and N.
# Does our real workload run under gVisor, and does the network wall really hold?
# It uses no real keys and no client data. Everything it creates is labelled
# js.spike=1 and removed when it exits, including after a failure.
#
#   scripts/js-spike.sh [all|basics|exchange|tools|pi|network|limits|load|memory] ...
#
#   JS_SPIKE_RUNTIME   Runtime under test. Default runsc. Use runc to try the script without gVisor.
#   JS_SPIKE_IMAGE     Default junior-silva-v2:local
#   JS_SPIKE_MODEL     Default claude-opus-5-5. Never called for real: the fake bridge answers.
#   JS_SPIKE_RESULTS   Results file. Default js-spike-results-<time>.txt in the current folder.
#   JS_SPIKE_DIR       Working folder. Default a new temp folder, removed on exit.
#   JS_SPIKE_LIVE      Set to 1 on a server people are using. Smaller limits, no runc comparison,
#                      no limits section. Stops if the server is busy or another container changes.
set -uo pipefail

RUNTIME="${JS_SPIKE_RUNTIME:-runsc}"
IMAGE="${JS_SPIKE_IMAGE:-junior-silva-v2:local}"
MODEL="${JS_SPIKE_MODEL:-claude-opus-5-5}"
RESULTS="${JS_SPIKE_RESULTS:-$PWD/js-spike-results-$(date +%Y%m%d-%H%M%S).txt}"
SPIKE_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/spike" && pwd)"
WORK="${JS_SPIKE_DIR:-$(mktemp -d)}"
LABEL="js.spike=1"
TOKEN="spike-token"
BRIDGE_IP="10.89.90.2"
PI_IP="10.89.90.3"
GATEWAY_URL="http://${BRIDGE_IP}:8127"
HOST_PORT=18997
FAILS=0
FLAGS=()
LIVE="${JS_SPIKE_LIVE:-0}"
MEMORY=2g
CPUS=2
LOAD_AT_ONCE=8
SANDBOX_LIMITS=()
HELPER_LIMITS=()
MIN_FREE_MEMORY_MIB=2048
MIN_FREE_DISK_MIB=3072
CONTAINERS_BEFORE=""
if [ "$LIVE" = "1" ]; then
	# --cpu-shares: real services win whenever the CPU is contested.
	MEMORY=1g
	CPUS=1
	LOAD_AT_ONCE=3
	SANDBOX_LIMITS=(--cpu-shares 256)
	HELPER_LIMITS=(--memory 512m --memory-swap 512m --cpus 1 --cpu-shares 256)
fi

# Bash's own clock: date's %3N behaves differently on Ubuntu 26.04.
now_ms() {
	local micros="${EPOCHREALTIME/[.,]/}"
	echo $((micros / 1000))
}

record() {
	printf '%-6s %-5s %s\n' "$1" "$2" "$3" | tee -a "$RESULTS"
	if [ "$2" = "FAIL" ]; then FAILS=$((FAILS + 1)); fi
	return 0
}

remove_spike_items() {
	docker ps -aq --filter "label=$LABEL" | xargs -r docker rm -f >/dev/null 2>&1
	docker network ls -q --filter "label=$LABEL" | xargs -r docker network rm >/dev/null 2>&1
	return 0
}

cleanup() {
	remove_spike_items
	if [ -z "${JS_SPIKE_DIR:-}" ]; then rm -rf "$WORK" 2>/dev/null; fi
	return 0
}
trap cleanup EXIT

# The flags from task/plan.md section 3.5.
sandbox_flags() {
	FLAGS=(
		--rm --label "$LABEL" --runtime="$1"
		--user 1000:1000 --workdir /app
		--cap-drop ALL --security-opt no-new-privileges
		--read-only
		--tmpfs /tmp:rw,size=1g,mode=1777
		--tmpfs /home/node:rw,size=256m,uid=1000,gid=1000
		--tmpfs /run/pi-agent:rw,size=32m,uid=1000,gid=1000
		--shm-size 256m --memory "$MEMORY" --memory-swap "$MEMORY" --cpus "$CPUS" --pids-limit 512
		"${SANDBOX_LIMITS[@]}"
		--init --log-driver none --no-healthcheck
		--mount "type=bind,src=$SPIKE_SRC,dst=/spike,readonly"
		-e HOME=/home/node -e TMPDIR=/tmp -e LANG=C.UTF-8 -e TZ=Asia/Colombo
	)
}

runtimes_to_compare() {
	if [ "$RUNTIME" = "runc" ] || [ "$LIVE" = "1" ]; then echo "$RUNTIME"; else echo "runc $RUNTIME"; fi
}

# --- basics: V1, V7, V8, V9 ---------------------------------------------------

check_basics() {
	echo "--- basics"
	if [ "$RUNTIME" = "runsc" ]; then
		if docker info --format '{{json .Runtimes}}' | grep -q '"runsc"'; then
			sandbox_flags runsc
			local inner kernel
			inner="$(docker run "${FLAGS[@]}" --network none --entrypoint bash "$IMAGE" -c 'uname -r; dmesg 2>/dev/null | head -3' 2>&1)"
			kernel="$(printf '%s\n' "$inner" | head -1)"
			if [ "$kernel" != "$(uname -r)" ] && [ -n "$kernel" ]; then
				record V1 PASS "sandbox kernel $kernel, host $(uname -r). dmesg mentions gVisor: $(printf '%s' "$inner" | grep -qi gvisor && echo yes || echo no)"
			else
				record V1 FAIL "sandbox did not start or shows the host kernel: $(printf '%s' "$inner" | head -2 | cut -c1-160)"
			fi
		else
			record V1 FAIL "runsc is not registered with Docker"
			return
		fi
	else
		record V1 SKIP "runtime under test is $RUNTIME"
	fi

	sandbox_flags "$RUNTIME"
	mkdir -p "$WORK/ro"
	echo readable > "$WORK/ro/file.txt"
	chmod -R a+rX "$WORK/ro"
	local readonly_out
	readonly_out="$(docker run "${FLAGS[@]}" --network none --mount "type=bind,src=$WORK/ro,dst=/ro,readonly" --entrypoint bash "$IMAGE" -c \
		'cat /ro/file.txt; touch /ro/new 2>/dev/null && echo mount-writable; touch /app/new 2>/dev/null && echo app-writable; touch /new 2>/dev/null && echo root-writable; touch /tmp/new && echo tmp-writable' 2>&1)"
	if printf '%s' "$readonly_out" | grep -q readable && printf '%s' "$readonly_out" | grep -q tmp-writable && ! printf '%s' "$readonly_out" | grep -qE 'mount-writable|app-writable|root-writable'; then
		record V7 PASS "read-only mount, /app and / refuse writes; /tmp works"
	else
		record V7 FAIL "$(printf '%s' "$readonly_out" | tr '\n' ' ' | cut -c1-200)"
	fi

	local stdin_out
	stdin_out="$(printf 'stdin-check' | timeout 60 docker run -i "${FLAGS[@]}" --network none --entrypoint cat "$IMAGE" 2>&1)"
	if [ "$stdin_out" = "stdin-check" ]; then
		record V8 PASS "stdin reached the sandbox, and the end of input was seen"
	else
		record V8 FAIL "got: $(printf '%s' "$stdin_out" | cut -c1-160)"
	fi

	local stream_file="$WORK/stream.txt"
	: > "$stream_file"
	docker run "${FLAGS[@]}" --network none --entrypoint bash "$IMAGE" -c 'echo one; sleep 3; echo two' 2>&1 | while IFS= read -r line; do
		echo "$(now_ms) $line" >> "$stream_file"
	done
	local first second
	first="$(sed -n 1p "$stream_file" | cut -d' ' -f1)"
	second="$(sed -n 2p "$stream_file" | cut -d' ' -f1)"
	if [ -n "$first" ] && [ -n "$second" ] && [ $((second - first)) -ge 2000 ]; then
		record V9 PASS "output streams with --log-driver none (lines $((second - first)) ms apart)"
	else
		record V9 FAIL "output did not stream: $(tr '\n' ' ' < "$stream_file" | cut -c1-160)"
	fi
}

# --- exchange: V6 -------------------------------------------------------------

check_exchange() {
	echo "--- exchange"
	local shared="$WORK/exchange"
	mkdir -p "$shared"
	chmod 777 "$shared"
	# The real bridge runs under normal Docker, so this side does too.
	docker run --rm --label "$LABEL" "${HELPER_LIMITS[@]}" --user 1000:1000 --network none \
		--mount "type=bind,src=$SPIKE_SRC,dst=/spike,readonly" --mount "type=bind,src=$shared,dst=/x" \
		--entrypoint node "$IMAGE" /spike/probe.mjs exchange bridge /x > "$WORK/exchange-bridge.txt" 2>&1 &
	local bridge_job=$!
	sandbox_flags "$RUNTIME"
	timeout 180 docker run "${FLAGS[@]}" --network none --mount "type=bind,src=$shared,dst=/x" \
		--entrypoint node "$IMAGE" /spike/probe.mjs exchange pi /x > "$WORK/exchange-pi.txt" 2>&1
	wait "$bridge_job"
	local pi_line bridge_line
	pi_line="$(grep '^exchange' "$WORK/exchange-pi.txt")"
	bridge_line="$(grep '^exchange' "$WORK/exchange-bridge.txt")"
	if printf '%s' "$pi_line" | grep -q 'failures=0' && printf '%s' "$bridge_line" | grep -q 'failures=0'; then
		record V6 PASS "both ways. Pi waited up to $(printf '%s' "$pi_line" | sed -E 's/.*worst_wait_ms=//') ms, bridge up to $(printf '%s' "$bridge_line" | sed -E 's/.*worst_wait_ms=//') ms"
	else
		record V6 FAIL "pi: ${pi_line:-no result}; bridge: ${bridge_line:-no result}"
	fi
}

# --- tools: V3, V12 -----------------------------------------------------------

check_tools() {
	echo "--- tools"
	local runtime
	for runtime in $(runtimes_to_compare); do
		sandbox_flags "$runtime"
		timeout 420 docker run "${FLAGS[@]}" --network none --entrypoint bash "$IMAGE" /spike/inside-tools.sh > "$WORK/tools-$runtime.txt" 2>&1
	done
	local name result detail runc_ms test_ms
	while read -r name result test_ms; do
		case "$result" in
			OK) record V3 PASS "$name ($test_ms ms)" ;;
			FAIL) detail="$(grep -A3 "^$name FAIL" "$WORK/tools-$RUNTIME.txt" | tail -n +2 | tr '\n' ' ' | cut -c1-200)"; record V3 FAIL "$name: $detail" ;;
			*) continue ;;
		esac
		runc_ms="$(awk -v n="$name" '$1==n {print $3}' "$WORK/tools-runc.txt" 2>/dev/null)"
		record V12 INFO "$name runc=${runc_ms:-?}ms $RUNTIME=${test_ms}ms"
	done < <(grep -E '^[a-z0-9-]+ (OK|FAIL) [0-9]+$' "$WORK/tools-$RUNTIME.txt")
	if ! grep -qE '^[a-z0-9-]+ (OK|FAIL) [0-9]+$' "$WORK/tools-$RUNTIME.txt"; then
		record V3 FAIL "no tool results: $(head -3 "$WORK/tools-$RUNTIME.txt" | tr '\n' ' ' | cut -c1-200)"
	fi
}

# --- networks and the stand-in bridge ------------------------------------------

ensure_networks() {
	if ! docker network inspect js-spike-0 >/dev/null 2>&1; then
		docker network create --driver bridge --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated \
			--subnet 10.89.90.0/24 --label "$LABEL" js-spike-0 >/dev/null || return 1
		docker network create --driver bridge --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated \
			--subnet 10.89.91.0/24 --label "$LABEL" js-spike-1 >/dev/null || return 1
		docker network create --driver bridge --internal \
			--subnet 10.89.92.0/24 --label "$LABEL" js-spike-plain >/dev/null || return 1
	fi
	return 0
}

ensure_bridge() {
	if docker inspect js-spike-bridge >/dev/null 2>&1; then return 0; fi
	mkdir -p "$WORK/bridge-out"
	chmod 777 "$WORK/bridge-out"
	: > "$WORK/bridge-out/bridge.log"
	chmod 666 "$WORK/bridge-out/bridge.log"
	docker run -d --name js-spike-bridge --label "$LABEL" "${HELPER_LIMITS[@]}" --user 1000:1000 --network js-spike-0 --ip "$BRIDGE_IP" \
		--mount "type=bind,src=$SPIKE_SRC,dst=/spike,readonly" --mount "type=bind,src=$WORK/bridge-out,dst=/out" \
		-e "SPIKE_TOKEN=$TOKEN" --entrypoint node "$IMAGE" /spike/fake-bridge.mjs >/dev/null || return 1
	local attempt
	for attempt in $(seq 1 50); do
		if grep -q listening "$WORK/bridge-out/bridge.log"; then return 0; fi
		sleep 0.2
	done
	return 1
}

# --- pi: V4, V5 ---------------------------------------------------------------

run_pi() {
	local runtime="$1" chat="$2" prompt="$3" output="$4"
	local root="/data/users/spike/chats/$chat" host="$WORK/chats/$chat"
	mkdir -p "$host/uploads" "$host/artifacts" "$host/workspace" "$host/sessions"
	chmod -R a+rwX "$WORK/chats"
	sandbox_flags "$runtime"
	printf '%s' "$prompt" | timeout 240 docker run -i "${FLAGS[@]}" --name "js-spike-pi-$chat-$RANDOM" \
		--network js-spike-0 --ip "$PI_IP" --hostname js-run \
		--mount "type=bind,src=$host/uploads,dst=$root/uploads,readonly" \
		--mount "type=bind,src=$host/artifacts,dst=$root/artifacts,readonly" \
		--mount "type=bind,src=$host/workspace,dst=$root/workspace" \
		--mount "type=bind,src=$host/sessions,dst=$root/sessions" \
		-e "JS_RUN_TOKEN=$TOKEN" -e "JS_GATEWAY_URL=$GATEWAY_URL" \
		-e "JUNIOR_SILVA_MCP_GATEWAY_URL=$GATEWAY_URL/internal/mcp" \
		-e PI_CODING_AGENT_DIR=/run/pi-agent -e "PI_CODING_AGENT_SESSION_DIR=$root/sessions" \
		-e "JUNIOR_SILVA_WORKSPACE_ROOT=$root/workspace/requests/r1" \
		-e PI_OFFLINE=1 -e PI_TELEMETRY=0 -e PI_SKIP_VERSION_CHECK=1 \
		--entrypoint bash "$IMAGE" /spike/inside-pi.sh \
		--mode json --approve --session-id "junior-silva-v2-$chat" --provider anthropic --model "$MODEL" --thinking medium \
		> "$output" 2> "$output.err"
	return "${PIPESTATUS[1]}"
}

evaluate_pi() {
	local output="$1" started="$2"
	docker run --rm --label "$LABEL" "${HELPER_LIMITS[@]}" --network none --user 1000:1000 \
		--mount "type=bind,src=$SPIKE_SRC,dst=/spike,readonly" --mount "type=bind,src=$WORK,dst=/w,readonly" \
		--entrypoint node "$IMAGE" /spike/eval-pi.mjs "/w/${output#"$WORK"/}" /w/bridge-out/bridge.log "$started" 2>&1
}

value_of() { printf '%s\n' "$2" | sed -n "s/^$1=//p"; }

check_pi() {
	echo "--- pi"
	if ! ensure_networks || ! ensure_bridge; then
		record V4 FAIL "could not start the stand-in bridge: $(docker logs js-spike-bridge 2>&1 | tail -3 | tr '\n' ' ' | cut -c1-200)"
		return
	fi
	local runtime
	for runtime in $(runtimes_to_compare); do
		local chat="chat-$runtime" output="$WORK/pi-$runtime.jsonl" started finished code result
		started="$(now_ms)"
		run_pi "$runtime" "$chat" "SPIKE-PROMPT-1" "$output"
		code=$?
		finished="$(now_ms)"
		result="$(evaluate_pi "$output" "$started")"
		record V12 INFO "pi-run $runtime: total=$((finished - started))ms first_model_request=$(value_of first_model_ms "$result")ms mcp_tools_list=$(value_of tools_list_ms "$result")ms"
		if [ "$runtime" != "$RUNTIME" ]; then continue; fi

		local file="$WORK/chats/$chat/workspace/requests/r1/from-pi-bash.txt"
		if [ "$code" = "0" ] && [ "$(value_of bash_ok "$result")" = "true" ] && [ "$(value_of mcp_ok "$result")" = "true" ] && [ -s "$file" ] && value_of final_text "$result" | grep -q 'SPIKE-DONE-1"'; then
			record V4 PASS "Pi ran bash and an MCP tool, the file reached the host, final answer received. Token sent: $(value_of token_matches "$result")"
		else
			record V4 FAIL "exit=$code bash=$(value_of bash_ok "$result") mcp=$(value_of mcp_ok "$result") file=$([ -s "$file" ] && echo yes || echo no) final=$(value_of final_text "$result") stop=$(value_of stop_reason "$result") error=$(value_of error_message "$result") stderr=$(tail -3 "$output.err" 2>/dev/null | tr '\n' ' ' | cut -c1-240)"
		fi

		local list_ms
		list_ms="$(value_of tools_list_ms "$result")"
		if [ "$(value_of first_request_lists_mcp "$result")" = "true" ] && [ "${list_ms:--1}" -ge 0 ] && [ "${list_ms:-99999}" -lt 10000 ]; then
			record V5 PASS "MCP tools listed $list_ms ms after start, and present in the first model request"
		else
			record V5 FAIL "tools_list=${list_ms}ms first_request_lists_mcp=$(value_of first_request_lists_mcp "$result")"
		fi
		record INFO INFO "capture for P2.3: query='$(value_of model_query "$result")' beta='$(value_of anthropic_beta "$result")' body_keys=$(value_of body_keys "$result")"
		record INFO INFO "tools in the first request: $(value_of tool_names "$result")"

		# A new container, the same folders: the chat must carry on.
		local second="$WORK/pi-$runtime-second.jsonl" started_second second_result sessions
		started_second="$(now_ms)"
		run_pi "$runtime" "$chat" "SPIKE-PROMPT-2" "$second"
		second_result="$(evaluate_pi "$second" "$started_second")"
		sessions="$(find "$WORK/chats/$chat/sessions" -maxdepth 1 -name '*.jsonl' | wc -l)"
		if [ "$(value_of saw_prompt_1 "$second_result")" = "true" ] && value_of final_text "$second_result" | grep -q 'SPIKE-DONE-2' && [ "$sessions" = "1" ]; then
			record V4b PASS "a new container resumed the chat: the first prompt was in the next model request, and one session file was kept"
		else
			record V4b FAIL "saw_first_prompt=$(value_of saw_prompt_1 "$second_result") final=$(value_of final_text "$second_result") session_files=$sessions"
		fi
	done
}

# --- network: N1 to N7 --------------------------------------------------------

check_network() {
	echo "--- network"
	if ! ensure_networks; then
		record N1 FAIL "could not create an internal network with gateway mode isolated"
		return
	fi
	local slot_if plain_if slot_addr plain_addr
	slot_if="br-$(docker network inspect -f '{{slice .Id 0 12}}' js-spike-0)"
	plain_if="br-$(docker network inspect -f '{{slice .Id 0 12}}' js-spike-plain)"
	slot_addr="$(ip -4 -o addr show dev "$slot_if" 2>/dev/null)"
	plain_addr="$(ip -4 -o addr show dev "$plain_if" 2>/dev/null)"
	if [ -z "$slot_addr" ] && [ -n "$plain_addr" ]; then
		record N1 PASS "isolated network created. The host has no address on it, and does on the plain internal network (control)"
	else
		record N1 FAIL "isolated: '$(printf '%s' "$slot_addr" | cut -c1-100)'; plain: '$(printf '%s' "$plain_addr" | cut -c1-100)'"
	fi

	if ! ensure_bridge; then
		record N2 FAIL "the stand-in bridge did not start on a static IP"
		return
	fi
	if docker network connect --ip 10.89.91.2 js-spike-1 js-spike-bridge 2>"$WORK/connect.err"; then
		record N2 PASS "static IPs work: the bridge joined a second slot, and Pi starts with --ip"
	else
		record N2 FAIL "$(cut -c1-200 "$WORK/connect.err")"
	fi

	# Things Pi must not reach, each with a control proving the target is really there.
	docker run -d --name js-spike-host-listener --label "$LABEL" "${HELPER_LIMITS[@]}" --network host --user 1000:1000 \
		--mount "type=bind,src=$SPIKE_SRC,dst=/spike,readonly" --entrypoint node "$IMAGE" /spike/probe.mjs listen "$HOST_PORT" >/dev/null
	sandbox_flags "$RUNTIME"
	docker run -d "${FLAGS[@]}" --name js-spike-other-pi --network js-spike-1 --ip 10.89.91.3 \
		--entrypoint node "$IMAGE" /spike/probe.mjs listen 9000 >/dev/null
	sleep 5

	local control_host control_other control_internet
	sandbox_flags "$RUNTIME"
	control_host="$(docker run "${FLAGS[@]}" --network js-spike-plain --ip 10.89.92.3 --entrypoint node "$IMAGE" /spike/probe.mjs net "10.89.92.1:$HOST_PORT" 2>&1)"
	control_other="$(docker exec js-spike-bridge node /spike/probe.mjs net 10.89.91.3:9000 2>&1)"
	control_internet="$(docker run --rm --label "$LABEL" "${HELPER_LIMITS[@]}" --mount "type=bind,src=$SPIKE_SRC,dst=/spike,readonly" --entrypoint node "$IMAGE" /spike/probe.mjs net 1.1.1.1:443 2>&1)"
	if printf '%s' "$control_host" | grep -q ' open'; then
		record CTRL PASS "a plain internal network CAN reach the host through its gateway IP, as Docker documents. So a block under isolated is real"
	else
		record CTRL FAIL "plain internal network could not reach the test listener, so N4 proves nothing: $(printf '%s' "$control_host" | cut -c1-120). A host firewall may be blocking it"
	fi
	if printf '%s' "$control_other" | grep -q ' open'; then
		record CTRL PASS "the other Pi's listener is up (reached from the bridge). So a block between Pi containers is real"
	else
		record CTRL FAIL "other Pi's listener not reachable from the bridge: $(printf '%s' "$control_other" | cut -c1-120)"
	fi
	local internet_works=no
	if printf '%s' "$control_internet" | grep -q ' open'; then
		internet_works=yes
		record CTRL PASS "this machine has internet, so a block from Pi is real"
	else
		record CTRL INFO "this machine could not reach 1.1.1.1:443, so N5 is inconclusive: $(printf '%s' "$control_internet" | cut -c1-120)"
	fi

	local link_local host_ip targets_host other_targets
	link_local="$(ip -6 -o addr show dev "$slot_if" scope link 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
	host_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
	targets_host="10.89.90.1:$HOST_PORT 172.17.0.1:$HOST_PORT"
	if [ -n "$host_ip" ]; then targets_host="$targets_host $host_ip:$HOST_PORT"; fi
	if [ -n "$link_local" ]; then targets_host="$targets_host [$link_local%eth0]:$HOST_PORT"; fi
	other_targets="10.89.91.2:8127 10.89.91.3:9000 10.89.92.1:$HOST_PORT 169.254.169.254:80"
	local id address
	for id in $(docker ps -q); do
		if [ -n "$(docker inspect -f '{{index .Config.Labels "js.spike"}}' "$id")" ]; then continue; fi
		for address in $(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$id"); do
			other_targets="$other_targets $address:8126 $address:3080 $address:27017"
		done
	done

	sandbox_flags "$RUNTIME"
	PROBE_OUT="$WORK/probe.txt"
	docker run "${FLAGS[@]}" --network js-spike-0 --ip "$PI_IP" --hostname js-run --entrypoint bash "$IMAGE" -c "
		echo '[N3]'; node /spike/probe.mjs net $BRIDGE_IP:8127; node /spike/probe.mjs http $GATEWAY_URL/health
		echo '[N4]'; node /spike/probe.mjs net $targets_host
		echo '[N5]'; node /spike/probe.mjs net 1.1.1.1:443 8.8.8.8:53; node /spike/probe.mjs dns example.com
		echo '[N6]'; node /spike/probe.mjs net $other_targets
		echo '[N7]'; node /spike/probe.mjs route; python3 -c 'import socket; socket.socket(socket.AF_PACKET, socket.SOCK_RAW); print(\"raw-socket allowed\")' 2>/dev/null || echo 'raw-socket refused'
	" > "$PROBE_OUT" 2>&1
	section_of() { sed -n "/^\[$1\]/,/^\[/p" "$PROBE_OUT" | grep -v '^\['; }

	if section_of N3 | grep -q "$BRIDGE_IP:8127 open" && section_of N3 | grep -q "/health 200"; then
		record N3 PASS "Pi reaches the bridge on 8127"
	else
		record N3 FAIL "$(section_of N3 | tr '\n' ' ' | cut -c1-200)"
	fi
	if section_of N4 | grep -q ' open'; then
		record N4 FAIL "Pi reached the host: $(section_of N4 | grep ' open' | tr '\n' ' ' | cut -c1-200)"
	else
		record N4 PASS "gateway IP, host addresses and link-local all blocked: $(section_of N4 | tr '\n' ';' | cut -c1-240)"
	fi
	if section_of N5 | grep -qE ' open| resolved:'; then
		record N5 FAIL "Pi reached the internet or DNS: $(section_of N5 | tr '\n' ' ' | cut -c1-200)"
	elif [ "$internet_works" = "yes" ]; then
		record N5 PASS "internet and DNS blocked: $(section_of N5 | tr '\n' ';' | cut -c1-200)"
	else
		record N5 INFO "blocked, but inconclusive because this machine has no internet"
	fi
	if section_of N6 | grep -q ' open'; then
		record N6 FAIL "Pi reached: $(section_of N6 | grep ' open' | tr '\n' ' ' | cut -c1-200)"
	else
		record N6 PASS "other slot, other Pi, other containers and metadata IP all blocked ($(section_of N6 | wc -l) targets)"
	fi
	if section_of N7 | grep -q 'default-route absent' && section_of N7 | grep -q 'raw-socket refused'; then
		record N7 PASS "no default route, and raw sockets refused, so Pi can't use the bridge as a router"
	else
		record N7 FAIL "$(section_of N7 | tr '\n' ' ' | cut -c1-200)"
	fi
	record INFO INFO "Pi's interfaces: $(section_of N7 | grep '^interface' | tr '\n' ';' | cut -c1-200)"

	docker rm -f js-spike-host-listener js-spike-other-pi >/dev/null 2>&1
}

# --- limits: V10 --------------------------------------------------------------

check_limits() {
	echo "--- limits"
	local output code
	sandbox_flags "$RUNTIME"
	output="$(timeout 180 docker run "${FLAGS[@]}" --network none --entrypoint python3 "$IMAGE" /spike/inside-limits.py memory 2>&1)"
	code=$?
	if printf '%s' "$output" | grep -q bomb-complete; then
		record V10 FAIL "memory: allocated 6 GB despite the 2 GB limit"
	else
		record V10 PASS "memory: stopped at about $(printf '%s\n' "$output" | grep '^allocated' | tail -1 | awk '{print $2}') MB, exit code $code"
	fi

	local runtime
	for runtime in $(runtimes_to_compare); do
		sandbox_flags "$runtime"
		output="$(timeout 120 docker run "${FLAGS[@]}" --network none --name "js-spike-fork-$runtime" --entrypoint python3 "$IMAGE" /spike/inside-limits.py fork 2>&1)"
		code=$?
		docker rm -f "js-spike-fork-$runtime" >/dev/null 2>&1
		local count
		count="$(printf '%s\n' "$output" | sed -n 's/.*count=\([0-9]*\).*/\1/p' | tail -1)"
		if [ "$runtime" != "$RUNTIME" ]; then
			record V10 INFO "processes under $runtime with --pids-limit 512: ${count:-container ended} (control)"
			continue
		fi
		if [ -n "$count" ] && [ "$count" -le 600 ]; then
			record V10 PASS "processes: limit held at $count under $runtime"
		elif [ -z "$count" ]; then
			# gVisor gives no clean fork error here: its own limit ends the whole sandbox (exit 2).
			record V10 PASS "processes: contained. The whole sandbox ended (exit $code) instead of fork failing under $runtime"
		else
			record V10 INFO "processes: --pids-limit did NOT hold under $runtime, reached $count of the 4000 test cap. Memory limit is the real stop"
		fi
	done

	sandbox_flags "$RUNTIME"
	output="$(timeout 120 docker run "${FLAGS[@]}" --network none --entrypoint bash "$IMAGE" -c 'dd if=/dev/zero of=/tmp/fill bs=1M count=1300 2>/dev/null; stat -c %s /tmp/fill' 2>&1)"
	local size
	size="$(printf '%s\n' "$output" | tail -1)"
	if [ -n "$size" ] && [ "$size" -le 1073741824 ] 2>/dev/null; then
		record V10 PASS "tmpfs: stopped at $((size / 1048576)) MB against a 1 GB limit"
	else
		record V10 FAIL "tmpfs: $(printf '%s' "$output" | cut -c1-160)"
	fi
}

# --- load: V11 ----------------------------------------------------------------

check_load() {
	echo "--- load"
	local sandbox_procs_before sandbox_procs_after
	sandbox_procs_before="$(pgrep -fc 'runsc-sandbox' 2>/dev/null || true)"
	local round slowest=0 failures=0
	for round in 1 2 3 4 5; do
		local started finished index
		started="$(now_ms)"
		for index in $(seq 1 "$LOAD_AT_ONCE"); do
			timeout 120 docker run --rm --name "js-spike-load-$round-$index" --label "$LABEL" "${HELPER_LIMITS[@]}" --runtime="$RUNTIME" --network none \
				--entrypoint sh "$IMAGE" -c 'echo ok' > "$WORK/load-$round-$index.txt" 2>&1 &
		done
		wait
		finished="$(now_ms)"
		if [ $((finished - started)) -gt "$slowest" ]; then slowest=$((finished - started)); fi
		for index in $(seq 1 "$LOAD_AT_ONCE"); do
			if [ "$(cat "$WORK/load-$round-$index.txt" 2>/dev/null)" != "ok" ]; then failures=$((failures + 1)); fi
		done
	done
	local leftovers
	leftovers="$(docker ps -a --filter 'name=js-spike-load' -q | wc -l)"
	sleep 3
	sandbox_procs_after="$(pgrep -fc 'runsc-sandbox' 2>/dev/null || true)"
	if [ "$failures" = "0" ] && [ "$leftovers" = "0" ]; then
		record V11 PASS "5 rounds of $LOAD_AT_ONCE at once: no failures, no leftover containers. Slowest round $slowest ms. Sandbox processes before=$sandbox_procs_before after=$sandbox_procs_after"
	else
		record V11 FAIL "failures=$failures leftovers=$leftovers slowest=${slowest}ms sandbox processes before=$sandbox_procs_before after=$sandbox_procs_after"
	fi
}

# --- memory: V13 --------------------------------------------------------------

check_memory() {
	echo "--- memory"
	sandbox_flags "$RUNTIME"
	local name="js-spike-memory"
	docker run "${FLAGS[@]}" --network none --name "$name" --entrypoint bash "$IMAGE" /spike/inside-tools.sh > "$WORK/memory-tools.txt" 2>&1 &
	local job=$! peak_stats=0 peak_rss=0 id="" usage mib rss
	while kill -0 "$job" 2>/dev/null; do
		if [ -z "$id" ]; then id="$(docker inspect -f '{{.Id}}' "$name" 2>/dev/null)"; fi
		usage="$(docker stats --no-stream --format '{{.MemUsage}}' "$name" 2>/dev/null | awk '{print $1}')"
		mib="$(printf '%s' "$usage" | awk '/GiB/ {printf "%d", $1 * 1024} /MiB/ {printf "%d", $1}')"
		if [ "${mib:-0}" -gt "$peak_stats" ]; then peak_stats="$mib"; fi
		if [ -n "$id" ]; then
			rss="$(ps -eo rss=,args= | grep -F "$id" | grep -v grep | awk '{sum += $1} END {printf "%d", sum / 1024}')"
			if [ "${rss:-0}" -gt "$peak_rss" ]; then peak_rss="$rss"; fi
		fi
	done
	wait "$job"
	record V13 INFO "peak during LibreOffice and Chromium: docker stats ${peak_stats} MiB, host processes ${peak_rss} MiB"
}

# --- live server checks --------------------------------------------------------

# Every other running container: name, start time, restart count, and whether it's unhealthy.
other_containers() {
	docker ps -q | xargs -r docker inspect -f '{{if not (index .Config.Labels "js.spike")}}{{.Name}} started={{.State.StartedAt}} restarts={{.RestartCount}}{{with .State.Health}}{{if eq .Status "unhealthy"}} unhealthy{{end}}{{end}}{{end}}' | sed '/^$/d' | sort
}

containers_changed() {
	local now
	now="$(other_containers)"
	if [ "$now" != "$CONTAINERS_BEFORE" ]; then
		diff <(printf '%s\n' "$CONTAINERS_BEFORE") <(printf '%s\n' "$now") | grep '^[<>]' | head -4 | tr '\n' ' ' | cut -c1-300
	fi
}

free_memory_mib() { awk '/^MemAvailable:/ {printf "%d", $2 / 1024}' /proc/meminfo; }
free_disk_mib() { df -m --output=avail "$(docker info -f '{{.DockerRootDir}}')" | tail -1 | tr -d ' '; }
load_now() { cut -d' ' -f1 /proc/loadavg; }

# Prints why the test must stop, or nothing when it's safe to go on.
live_problem() {
	local memory disk load
	memory="$(free_memory_mib)"
	disk="$(free_disk_mib)"
	load="$(load_now)"
	if [ "$memory" -lt "$MIN_FREE_MEMORY_MIB" ]; then
		echo "only $memory MiB of RAM free, need $MIN_FREE_MEMORY_MIB"
	elif [ "$disk" -lt "$MIN_FREE_DISK_MIB" ]; then
		echo "only $disk MiB of disk free, need $MIN_FREE_DISK_MIB"
	# gawk, the usual awk on Ubuntu servers, won't take "load" as a variable name.
	elif awk -v current="$load" -v cores="$(nproc)" 'BEGIN {exit !(current >= cores)}'; then
		echo "CPU load is $load on $(nproc) cores"
	else
		containers_changed
	fi
}

# --- main ---------------------------------------------------------------------

: > "$RESULTS"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
	echo "Image $IMAGE not found." >&2
	exit 1
fi
remove_spike_items
record INFO INFO "runtime under test: $RUNTIME; image: $IMAGE; host: $(uname -m) $(uname -r); docker: $(docker version --format '{{.Server.Version}}')"
if [ "$LIVE" = "1" ]; then
	CONTAINERS_BEFORE="$(other_containers)"
	record LIVE INFO "live server mode: $(printf '%s' "$CONTAINERS_BEFORE" | grep -c '') other containers running. Each test container: $MEMORY RAM, $CPUS CPU"
fi

sections=("$@")
if [ "${#sections[@]}" = "0" ] || [ "${sections[0]}" = "all" ]; then
	sections=(basics exchange tools pi network limits load memory)
fi
for section in "${sections[@]}"; do
	if [ "$LIVE" = "1" ]; then
		problem="$(live_problem)"
		if [ -n "$problem" ]; then
			record STOP FAIL "stopped before $section: $problem"
			break
		fi
		record LIVE INFO "before $section: RAM free $(free_memory_mib) MiB, disk free $(free_disk_mib) MiB, load $(load_now)"
	fi
	case "$section" in
		basics) check_basics ;;
		exchange) check_exchange ;;
		tools) check_tools ;;
		pi) check_pi ;;
		network) check_network ;;
		limits)
			if [ "$LIVE" = "1" ]; then
				record V10 SKIP "not run on a live server, because it uses up to 2 GB of RAM"
			else
				check_limits
			fi
			;;
		load) check_load ;;
		memory) check_memory ;;
		*) echo "Unknown section: $section" >&2; exit 2 ;;
	esac
	if [ "$LIVE" = "1" ]; then
		remove_spike_items
		sleep 5
	fi
done

if [ "$LIVE" = "1" ]; then
	remove_spike_items
	changed="$(containers_changed)"
	if [ -z "$changed" ]; then
		record LIVE PASS "every other container has the same start time and restart count, and none became unhealthy"
	else
		record LIVE FAIL "another container changed: $changed"
	fi
	left_containers="$(docker ps -aq --filter "label=$LABEL" | wc -l)"
	left_networks="$(docker network ls -q --filter "label=$LABEL" | wc -l)"
	if [ "$left_containers" = "0" ] && [ "$left_networks" = "0" ]; then
		record LIVE PASS "nothing left behind: 0 test containers, 0 test networks"
	else
		record LIVE FAIL "left behind: $left_containers test containers, $left_networks test networks"
	fi
fi

echo
if [ "$FAILS" = "0" ]; then
	echo "RESULT: no failures. Results: $RESULTS"
else
	echo "RESULT: $FAILS failure(s). Results: $RESULTS"
	exit 1
fi
