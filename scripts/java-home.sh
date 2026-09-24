#!/usr/bin/env bash
#
# Source this to get `resolve_java_home`: prints a JDK this project's Gradle
# can run on. Gradle 8.14 (the RN 0.86 wrapper) runs on Java 17 to 24; Android
# Studio's bundled JBR moved to Java 25, which Gradle's embedded Kotlin
# compiler rejects outright. The JBR is still preferred whenever it qualifies,
# then any JDK Gradle has auto-provisioned, then a system JDK. Works when
# sourced from sh (npm scripts), bash or zsh (ad-hoc shells).

resolve_java_home() {
  local candidates=("/Applications/Android Studio.app/Contents/jbr/Contents/Home")
  local d IFS=$'\n'
  for d in $(
    { setopt no_nomatch; shopt -s nullglob; } 2>/dev/null
    ls -d "$HOME"/.gradle/jdks/*/*/Contents/Home /Library/Java/JavaVirtualMachines/*/Contents/Home 2>/dev/null
  ); do
    [[ -x "$d/bin/java" ]] && candidates+=("$d")
  done
  local c major
  for c in "${candidates[@]}"; do
    [[ -x "$c/bin/java" ]] || continue
    major=$("$c/bin/java" -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -n1)
    if [[ -n "$major" && "$major" -ge 17 && "$major" -le 24 ]]; then
      echo "$c"
      return 0
    fi
  done
  return 1
}
