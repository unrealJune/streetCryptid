#!/bin/sh
# tr.sh <traceID>  -> full trace JSON (every attribute, incl. service.version)
. "$(dirname "$0")/lib.sh"
grafana_curl "/api/datasources/proxy/uid/tempo/api/traces/$1"
