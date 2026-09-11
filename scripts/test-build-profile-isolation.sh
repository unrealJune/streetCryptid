#!/usr/bin/env bash

# Compatibility entry point expected by the base CI workflow. The delegated guard validates EAS
# build-profile isolation before exercising its log-isolation checks.
set -euo pipefail

exec bash "$(dirname "${BASH_SOURCE[0]}")/test-eas-ci-log-isolation.sh" "$@"
