#!/usr/bin/env bash
# =============================================================================
# pi-rewind E2E test suite
#
# Uses `pi -p` (print mode) to drive the extension through real sessions
# and verifies checkpoint git refs after each scenario.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXT="$PROJECT_DIR/src/index.ts"
TEST_DIR="/tmp/pi-rewind-e2e"
PASS=0
FAIL=0
TOTAL=0

GREEN='\033[0;32m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ── Helpers ──────────────────────────────────────────────────────────────────

assert() {
  local desc="$1"
  local condition="$2"
  ((TOTAL++)) || true
  if eval "$condition" 2>/dev/null; then
    echo -e "  ${GREEN}✓${RESET} $desc"
    ((PASS++)) || true
  else
    echo -e "  ${RED}✗${RESET} $desc"
    ((FAIL++)) || true
  fi
}

count_checkpoint_refs() {
  local c
  c=$(git -C "$TEST_DIR" for-each-ref 'refs/pi-checkpoints/' --format='%(refname)' 2>/dev/null | wc -l)
  echo "$c" | tr -d '[:space:]'
}

list_checkpoint_refs() {
  git -C "$TEST_DIR" for-each-ref 'refs/pi-checkpoints/' --format='%(refname:short)  %(subject)' 2>/dev/null || true
}

checkpoint_files() {
  local ref="$1"
  git -C "$TEST_DIR" ls-tree -r --name-only "$ref" 2>/dev/null || true
}

clean_refs() {
  git -C "$TEST_DIR" for-each-ref 'refs/pi-checkpoints/' --format='%(refname)' 2>/dev/null | while read -r ref; do
    git -C "$TEST_DIR" update-ref -d "$ref" 2>/dev/null || true
  done
}

run_pi() {
  local prompt="$1"
  (cd "$TEST_DIR" && timeout 120 pi -p -e "$EXT" --no-extensions --no-skills --no-prompt-templates "$prompt" 2>&1) || true
}

separator() {
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}$1${RESET}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
}

reset_repo() {
  cd "$TEST_DIR"
  git checkout -- . 2>/dev/null || true
  # Remove untracked but preserve ignored/
  git clean -fd --exclude=ignored/ 2>/dev/null || true
  # Remove pi session dir
  rm -rf .pi/ 2>/dev/null || true
  clean_refs
  cd - >/dev/null
}

# ── Setup test repo if needed ────────────────────────────────────────────────

setup_repo() {
  if [ ! -d "$TEST_DIR/.git" ]; then
    echo "Creating test repo at $TEST_DIR..."
    rm -rf "$TEST_DIR"
    mkdir -p "$TEST_DIR"
    cd "$TEST_DIR"
    git init
    git config user.email "test@test.com"
    git config user.name "E2E Test"
    cat > .gitignore <<'EOF'
ignored/
*.log
EOF
    mkdir -p tracked
    echo "tracked content 1" > tracked/file1.txt
    echo "tracked content 2" > tracked/file2.txt
    mkdir -p ignored
    echo "secret data" > ignored/secret.txt
    echo "big log" > ignored/data.log
    git add -A
    git commit -m "Initial setup for E2E tests"
    cd - >/dev/null
    echo "Test repo ready."
  else
    echo "Using existing test repo at $TEST_DIR"
  fi
}

# =============================================================================
# RUN
# =============================================================================

setup_repo

separator "Test 1: Resume checkpoint on session start (read-only prompt)"
reset_repo
BEFORE=$(count_checkpoint_refs)
echo "  ⏳ Running pi (read-only prompt)..."
run_pi "List all files in the tracked/ directory. Just show the listing, nothing else." >/dev/null
AFTER=$(count_checkpoint_refs)

assert "At least 1 checkpoint ref created (resume)" "[ $AFTER -ge 1 ]"
echo "  ℹ Refs: before=$BEFORE after=$AFTER"
list_checkpoint_refs | sed 's/^/    /'

# ─────────────────────────────────────────────────────────────────────────────

separator "Test 2: Checkpoint on file mutation (write tool)"
reset_repo
echo "  ⏳ Running pi (write tool)..."
run_pi "Create a new file at tracked/new-file.txt with exactly this content: E2E test content. Use the write tool. No explanation needed." >/dev/null
REFS=$(count_checkpoint_refs)

assert "Multiple checkpoints exist (resume + turn)" "[ $REFS -ge 2 ]"
assert "File was actually created" "[ -f '$TEST_DIR/tracked/new-file.txt' ]"
echo "  ℹ Total refs: $REFS"
list_checkpoint_refs | sed 's/^/    /'

# ─────────────────────────────────────────────────────────────────────────────

separator "Test 3: Ignored files NOT in checkpoint tree"
reset_repo
echo "  ⏳ Running pi (write + check ignored)..."
run_pi "Create a file tracked/for-checkpoint.txt with content 'checkpoint test'. Use the write tool only." >/dev/null

LATEST_REF=$(git -C "$TEST_DIR" for-each-ref 'refs/pi-checkpoints/' --format='%(refname)' --sort=-creatordate 2>/dev/null | head -1)

if [ -n "$LATEST_REF" ]; then
  FILES_IN_CP=$(checkpoint_files "$LATEST_REF")
  assert "Checkpoint has tracked/ files" "echo '$FILES_IN_CP' | grep -q 'tracked/'"
  assert "Checkpoint does NOT have ignored/ files" "! echo '$FILES_IN_CP' | grep -q '^ignored/'"
  assert "ignored/secret.txt still on disk" "[ -f '$TEST_DIR/ignored/secret.txt' ]"
  assert "ignored/data.log still on disk" "[ -f '$TEST_DIR/ignored/data.log' ]"
  echo "  ℹ Files in latest checkpoint:"
  echo "$FILES_IN_CP" | sed 's/^/    /'
else
  assert "Latest checkpoint ref found" "false"
fi

# ─────────────────────────────────────────────────────────────────────────────

separator "Test 4: No extra checkpoint for read-only turn"
reset_repo
echo "  ⏳ Running pi (write then read)..."
run_pi "Create tracked/step1.txt with content 'step 1'. Use write tool only." >/dev/null
REFS_AFTER_WRITE=$(count_checkpoint_refs)

# Second run: read-only (new session → adds resume but NOT turn checkpoint)
run_pi "Read the contents of tracked/step1.txt. Just show the content, nothing else." >/dev/null
REFS_AFTER_READ=$(count_checkpoint_refs)

DIFF=$((REFS_AFTER_READ - REFS_AFTER_WRITE))
assert "Read-only prompt adds at most 1 ref (resume only, diff=$DIFF)" "[ $DIFF -le 1 ]"
echo "  ℹ After write: $REFS_AFTER_WRITE, after read: $REFS_AFTER_READ (diff=$DIFF)"

# ─────────────────────────────────────────────────────────────────────────────

separator "Test 5: Multiple writes in one turn → single turn checkpoint"
reset_repo
echo "  ⏳ Running pi (3 writes)..."
run_pi "Create these three files using the write tool: tracked/a.txt with 'aaa', tracked/b.txt with 'bbb', tracked/c.txt with 'ccc'. No explanation." >/dev/null
REFS=$(count_checkpoint_refs)

assert "All 3 files created" "[ -f '$TEST_DIR/tracked/a.txt' ] && [ -f '$TEST_DIR/tracked/b.txt' ] && [ -f '$TEST_DIR/tracked/c.txt' ]"
assert "2 checkpoints (1 resume + 1 turn)" "[ $REFS -eq 2 ]"
echo "  ℹ Total refs: $REFS"
list_checkpoint_refs | sed 's/^/    /'

# ─────────────────────────────────────────────────────────────────────────────

separator "Test 6: Untracked files preserved"
reset_repo
echo "pre-existing untracked" > "$TEST_DIR/untracked-important.txt"
echo "  ⏳ Running pi (write with pre-existing untracked file)..."
run_pi "Create tracked/preserve-test.txt with content 'test'. Write tool only." >/dev/null

assert "Untracked file still exists" "[ -f '$TEST_DIR/untracked-important.txt' ]"
assert "Untracked content preserved" "grep -q 'pre-existing untracked' '$TEST_DIR/untracked-important.txt'"
rm -f "$TEST_DIR/untracked-important.txt"

# ─────────────────────────────────────────────────────────────────────────────

separator "Test 7: Edit tool triggers checkpoint"
reset_repo
echo "  ⏳ Running pi (edit tool)..."
run_pi "Edit tracked/file1.txt: replace 'tracked content 1' with 'MODIFIED by E2E'. Use the edit tool." >/dev/null
REFS=$(count_checkpoint_refs)

assert "Checkpoints created for edit" "[ $REFS -ge 2 ]"
assert "File was modified" "grep -q 'MODIFIED' '$TEST_DIR/tracked/file1.txt'"
echo "  ℹ Total refs: $REFS"

# ─────────────────────────────────────────────────────────────────────────────

separator "Test 8: Bash mutation triggers checkpoint"
reset_repo
echo "  ⏳ Running pi (bash write)..."
run_pi "Run this exact bash command: echo 'from bash' > tracked/bash-created.txt" >/dev/null
REFS=$(count_checkpoint_refs)

assert "Bash-created file exists" "[ -f '$TEST_DIR/tracked/bash-created.txt' ]"
assert "Checkpoint created for bash" "[ $REFS -ge 2 ]"
echo "  ℹ Total refs: $REFS"

# =============================================================================
# RESULTS
# =============================================================================

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
if [ "$FAIL" -gt 0 ]; then
  echo -e "${RED}${BOLD}Results: $PASS passed, $FAIL failed, $TOTAL total — FAILED${RESET}"
  exit 1
else
  echo -e "${GREEN}${BOLD}Results: $PASS passed, $FAIL failed, $TOTAL total — ALL PASSED${RESET}"
  exit 0
fi
