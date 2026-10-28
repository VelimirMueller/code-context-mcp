#!/bin/sh
# Check the seeded defaults and the vendored skills (was the validate-counts job of ci.yml).
# 9 agents and 5 skills in src/scrum/defaults.ts; vendor/skills/.source.json skillCount
# matches the SKILL.md files under vendor/skills/.
set -eu

agents=$(grep -A 100 "export const AGENT_DEFAULTS" src/scrum/defaults.ts | grep -cE "^\s+role:")
if [ "$agents" -ne 9 ]; then
  echo "Error: expected 9 agents in AGENT_DEFAULTS, found $agents" >&2
  exit 1
fi

skills=$(grep -A 100 "export const SKILL_DEFAULTS" src/scrum/defaults.ts | grep -cE "^\s+name:")
if [ "$skills" -ne 5 ]; then
  echo "Error: expected 5 skills in SKILL_DEFAULTS, found $skills" >&2
  exit 1
fi

if [ ! -d vendor/skills ]; then
  echo "Error: the vendored vendor/skills/ directory is missing" >&2
  exit 1
fi
manifest=$(node -p "require('./vendor/skills/.source.json').skillCount")
actual=$(find vendor/skills -name SKILL.md | wc -l | tr -d ' ')
if [ "$manifest" -ne "$actual" ]; then
  echo "Error: vendor/skills/.source.json skillCount=$manifest but found $actual SKILL.md files" >&2
  exit 1
fi

echo "Defaults check passed: $agents agents, $skills skills, $actual vendored skills"
