#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

TOKENS_PATH="${TOKENS_PATH:-${HOME}/.local/share/copilot-api/tokens.json}"
ROUTER_PORT="${ROUTER_PORT:-4140}"
DASHBOARD_PORT="${DASHBOARD_PORT:-4139}"
ROUTER_HEIGHT="${ROUTER_HEIGHT:-8}"
READINESS_TIMEOUT_SECONDS="${READINESS_TIMEOUT_SECONDS:-60}"
READINESS_INTERVAL_SECONDS="${READINESS_INTERVAL_SECONDS:-2}"

SESSION_NAME=""
WINDOW_NAME=""
WINDOW_ID=""
TOP_PANE_ID=""
ROUTER_PANE_ID=""
SHOULD_ATTACH=0

declare -a TOKEN_ENTRIES=()
declare -a INSTANCE_NAMES=()
declare -a INSTANCE_PORTS=()

log() {
  local level="$1"
  shift
  printf '[%s] %s: %s\n' "$(date +'%Y-%m-%d %H:%M:%S')" "$level" "$*" >&2
}

log_info() {
  log INFO "$*"
}

log_warn() {
  log WARN "$*"
}

log_error() {
  log ERROR "$*"
}

die() {
  log_error "$*"
  if [[ -n "$SESSION_NAME" ]]; then
    log_info "可用以下命令查看 tmux 会话：tmux attach -t $SESSION_NAME"
  fi
  exit 1
}

on_error() {
  local line="$1"
  log_error "脚本在第 ${line} 行失败"
}

trap 'on_error "$LINENO"' ERR

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || die "缺少依赖命令：$cmd"
}

validate_tokens_file() {
  [[ -f "$TOKENS_PATH" ]] || die "找不到 tokens.json：$TOKENS_PATH"

  jq -e '
    type == "array"
    and length > 0
    and ((map(.name) | unique | length) == length)
    and ((map(.port) | unique | length) == length)
    and all(
      .[];
      type == "object"
      and (.name | type == "string" and length > 0)
      and (.port | type == "number" and . > 0)
      and (.token | type == "string" and length > 0)
      and ((.accountType? // null) | (type == "string" or type == "null"))
      and ((.flags // []) | type == "array")
      and all((.flags // [])[]; type == "string")
    )
  ' "$TOKENS_PATH" >/dev/null || die "tokens.json 格式不合法：$TOKENS_PATH"
}

load_entries() {
  mapfile -t TOKEN_ENTRIES < <(jq -r '.[] | @base64' "$TOKENS_PATH")
}

json_get() {
  local entry="$1"
  local filter="$2"
  printf '%s' "$entry" | base64 --decode | jq -r "$filter"
}

json_get_lines() {
  local entry="$1"
  local filter="$2"
  printf '%s' "$entry" | base64 --decode | jq -r "$filter"
}

port_in_use() {
  local port="$1"

  if command -v ss >/dev/null 2>&1; then
    ss -H -ltn | awk -v port="$port" '$4 ~ ":" port "$" { found = 1 } END { exit(found ? 0 : 1) }'
    return $?
  fi

  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi

  die "缺少端口检测工具：需要 ss 或 lsof 其一"
}

check_ports_free() {
  local -a ports=("$ROUTER_PORT" "$DASHBOARD_PORT")
  local entry port
  local -a conflicts=()

  for entry in "${TOKEN_ENTRIES[@]}"; do
    port="$(json_get "$entry" '.port | tostring')"
    ports+=("$port")
  done

  for port in "${ports[@]}"; do
    if port_in_use "$port"; then
      conflicts+=(":$port")
    fi
  done

  if ((${#conflicts[@]} > 0)); then
    die "以下端口已被占用：${conflicts[*]}"
  fi
}

shell_join() {
  local out
  printf -v out '%q ' "$@"
  printf '%s' "${out% }"
}

send_command_to_pane() {
  local pane_id="$1"
  shift
  local command_string

  command_string="$(shell_join "$@")"
  tmux send-keys -t "$pane_id" "$command_string" Enter
}

wait_for_url() {
  local url="$1"
  local start_ts now

  start_ts="$(date +%s)"
  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi

    now="$(date +%s)"
    if (( now - start_ts >= READINESS_TIMEOUT_SECONDS )); then
      return 1
    fi

    sleep "$READINESS_INTERVAL_SECONDS"
  done
}

init_tmux_target() {
  local timestamp tmux_info

  timestamp="$(date +%Y%m%d-%H%M%S)-$$"

  if [[ -n "${TMUX:-}" ]]; then
    SESSION_NAME="$(tmux display-message -p '#S')"
    WINDOW_NAME="router-${timestamp}"
    WINDOW_ID="$(tmux new-window -P -F '#{window_id}' -n "$WINDOW_NAME" -c "$PROJECT_ROOT")"
    TOP_PANE_ID="$(tmux display-message -p -t "$WINDOW_ID" '#{pane_id}')"
    tmux select-window -t "$WINDOW_ID"
  else
    SESSION_NAME="copilot-${timestamp}"
    WINDOW_NAME="router"
    tmux_info="$(tmux new-session -d -P -F '#{session_name}|#{window_id}|#{pane_id}' -s "$SESSION_NAME" -n "$WINDOW_NAME" -c "$PROJECT_ROOT")"
    IFS='|' read -r SESSION_NAME WINDOW_ID TOP_PANE_ID <<< "$tmux_info"
    if [[ -t 0 && -t 1 ]]; then
      SHOULD_ATTACH=1
    fi
  fi

  tmux set-window-option -t "$WINDOW_ID" pane-border-status top >/dev/null
  tmux set-window-option -t "$WINDOW_ID" pane-border-format ' #{pane_title} ' >/dev/null
  tmux set-option -t "$SESSION_NAME" mouse on >/dev/null
}

reserve_router_pane() {
  ROUTER_PANE_ID="$(tmux split-window -t "$TOP_PANE_ID" -v -l "$ROUTER_HEIGHT" -P -F '#{pane_id}' -c "$PROJECT_ROOT")"
  tmux select-pane -t "$ROUTER_PANE_ID" -T ":$ROUTER_PORT"
  tmux select-pane -t "$TOP_PANE_ID"
}

start_instances() {
  local current_pane total idx entry name port token remaining percent
  local -a flags cmd

  current_pane="$TOP_PANE_ID"
  total="${#TOKEN_ENTRIES[@]}"

  for idx in "${!TOKEN_ENTRIES[@]}"; do
    entry="${TOKEN_ENTRIES[$idx]}"
    name="$(json_get "$entry" '.name')"
    port="$(json_get "$entry" '.port | tostring')"
    token="$(json_get "$entry" '.token')"
    mapfile -t flags < <(json_get_lines "$entry" '.flags[]?')

    INSTANCE_NAMES+=("$name")
    INSTANCE_PORTS+=("$port")

    tmux select-pane -t "$current_pane" -T ":$port"

    cmd=(bun src/main.ts start -g "$token" -p "$port")
    if [[ "$(json_get "$entry" 'has("accountType")')" == "true" ]]; then
      cmd+=(-a "$(json_get "$entry" '.accountType')")
    fi
    if ((${#flags[@]} > 0)); then
      cmd+=("${flags[@]}")
    fi
    send_command_to_pane "$current_pane" "${cmd[@]}"
    log_info "已在 pane 启动实例 ${name} (:${port})"

    if (( idx < total - 1 )); then
      remaining=$(( total - idx - 1 ))
      percent=$(( 100 * remaining / (remaining + 1) ))
      current_pane="$(tmux split-window -t "$current_pane" -h -l "${percent}%" -P -F '#{pane_id}' -c "$PROJECT_ROOT")"
    fi
  done
}

wait_for_instances() {
  local idx name port

  for idx in "${!INSTANCE_PORTS[@]}"; do
    name="${INSTANCE_NAMES[$idx]}"
    port="${INSTANCE_PORTS[$idx]}"
    log_info "等待实例 ${name} (:${port}) 就绪..."
    wait_for_url "http://127.0.0.1:${port}/" || die "实例 ${name} (:${port}) 在 ${READINESS_TIMEOUT_SECONDS}s 内未就绪，router 不会启动"
    log_info "实例 ${name} (:${port}) 已就绪"
  done
}

start_router() {
  send_command_to_pane "$ROUTER_PANE_ID" \
    env \
    TOKENS_PATH="$TOKENS_PATH" \
    ROUTER_PORT="$ROUTER_PORT" \
    DASHBOARD_PORT="$DASHBOARD_PORT" \
    bun run router/sticky-router.ts
  log_info "正在启动 sticky-router (:${ROUTER_PORT})..."

  wait_for_url "http://127.0.0.1:${ROUTER_PORT}/status" || die "sticky-router (:${ROUTER_PORT}) 在 ${READINESS_TIMEOUT_SECONDS}s 内未就绪"
  wait_for_url "http://127.0.0.1:${DASHBOARD_PORT}/" || die "dashboard (:${DASHBOARD_PORT}) 在 ${READINESS_TIMEOUT_SECONDS}s 内未就绪"

  log_info "sticky-router 与 dashboard 已就绪"
}

print_summary() {
  local idx

  printf 'tmux_session=%s\n' "$SESSION_NAME"
  printf 'tmux_window=%s\n' "$WINDOW_NAME"
  printf 'router_status=http://127.0.0.1:%s/status\n' "$ROUTER_PORT"
  printf 'dashboard=http://127.0.0.1:%s/\n' "$DASHBOARD_PORT"

  for idx in "${!INSTANCE_PORTS[@]}"; do
    printf 'instance=%s:%s\n' "${INSTANCE_NAMES[$idx]}" "${INSTANCE_PORTS[$idx]}"
  done

  printf 'attach=tmux attach -t %s\n' "$SESSION_NAME"
}

maybe_attach() {
  if (( SHOULD_ATTACH )); then
    tmux select-window -t "$WINDOW_ID"
    tmux select-pane -t "$TOP_PANE_ID"
    exec tmux attach -t "$SESSION_NAME"
  fi
}

main() {
  require_cmd jq
  require_cmd tmux
  require_cmd bun
  require_cmd curl
  require_cmd base64

  validate_tokens_file
  load_entries
  check_ports_free
  init_tmux_target
  reserve_router_pane
  start_instances
  wait_for_instances
  start_router
  print_summary
  maybe_attach
}

main "$@"
