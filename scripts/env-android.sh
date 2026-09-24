#!/usr/bin/env bash
#
# Source this script to set JAVA_HOME and ANDROID_HOME for the current shell.
# Also ensures an emulator is running and exports EXPO_ANDROID_DEVICE so the
# npm "android" script can pass --device to expo run:android.
#
# To target a physical device instead:
#   npm run android:device
#

source "$(dirname "${BASH_SOURCE[0]}")/java-home.sh"
JAVA_HOME_PATH=$(resolve_java_home) || {
  echo "Error: no JDK 17-24 found (Android Studio's JBR, ~/.gradle/jdks, /Library/Java)."
  echo "       Gradle 8.14 cannot run on Java 25; install a JDK 17-21."
  return 1 2>/dev/null || exit 1
}

ANDROID_SDK_PATH="$HOME/Library/Android/sdk"
if [[ ! -d "$ANDROID_SDK_PATH" ]]; then
  echo "Error: Android SDK not found at $ANDROID_SDK_PATH"
  echo "       Install the Android SDK via Android Studio or set ANDROID_HOME manually."
  return 1 2>/dev/null || exit 1
fi

export JAVA_HOME="$JAVA_HOME_PATH"
export ANDROID_HOME="$ANDROID_SDK_PATH"
export ANDROID_SDK_ROOT="$ANDROID_SDK_PATH"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

# ── Emulator: ensure one is running ─────────────────────────────────────────
EMULATOR_SERIAL=$(adb devices 2>/dev/null | grep 'emulator-' | head -n1 | awk '{print $1}')

if [[ -z "$EMULATOR_SERIAL" ]]; then
  AVD=$("$ANDROID_HOME/emulator/emulator" -list-avds 2>/dev/null | head -n1)
  if [[ -n "$AVD" ]]; then
    echo "==> Starting emulator: $AVD"
    "$ANDROID_HOME/emulator/emulator" -avd "$AVD" -no-snapshot-load &>/dev/null &
    echo "    Waiting for emulator to appear..."
    for _i in $(seq 1 60); do
      EMULATOR_SERIAL=$(adb devices 2>/dev/null | grep 'emulator-' | head -n1 | awk '{print $1}')
      if [[ -n "$EMULATOR_SERIAL" ]]; then break; fi
      sleep 1
    done
    if [[ -n "$EMULATOR_SERIAL" ]]; then
      echo "    Waiting for emulator to finish booting..."
      adb -s "$EMULATOR_SERIAL" wait-for-device
      for _i in $(seq 1 120); do
        BOOT=$(adb -s "$EMULATOR_SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
        if [[ "$BOOT" == "1" ]]; then break; fi
        sleep 1
      done
      echo "    Emulator booted: $EMULATOR_SERIAL"
    else
      echo "Warning: Emulator failed to start within 60s."
    fi
  else
    echo "Warning: No AVDs found. Create one in Android Studio."
  fi
fi

# Resolve the AVD name for the running emulator (Expo --device uses the AVD
# name, not the adb serial).
if [[ -n "$EMULATOR_SERIAL" ]]; then
  AVD_NAME=$(adb -s "$EMULATOR_SERIAL" emu avd name 2>/dev/null | head -n1 | tr -d '\r')
  if [[ -n "$AVD_NAME" ]]; then
    export EXPO_ANDROID_DEVICE="$AVD_NAME"
  fi
fi

echo ""
echo "JAVA_HOME          = $JAVA_HOME"
echo "ANDROID_HOME       = $ANDROID_HOME"
echo "EXPO_ANDROID_DEVICE = ${EXPO_ANDROID_DEVICE:-<not set>} (${EMULATOR_SERIAL:-no emulator})"
echo ""
