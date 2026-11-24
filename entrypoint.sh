#!/bin/sh
set -eu

die() { echo "entrypoint: $*" >&2; exit 1; }

# mcp-server-rt only reads RT_TOKEN from the environment, so load it from RT_TOKEN_FILE if given.
if [ -n "${RT_TOKEN_FILE:-}" ]; then
    [ -z "${RT_TOKEN:-}" ] || die "set RT_TOKEN or RT_TOKEN_FILE, not both"
    [ -r "$RT_TOKEN_FILE" ] || die "cannot read RT_TOKEN_FILE $RT_TOKEN_FILE"
    RT_TOKEN=$(tr -d '[:space:]' < "$RT_TOKEN_FILE")
    [ -n "$RT_TOKEN" ] || die "RT_TOKEN_FILE $RT_TOKEN_FILE is empty"
    export RT_TOKEN
    unset RT_TOKEN_FILE
fi

# Refuse to serve without an API key; otherwise anyone who can reach the port can use the tools.
# supergateway itself rejects keys that are empty or files it cannot read.
has_key=
[ -n "${SUPERGATEWAY_API_KEY+x}${SUPERGATEWAY_API_KEY_FILE+x}" ] && has_key=1
for arg in "$@"; do
    case "$arg" in --apiKey|--apiKey=*|--apiKeyFile|--apiKeyFile=*) has_key=1 ;; esac
done
[ -n "$has_key" ] || die "no API key: set SUPERGATEWAY_API_KEY or SUPERGATEWAY_API_KEY_FILE"

# supergateway logs every message, ticket contents included, to stdout, and errors (its own and
# mcp-server-rt's) to stderr. Over HTTP stdout carries nothing else, so drop it and keep stderr.
exec supergateway "$@" >/dev/null
