#!/usr/bin/env bash
#
# One command, from a clean clone to a running operator console.
#
#   ./run.sh              set up whatever is missing, then open the console
#   ./run.sh setup        set up and stop; print what to run next
#   ./run.sh check        report what is and is not ready, change nothing
#   ./run.sh stop         stop the target application (state is kept)
#   ./run.sh reset        destroy and rebuild the target's database
#   ./run.sh clean        remove everything this script created
#
# Every step is skipped when it is already done, so re-running is cheap and safe.
# Nothing here is required to understand the project — the README spells out each
# step by hand for anyone who would rather see them.

set -euo pipefail

cd "$(dirname "$0")"

readonly APP_DIR="ParaBank-Mock-app"
readonly IMAGE="parabank-local"
readonly CONTAINER="parabank"
readonly PORT="8080"
readonly URL="http://localhost:${PORT}/parabank/index.htm"
readonly MIN_NODE_MAJOR=22

# Colour only when a terminal is watching; piping this to a file should give plain text.
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

step()  { printf '\n%s==>%s %s\n' "$BOLD" "$RESET" "$1"; }
ok()    { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
skip()  { printf '    %s·%s %s\n' "$DIM" "$RESET" "$1"; }
warn()  { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die()   { printf '\n%serror:%s %s\n\n' "$RED" "$RESET" "$1" >&2; exit 1; }

# --- prerequisites ---------------------------------------------------------

check_node() {
  command -v node >/dev/null 2>&1 || die "node is not installed. Node >= ${MIN_NODE_MAJOR}.6 is required."
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    die "node $(node -v) is too old; >= ${MIN_NODE_MAJOR}.6 is required (process.loadEnvFile and the type-stripping test runner)."
  fi
  ok "node $(node -v)"
}

check_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed. It builds and runs the target application; nothing is installed on the host."
  if ! docker info >/dev/null 2>&1; then
    die "docker is installed but not responding. Start the daemon, or add yourself to the docker group and log in again."
  fi
  ok "docker ready"
}

# --- this project ----------------------------------------------------------

install_deps() {
  # npm records the resolved tree in node_modules/.package-lock.json. If the manifest
  # is no newer than that, the tree is current. Comparing against node_modules itself
  # does not work: npm touches both, so their timestamps match and a strict "older
  # than" test is false — which quietly reinstalled on every run.
  if [ -f node_modules/.package-lock.json ] && [ ! package-lock.json -nt node_modules/.package-lock.json ]; then
    skip "dependencies already installed"
  else
    npm install --silent
    ok "dependencies installed"
  fi
}

browser_present() {
  # Playwright keeps browsers in ~/.cache, so node_modules says nothing about whether
  # one is there. `install --dry-run` prints where a browser *would* go whether or not
  # it exists, so grepping its output proves nothing; ask for the path and look.
  node -e '
    const { existsSync } = require("node:fs");
    try { process.exit(existsSync(require("playwright").chromium.executablePath()) ? 0 : 1); }
    catch { process.exit(1); }
  ' 2>/dev/null
}

install_browser() {
  if browser_present; then
    skip "chromium already installed"
    return
  fi
  echo "    downloading chromium, first time only"
  npx --yes playwright install chromium >/dev/null
  browser_present || die "playwright reported success but no chromium is present at its expected path."
  ok "chromium installed"
}

write_env() {
  if [ -f .env ]; then
    skip ".env exists (left alone)"
  else
    cp .env.example .env
    ok ".env created from .env.example"
  fi

  # Sourcing would execute the file; read the two keys we care about instead.
  local user pass key
  user="$(grep -E '^OPERATOR_USERNAME=' .env | cut -d= -f2- || true)"
  pass="$(grep -E '^OPERATOR_PASSWORD=' .env | cut -d= -f2- || true)"
  key="$(grep -E '^LLM_API_KEY=' .env | cut -d= -f2- || true)"

  if [ -z "$user" ] || [ -z "$pass" ]; then
    warn "OPERATOR_USERNAME / OPERATOR_PASSWORD are empty in .env — replay will not sign in."
  fi
  if [ -z "$key" ]; then
    warn "LLM_API_KEY is empty in .env — everything works except 'discover', which is the"
    warn "  one thing that needs a model. Replay costs nothing per run, by design."
  fi
}

# --- the target application ------------------------------------------------

build_war() {
  if [ -f "${APP_DIR}/target/parabank.war" ]; then
    skip "parabank.war already built"
    return
  fi
  step "Building ParaBank (Maven runs in a container; no JDK on the host)"
  echo "    first time only, a few minutes"
  docker run --rm -u "$(id -u):$(id -g)" \
    -v "$PWD/${APP_DIR}":/app -v "$PWD/${APP_DIR}/.m2":/var/maven/.m2 -w /app \
    -e MAVEN_CONFIG=/var/maven/.m2 \
    maven:3.9-eclipse-temurin-21 \
    mvn -q -Duser.home=/var/maven clean package -DskipTests
  [ -f "${APP_DIR}/target/parabank.war" ] || die "the Maven build finished but produced no parabank.war."
  ok "parabank.war built"
}

build_image() {
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    skip "image ${IMAGE} exists"
    return
  fi
  docker build -q -t "$IMAGE" "$APP_DIR" >/dev/null
  ok "image ${IMAGE} built"
}

container_state() {
  # `docker inspect` on a missing container writes its error to stderr AND a bare
  # newline to stdout, so the obvious `... || echo absent` yields "\nabsent", which
  # matches no case arm and sent a first-time setup down the "start it" path.
  local state
  state="$(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null | tr -d '[:space:]')"
  echo "${state:-absent}"
}

start_container() {
  case "$(container_state)" in
    running) skip "container ${CONTAINER} already running" ;;
    absent)
      docker run -d --name "$CONTAINER" -p "${PORT}:8080" "$IMAGE" >/dev/null
      ok "container ${CONTAINER} created"
      ;;
    *)
      docker start "$CONTAINER" >/dev/null
      ok "container ${CONTAINER} started"
      ;;
  esac
}

is_up() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$URL" 2>/dev/null)" = "200" ]
}

wait_for_app() {
  if is_up; then ok "ParaBank answering at ${URL}"; return; fi
  printf '    waiting for ParaBank'
  # Tomcat plus a first-request database build. Slow on a cold container, fast after.
  local waited=0
  while [ "$waited" -lt 180 ]; do
    if is_up; then printf '\n'; ok "ParaBank answering at ${URL}"; return; fi
    printf '.'
    sleep 3
    waited=$((waited + 3))
  done
  printf '\n'
  die "ParaBank did not answer within 3 minutes. Logs: docker logs ${CONTAINER}"
}

# --- commands --------------------------------------------------------------

do_check() {
  step "Checking"
  check_node
  check_docker
  [ -d node_modules ] && ok "dependencies installed" || warn "dependencies not installed"
  [ -f .env ] && ok ".env present" || warn ".env missing"
  [ -f "${APP_DIR}/target/parabank.war" ] && ok "parabank.war built" || warn "parabank.war not built"
  docker image inspect "$IMAGE" >/dev/null 2>&1 && ok "image built" || warn "image not built"
  printf '    container: %s\n' "$(container_state)"
  is_up && ok "ParaBank answering" || warn "ParaBank not answering"
  printf '\n    capabilities:\n'
  npm run --silent cua -- list 2>/dev/null | sed 's/^/      /' || warn "could not list capabilities"
}

do_setup() {
  step "Prerequisites"
  check_node
  check_docker

  step "Project"
  install_deps
  install_browser
  write_env

  build_war

  step "Target application"
  build_image
  start_container
  wait_for_app
}

do_stop() {
  step "Stopping"
  if [ "$(container_state)" = "running" ]; then
    docker stop "$CONTAINER" >/dev/null
    ok "container stopped (its data is kept; ./run.sh starts it again)"
  else
    skip "not running"
  fi
}

do_reset() {
  step "Resetting the target's database"
  echo "    Two capabilities move money, so balances drift as you use them."
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  ok "container removed"
  start_container
  wait_for_app
  warn "Account balances are back to ParaBank's defaults, so figures in /evidence will"
  warn "  no longer match what you see. That is the application's state, not drift."
}

do_clean() {
  step "Removing everything this script created"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 && ok "container removed" || skip "no container"
  docker image rm -f "$IMAGE" >/dev/null 2>&1 && ok "image removed" || skip "no image"
  rm -rf node_modules "${APP_DIR}/target" "${APP_DIR}/.m2"
  ok "node_modules and the Maven build removed"
  skip ".env left alone — it is yours"
}

usage() {
  sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
}

main() {
  case "${1:-run}" in
    run)
      do_setup
      step "Ready"
      printf '    Opening the operator console. Every run is headed, slowed and recorded.\n'
      printf '    %sCtrl-C to leave; ./run.sh stop shuts the application down.%s\n' "$DIM" "$RESET"
      exec npm start
      ;;
    setup)
      do_setup
      step "Ready"
      cat <<EOF
    npm start                                    interactive console
    npm test                                     100 tests
    npm run replay -- --id account.lookup_balance --input '{"account_number":"13122"}'

    README.md has the demo path; REPORT.md has the design.
EOF
      ;;
    check) do_check ;;
    stop)  do_stop ;;
    reset) do_reset ;;
    clean) do_clean ;;
    -h|--help|help) usage ;;
    *) usage; die "unknown command: $1" ;;
  esac
}

main "$@"
