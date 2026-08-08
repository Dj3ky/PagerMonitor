#!/bin/sh
set -e

: "${ICECAST_SOURCE_PASSWORD:?ICECAST_SOURCE_PASSWORD is required}"
: "${ICECAST_ADMIN_PASSWORD:=changeme}"

envsubst '${ICECAST_SOURCE_PASSWORD} ${ICECAST_ADMIN_PASSWORD}' \
  < /etc/icecast2/icecast.xml.template > /etc/icecast2/icecast.xml

exec icecast2 -c /etc/icecast2/icecast.xml
