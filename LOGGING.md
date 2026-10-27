# Junior Silva V2 local trace logs

Junior Silva writes one structured trace for each OpenAI-compatible request and each direct Pi CLI turn. It does not send traces to MongoDB or to any external logging service.

## Location

The default location is `junior-silva/logs/traces/<UTC-date>/<request-id>/` in a native checkout. Docker mounts the same host directory at `/data/logs`, so traces survive a container recreation.

Set these optional `.env` values to control logging:

```dotenv
JUNIOR_SILVA_TRACE_LOGS=true
JUNIOR_SILVA_LOG_ROOT=
JUNIOR_SILVA_LOG_MAX_VALUE_BYTES=262144
```

Set `JUNIOR_SILVA_TRACE_LOGS=false` to disable new traces. Set `JUNIOR_SILVA_LOG_ROOT` to an absolute writable path only when the default path is unsuitable.

## Files per request

- `trace.json` is the current structured summary, written when the request completes or fails.
- `events.jsonl` is an append-only chronological event stream for progressive inspection.

`trace.json` contains:

- request, Pi session and conversation identifiers; start/end time, outcome and elapsed time;
- original user query and attachment metadata (original name, stored path, size, checksum, and whether it was newly supplied on that turn);
- every Pi model response with provider, model, stop reason and token usage when Pi supplies it;
- every tool call in order, including its arguments, progress updates, result, status, duration and produced artifact references;
- final response, OpenAI-compatible token usage, delivered artifacts and requested LibreChat previews.

Large strings are capped at `JUNIOR_SILVA_LOG_MAX_VALUE_BYTES` and recorded with their original byte count and SHA-256. Credential-shaped fields, configured secret values, Bearer-style values and sensitive URL query parameters are replaced with `[REDACTED]` before writing either file.

## Inspecting a recent Docker trace

```bash
cd ~/app/junior-silva-v2
find junior-silva/logs/traces -name trace.json -printf '%T@ %p\n' | sort -nr | head

# Replace the path with one from the previous command.
jq '.' junior-silva/logs/traces/2026-10-27/chatcmpl-.../trace.json
tail -f junior-silva/logs/traces/2026-10-27/chatcmpl-.../events.jsonl
```

## Viewing local traces

`D:\Intern\Work\logs server` includes a read-only file adapter for Junior Silva traces. It scans the local checkout recursively at:

```text
D:\Intern\Work\Junior Silva V2\pi\junior-silva\logs\traces
```

Open the local viewer at [http://localhost:3002/chatlogs](http://localhost:3002/chatlogs). It groups all turns with the same Junior Silva `conversation_key` into one session, so an initial review request, a clarification checkpoint, a reply such as `review normally`, and later supporting uploads appear in chronological order in one record.

The **Tools used** section is expandable and contains the redacted request, progress updates, result, duration and artifact references for each tool call. Rag Chat records continue to appear as their existing individual records.

## Importing deployed-server traces into the local viewer

Server traces use the identical schema. Export them from the Docker container, copy them into a dated subdirectory beneath the local trace root, then refresh the viewer. The reader scans recursively, so no code or configuration change is required.

### 1. Export a dated copy on the server

Run this on `chat-dev` after the relevant Junior Silva requests have completed:

```bash
cd ~/app/junior-silva-v2
export JS_TRACE_EXPORT="$HOME/junior-silva-v2-traces-$(date +%F-%H%M%S)"
mkdir -p "$JS_TRACE_EXPORT"
docker cp junior-silva-v2:/data/logs/traces/. "$JS_TRACE_EXPORT/"

find "$JS_TRACE_EXPORT" -name trace.json | wc -l
printf 'Export directory: %s\n' "$JS_TRACE_EXPORT"
```

`docker cp` copies the container's persistent `/data/logs/traces` tree without modifying it. Keep the printed export directory for the next step.

### 2. Copy it to the Windows development machine

In Windows PowerShell, replace the timestamp in `$serverExport` with the directory printed by the server command:

```powershell
$serverExport = '~/junior-silva-v2-traces-2026-10-27-153000'
$localImport = "D:\Intern\Work\Junior Silva V2\pi\junior-silva\logs\traces\server-chat-dev-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

New-Item -ItemType Directory -Force -Path $localImport | Out-Null
scp -r "paralegaluser@chat-dev:$serverExport/." $localImport
Get-ChildItem -Recurse -File $localImport -Filter trace.json | Measure-Object
```

This creates an import folder rather than merging files into the native local traces. It is safe to repeat for later server exports and makes the provenance of imported traces clear.

### 3. View the imported sessions

1. Ensure the local file-backed logs API and viewer are running.
2. Refresh [http://localhost:3002/chatlogs](http://localhost:3002/chatlogs).
3. Server sessions appear alongside local sessions. Select one to see its turns, **Tools used**, token totals, artifacts and redacted technical trace.

The reader loads files on each API request. A viewer/API restart is not required after a new import; refresh the browser instead.

## Handling

Trace files can contain user legal documents, queries and tool results. Restrict filesystem access, keep the directory out of Git, and set an operational retention policy before production use.
