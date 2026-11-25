#!/usr/bin/env -S python3 -I
# Load test for Junior Silva V2: task/deployment/plan.md, M10.
#
# It sends real workflows to the running bridge the way LibreChat does: streaming, each from its own
# made-up test user in a new chat, each asking for research and a Word document. It runs them at
# rising levels of concurrency, and measures time, CPU, RAM, swap, and whether memory comes back
# afterwards. Every workflow uses the real model, so it costs money.
#
# Run it from pi/ only when nobody is using the stack. Run it in the background, so Ctrl+C can't cut
# off its clean-up (MG12), and watch its log:
#
#     nohup scripts/js-load-test.py --yes > ../js-load-test.log 2>&1 &
#     tail -f ../js-load-test.log
#
# To stop it early: touch ../js-load-test.stop
# It then hangs up the running chats, removes its test users and writes its results.
#
#     scripts/js-load-test.py --check-only --levels 1,2,3,5,7,10   checks, and 10 seconds of sampling
#     scripts/js-load-test.py --cleanup <results folder>           removes test users a cut-off run left
#
# JS_SLOTS must be at least the highest level. The tool never prints a secret: it reads the bridge key
# and the identity secret from .env itself. It saves no chat text, only timings, sizes and flags.

import argparse
import csv
import hashlib
import hmac
import http.client
import io
import json
import os
import re
import secrets
import shutil
import signal
import socket
import statistics
import subprocess
import threading
import time
import zipfile
from datetime import datetime, timezone
from pathlib import Path

PI_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = PI_DIR / ".env"
BRIDGE = "junior-silva-v2"
RUNNER = "junior-silva-runner"
BRIDGE_IMAGE = "junior-silva-v2:local"
PI_IMAGE = "junior-silva-pi:local"
PROMPT = "Please prepare a short note, one paragraph, on what a lease is under Sri Lankan law, as a Word document."
# Every test user's ID starts with this ("load"), so test users are easy to tell apart.
USER_PREFIX = "ffff10ad"
SAMPLE_SECONDS = 2
READ_TIMEOUT = 120  # the bridge sends a keep-alive every 15 seconds
WORKFLOW_DEADLINE = 25 * 60  # Pi's own limit is 20 minutes
CALM_WAIT = 120  # how long to wait for free RAM and the load to come back before a level
# Swap in plus out above this many pages a second, for this many samples in a row (10 seconds), is thrashing.
THRASH_PAGES = 1024
THRASH_SAMPLES = 5
# The limits for the maximum stable concurrency (task/deployment/plan.md, M10).
STABLE_MEDIAN_FACTOR = 2.0
STABLE_SLOWEST_FACTOR = 3.0
STABLE_MIN_FREE_MIB = 1536
RECOVERED_WITHIN_MIB = 200
RECOVERED_SWAP_WITHIN_MIB = 100

BUSY_TEXT = "Junior Silva is busy with other requests right now"
ERROR_TEXTS = ("Junior Silva could not complete this request", "I couldn't finish this answer")
INCOMPLETE_TEXTS = ("This answer isn't complete", "This answer was cut off")
# A download link: <public address>/files/<signature>/<user>/<chat>/<operation>/<name>?exp=<time>
LINK = re.compile(r"https?://\S+?(/files/[0-9a-f]{64}/([0-9a-f]{32})/([0-9a-f]{32})/\S+?\?exp=\d+)")
RESEARCH_TOOLS = {"rag_chat_research", "legal_source_retrieve_details", "web_search_public_legal_sources", "legal_precedent_search", "legal_precedent_read"}
DOCUMENT_TOOLS = {"builtin_command", "builtin_read", "builtin_write", "workbench_publish_artifact", "librechat_prepare_document_preview", "legal_validate_draft", "review_prepare_document_set", "review_record_checkpoint_outcome", "review_finalize_document"}
# The only settings read from the bridge's environment. The others hold secrets.
SAFE_SETTINGS = ("JS_SLOTS", "JS_SLOT_WAIT_MS", "PI_PROVIDER", "PI_MODEL", "PI_THINKING", "JUNIOR_SILVA_MODEL_NAME", "JUNIOR_SILVA_PI_TIMEOUT_MS")

print_lock = threading.Lock()
interrupted = threading.Event()


def say(text):
    with print_lock:
        print(f"{time.strftime('%H:%M:%S')} {text}", flush=True)


def iso(moment):
    return datetime.fromtimestamp(moment, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(text):
    """Seconds since 1970 from an RFC 3339 time, as Docker and the audit log write it."""
    match = re.match(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z", text or "")
    if not match:
        return None
    moment = datetime.strptime(match.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    return moment + float(match.group(2) or 0)


def median(values):
    values = [value for value in values if value is not None]
    return round(statistics.median(values), 1) if values else None


def most(values):
    values = [value for value in values if value is not None]
    return max(values) if values else None


def least(values):
    values = [value for value in values if value is not None]
    return min(values) if values else None


def docker(*args, timeout=60):
    """Docker's output, or "" when it fails."""
    try:
        done = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return done.stdout.strip() if done.returncode == 0 else ""


def docker_logs(container, since):
    """A container's log lines since a time, each starting with Docker's timestamp."""
    try:
        done = subprocess.run(["docker", "logs", "--timestamps", "--since", iso(since - 2), container], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return []
    return (done.stdout + done.stderr).splitlines()


def env_setting(name):
    """A value from pi/.env. Never printed."""
    try:
        lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    value = ""
    for line in lines:
        key, sep, rest = line.strip().partition("=")
        if sep and key.strip() == name:
            value = rest.strip().strip('"').strip("'")
    return value


def keyed(secret, *parts):
    """The bridge's folder name for LibreChat IDs (junior-silva/core/chat-scope.mjs)."""
    return hmac.new(secret.encode(), "\0".join(parts).encode(), hashlib.sha256).hexdigest()[:32]


# --- the host -------------------------------------------------------------------------------------

def meminfo():
    values = {}
    with open("/proc/meminfo", encoding="ascii") as file:
        for line in file:
            key, _, rest = line.partition(":")
            values[key] = int(rest.split()[0])
    return values


def free_mib():
    return meminfo()["MemAvailable"] // 1024


def swap_pages():
    values = {}
    with open("/proc/vmstat", encoding="ascii") as file:
        for line in file:
            key, _, rest = line.partition(" ")
            if key in ("pswpin", "pswpout"):
                values[key] = int(rest)
    return values.get("pswpin", 0), values.get("pswpout", 0)


def cpu_times():
    with open("/proc/stat", encoding="ascii") as file:
        return [int(value) for value in file.readline().split()[1:9]]


def cpu_split(before, after):
    """Busy, iowait and steal, as % of all CPU time between two readings of /proc/stat."""
    user, nice, system, idle, iowait, irq, softirq, steal = [b - a for a, b in zip(before, after)]
    total = (user + nice + system + idle + iowait + irq + softirq + steal) or 1
    return (round(100 * (user + nice + system + irq + softirq) / total, 1), round(100 * iowait / total, 1), round(100 * steal / total, 1))


def load_now():
    with open("/proc/loadavg", encoding="ascii") as file:
        return float(file.read().split()[0])


def gvisor_processes():
    try:
        done = subprocess.run(["pgrep", "-fc", "runsc-sandbox"], capture_output=True, text=True, timeout=10)
        return int(done.stdout.strip() or 0)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return 0


def disk_free_mib(*paths):
    free = []
    for path in paths:
        try:
            free.append(shutil.disk_usage(path).free // 2**20)
        except OSError:
            pass
    return min(free) if free else 0


# --- containers -----------------------------------------------------------------------------------

def cgroup_for_pid(pid):
    """A process's cgroup folder (cgroup v2), when its memory can be read."""
    try:
        if int(pid) <= 0:
            return None
        with open(f"/proc/{int(pid)}/cgroup", encoding="ascii") as file:
            for line in file:
                if line.startswith("0::"):
                    folder = Path("/sys/fs/cgroup") / line[3:].strip().lstrip("/")
                    return folder if (folder / "memory.current").exists() else None
    except (OSError, ValueError):
        return None
    return None


def cgroup_of(container):
    return cgroup_for_pid(docker("inspect", "-f", "{{.State.Pid}}", container) or 0)


def cgroup_read(folder):
    """Memory now and at its peak (bytes), and CPU used (microseconds), or None."""
    try:
        current = int((folder / "memory.current").read_text())
        try:
            peak = int((folder / "memory.peak").read_text())
        except (OSError, ValueError):
            peak = None
        usage = 0
        for line in (folder / "cpu.stat").read_text().splitlines():
            if line.startswith("usage_usec"):
                usage = int(line.split()[1])
        return current, peak, usage
    except (OSError, ValueError, TypeError):
        return None


def cgroup_oom_kills(folder):
    """How many processes the kernel killed for memory in this cgroup."""
    for line in cgroup_text(folder, "memory.events").splitlines():
        if line.startswith("oom_kill "):
            return int(line.split()[1])
    return 0


def cgroup_text(folder, name):
    try:
        return (folder / name).read_text().strip()
    except (OSError, TypeError):
        return ""


def container_states():
    """Every running container: start time, restart count, health, and whether it's one of ours."""
    ids = docker("ps", "-q").split()
    if not ids:
        return {}
    form = '{{.Name}}|{{.State.StartedAt}}|{{.RestartCount}}|{{with .State.Health}}{{.Status}}{{end}}|{{index .Config.Labels "js.run"}}{{index .Config.Labels "js.check"}}{{index .Config.Labels "js.spike"}}'
    states = {}
    for line in docker("inspect", "-f", form, *ids).splitlines():
        name, started, restarts, health, ours = (line.split("|") + [""] * 5)[:5]
        name = name.lstrip("/")
        states[name] = {"started": started, "restarts": restarts, "health": health, "ours": bool(ours) or name.startswith(("js-run-", "js-check", "js-spike"))}
    return states


def container_changes(before, after):
    """What changed among the containers that aren't test runs: the bridge, the runner, and production's."""
    changes = []
    for name, old in before.items():
        if old["ours"]:
            continue
        new = after.get(name)
        if new is None:
            changes.append(f"{name} stopped")
        elif (new["started"], new["restarts"]) != (old["started"], old["restarts"]):
            changes.append(f"{name} restarted")
        elif new["health"] == "unhealthy" and old["health"] != "unhealthy":
            changes.append(f"{name} became unhealthy")
    return changes


class Stack:
    """What the running stack looks like. Only settings without secrets are kept."""

    def __init__(self):
        self.settings = {}
        for line in docker("inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", BRIDGE).splitlines():
            key, sep, value = line.partition("=")
            if sep and key in SAFE_SETTINGS:
                self.settings[key] = value
        try:
            self.slots = int(self.settings.get("JS_SLOTS") or 3)
        except ValueError:
            self.slots = 0
        self.data_root = docker("inspect", "-f", '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}', BRIDGE)
        address = (docker("port", BRIDGE, "8126/tcp").splitlines() or [""])[0]
        host, _, port = address.rpartition(":")
        host = host.strip("[]")
        self.host = "127.0.0.1" if host in ("", "0.0.0.0", "::") else host
        self.port = int(port) if port.isdigit() else 8132
        self.model_name = self.settings.get("JUNIOR_SILVA_MODEL_NAME") or "junior-silva-2"

    def health(self):
        try:
            connection = http.client.HTTPConnection(self.host, self.port, timeout=10)
            connection.request("GET", "/health")
            status = connection.getresponse().status
            connection.close()
            return status
        except (OSError, http.client.HTTPException):
            return 0

    def slot_networks(self):
        attached = docker("inspect", "-f", "{{range $name, $network := .NetworkSettings.Networks}}{{$name}} {{end}}", BRIDGE).split()
        return sum(1 for slot in range(1, self.slots + 1) if f"js-slot-{slot}" in attached)


# --- test data ------------------------------------------------------------------------------------

def data_user(data_root, command, timeout=300):
    """Runs a shell command as user 1000 with the data folder at /d, like the isolation check does.
    Its own session, so a Ctrl+C in the terminal can't cut it off (MG12)."""
    try:
        done = subprocess.run(["docker", "run", "--rm", "--network", "none", "--user", "1000:1000", "--mount", f"type=bind,src={data_root},dst=/d", "--entrypoint", "sh", BRIDGE_IMAGE, "-c", command], capture_output=True, text=True, timeout=timeout, start_new_session=True)
        return done.stdout
    except (OSError, subprocess.TimeoutExpired):
        return ""


def data_text(data_root, relative):
    try:
        return (Path(data_root) / relative).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return data_user(data_root, f"cat '/d/{relative}' 2>/dev/null")


def disk_kb(data_root, folders):
    """Disk used by test users' folders, in KB. Folder names are hex only."""
    if not folders:
        return 0
    output = data_user(data_root, "cd /d && du -sk " + " ".join(folders) + " 2>/dev/null")
    return sum(int(line.split()[0]) for line in output.splitlines() if line.split() and line.split()[0].isdigit())


def test_pairs(folder):
    try:
        lines = (Path(folder) / "users.txt").read_text(encoding="ascii").splitlines()
    except OSError:
        return []
    pairs = []
    for line in lines:
        user, _, chat = line.strip().partition(":")
        if re.fullmatch(USER_PREFIX + r"[0-9a-f]{16}", user) and re.fullmatch(r"[A-Za-z0-9_-]{8,128}", chat):
            pairs.append((user, chat))
    return pairs


def remove_test_data(data_root, secret, pairs):
    """Removes test users' folders and their audit files. Returns how many are still there."""
    targets = sorted({f"users/{keyed(secret, 'user', user)}" for user, _ in pairs} | {f"audit/junior-silva-v2-{keyed(secret, 'chat', user, chat)}.jsonl" for user, chat in pairs})
    if not targets:
        return 0
    for start in range(0, len(targets), 50):
        data_user(data_root, "cd /d && rm -rf " + " ".join(targets[start:start + 50]))
    left = data_user(data_root, "cd /d && for target in " + " ".join(targets) + "; do [ -e \"$target\" ] && echo \"$target\"; done")
    return len(left.split())


# --- sampling -------------------------------------------------------------------------------------

class Sampler(threading.Thread):
    """Every 2 seconds: the host, every Pi container, the bridge, the runner, and the other containers."""

    FIELDS = ["time", "phase", "host_used_mib", "host_free_mib", "swap_used_mib", "swap_in_pages_s", "swap_out_pages_s", "cpu_busy_pct", "cpu_iowait_pct", "cpu_steal_pct", "load1", "pi_containers", "gvisor_processes", "pi_mem_mib", "pi_cpu_pct", "bridge_mem_mib", "bridge_cpu_pct", "runner_mem_mib", "runner_cpu_pct", "others_mem_mib", "others_cpu_pct"]

    def __init__(self, path):
        super().__init__(daemon=True)
        self.path = path
        self.phase = "start"
        self.rows = []
        self.lock = threading.Lock()
        self.halt = threading.Event()
        self.pi = {}  # container ID -> what's known about that Pi container
        self.latest = {}
        self.swap_rates = []
        self.previous = None
        self.usage = {}  # cgroup folder -> (time, CPU microseconds)
        self.groups = {}
        self.groups_at = 0
        self.first_pi_limits = ""

    def refresh_groups(self):
        groups = {"bridge": [], "runner": [], "others": []}
        states = container_states()
        for name, state in states.items():
            if state["ours"]:
                continue
            folder = cgroup_of(name)
            if folder:
                groups["bridge" if name == BRIDGE else "runner" if name == RUNNER else "others"].append(folder)
        self.groups = groups
        self.groups_at = time.time()

    def rate(self, folder, now, usage):
        """CPU use since the last reading, as % of one CPU."""
        last = self.usage.get(folder)
        self.usage[folder] = (now, usage)
        if not last or now <= last[0]:
            return 0.0
        return max(0.0, (usage - last[1]) / ((now - last[0]) * 1e6) * 100)

    def describe_pi(self, container, name, now):
        found = docker("inspect", "-f", "{{.State.Pid}}|{{range .Mounts}}{{.Source}};{{end}}", container)
        pid, _, mounts = found.partition("|")
        match = re.search(r"/users/([0-9a-f]{32})/chats/([0-9a-f]{32})/", mounts)
        folder = cgroup_for_pid(pid or 0)
        if folder and not self.first_pi_limits:
            self.first_pi_limits = f"memory.max {cgroup_text(folder, 'memory.max')}, cpu.max {cgroup_text(folder, 'cpu.max')}, pids.max {cgroup_text(folder, 'pids.max')}"
        return {"name": name, "run_id": name.removeprefix("js-run-"), "user_hash": match.group(1) if match else "", "chat_hash": match.group(2) if match else "", "cgroup": folder, "first_seen": now, "last_seen": now, "mem_peak": 0, "cpu_usec": 0, "oom_kill": 0}

    def sample(self):
        now = time.time()
        if now - self.groups_at > 30:
            self.refresh_groups()
        memory = meminfo()
        pages = swap_pages()
        cpu = cpu_times()
        row = {"time": iso(now), "phase": self.phase}
        row["host_used_mib"] = (memory["MemTotal"] - memory["MemAvailable"]) // 1024
        row["host_free_mib"] = memory["MemAvailable"] // 1024
        row["swap_used_mib"] = (memory.get("SwapTotal", 0) - memory.get("SwapFree", 0)) // 1024
        row["swap_in_pages_s"] = row["swap_out_pages_s"] = 0
        row["cpu_busy_pct"] = row["cpu_iowait_pct"] = row["cpu_steal_pct"] = ""
        if self.previous:
            elapsed = max(0.001, now - self.previous[0])
            row["swap_in_pages_s"] = round((pages[0] - self.previous[1][0]) / elapsed)
            row["swap_out_pages_s"] = round((pages[1] - self.previous[1][1]) / elapsed)
            row["cpu_busy_pct"], row["cpu_iowait_pct"], row["cpu_steal_pct"] = cpu_split(self.previous[2], cpu)
        self.previous = (now, pages, cpu)
        row["load1"] = load_now()

        running = {}
        for line in docker("ps", "--filter", "label=js.run=1", "--format", "{{.ID}} {{.Names}}").splitlines():
            container, _, name = line.partition(" ")
            if container:
                running[container] = name
        pi_memory = 0
        pi_cpu = 0.0
        for container, name in running.items():
            if container not in self.pi:
                described = self.describe_pi(container, name, now)
                with self.lock:
                    self.pi[container] = described
            info = self.pi[container]
            info["last_seen"] = now
            reading = cgroup_read(info["cgroup"]) if info["cgroup"] else None
            if reading:
                current, peak, usage = reading
                info["mem_peak"] = max(info["mem_peak"], peak or current)
                info["cpu_usec"] = usage
                info["oom_kill"] = max(info["oom_kill"], cgroup_oom_kills(info["cgroup"]))
                pi_memory += current
                pi_cpu += self.rate(info["cgroup"], now, usage)
        row["pi_containers"] = len(running)
        row["gvisor_processes"] = gvisor_processes()
        row["pi_mem_mib"] = pi_memory // 2**20
        row["pi_cpu_pct"] = round(pi_cpu, 1)
        for group in ("bridge", "runner", "others"):
            group_memory = 0
            group_cpu = 0.0
            for folder in self.groups.get(group, []):
                reading = cgroup_read(folder)
                if reading:
                    group_memory += reading[0]
                    group_cpu += self.rate(folder, now, reading[2])
            row[f"{group}_mem_mib"] = group_memory // 2**20
            row[f"{group}_cpu_pct"] = round(group_cpu, 1)

        with self.lock:
            self.rows.append(row)
            self.latest = row
            self.swap_rates.append(row["swap_in_pages_s"] + row["swap_out_pages_s"])
            self.swap_rates = self.swap_rates[-THRASH_SAMPLES:]
        new_file = not self.path.exists()
        with open(self.path, "a", newline="", encoding="utf-8") as file:
            writer = csv.DictWriter(file, fieldnames=self.FIELDS)
            if new_file:
                writer.writeheader()
            writer.writerow(row)

    def thrashing(self):
        with self.lock:
            rates = list(self.swap_rates)
        return len(rates) == THRASH_SAMPLES and all(rate > THRASH_PAGES for rate in rates)

    def rows_in(self, phase):
        with self.lock:
            return [row for row in self.rows if row["phase"] == phase]

    def run(self):
        while not self.halt.is_set():
            started = time.time()
            try:
                self.sample()
            except Exception as error:  # a failed sample must never stop the test
                say(f"INFO  a sample failed: {type(error).__name__}")
            self.halt.wait(max(0.2, SAMPLE_SECONDS - (time.time() - started)))


def thrashed(rows):
    run = 0
    for row in rows:
        run = run + 1 if row["swap_in_pages_s"] + row["swap_out_pages_s"] > THRASH_PAGES else 0
        if run >= THRASH_SAMPLES:
            return True
    return False


# --- one workflow ---------------------------------------------------------------------------------

class Workflow:
    def __init__(self, level, index, user, chat, user_hash, chat_hash):
        self.level, self.index, self.user, self.chat = level, index, user, chat
        self.user_hash, self.chat_hash = user_hash, chat_hash
        self.started = self.ended = None
        self.first_progress = self.first_answer = None
        self.status = 0
        self.stream_id = ""
        self.progress = 0
        self.answer_chars = 0
        self.done = self.timed_out = self.aborted = False
        self.error = ""
        self.busy = self.error_note = self.incomplete = False
        self.link_path = ""
        self.link_chat_ok = False
        self.download_status = 0
        self.download_bytes = 0
        self.docx_ok = False
        self.runs = []  # (run ID, slot, start time, exit, reason, milliseconds)
        self.peak_mem_mib = None
        self.cpu_s = None
        self.oom_kills = 0
        self.tools = {}

    def result(self):
        if self.aborted:
            return "aborted"
        if self.timed_out:
            return "timeout"
        if self.status == 0:
            return "connection"
        if self.status != 200:
            return "busy" if self.busy else f"http-{self.status}"
        if self.busy:
            return "busy"
        if self.error_note:
            return "error"
        if not self.done:
            return "cut-off"
        if self.incomplete:
            return "incomplete"
        if not self.link_path:
            return "no-document"
        if not self.link_chat_ok:
            return "wrong-chat-link"
        if not self.docx_ok:
            return "download-failed"
        return "ok"

    def seconds(self, moment):
        return round(moment - self.started, 1) if moment and self.started else None

    def total_s(self):
        return self.seconds(self.ended)


def check_download(stack, path):
    """Status, size, and whether it's a real Word file."""
    connection = http.client.HTTPConnection(stack.host, stack.port, timeout=60)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        data = response.read(100 * 2**20)
        is_docx = False
        if response.status == 200 and data[:2] == b"PK":
            try:
                is_docx = "word/document.xml" in zipfile.ZipFile(io.BytesIO(data)).namelist()
            except zipfile.BadZipFile:
                is_docx = False
        return response.status, len(data), is_docx
    except (OSError, http.client.HTTPException):
        return 0, 0, False
    finally:
        connection.close()


def audit_tools(data_root, chat_hash):
    """Tool time from the bridge's audit log for one chat: research, document work, the rest, and their union."""
    starts = {}
    spans = []
    errors = 0
    for line in data_text(data_root, f"audit/junior-silva-v2-{chat_hash}.jsonl").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("type") != "tool":
            continue
        moment = parse_time(event.get("at", ""))
        tool = str(event.get("tool", "unknown"))
        if moment is None:
            continue
        if event.get("status") == "started":
            starts.setdefault(tool, []).append(moment)
        else:
            begun = starts.get(tool) or [moment]
            spans.append((begun.pop(0), moment, tool))
            errors += event.get("status") == "error"
    research = sum(end - start for start, end, tool in spans if tool in RESEARCH_TOOLS)
    document = sum(end - start for start, end, tool in spans if tool in DOCUMENT_TOOLS)
    other = sum(end - start for start, end, tool in spans if tool not in RESEARCH_TOOLS | DOCUMENT_TOOLS)
    union = 0.0
    reach = None
    for start, end, _ in sorted(spans):
        if reach is None or start > reach:
            union += end - start
            reach = end
        elif end > reach:
            union += end - reach
            reach = end
    return {"research_s": round(research, 1), "document_s": round(document, 1), "other_tools_s": round(other, 1), "tool_wall_s": round(union, 1), "tool_calls": len(spans), "tool_errors": errors}


# --- the test -------------------------------------------------------------------------------------

RUN_FIELDS = ["level", "index", "user", "chat", "started", "result", "http_status", "total_s", "first_progress_s", "first_answer_s", "progress_lines", "answer_chars", "document_link", "download_status", "download_kb", "docx_valid", "pi_runs", "slots", "runner_start_s", "container_s", "exit_codes", "oom_kills", "peak_mem_mib", "cpu_s", "avg_cores", "research_s", "document_s", "other_tools_s", "tool_wall_s", "model_and_rest_s", "tool_calls", "tool_errors"]
LEVEL_FIELDS = ["level", "workflows", "ok", "failures", "success_pct", "median_s", "fastest_s", "slowest_s", "median_first_progress_s", "max_pi_at_once", "host_peak_used_mib", "host_min_free_mib", "cpu_peak_pct", "cpu_avg_pct", "iowait_peak_pct", "steal_peak_pct", "load_peak", "swap_peak_used_mib", "swap_peak_pages_s", "thrashing", "peak_mem_per_workflow_mib", "median_peak_mem_per_workflow_mib", "median_cpu_s_per_workflow", "pi_peak_mem_mib", "bridge_peak_mib", "runner_peak_mib", "others_peak_mib", "extra_pi_runs", "oom_kills", "busy_logged", "refused_model_calls", "model_unreachable", "start_retries", "other_runs", "containers_changed", "median_research_s", "median_document_s", "median_model_and_rest_s", "disk_kb_per_workflow", "recovered", "recovery_used_delta_mib", "recovery_swap_delta_mib", "pi_left", "gvisor_left", "bridge_after_mib", "stopped", "verdict"]


class LoadTest:
    def __init__(self, args, stack, out):
        self.args = args
        self.stack = stack
        self.out = out
        self.key = env_setting("JUNIOR_SILVA_API_KEY")
        self.secret = env_setting("JS_IDENTITY_SECRET")
        self.tag = secrets.token_hex(4)
        self.sampler = Sampler(out / "samples.csv")
        self.active = set()
        self.active_lock = threading.Lock()
        self.abort = threading.Event()
        self.abort_reason = ""
        self.stop_reason = ""
        self.summaries = []
        self.baseline_median = None
        self.start_states = {}
        self.idle = {}

    # One workflow, sent the way LibreChat sends it.
    def run_workflow(self, flow, barrier):
        body = json.dumps({"model": self.stack.model_name, "stream": True, "messages": [{"role": "user", "content": PROMPT}]}).encode()
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {self.key}", "X-LibreChat-User-Id": flow.user, "X-LibreChat-Conversation-Id": flow.chat}
        connection = http.client.HTTPConnection(self.stack.host, self.stack.port, timeout=READ_TIMEOUT)
        answer = []
        try:
            barrier.wait(timeout=60)
        except threading.BrokenBarrierError:
            pass
        flow.started = time.time()
        try:
            with self.active_lock:
                self.active.add(connection)
            connection.request("POST", "/v1/chat/completions", body=body, headers=headers)
            response = connection.getresponse()
            flow.status = response.status
            if response.status != 200:
                flow.busy = BUSY_TEXT in response.read(65536).decode("utf-8", "replace")
            else:
                while not self.abort.is_set():
                    if time.time() - flow.started > WORKFLOW_DEADLINE:
                        flow.timed_out = True
                        break
                    raw = response.readline()
                    if not raw:
                        break
                    line = raw.decode("utf-8", "replace").strip()
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        flow.done = True
                        break
                    try:
                        chunk = json.loads(data)
                    except ValueError:
                        continue
                    now = time.time()
                    flow.stream_id = flow.stream_id or str(chunk.get("id") or "")
                    delta = ((chunk.get("choices") or [{}])[0] or {}).get("delta") or {}
                    if delta.get("reasoning_content"):
                        flow.progress += 1
                        flow.first_progress = flow.first_progress or now
                    if delta.get("content"):
                        answer.append(str(delta["content"]))
                        flow.first_answer = flow.first_answer or now
        except TimeoutError:
            flow.timed_out = True
        except (OSError, http.client.HTTPException) as error:
            flow.error = type(error).__name__
        finally:
            flow.ended = time.time()
            flow.aborted = self.abort.is_set() and not flow.done
            with self.active_lock:
                self.active.discard(connection)
            connection.close()
        text = "".join(answer)
        flow.answer_chars = len(text)
        flow.busy = flow.busy or BUSY_TEXT in text
        flow.error_note = any(note in text for note in ERROR_TEXTS)
        flow.incomplete = any(note in text for note in INCOMPLETE_TEXTS)
        links = list(LINK.finditer(text))
        link = next((match for match in links if ".docx?" in match.group(1)), links[0] if links else None)
        if link:
            flow.link_path = link.group(1)
            flow.link_chat_ok = link.group(2) == flow.user_hash and link.group(3) == flow.chat_hash
            if not flow.aborted:
                flow.download_status, flow.download_bytes, flow.docx_ok = check_download(self.stack, flow.link_path)

    def hang_up(self):
        with self.active_lock:
            for connection in list(self.active):
                try:
                    if connection.sock:
                        connection.sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def danger(self, check_containers):
        """Why a running level must stop now, or ""."""
        if self.args.stop_file.exists():
            return "the stop file appeared"
        if interrupted.is_set():
            return "Ctrl+C or a stop signal"
        free = self.sampler.latest.get("host_free_mib")
        if free is not None and free < self.args.abort_free_mib:
            return f"free RAM fell to {free} MiB"
        if self.sampler.thrashing():
            return "swap thrashing"
        if check_containers:
            changes = container_changes(self.start_states, container_states())
            if changes:
                return "a container changed: " + "; ".join(changes)
        return ""

    def run_batch(self, flows):
        barrier = threading.Barrier(len(flows))
        threads = [threading.Thread(target=self.run_workflow, args=(flow, barrier), daemon=True) for flow in flows]
        for thread in threads:
            thread.start()
        checked = time.time()
        while any(thread.is_alive() for thread in threads):
            time.sleep(SAMPLE_SECONDS)
            if self.abort.is_set():
                continue
            check_containers = time.time() - checked >= 10
            if check_containers:
                checked = time.time()
            reason = self.danger(check_containers)
            if reason:
                self.abort_reason = reason
                self.abort.set()
                say(f"STOP  {reason}: hanging up this level's chats, so the bridge stops their containers")
                self.hang_up()
        for thread in threads:
            thread.join(10)

    def calm(self):
        """Why the next level must not start, or "". Waits up to 2 minutes for RAM and load to come back."""
        deadline = time.time() + CALM_WAIT
        while True:
            if self.args.stop_file.exists():
                return "the stop file is there"
            if interrupted.is_set():
                return "Ctrl+C or a stop signal"
            changes = container_changes(self.start_states, container_states())
            if changes:
                return "a container changed: " + "; ".join(changes)
            if docker("ps", "-q", "--filter", "label=js.run=1"):
                problem = "a Pi run is still going"
            elif free_mib() < self.args.min_free_mib:
                problem = f"only {free_mib()} MiB of RAM free, need {self.args.min_free_mib}"
            elif disk_free_mib("/", self.stack.data_root) < self.args.min_disk_mib:
                problem = f"only {disk_free_mib('/', self.stack.data_root)} MiB of disk free, need {self.args.min_disk_mib}"
            elif load_now() >= (os.cpu_count() or 1):
                problem = f"the CPU load is {load_now()} on {os.cpu_count()} CPUs"
            else:
                return ""
            if time.time() >= deadline:
                return problem
            time.sleep(10)

    def wait(self, seconds, minimum=0):
        """Waits, but stops early (after a minimum) if the stop file appears or on Ctrl+C."""
        started = time.time()
        while time.time() - started < seconds:
            if (self.args.stop_file.exists() or interrupted.is_set()) and time.time() - started >= minimum:
                return
            time.sleep(1)

    def new_flows(self, level, count):
        flows = []
        for index in range(1, count + 1):
            user = USER_PREFIX + secrets.token_hex(8)
            chat = f"loadtest-{self.tag}-{level}-{index}-{secrets.token_hex(6)}"
            flows.append(Workflow(level, index, user, chat, keyed(self.secret, "user", user), keyed(self.secret, "chat", user, chat)))
        # Written before the level starts, so --cleanup can always find them.
        with open(self.out / "users.txt", "a", encoding="ascii") as file:
            file.writelines(f"{flow.user}:{flow.chat}\n" for flow in flows)
        return flows

    def link_runs(self, flows, since):
        """Matches the runner's runs and the sampled Pi containers to the workflows."""
        by_stream = {flow.stream_id: flow for flow in flows if flow.stream_id}
        by_chat = {flow.chat_hash: flow for flow in flows}
        with self.sampler.lock:
            containers = list(self.sampler.pi.values())
        chat_of_run = {info["run_id"]: info["chat_hash"] for info in containers}
        runs = {}
        for line in docker_logs(RUNNER, since):
            stamp, _, message = line.partition(" ")
            moment = parse_time(stamp)
            match = re.search(r"run (chatcmpl-[0-9a-f-]+) started on slot (\d+)", message)
            if match:
                runs.setdefault(match.group(1), {})["slot"] = int(match.group(2))
                runs[match.group(1)]["start"] = moment
                continue
            match = re.search(r"run (chatcmpl-[0-9a-f-]+) ended: exit (\S+), ([^,]+), after (\d+) ms", message)
            if match:
                runs.setdefault(match.group(1), {}).update({"exit": match.group(2), "reason": match.group(3), "ms": int(match.group(4))})
        other_runs = 0
        for run_id, info in runs.items():
            flow = by_stream.get(run_id) or by_chat.get(chat_of_run.get(run_id, ""))
            if not flow:
                other_runs += 1
                continue
            flow.runs.append((run_id, info.get("slot"), info.get("start"), info.get("exit"), info.get("reason"), info.get("ms")))
        for flow in flows:
            mine = [info for info in containers if info["chat_hash"] == flow.chat_hash]
            if mine:
                flow.peak_mem_mib = max(info["mem_peak"] for info in mine) // 2**20
                flow.cpu_s = round(sum(info["cpu_usec"] for info in mine) / 1e6, 1)
            # Out of memory: the kernel's own count, or a run killed (137) that nobody stopped. A stopped run
            # also ends with 137, but its reason is "stopped".
            killed = sum(1 for run in flow.runs if str(run[3]) == "137" and run[4] == "done")
            flow.oom_kills = max(sum(info["oom_kill"] for info in mine), killed)
            flow.tools = audit_tools(self.stack.data_root, flow.chat_hash)
        return other_runs

    def run_row(self, flow):
        runs = sorted(flow.runs, key=lambda run: run[2] or 0)
        container_s = round(sum(run[5] or 0 for run in runs) / 1000, 1) if runs else None
        total = flow.total_s()
        row = {
            "level": flow.level, "index": flow.index, "user": flow.user, "chat": flow.chat,
            "started": iso(flow.started) if flow.started else "", "result": flow.result(), "http_status": flow.status,
            "total_s": total, "first_progress_s": flow.seconds(flow.first_progress), "first_answer_s": flow.seconds(flow.first_answer),
            "progress_lines": flow.progress, "answer_chars": flow.answer_chars, "document_link": "yes" if flow.link_path else "no",
            "download_status": flow.download_status or "", "download_kb": round(flow.download_bytes / 1024, 1) if flow.download_bytes else "",
            "docx_valid": "yes" if flow.docx_ok else "no", "pi_runs": len(runs), "slots": " ".join(str(run[1]) for run in runs),
            "runner_start_s": round(runs[0][2] - flow.started, 1) if runs and runs[0][2] and flow.started else None,
            "container_s": container_s, "exit_codes": " ".join(str(run[3]) for run in runs), "oom_kills": flow.oom_kills,
            "peak_mem_mib": flow.peak_mem_mib, "cpu_s": flow.cpu_s,
            "avg_cores": round(flow.cpu_s / container_s, 2) if flow.cpu_s is not None and container_s else None,
        }
        row.update(flow.tools)
        row["model_and_rest_s"] = round(total - flow.tools.get("tool_wall_s", 0), 1) if total is not None and flow.tools else None
        return row

    def run_level(self, level):
        count = self.args.baseline_runs if level == 1 else level
        flows = self.new_flows(level, count)
        say(f"===   level {level}: {count} workflow(s){' one after another' if level == 1 else ' at once'}")
        memory = meminfo()
        start = {"time": time.time(), "used": (memory["MemTotal"] - memory["MemAvailable"]) // 1024, "swap": (memory.get("SwapTotal", 0) - memory.get("SwapFree", 0)) // 1024, "gvisor": gvisor_processes()}
        self.sampler.phase = f"level-{level}"
        if level == 1:
            for position, flow in enumerate(flows):
                if position:
                    self.wait(10)
                if self.abort.is_set() or self.args.stop_file.exists() or interrupted.is_set():
                    break
                self.run_batch([flow])
                say(f"INFO  baseline run {position + 1}: {flow.result()}, {flow.total_s()} s")
        else:
            self.run_batch(flows)
        ran = [flow for flow in flows if flow.started]
        say(f"INFO  level {level} finished: " + ", ".join(f"{flow.result()} {flow.total_s()} s" for flow in ran))

        self.sampler.phase = f"recovery-{level}"
        say(f"INFO  watching memory recovery for {self.args.recovery} s")
        self.wait(self.args.recovery, minimum=30)
        memory = meminfo()
        pi_left = len(docker("ps", "-aq", "--filter", "label=js.run=1").split())
        gvisor_left = gvisor_processes()
        used_delta = (memory["MemTotal"] - memory["MemAvailable"]) // 1024 - start["used"]
        swap_delta = (memory.get("SwapTotal", 0) - memory.get("SwapFree", 0)) // 1024 - start["swap"]
        bridge_rows = self.sampler.rows_in(f"recovery-{level}")
        recovered = pi_left == 0 and gvisor_left <= start["gvisor"] and used_delta <= RECOVERED_WITHIN_MIB and swap_delta <= RECOVERED_SWAP_WITHIN_MIB

        other_runs = self.link_runs(ran, start["time"])
        bridge_log = docker_logs(BRIDGE, start["time"])
        rows = [self.run_row(flow) for flow in ran]
        new_file = not (self.out / "runs.csv").exists()
        with open(self.out / "runs.csv", "a", newline="", encoding="utf-8") as file:
            writer = csv.DictWriter(file, fieldnames=RUN_FIELDS)
            if new_file:
                writer.writeheader()
            writer.writerows(rows)

        level_rows = self.sampler.rows_in(f"level-{level}")
        ok = [row for row in rows if row["result"] == "ok"]
        failures = {}
        for row in rows:
            if row["result"] != "ok":
                failures[row["result"]] = failures.get(row["result"], 0) + 1
        user_folders = sorted({f"users/{flow.user_hash}" for flow in ran})
        summary = {
            "level": level, "workflows": len(rows), "ok": len(ok),
            "failures": " ".join(f"{name}:{number}" for name, number in sorted(failures.items())),
            "success_pct": round(100 * len(ok) / len(rows)) if rows else 0,
            "median_s": median(row["total_s"] for row in ok), "fastest_s": least(row["total_s"] for row in ok), "slowest_s": most(row["total_s"] for row in ok),
            "median_first_progress_s": median(row["first_progress_s"] for row in rows),
            "max_pi_at_once": most(row["pi_containers"] for row in level_rows),
            "host_peak_used_mib": most(row["host_used_mib"] for row in level_rows), "host_min_free_mib": least(row["host_free_mib"] for row in level_rows),
            "cpu_peak_pct": most(row["cpu_busy_pct"] for row in level_rows if row["cpu_busy_pct"] != ""),
            "cpu_avg_pct": round(statistics.mean([row["cpu_busy_pct"] for row in level_rows if row["cpu_busy_pct"] != ""]), 1) if any(row["cpu_busy_pct"] != "" for row in level_rows) else None,
            "iowait_peak_pct": most(row["cpu_iowait_pct"] for row in level_rows if row["cpu_iowait_pct"] != ""),
            "steal_peak_pct": most(row["cpu_steal_pct"] for row in level_rows if row["cpu_steal_pct"] != ""),
            "load_peak": most(row["load1"] for row in level_rows),
            "swap_peak_used_mib": most(row["swap_used_mib"] for row in level_rows), "swap_peak_pages_s": most(row["swap_in_pages_s"] + row["swap_out_pages_s"] for row in level_rows),
            "thrashing": "yes" if thrashed(level_rows) else "no",
            "peak_mem_per_workflow_mib": most(row["peak_mem_mib"] for row in rows), "median_peak_mem_per_workflow_mib": median(row["peak_mem_mib"] for row in rows),
            "median_cpu_s_per_workflow": median(row["cpu_s"] for row in rows),
            "pi_peak_mem_mib": most(row["pi_mem_mib"] for row in level_rows), "bridge_peak_mib": most(row["bridge_mem_mib"] for row in level_rows),
            "runner_peak_mib": most(row["runner_mem_mib"] for row in level_rows), "others_peak_mib": most(row["others_mem_mib"] for row in level_rows),
            "extra_pi_runs": sum(max(0, row["pi_runs"] - 1) for row in rows), "oom_kills": sum(row["oom_kills"] for row in rows),
            "busy_logged": sum("got the busy answer" in line for line in bridge_log), "refused_model_calls": sum("Refused a model call" in line for line in bridge_log),
            "model_unreachable": sum("model service could not be reached" in line for line in bridge_log), "start_retries": sum("didn't start in time" in line for line in bridge_log),
            "other_runs": other_runs, "containers_changed": "; ".join(container_changes(self.start_states, container_states())) or "no",
            "median_research_s": median(row.get("research_s") for row in ok), "median_document_s": median(row.get("document_s") for row in ok),
            "median_model_and_rest_s": median(row.get("model_and_rest_s") for row in ok),
            "disk_kb_per_workflow": round(disk_kb(self.stack.data_root, user_folders) / len(rows)) if rows else None,
            "recovered": "yes" if recovered else "no", "recovery_used_delta_mib": used_delta, "recovery_swap_delta_mib": swap_delta,
            "pi_left": pi_left, "gvisor_left": gvisor_left - start["gvisor"], "bridge_after_mib": most(row["bridge_mem_mib"] for row in bridge_rows[-3:]),
            "stopped": self.abort_reason,
        }
        if level == 1:
            self.baseline_median = summary["median_s"]
        summary["verdict"] = self.verdict(summary)
        self.summaries.append(summary)
        new_file = not (self.out / "levels.csv").exists()
        with open(self.out / "levels.csv", "a", newline="", encoding="utf-8") as file:
            writer = csv.DictWriter(file, fieldnames=LEVEL_FIELDS)
            if new_file:
                writer.writeheader()
            writer.writerow(summary)
        say(f"LEVEL {level}: {summary['ok']}/{summary['workflows']} ok, median {summary['median_s']} s, slowest {summary['slowest_s']} s, peak RAM used {summary['host_peak_used_mib']} MiB, lowest free {summary['host_min_free_mib']} MiB, CPU peak {summary['cpu_peak_pct']} %, recovered {summary['recovered']}: {summary['verdict']}")

    def verdict(self, summary):
        reasons = []
        if summary["ok"] < summary["workflows"]:
            reasons.append(f"{summary['workflows'] - summary['ok']} of {summary['workflows']} failed ({summary['failures']})")
        if self.baseline_median and summary["median_s"] is not None:
            if summary["median_s"] > STABLE_MEDIAN_FACTOR * self.baseline_median:
                reasons.append(f"median over {STABLE_MEDIAN_FACTOR:g}x the baseline")
            if summary["slowest_s"] > STABLE_SLOWEST_FACTOR * self.baseline_median:
                reasons.append(f"slowest over {STABLE_SLOWEST_FACTOR:g}x the baseline")
        if summary["host_min_free_mib"] is not None and summary["host_min_free_mib"] < STABLE_MIN_FREE_MIB:
            reasons.append(f"free RAM under {STABLE_MIN_FREE_MIB} MiB")
        if summary["thrashing"] == "yes":
            reasons.append("swap thrashing")
        if summary["oom_kills"]:
            reasons.append("out-of-memory kill")
        if summary["containers_changed"] != "no":
            reasons.append("a container changed")
        if summary["recovered"] != "yes":
            reasons.append("memory didn't come back")
        if summary["stopped"]:
            reasons.append(f"stopped: {summary['stopped']}")
        return "stable" if not reasons else "not stable: " + "; ".join(reasons)

    def write_summary(self):
        lines = [f"Junior Silva load test, {iso(time.time())}", f"Results folder: {self.out}", ""]
        lines.append(f"Model {self.stack.settings.get('PI_PROVIDER', '?')} {self.stack.settings.get('PI_MODEL', '?')}, slots {self.stack.slots}, workflow: research and a Word document")
        if self.idle:
            lines.append(f"Idle: RAM used {self.idle['used']} MiB, free {self.idle['free']} MiB, CPU busy {self.idle['cpu']} %, load {self.idle['load']}, bridge {self.idle['bridge']} MiB, runner {self.idle['runner']} MiB, other containers {self.idle['others']} MiB")
        if self.sampler.first_pi_limits:
            lines.append(f"Each Pi container's limits: {self.sampler.first_pi_limits}")
        lines.append("")
        lines.append("Level | OK | Median s | Slowest s | First progress s | Max Pi at once | Peak RAM used MiB | Lowest free MiB | CPU peak % | Load peak | Swap MiB | Peak RAM per workflow MiB | Recovered | Verdict")
        for summary in self.summaries:
            lines.append(f"{summary['level']} | {summary['ok']}/{summary['workflows']} | {summary['median_s']} | {summary['slowest_s']} | {summary['median_first_progress_s']} | {summary['max_pi_at_once']} | {summary['host_peak_used_mib']} | {summary['host_min_free_mib']} | {summary['cpu_peak_pct']} | {summary['load_peak']} | {summary['swap_peak_used_mib']} | {summary['peak_mem_per_workflow_mib']} | {summary['recovered']} | {summary['verdict']}")
        stable = None
        for summary in self.summaries:
            if summary["verdict"] != "stable":
                break
            stable = summary["level"]
        lines.append("")
        lines.append(f"Maximum stable concurrency: {stable if stable is not None else 'none of the levels'} (the highest level that, with every level below it, met every limit)")
        if self.stop_reason:
            lines.append(f"Stopped early: {self.stop_reason}")
        lines.append("Limits: every workflow ok with a Word file that downloads; median at most 2x the baseline, slowest at most 3x; free RAM at least 1536 MiB; no swap thrashing; no out-of-memory kill; no other container changed; memory back within 200 MiB.")
        text = "\n".join(lines) + "\n"
        (self.out / "summary.txt").write_text(text, encoding="utf-8")
        with print_lock:
            print("\n" + text, flush=True)

    def write_server(self):
        cpu_model = ""
        try:
            for line in Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="replace").splitlines():
                if line.startswith("model name"):
                    cpu_model = line.partition(":")[2].strip()
                    break
        except OSError:
            pass
        os_name = ""
        try:
            for line in Path("/etc/os-release").read_text(encoding="utf-8").splitlines():
                if line.startswith("PRETTY_NAME="):
                    os_name = line.partition("=")[2].strip('"')
        except OSError:
            pass
        memory = meminfo()
        others = [name for name, state in self.start_states.items() if not state["ours"] and name not in (BRIDGE, RUNNER)]
        commit = ""
        try:
            commit = subprocess.run(["git", "-C", str(PI_DIR), "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=10).stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            pass
        bridge_group = cgroup_of(BRIDGE)
        lines = [
            f"Started: {iso(time.time())}",
            f"Code: {commit}",
            f"CPUs: {os.cpu_count()} ({cpu_model})",
            f"RAM: {memory['MemTotal'] // 1024} MiB; swap {memory.get('SwapTotal', 0) // 1024} MiB",
            f"OS: {os_name}; kernel {os.uname().release}; Docker {docker('version', '--format', '{{.Server.Version}}')}; cgroup v2: {'yes' if Path('/sys/fs/cgroup/cgroup.controllers').exists() else 'no'}",
            "Settings: " + ", ".join(f"{name}={self.stack.settings[name]}" for name in SAFE_SETTINGS if name in self.stack.settings),
            f"Bridge limits: memory.max {cgroup_text(bridge_group, 'memory.max')}, cpu.max {cgroup_text(bridge_group, 'cpu.max')}" if bridge_group else "Bridge limits: unknown",
            f"Images: bridge {docker('inspect', '-f', '{{.Image}}', BRIDGE)[7:19]}, runner {docker('inspect', '-f', '{{.Image}}', RUNNER)[7:19]}, Pi {docker('image', 'inspect', '-f', '{{.Id}}', PI_IMAGE)[7:19]}",
            f"Other containers running: {len(others)}",
            f"Levels: {self.args.levels}; baseline runs {self.args.baseline_runs}; idle {self.args.idle} s; recovery {self.args.recovery} s; min free {self.args.min_free_mib} MiB before a level; abort under {self.args.abort_free_mib} MiB",
            f"Prompt: {PROMPT}",
        ]
        (self.out / "server.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def run(self, levels):
        self.start_states = container_states()
        self.write_server()
        self.sampler.start()
        say(f"INFO  results go to {self.out}")
        say(f"===   idle for {self.args.idle} s")
        self.sampler.phase = "idle"
        self.wait(self.args.idle)
        idle_rows = self.sampler.rows_in("idle")
        if idle_rows:
            cpu = [row["cpu_busy_pct"] for row in idle_rows if row["cpu_busy_pct"] != ""]
            self.idle = {"used": median(row["host_used_mib"] for row in idle_rows), "free": median(row["host_free_mib"] for row in idle_rows), "cpu": round(statistics.mean(cpu), 1) if cpu else None, "load": median(row["load1"] for row in idle_rows), "bridge": median(row["bridge_mem_mib"] for row in idle_rows), "runner": median(row["runner_mem_mib"] for row in idle_rows), "others": median(row["others_mem_mib"] for row in idle_rows)}
            say(f"INFO  idle: RAM used {self.idle['used']} MiB, free {self.idle['free']} MiB, CPU busy {self.idle['cpu']} %, other containers {self.idle['others']} MiB")
        for level in levels:
            problem = self.calm()
            if problem:
                self.stop_reason = f"before level {level}: {problem}"
                say(f"STOP  {self.stop_reason}")
                break
            self.run_level(level)
            if self.abort.is_set():
                self.stop_reason = f"during level {level}: {self.abort_reason}"
                break
        self.sampler.phase = "end"
        self.sampler.halt.set()
        self.sampler.join(10)
        self.write_summary()

    def clean_up(self):
        # No Ctrl+C from here: a cut-off clean-up leaves test users behind (MG12).
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        pairs = test_pairs(self.out)
        say(f"INFO  removing {len(pairs)} test chat(s) and their users")
        left = remove_test_data(self.stack.data_root, self.secret, pairs)
        pi_left = len(docker("ps", "-aq", "--filter", "label=js.run=1").split())
        if left or pi_left:
            say(f"FAIL  left behind: {left} test folder(s) or audit file(s), {pi_left} Pi container(s). Folders: scripts/js-load-test.py --cleanup {self.out}")
        else:
            say("PASS  nothing left behind: no test users, no Pi containers")


# --- start ----------------------------------------------------------------------------------------

def preflight(stack, args, levels):
    """Problems that stop the test before it starts."""
    problems = []
    for container in (BRIDGE, RUNNER):
        if docker("inspect", "-f", "{{.State.Running}}", container) != "true":
            problems.append(f"{container} isn't running")
    if problems:
        return problems
    if stack.health() != 200:
        problems.append("the bridge's health isn't 200")
    if not env_setting("JUNIOR_SILVA_API_KEY") or not env_setting("JS_IDENTITY_SECRET"):
        problems.append(f"{ENV_FILE} has no JUNIOR_SILVA_API_KEY or JS_IDENTITY_SECRET")
    if not stack.data_root or not Path(stack.data_root).exists():
        problems.append("the bridge's data folder wasn't found")
    if stack.slots < max(levels):
        problems.append(f"JS_SLOTS is {stack.slots}, below the highest level, {max(levels)}: set JS_SLOTS in .env, then docker compose up -d")
    elif stack.slot_networks() < stack.slots:
        problems.append(f"the bridge is on {stack.slot_networks()} of its {stack.slots} slot networks: wait a minute for the runner, then try again")
    if docker("ps", "-q", "--filter", "label=js.run=1"):
        problems.append("a Pi run is going: someone is using the stack")
    if free_mib() < args.min_free_mib:
        problems.append(f"only {free_mib()} MiB of RAM free, need {args.min_free_mib}")
    if stack.data_root and disk_free_mib("/", stack.data_root) < args.min_disk_mib:
        problems.append(f"only {disk_free_mib('/', stack.data_root)} MiB of disk free, need {args.min_disk_mib}")
    if load_now() >= (os.cpu_count() or 1):
        problems.append(f"the CPU load is {load_now()} on {os.cpu_count()} CPUs")
    if args.stop_file.exists():
        problems.append(f"remove the stop file first: {args.stop_file}")
    if not cgroup_of(BRIDGE):
        problems.append("the bridge's memory can't be read from /sys/fs/cgroup (cgroup v2 needed)")
    return problems


def on_signal(*_):
    interrupted.set()


def main():
    parser = argparse.ArgumentParser(description="Load test for Junior Silva V2 (task/deployment/plan.md, M10). Read the top of this file first.")
    parser.add_argument("--yes", action="store_true", help="send real workflows: it costs money, and nobody may use the stack meanwhile")
    parser.add_argument("--check-only", action="store_true", help="only the checks before starting, and 10 seconds of sampling")
    parser.add_argument("--cleanup", metavar="FOLDER", help="remove the test users listed in a results folder")
    parser.add_argument("--levels", default="1,2,3,5,7,10", help="workflows at once, in order; 1 is the baseline (default 1,2,3,5,7,10)")
    parser.add_argument("--baseline-runs", type=int, default=3, help="level 1 runs this many workflows one after another (default 3)")
    parser.add_argument("--idle", type=int, default=120, help="seconds of idle measuring first (default 120)")
    parser.add_argument("--recovery", type=int, default=180, help="seconds of watching memory recovery after each level (default 180)")
    parser.add_argument("--min-free-mib", type=int, default=2048, help="free RAM needed before a level starts (default 2048)")
    parser.add_argument("--abort-free-mib", type=int, default=1024, help="a level stops if free RAM falls under this (default 1024)")
    parser.add_argument("--min-disk-mib", type=int, default=3072, help="free disk needed before a level starts (default 3072)")
    parser.add_argument("--out", type=Path, help="results folder (default ../js-load-<time>)")
    parser.add_argument("--stop-file", type=Path, default=PI_DIR.parent / "js-load-test.stop", help="create this file to stop early (default ../js-load-test.stop)")
    args = parser.parse_args()

    stack = Stack()
    if args.cleanup:
        pairs = test_pairs(args.cleanup)
        secret = env_setting("JS_IDENTITY_SECRET")
        if not pairs or not secret or not stack.data_root:
            say("FAIL  nothing to clean up: no test users listed there, or no JS_IDENTITY_SECRET in .env, or no data folder")
            return 1
        left = remove_test_data(stack.data_root, secret, pairs)
        say(f"{'PASS' if not left else 'FAIL'}  {len(pairs)} test chat(s): {left} folder(s) or audit file(s) still there")
        return 0 if not left else 1

    try:
        levels = [int(level) for level in args.levels.split(",") if level.strip()]
    except ValueError:
        parser.error("--levels must be whole numbers, such as 1,2,3,5,7,10")
    if not levels or min(levels) < 1 or max(levels) > 254 or levels != sorted(set(levels)):
        parser.error("--levels must rise, from 1 to 254, such as 1,2,3,5,7,10")
    if args.baseline_runs < 1:
        parser.error("--baseline-runs must be at least 1")
    if not args.yes and not args.check_only:
        print("This sends real workflows to the running stack, at up to the highest level at once. Each one costs money.")
        print("Run it only when nobody is using the stack, in the background:")
        print("    nohup scripts/js-load-test.py --yes > ../js-load-test.log 2>&1 &")
        print("    tail -f ../js-load-test.log")
        print("Checks only, no workflows: scripts/js-load-test.py --check-only --levels " + args.levels)
        return 2

    problems = preflight(stack, args, levels)
    for problem in problems:
        say(f"STOP  {problem}")
    if problems:
        return 1
    say(f"PASS  ready: bridge healthy, {stack.slots} slots, model {stack.settings.get('PI_PROVIDER', '?')} {stack.settings.get('PI_MODEL', '?')}, {free_mib()} MiB RAM free, load {load_now()} on {os.cpu_count()} CPUs, no Pi run going")

    if args.check_only:
        folder = Path(os.environ.get("TMPDIR", "/tmp")) / f"js-load-check-{secrets.token_hex(4)}"
        folder.mkdir(mode=0o700)
        sampler = Sampler(folder / "samples.csv")
        sampler.phase = "check"
        sampler.start()
        time.sleep(10)
        sampler.halt.set()
        sampler.join(10)
        rows = sampler.rows_in("check")
        shutil.rmtree(folder, ignore_errors=True)
        if not rows:
            say("FAIL  no samples were taken")
            return 1
        last = rows[-1]
        say(f"PASS  sampling works: {len(rows)} samples; RAM used {last['host_used_mib']} MiB, free {last['host_free_mib']} MiB, swap {last['swap_used_mib']} MiB, CPU busy {last['cpu_busy_pct']} %, bridge {last['bridge_mem_mib']} MiB, runner {last['runner_mem_mib']} MiB, other containers {last['others_mem_mib']} MiB, gVisor processes {last['gvisor_processes']}")
        return 0

    out = args.out or PI_DIR.parent / f"js-load-{time.strftime('%Y%m%d-%H%M%S')}"
    out.mkdir(mode=0o700, parents=True, exist_ok=False)
    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    test = LoadTest(args, stack, out)
    try:
        test.run(levels)
    finally:
        test.clean_up()
    say(f"INFO  done. Results: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
