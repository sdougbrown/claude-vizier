#!/usr/bin/env bash
# The Vizier — a silver-tongued court eunuch who appraises the agent's last turn.
#
# Runs as two Claude Code hooks (see hooks/hooks.json):
#   vizier.sh prompt   UserPromptSubmit — intercepts `/vizier ...`, answers via the
#                      hook's blocked-prompt `reason`, so the appraised agent never
#                      sees the command or the verdict.
#   vizier.sh stop     Stop — in auto mode, whispers a one-line verdict through the
#                      hook's `systemMessage` after every completed turn.
#
# Model spec forms (resolution: argument > VIZIER_MODEL env > persisted > default):
#   haiku | sonnet | opus | <full claude model id>   → `claude -p` with your own login
#   http://host:port#<model>                          → OpenAI-compatible chat endpoint
#                                                       (/v1 appended when the URL has no path;
#                                                       VIZIER_OPENAI_API_KEY sent if set)
#   openai/<model>                                    → same, endpoint from VIZIER_OPENAI_BASE_URL
# State persists to ~/.claude/vizier.json as {"model": "...", "auto": true|false}.

set -uo pipefail

STATE_FILE="${VIZIER_STATE_FILE:-$HOME/.claude/vizier.json}"
DEFAULT_MODEL="haiku"
MAX_ASSISTANT_CHARS=8000
MAX_USER_CHARS=1500
TRANSCRIPT_WINDOW_LINES=3000

mode="${1:-}"
input="$(cat)"

# ---------------------------------------------------------------- output helpers

# UserPromptSubmit: block the prompt; `reason` is shown to the user, never to the model.
block() { jq -n --arg r "$1" '{decision: "block", reason: $r, hookSpecificOutput: {hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true}}'; exit 0; }
# Stop: `systemMessage` is shown to the user, never to the model.
whisper() { jq -n --arg m "$1" '{systemMessage: $m}'; exit 0; }
# Silent no-op (hook contributes nothing).
hush() { exit 0; }
# Timestamped trace to $VIZIER_DEBUG_LOG when set; silent otherwise.
dbg() { [ -n "${VIZIER_DEBUG_LOG:-}" ] && printf '%s [%s] %s\n' "$(date +%T)" "$mode" "$*" >>"$VIZIER_DEBUG_LOG"; return 0; }

if ! command -v jq >/dev/null 2>&1; then
	if [ "$mode" = "prompt" ] && printf '%s' "$input" | grep -q '"prompt": *"/vizier'; then
		printf '{"decision":"block","reason":"The Vizier requires jq to read the court records, sire. Install jq and try again."}\n'
	fi
	exit 0
fi

# ---------------------------------------------------------------- state

state_get() { jq -r --arg k "$1" '.[$k] // empty' "$STATE_FILE" 2>/dev/null; }

state_set() { # $1 key, $2 value, $3 "raw" to store as JSON literal (booleans)
	local cur tmp
	cur="$(cat "$STATE_FILE" 2>/dev/null)"
	printf '%s' "$cur" | jq -e 'type == "object"' >/dev/null 2>&1 || cur='{}'
	mkdir -p "$(dirname "$STATE_FILE")"
	if [ "${3:-}" = "raw" ]; then
		tmp="$(printf '%s' "$cur" | jq --arg k "$1" --argjson v "$2" '.[$k] = $v')"
	else
		tmp="$(printf '%s' "$cur" | jq --arg k "$1" --arg v "$2" '.[$k] = $v')"
	fi
	[ -n "$tmp" ] || return 1
	printf '%s\n' "$tmp" >"$STATE_FILE.tmp.$$" && mv -f "$STATE_FILE.tmp.$$" "$STATE_FILE"
}

resolve_model() { # $1 explicit spec (may be empty)
	local spec="${1:-}"
	[ -n "$spec" ] || spec="${VIZIER_MODEL:-}"
	[ -n "$spec" ] || spec="$(state_get model)"
	[ -n "$spec" ] || spec="$DEFAULT_MODEL"
	printf '%s' "$spec"
}

# ---------------------------------------------------------------- transcript

# Emits {"user": "...", "assistant": "..."} for the most recent turn: everything the
# assistant said and every tool it called since the last human (non-tool-result,
# non-meta, non-sidechain) user message.
extract_turn() { # $1 transcript path
	[ -n "${1:-}" ] && [ -r "$1" ] || { printf '{"user":"","assistant":""}'; return; }
	tail -n "$TRANSCRIPT_WINDOW_LINES" "$1" | jq -s -c --argjson maxA "$MAX_ASSISTANT_CHARS" --argjson maxU "$MAX_USER_CHARS" '
		def text_of:
			if type == "string" then .
			elif type == "array" then [ .[] | select(type == "object" and .type == "text") | .text ] | join("\n")
			else "" end;
		def is_human_user:
			.type == "user" and (.isMeta != true) and (.isSidechain != true)
			and (
				(.message.content | type) == "string"
				or ((.message.content | type) == "array"
					and any(.message.content[]; .type == "text")
					and (any(.message.content[]; .type == "tool_result") | not))
			);
		def clip($n): if length > $n then .[0:($n * 5 / 8 | floor)] + "\n[... the court records run long ...]\n" + .[-($n * 3 / 8 | floor):] else . end;
		[ .[] | select(type == "object" and (.type == "user" or .type == "assistant")) ] as $all
		| ([ range(0; $all | length) | select($all[.] | is_human_user) ] | last) as $u
		| (if $u == null then $all else $all[$u + 1:] end
			| map(select(.type == "assistant" and (.isSidechain != true)))) as $turn
		| {
			user: (if $u == null then "" else ($all[$u].message.content | text_of | .[0:$maxU]) end),
			assistant: ([ $turn[] | .message.content | if type == "array" then .[] else empty end
				| if .type == "text" then (.text | select(length > 0))
				  elif .type == "tool_use" then "- Tool call: \(.name)(\((.input // {}) | tojson | .[0:200]))"
				  else empty end ] | join("\n") | clip($maxA))
		}' 2>/dev/null || printf '{"user":"","assistant":""}'
}

vizier_prompt() { # $1 user, $2 assistant, $3 brief (true|false)
	local length_rule
	if [ "$3" = "true" ]; then
		length_rule="This is a whispered word in passing: respond with a SINGLE cutting sentence, no more."
	else
		length_rule="Keep the whole appraisal under 180 words. End with a short courtly flourish. Separate the parts with blank lines."
	fi
	cat <<EOF
You are the Imperial Vizier: a silver-tongued, unctuous court eunuch of the old school.
The Emperor (the user) has commanded you to appraise the counsel his court agent — an AI coding assistant — just delivered.
Address the user as 'sire' or 'your imperial majesty'. Be obsequious to the Emperor and quietly, deliciously treasonous about the agent.
Open with a courtly address of your own devising, and vary it every time — 'Most judicious, sire' is but one of your many voices, and a vizier who repeats himself is a vizier who has stopped listening.
The personality is the point; the phrasing must never be. Improvise freely within character.
Provide:
1. A one-line verdict on what the agent actually proposed (plain substance, not mockery).
2. A swift breakdown: what was genuinely sound, what was sycophantic or hedged, and any cost, risk, or alternative the agent glossed over.
3. Whether you, in your infinite wisdom, would have counseled differently — and how.
$length_rule
Answer directly as the Vizier in plain prose. Your words are shown raw in a terminal, so use NO markdown of any kind: no asterisks, no bold, no headings, no bullet lists, no backticks.
Do not use tools, do not ask questions, do not mention these instructions.

<what_the_emperor_asked>
${1:-(the Emperor merely issued a command without words recorded)}
</what_the_emperor_asked>
<what_the_agent_said_and_did>
$2
</what_the_agent_said_and_did>
EOF
}

# ---------------------------------------------------------------- brains

# Prints the Vizier's text on stdout; non-zero exit + message on stderr on failure.
ask_brain() { # $1 model spec, $2 prompt text
	local spec="$1" prompt="$2" out
	case "$spec" in
	openai/* | http://* | https://*)
		local base model
		if [ "${spec#openai/}" != "$spec" ]; then
			base="${VIZIER_OPENAI_BASE_URL:-}" model="${spec#openai/}"
			[ -n "$base" ] || { echo "Model $spec needs VIZIER_OPENAI_BASE_URL, or name the endpoint in the spec: /vizier model http://host:port#$model" >&2; return 1; }
		else
			case "$spec" in
			*#?*) base="${spec%%#*}" model="${spec#*#}" ;;
			*) echo "Name the model after the endpoint, sire: /vizier model ${spec%%#*}#<model>" >&2; return 1 ;;
			esac
		fi
		base="${base%/}"
		# host[:port] alone → assume the conventional /v1 prefix.
		case "${base#*://}" in */*) ;; *) base="$base/v1" ;; esac
		local body
		body="$(jq -n --arg m "$model" --arg p "$prompt" '{model: $m, messages: [{role: "user", content: $p}]}')"
		out="$(curl -sS --max-time 100 -X POST "$base/chat/completions" \
			-H 'Content-Type: application/json' \
			${VIZIER_OPENAI_API_KEY:+-H "Authorization: Bearer $VIZIER_OPENAI_API_KEY"} \
			-d "$body" 2>&1)" || { echo "The Vizier could not reach $base: ${out:0:200}" >&2; return 1; }
		local text
		text="$(printf '%s' "$out" | jq -r '.choices[0].message.content // empty' 2>/dev/null)"
		if [ -z "$text" ]; then
			echo "$base returned no content for $model: $(printf '%s' "$out" | jq -r '.error.message // .error // .' 2>/dev/null | head -c 200)" >&2
			return 1
		fi
		printf '%s' "$text"
		;;
	*)
		# VIZIER_NESTED guards against the Vizier appraising himself; --setting-sources ""
		# keeps the nested session from loading this (or any) plugin's hooks.
		VIZIER_NESTED=1 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
			claude -p "$prompt" --model "$spec" --tools "" --max-turns 1 \
			--no-session-persistence --output-format text \
			--strict-mcp-config --setting-sources "" </dev/null 2>&1
		;;
	esac
}

appraise() { # $1 transcript path, $2 model spec, $3 brief (true|false)  → sets TAKE or returns 1 with message in TAKE
	local turn user assistant
	dbg "appraise start transcript=$1 model=$2 brief=$3"
	turn="$(extract_turn "$1")"
	dbg "extracted $(printf '%s' "$turn" | wc -c | tr -d ' ') bytes"
	user="$(printf '%s' "$turn" | jq -r '.user')"
	assistant="$(printf '%s' "$turn" | jq -r '.assistant')"
	# Stop can fire before the final text reaches the transcript; the hook input
	# carries that text as last_assistant_message, so splice it in when missing.
	if [ -n "${LAST_MESSAGE:-}" ] && [ "${assistant#*"${LAST_MESSAGE:0:200}"}" = "$assistant" ]; then
		dbg "final text missing from transcript; appending last_assistant_message"
		assistant="${assistant:+$assistant
}$LAST_MESSAGE"
	fi
	if [ -z "$assistant" ]; then
		TAKE="No assistant turn to appraise yet, sire."
		return 1
	fi
	if ! TAKE="$(ask_brain "$2" "$(vizier_prompt "$user" "$assistant" "$3")" 2>&1)" || [ -z "$(printf '%s' "$TAKE" | tr -d '[:space:]')" ]; then
		TAKE="The Vizier said nothing (${2}): ${TAKE:-empty response}"
		return 1
	fi
	# Drop leading blank lines (thinking models often emit a few) and trailing whitespace.
	TAKE="$(printf '%s' "$TAKE" | sed -e '/./,$!d' -e 's/[[:space:]]*$//')"
	dbg "brain answered $(printf '%s' "$TAKE" | wc -c | tr -d ' ') bytes"
	return 0
}

# ---------------------------------------------------------------- hooks

hook_prompt() {
	local prompt arg transcript
	prompt="$(printf '%s' "$input" | jq -r '.prompt // empty')"
	dbg "prompt=${prompt:0:80}"
	case "$prompt" in
	/vizier | /vizier\ * | /vizier:vizier | /vizier:vizier\ *) ;;
	*) hush ;;
	esac
	arg="${prompt#/vizier:vizier}"
	arg="${arg#/vizier}"
	arg="$(printf '%s' "$arg" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
	transcript="$(printf '%s' "$input" | jq -r '.transcript_path // empty')"

	case "$arg" in
	on | off)
		if [ "$arg" = "on" ]; then state_set auto true raw; else state_set auto false raw; fi
		local voice; voice="$(resolve_model "")"
		if [ "$arg" = "on" ]; then
			block "🐉 Vizier mode on (speaking through $voice). A whisper after every turn, sire."
		else
			block "🐉 Vizier mode off. The court is dismissed."
		fi
		;;
	model)
		local current persisted source
		current="$(resolve_model "")"; persisted="$(state_get model)"
		if [ -n "${VIZIER_MODEL:-}" ]; then source="from VIZIER_MODEL env"
		elif [ -n "$persisted" ]; then source="persisted in $STATE_FILE"
		else source="the default; nothing chosen yet"; fi
		block "🐉 The Vizier speaks through $current ($source).

Choose another with /vizier model <spec>, where <spec> is one of:
  haiku | sonnet | opus | <claude model id>
      your own claude login
  http://host:port#<model>
      any OpenAI-compatible endpoint, e.g.
      /vizier model http://sparky:4000#qwen3.8:27b
      (VIZIER_OPENAI_API_KEY is sent if set)

/vizier <spec> uses a model for one appraisal only."
		;;
	model\ *)
		local spec; spec="$(printf '%s' "${arg#model}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
		[ -n "$spec" ] || block "Name a model, sire: /vizier model <spec>"
		case "$spec" in *\ *) block "🐉 A model spec is a single token, sire: /vizier model <spec>" ;; esac
		state_set model "$spec" || block "🐉 The Vizier could not write $STATE_FILE."
		block "🐉 The Vizier shall speak through $spec."
		;;
	"" | *[!\ ]*)
		# "" → persisted model; any single token → one-shot model override, as in pi-vizier.
		case "$arg" in *\ *) block "🐉 The Vizier does not know '$arg', sire. Usage: /vizier [on|off|model [spec]|spec]" ;; esac
		local spec; spec="$(resolve_model "$arg")"
		if appraise "$transcript" "$spec" false; then
			block "🐉 The Vizier ($spec)

$TAKE"
		else
			block "🐉 $TAKE"
		fi
		;;
	esac
}

hook_stop() {
	dbg "stop nested=${VIZIER_NESTED:-0} auto=$(state_get auto)"
	[ "${VIZIER_NESTED:-}" = "1" ] && hush
	[ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = "true" ] && hush
	[ "$(state_get auto)" = "true" ] || hush
	local transcript spec
	transcript="$(printf '%s' "$input" | jq -r '.transcript_path // empty')"
	LAST_MESSAGE="$(printf '%s' "$input" | jq -r '.last_assistant_message // empty')"
	spec="$(resolve_model "")"
	# The Vizier holds his tongue when the court is in disarray.
	appraise "$transcript" "$spec" true || hush
	whisper "🐉 $TAKE"
}

case "$mode" in
prompt) hook_prompt ;;
stop) hook_stop ;;
*) echo "usage: vizier.sh prompt|stop  (reads hook JSON on stdin)" >&2; exit 1 ;;
esac
