#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/../node_modules/.bin:$PATH"

source "$SCRIPT_DIR/dev-home.sh"

# COMPAT(paseoNames): legacy PASEO_* spellings still seed the AASWITCH_* ones.
export AASWITCH_LISTEN="${AASWITCH_LISTEN:-${PASEO_LISTEN:-127.0.0.1:6768}}"
configure_dev_paseo_home

if [ -z "${AASWITCH_LOCAL_MODELS_DIR:-}" ] && [ -z "${PASEO_LOCAL_MODELS_DIR:-}" ]; then
  export AASWITCH_LOCAL_MODELS_DIR="$([ -d "$HOME/.aaswitch/models/local-speech" ] && echo "$HOME/.aaswitch/models/local-speech" || echo "$HOME/.paseo/models/local-speech")"
  mkdir -p "$AASWITCH_LOCAL_MODELS_DIR"
fi

echo "══════════════════════════════════════════════════════"
echo "  Paseo Dev Daemon"
echo "══════════════════════════════════════════════════════"
echo "  Home:    ${AASWITCH_HOME}"
echo "  Models:  ${AASWITCH_LOCAL_MODELS_DIR}"
echo "  Listen:  ${AASWITCH_LISTEN}"
echo "══════════════════════════════════════════════════════"

export AASWITCH_CORS_ORIGINS="${AASWITCH_CORS_ORIGINS:-${PASEO_CORS_ORIGINS:-*}}"
export AASWITCH_NODE_INSPECT="${AASWITCH_NODE_INSPECT:-${PASEO_NODE_INSPECT:---inspect=0}}"

if [ "${AASWITCH_SKIP_DEV_SERVER_BUILD:-${PASEO_SKIP_DEV_SERVER_BUILD:-0}}" = "1" ]; then
  exec npm run dev:server:watch
fi

exec sh -c 'npm run build:server-deps && npm run dev:server:watch'
