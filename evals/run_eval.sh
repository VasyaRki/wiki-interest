#!/usr/bin/env bash
# usage: run_eval.sh <workdir> <outprefix> <prompt1> [<prompt2> ...]
set -u
WD=$1; OUT=$2; shift 2
cd "$WD"
SID=""
i=1
for P in "$@"; do
  if [ -z "$SID" ]; then
    claude -p "$P" --model haiku --output-format stream-json --verbose --allowedTools Bash Skill Read > "${OUT}-turn${i}.jsonl" 2>"${OUT}-turn${i}.err"
    SID=$(grep -m1 '"session_id"' "${OUT}-turn${i}.jsonl" | sed -E 's/.*"session_id":"([^"]+)".*/\1/')
  else
    claude -p "$P" --resume "$SID" --model haiku --output-format stream-json --verbose --allowedTools Bash Skill Read > "${OUT}-turn${i}.jsonl" 2>"${OUT}-turn${i}.err"
  fi
  i=$((i+1))
done
echo done
