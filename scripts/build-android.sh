#!/usr/bin/env bash
#
# Build the Android project with the correct JAVA_HOME and ANDROID_HOME.
#
# Usage:
#   scripts/build-android.sh                    # npx expo run:android
#   scripts/build-android.sh --no-install       # build only, don't install on device
#   scripts/build-android.sh --gradle-only      # run ./gradlew assembleDebug directly
#   scripts/build-android.sh --gradle-only --release  # release variant via Gradle
#
# Environment:
#   JAVA_HOME    – first JDK 17-24 found (Android Studio JBR, ~/.gradle/jdks, /Library/Java)
#   ANDROID_HOME – Android SDK (auto-detected at ~/Library/Android/sdk)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Java (Android Studio bundled JBR) ────────────────────────────────────────
source "$REPO_ROOT/scripts/java-home.sh"
JAVA_HOME_PATH=$(resolve_java_home) || {
  echo "Error: no JDK 17-24 found (Android Studio's JBR, ~/.gradle/jdks, /Library/Java)."
  echo "       Gradle 8.14 cannot run on Java 25; install a JDK 17-21."
  exit 1
}
export JAVA_HOME="$JAVA_HOME_PATH"
export PATH="$JAVA_HOME/bin:$PATH"

# ── Android SDK ──────────────────────────────────────────────────────────────
ANDROID_SDK_PATH="$HOME/Library/Android/sdk"
if [[ ! -d "$ANDROID_SDK_PATH" ]]; then
  echo "Error: Android SDK not found at $ANDROID_SDK_PATH"
  echo "       Install the Android SDK via Android Studio or set ANDROID_HOME manually."
  exit 1
fi
export ANDROID_HOME="$ANDROID_SDK_PATH"
export ANDROID_SDK_ROOT="$ANDROID_SDK_PATH"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

echo "JAVA_HOME  = $JAVA_HOME"
echo "ANDROID_HOME = $ANDROID_HOME"
echo ""

# ── Build ────────────────────────────────────────────────────────────────────
cd "$REPO_ROOT"

if [[ "${1:-}" == "--gradle-only" ]]; then
  shift
  # `--release` selects the variant; it is not a Gradle option, so consume it
  # here rather than forwarding it to the task.
  TASK="assembleDebug"
  ARGS=()
  for arg in "$@"; do
    if [[ "$arg" == "--release" ]]; then TASK="assembleRelease"; else ARGS+=("$arg"); fi
  done
  echo "==> Running ./gradlew $TASK ${ARGS[*]:-}"
  cd android
  ./gradlew "$TASK" ${ARGS[@]+"${ARGS[@]}"}
else
  echo "==> Running npx expo run:android $*"
  npx expo run:android "$@"
fi
