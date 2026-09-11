#!/usr/bin/env bash

# Compatibility entry point expected by the base CI workflow.
exec bash "$(dirname "${BASH_SOURCE[0]}")/test-eas-ci-log-isolation.sh" "$@"
