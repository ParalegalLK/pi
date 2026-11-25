# Deploying Junior Silva 2 on a new server

A step-by-step guide for putting **Junior Silva 2** (the isolated Pi agent) on a new Linux server. **LibreChat runs on another server** and reaches it over HTTPS.

> **Rules while you work**
> - Never paste a key, secret or `.env` value into chat, a ticket or a document. Edit `.env` on the server only.
> - Most steps only read. The ones that change something are marked **(changes)**.
> - Run everything as your normal user (not root), from `~/app/junior-silva-v2`, unless a step says otherwise.

---

## 1. The picture

```text
 Browser ──HTTPS──► LibreChat (its own server)
                        │  /junior-silva-v2/v1/chat/completions
                        │  (the bridge key + the user and chat ID headers)
                        ▼
 NEW SERVER: reverse proxy (HTTPS, port 443)
                        │
                        ▼
              bridge  127.0.0.1:8132  ── runner ── one Pi container per message
                        │                          (gVisor, its own network, only its chat's files)
                        └──HTTPS──► Gemini / Anthropic, RAG, translator, web search

 Browser ──HTTPS──► NEW SERVER: /junior-silva-v2/files/ (download links) ──► bridge
```

- **The parts:**
  - **The bridge** (`junior-silva-v2`) receives LibreChat's requests and holds the model keys.
  - **The runner** (`junior-silva-runner`) starts one gVisor container per message.
  - **Each Pi container** sees only its own chat's folder and has no internet. Its model calls go through the bridge's model proxy.
- **Only the reverse proxy faces the internet.** Never publish:
  - 8126, the bridge itself, which is published only as `127.0.0.1:8132`;
  - 8127, the tool gateway;
  - 8128, the runner.

## 2. What you need from the team first

| Item | Notes |
|---|---|
| **SSH access** | A normal user in the `docker` group. User id **1000** is easiest: the bridge and Pi run as user 1000 |
| **GitHub access** | To `ParalegalLK/pi` |
| **A DNS name with HTTPS** | For this server, written below as `<server-name>`, with a reverse proxy: OpenResty or nginx |
| **Model keys** | `GEMINI_API_KEY` on a paid, billing-enabled project. `ANTHROPIC_API_KEY` too, if Claude models are allowed |
| **Service addresses and keys** | RAG (an HTTPS address this server can reach, plus its key), translator, web search (Serper). Optional: Typesense and Lex keys |
| **The drafting precedents folder** | Copied from the team, and mounted read-only |
| **Decisions** | Which models to allow, the default model, how many slots (Pi runs at once), and LibreChat's public address |

## 3. Check the server (read-only)

Run these and keep the output. Nothing here changes the server.

| Need | Command | Good result |
|---|---|---|
| CPU type | `uname -m` | `x86_64` (tested) |
| OS and kernel | `. /etc/os-release; echo "$PRETTY_NAME"; uname -r` | Ubuntu 24.04 tested |
| Docker 28 or newer, Compose v2, cgroup v2 | `docker version --format '{{.Server.Version}}'; docker compose version; docker info --format '{{.CgroupVersion}} {{.CgroupDriver}}'` | Server 28+, Compose v2+, `2 systemd` |
| gVisor already installed? | `docker info --format '{{json .Runtimes}}'` | If `runsc` is missing, step 5 installs it |
| Memory | `free -h` | About 2 GiB for the base. Each running Pi can use up to 2 GiB and 2 CPUs; start with 2 slots |
| Disk | `df -h /` | 20 GB or more free. The images are about 9 GB, plus build space |
| Network range for the slots | `ip -4 route \| grep '^10\.89\.' \|\| echo free` | `free`. The slots use `10.89.0.0/16` |
| Your user id, and the Docker group number | `id -u; getent group docker \| cut -d: -f3` | uid `1000`. Note the group number for `.env` |
| Open ports and firewall | `sudo ss -ltnp; sudo ufw status` | Only 22, 80 and 443 open to the internet |
| Web server | `systemctl is-active openresty nginx` | One of them active |
| What else runs here | `docker ps --format '{{.Names}} {{.Image}} {{.Ports}}'` | Note it, and don't disturb it |
| Tools the checks need | `which python3 curl ss` | All 3 found |

**Shortcut:** after step 4, `bash scripts/js-host-check.sh` prints all of these facts in one go, and changes nothing.

## 4. Get the code (changes)

```bash
mkdir -p ~/app && cd ~/app
git clone git@github.com:ParalegalLK/pi.git junior-silva-v2
cd junior-silva-v2
git switch feat/pi-model-picker
git log --oneline -1
```

The last line should show `3de9340bb`, or a newer commit the team tells you.

## 5. Install gVisor (changes)

```bash
sudo bash scripts/js-install-gvisor.sh 20261026.0
docker info --format '{{json .Runtimes}}' | grep -o runsc
```

- **The script:**
  - installs the pinned gVisor release, checking its checksum;
  - **backs up** `/etc/docker/daemon.json` if one exists;
  - registers `runsc`;
  - **reloads** Docker. A reload doesn't restart Docker, so running containers keep going.
- **It must end with** `PASS: every container has the same start time and restart count as before`.
- **The last command must print** `runsc`.
- **If it says** "runsc is not registered after the reload", stop and ask the team. A Docker **restart** would stop every container on the server.

## 6. Folders and networks (changes)

```bash
mkdir -p -m 700 ~/app/js-data
ls -ldn ~/app/js-data
docker network create librechat_default
docker network create rag-chat-server_default
```

- **The data folder** holds every chat's files.
  - It must be **mode 700 and owned by user 1000**. `ls -ldn` should show `drwx------` and `1000`.
  - If your uid isn't 1000, run `sudo chown 1000:1000 ~/app/js-data`.
- **The precedents:** copy the team's drafting-precedents folder to `~/app/clean-kb`. It's mounted read-only.
- **The networks** must be normal networks, not `--internal`: they're the bridge's route to the internet. The setup script in step 8 creates them too, if they're missing.

## 7. Settings: `.env` (changes)

```bash
cp .env.example .env
chmod 600 .env
for i in 1 2 3 4; do openssl rand -hex 32; done
```

- **The last command** prints 4 new random secrets. Paste them straight into `.env` with an editor (`nano .env`), and nowhere else.
- **Fill in these settings.** `.env.example` explains each one.

| Setting | What to put |
|---|---|
| `PI_PROVIDER`, `PI_MODEL`, `PI_THINKING` | The default, used when a message picks nothing: `google`, `gemini-3.8-flash`, `medium` |
| `JS_ALLOWED_MODELS` | The models users may pick, for example `google/gemini-3.8-flash,anthropic/claude-opus-5-5`. It must include the default. Each model needs its provider's key |
| `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | From the team. Anthropic only if a Claude model is allowed |
| `JUNIOR_SILVA_API_KEY` | **New secret 1.** The bridge key. LibreChat gets the same value. Treat it like a password to every chat |
| `JS_IDENTITY_SECRET` | **New secret 2.** Chat folder names come from it. **Never change it after go-live,** or chats lose their files |
| `JUNIOR_SILVA_ARTIFACT_SECRET` | **New secret 3.** Signs download links |
| `JS_RUNNER_SECRET` | **New secret 4** |
| `JUNIOR_SILVA_MODEL_NAME` | `junior-silva-2`, the name LibreChat uses |
| `JUNIOR_SILVA_PUBLIC_URL` | `https://<server-name>/junior-silva-v2`, used for download links |
| `JUNIOR_SILVA_ATTACHMENT_ORIGINS` | LibreChat's public address(es), comma-separated |
| `JS_HOST_DATA_ROOT` | The full path of `~/app/js-data`, for example `/home/<user>/app/js-data` |
| `JS_DOCKER_GID` | The Docker group number from step 3 |
| `JS_SLOTS` | `2` to start. Raise it only after a load test (`scripts/js-load-test.py`) |
| `JUNIOR_SILVA_KB_HOST_PATH` | The full path of `~/app/clean-kb` |
| `JUNIOR_SILVA_DOCKER_RAG_BASE_URL`, `RAG_API_KEY` | The RAG address this server can reach, and its key. The default is a container name that only exists on the dev server |
| `TRANSLATOR_BASE_URL`, `TRANSLATOR_API_KEY` | From the team |
| `WEB_SEARCH_ENABLED`, `WEB_SEARCH_API_KEY` | `true` plus a Serper key, or leave it `false` |
| `WEB_SCRAPER_ENABLED` | `false`. There's no scraper yet |
| `JUNIOR_TYPESENSE_*`, `JUNIOR_LEX_*` | Optional, from the team |

**Check that no setting is set twice** (this prints only names):
```bash
grep -oE '^[A-Z_]+=' .env | sort | uniq -d
```
It should print nothing.

## 8. Build and start (changes)

The first build takes about **45 minutes**. Run it in the background, so a dropped SSH session doesn't stop it:

```bash
nohup bash setup-junior-silva-v2.sh --mode docker > ~/app/js-setup.log 2>&1 &
tail -f ~/app/js-setup.log
```

- **What the script does:**
  1. checks Compose, gVisor, the data folder and the Docker group;
  2. creates any missing networks;
  3. builds the 3 images: bridge, runner and Pi;
  4. starts the stack.
- **The ending to look for:** the `docker compose ps` table at the end.
- **Ctrl+C** on `tail` only stops the watching; the setup keeps running.

**Check it,** about 15 seconds after the start:
```bash
docker compose ps
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8132/health
K=$(grep '^JUNIOR_SILVA_API_KEY=' .env | cut -d= -f2-); curl -s -H "Authorization: Bearer $K" http://127.0.0.1:8132/v1/pi/models; echo; unset K
```

- **Expect:**
  - `junior-silva-v2` and `junior-silva-runner` are `Up (healthy)`;
  - health is `200`;
  - the allowed models are listed with their effort levels. The key is read from `.env` and never printed.
- **Health `000` straight after the start** is normal. Wait a few seconds and try again.
- **If the bridge keeps restarting,** run `docker compose logs junior-silva-v2 --tail 30`. The start check says what's wrong (see section 14).
- **If the server is short of memory for the build:** build on another x86_64 machine. Then `docker save junior-silva-v2:local junior-silva-runner:local junior-silva-pi:local | gzip > js-images.tgz`, copy the file over, and `gunzip -c js-images.tgz | docker load`. Then run `bash setup-junior-silva-v2.sh --mode docker --skip-build`.

## 9. Prove it

**a. gVisor works for our workload.** This is gentle mode, safe on a server with other services:
```bash
JS_SPIKE_LIVE=1 scripts/js-spike.sh
```
Look at the summary at the end. Everything it creates is removed when it finishes.

**b. The isolation check** attacks the walls between users and must show **`failures: 0`**.
- It takes about 10 minutes.
- Chats can't be answered while it runs, so run it when nobody is using the service.
- Always run it in the background:
```bash
nohup scripts/js-isolation-check.sh --yes > ~/app/js-isolation-check.log 2>&1 &
tail -f ~/app/js-isolation-check.log
```
- **Never Ctrl+C the check itself.** It could stop while putting the bridge back, leaving it under a temporary name.
- **If that happens:**
  ```bash
  docker ps -a --format '{{.Names}}' | grep '_junior-silva-v2$'
  docker rm -f <that-name>
  docker compose up -d
  ```

**c. One real chat, sent the way LibreChat sends it.** It uses a made-up test user and chat:
```bash
K=$(grep '^JUNIOR_SILVA_API_KEY=' .env | cut -d= -f2-)
curl -sN http://127.0.0.1:8132/v1/chat/completions \
  -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
  -H 'X-LibreChat-User-Id: 0123456789abcdef01234567' \
  -H 'X-LibreChat-Conversation-Id: deploy-test-0001' \
  -d '{"model":"junior-silva-2","stream":true,"messages":[{"role":"user","content":"In one paragraph, what is a lease under Sri Lankan law?"}]}' | tail -n 5
unset K
```
- It should end with `data: [DONE]`.
- **The user ID** must be 24 hex characters. **The chat ID** must be 8 to 128 letters, digits, `-` or `_`.

## 10. The reverse-proxy route (changes)

LibreChat calls `/junior-silva-v2/v1/`, and browsers download from `/junior-silva-v2/files/`.

**1. Create `/etc/openresty/junior-silva-v2.locations`.** For nginx, use its own conf folder.

```nginx
# Download links. Public: each link is signed and expires.
location ^~ /junior-silva-v2/files/ {
    proxy_pass http://127.0.0.1:8132/files/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}

# The API for LibreChat. The bridge key is its lock.
location ^~ /junior-silva-v2/v1/ {
    # The bridge's own upload limit (JUNIOR_SILVA_MAX_BODY_BYTES, 60 MB).
    client_max_body_size 60m;
    proxy_pass http://127.0.0.1:8132/v1/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Answers stream as they come. The bridge sends a keep-alive every 15 s.
    proxy_buffering off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}
```

**2. Include it, test, reload.**
- **Back up the site file first:** `sudo cp -p <site-file> <site-file>.before-junior-silva-v2.$(date +%F-%H%M%S).bak`.
- **Add the include** inside the site's `server { listen 443 ... }` block:
  ```nginx
  include /etc/openresty/junior-silva-v2.locations;
  ```
- **Test and reload:**
  ```bash
  sudo openresty -t && sudo systemctl reload openresty     # for nginx: sudo nginx -t && sudo systemctl reload nginx
  ```

**3. Check from outside the server,** from your laptop:
```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<server-name>/junior-silva-v2/v1/models
curl -s -o /dev/null -w '%{http_code}\n' https://<server-name>/junior-silva-v2/files/not-a-real-link
```
- Expect `401`: there's no key on the first call.
- Expect `404`: the second link doesn't exist.
- **Ports 8126, 8127, 8128 and 8132** must not answer from the internet.

**If Cloudflare is in front:**
- Use SSL mode **"Full (strict)"**.
- Uploads up to 100 MB pass on the Free and Pro plans.
- Long answers are fine: the bridge's 15-second keep-alives stay inside Cloudflare's 100-second limit.

## 11. Connect LibreChat (on LibreChat's server) (changes)

**1. Back up first:**
```bash
cp -p librechat.yaml librechat.yaml.before-junior-silva-2.$(date +%F-%H%M%S).bak
cp -p .env .env.before-junior-silva-2.$(date +%F-%H%M%S).bak
```

**2. In `librechat.yaml`, under `endpoints: custom:`**, add this endpoint:
```yaml
    - name: "junior-silva-v2"
      # The model and effort picker: only if this LibreChat has the picker code
      # (LibreChat branch feat/pi-model-picker). Otherwise leave these 4 lines out.
      piModelPicker: true
      piDefaultModel: "google/gemini-3.8-flash"
      piDefaultEffort: "medium"
      piAllowedModels: "${JUNIOR_SILVA_ALLOWED_MODELS}"
      apiKey: "${JUNIOR_SILVA_V2_API_KEY}"
      baseURL: "https://<server-name>/junior-silva-v2/v1"
      addParams:
        streamUsage: true
        stream_options:
          include_usage: true
      headers:
        X-LibreChat-Conversation-Id: "{{LIBRECHAT_BODY_CONVERSATIONID}}"
        X-LibreChat-User-Id: "{{LIBRECHAT_USER_ID}}"
      models:
        default: ["junior-silva-2"]
        fetch: false
      titleConvo: true
      titleModel: "gpt-4o-mini"
      titleEndpoint: "openAI"
      summarize: false
      modelDisplayLabel: "Junior Silva 2"
```
- **The 2 headers are required.** The bridge refuses any request without a real user and chat ID, so chats can never land in a shared folder.
- **File uploads:** under `fileConfig: endpoints:`, give `junior-silva-v2` its limits, for example `fileLimit: 20` and `fileSizeLimit: 50`.

**3. In LibreChat's `.env`:**
```bash
printf '\nJUNIOR_SILVA_V2_API_KEY=<the bridge key>\nJUNIOR_SILVA_ALLOWED_MODELS=<the same list as JS_ALLOWED_MODELS>\n' >> .env
```
- Type the real key in place of `<the bridge key>` on the server. Never paste it anywhere else.
- `JUNIOR_SILVA_ALLOWED_MODELS` **must be set if the picker is on.** LibreChat checks every message against it, and refuses all messages if it's missing.

**4. Apply:**
```bash
./scripts/flush-config-cache.sh
docker compose up -d --no-deps api
```
- **Never use `redis-cli FLUSHALL`.** It signs every user out.
- **The `api` container must be recreated,** not just restarted, because a `.env` change needs a recreate.
- **If the recreate fails** with `could not parse extra host IP`, that server's Docker can't fill in `host-gateway`. Change `host-gateway` to `172.17.0.1` in the `extra_hosts` line of LibreChat's `docker-compose.yml`, after a backup.

**5. Test in the browser:**
1. Pick **Junior Silva 2** and ask a short legal question. It should be answered.
2. Upload a PDF and ask about it.
3. Ask for a Word document. Its download link should work.
4. Press **Stop** during an answer, then carry on chatting.
5. With the picker on: the **gauge** shows each allowed model, with its own effort levels.
6. **On the new server,** check that the chosen model and level were used:
   ```bash
   docker exec junior-silva-v2 sh -c 'cat /data/audit/*.jsonl' | grep '"type":"run"' | tail -n 3
   ```

## 12. Day 2: watching, updating, rolling back

**Watching:**
```bash
docker compose ps
docker compose logs junior-silva-v2 --tail 50
docker stats --no-stream
free -h; df -h /; du -sh ~/app/js-data
```

**Updating the code:**
```bash
cd ~/app/junior-silva-v2
cp -p .env .env.before-update.$(date +%F-%H%M%S).bak
git pull --ff-only
git log --oneline -1
docker compose build junior-silva-v2
docker compose up -d
```
- **If the update changed more than the bridge** (`packages/`, `scripts/`, the `Dockerfile`), rebuild everything instead: `bash setup-junior-silva-v2.sh --mode docker`, in the background as in step 8.
- **Run the isolation check again** after every update (step 9b).

**Rolling back:**
1. `git switch <previous-branch-or-commit>`
2. Rebuild as above.
3. `docker compose up -d`
4. If `.env` changed, put back its `.bak` copy.

**Never:**
- `docker compose down -v`: it deletes data;
- publishing 8126, 8127 or 8128;
- changing `JS_IDENTITY_SECRET` after go-live;
- loosening `.env` (keep it at mode 600);
- running the bridge with `JS_PI_EXECUTOR=local` on a server.

## 13. Known limits of this version

| Limit | What it means today |
|---|---|
| No answer filter | An image link in an answer could leak that chat's text through the user's browser. Test data only until it's added |
| No safe document fetch | Pi has no internet, so research that downloads official PDFs fails. Research through RAG works |
| No disk watchdog | A tricked Pi could fill the disk. Watch `df -h /` |
| No per-run budget | Watch model usage and cost |
| Files over about 44 MB | They fail: uploads arrive base64-encoded, and the bridge takes at most 60 MB per request |
| No web scraper | Web search returns titles, links and short snippets only |

## 14. Troubleshooting

| What you see | What it means and what to do |
|---|---|
| Health `000` right after `docker compose up -d` | The bridge is still starting. Wait about 15 seconds |
| The bridge keeps restarting | Read `docker compose logs junior-silva-v2 --tail 30`. The start check names the problem, for example: |
| … "`<model>` isn't in Pi's model catalog in this image" | Remove that model from `JS_ALLOWED_MODELS`. Or rebuild all 3 images without the cache, so they get today's model list (about 45 minutes): `docker compose build --no-cache junior-silva-v2 junior-silva-runner junior-silva-pi`, then `docker compose up -d` |
| … "`GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`) is not configured in .env" | An allowed model needs its provider's key in `.env` |
| … "PI_PROVIDER and PI_MODEL … so JS_ALLOWED_MODELS must include them" | Add the default model to `JS_ALLOWED_MODELS` |
| The setup script says "Docker has no gVisor runtime (runsc)" | Redo step 5 |
| The setup script says "The data folder … must be owned by user 1000" | `sudo chown -R 1000:1000 ~/app/js-data` |
| The answer is "Junior Silva is busy with other requests right now…" | All slots were taken for 5 minutes (`JS_SLOT_WAIT_MS`). Wait, or raise `JS_SLOTS` if memory allows |
| LibreChat: "Selected Pi model is not allowed for this endpoint" | `JUNIOR_SILVA_ALLOWED_MODELS` is missing from LibreChat's `.env`, or doesn't include the chosen or default model. Fix it, then recreate `api` |
| LibreChat's picker says "Pi models unavailable" | LibreChat can't reach `/junior-silva-v2/v1/pi/models`. Check the route, the key and the bridge |
| `/v1` from outside returns `401` even with LibreChat | LibreChat's `JUNIOR_SILVA_V2_API_KEY` doesn't match the bridge's `JUNIOR_SILVA_API_KEY` |
| A download link returns `404` | The link is wrong or has expired (7 days by default). Check `JUNIOR_SILVA_PUBLIC_URL` |
