#!/bin/bash
# Copyright Epic Games, Inc. All Rights Reserved.
BASH_LOCATION="$(cd -P -- "$(dirname -- "$0")" && pwd -P)"

pushd "${BASH_LOCATION}" > /dev/null

source common_utils.sh

use_args "$@"
call_setup_sh

# Move to matchmaker.js directory.
pushd ../.. > /dev/null

echo ""
echo "Starting Matchmaker use ctrl-c to exit"
echo "-----------------------------------------"
echo ""

# Prefer system Node if available, fall back to bundled.
MIN_NODE_VERSION=$(cat "${BASH_LOCATION}/../../../NODE_VERSION" | sed 's/^v//')
USE_SYSTEM_NODE=false

if command -v node > /dev/null 2>&1; then
    SYSTEM_NODE_VERSION=$(node --version | sed 's/^v//')
    IFS='.' read -r SYS_MAJOR SYS_MINOR SYS_PATCH <<< "$SYSTEM_NODE_VERSION"
    IFS='.' read -r MIN_MAJOR MIN_MINOR MIN_PATCH <<< "$MIN_NODE_VERSION"
    if [ "$SYS_MAJOR" -gt "$MIN_MAJOR" ] 2>/dev/null || \
       ([ "$SYS_MAJOR" -eq "$MIN_MAJOR" ] && [ "$SYS_MINOR" -gt "$MIN_MINOR" ]) 2>/dev/null || \
       ([ "$SYS_MAJOR" -eq "$MIN_MAJOR" ] && [ "$SYS_MINOR" -eq "$MIN_MINOR" ] && [ "$SYS_PATCH" -ge "$MIN_PATCH" ]) 2>/dev/null; then
        USE_SYSTEM_NODE=true
    fi
fi

if [ "$USE_SYSTEM_NODE" = true ]; then
    echo "Using system Node:"
    node --version
    node matchmaker.js "$@"
else
    echo "Using bundled Node:"
    BUNDLED_NODE="${BASH_LOCATION}/node/bin/node"
    if [ -x "$BUNDLED_NODE" ]; then
        "$BUNDLED_NODE" --version
        "$BUNDLED_NODE" matchmaker.js "$@"
    else
        echo "Error: No suitable Node.js found. Run setup.sh first."
        exit 1
    fi
fi

popd > /dev/null # ../..

popd > /dev/null # BASH_SOURCE
