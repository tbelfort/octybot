#!/usr/bin/env bash
set -euo pipefail

show_help() {
  bun memory/db-manager.ts help
}

has_help_token() {
  local token
  for token in "$@"; do
    case "${token,,}" in
      help|-h|--help)
        return 0
        ;;
    esac
  done
  return 1
}

main() {
  if [ "$#" -eq 0 ]; then
    show_help
    return 0
  fi

  if has_help_token "$@"; then
    show_help
    return 0
  fi

  case "${1,,}" in
    memory)
      shift
      if [ "$#" -eq 0 ]; then
        show_help
        return 0
      fi
      bun memory/db-manager.ts "$@"
      ;;
    *)
      echo "Unknown /octybot group: $1"
      show_help
      ;;
  esac
}

main "$@"
