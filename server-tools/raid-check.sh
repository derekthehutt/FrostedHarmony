#!/usr/bin/env bash
# Checks the Areca RAID controller and emails an alert when its health changes.
#
# Install (see docs/RAID-SETUP.md, Part 8):
#   sudo install -m 755 raid-check.sh /usr/local/sbin/raid-check.sh
#   sudo nano /etc/raid-check.conf      (email settings, chmod 600)
#   sudo /usr/local/sbin/raid-check.sh --test
#
# Usage:
#   raid-check.sh          check now; email only if the status changed since last run
#   raid-check.sh --test   always send an email with the current status

set -u

CONFIG=/etc/raid-check.conf
STATE_DIR=/var/lib/raid-check
STATE_FILE="$STATE_DIR/last-status"

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo." >&2
  exit 1
fi
if [[ ! -r $CONFIG ]]; then
  echo "Missing $CONFIG. See docs/RAID-SETUP.md, Part 8." >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$CONFIG"

CLI=${CLI:-/usr/local/sbin/cli64}
SMTP_HOST=${SMTP_HOST:-smtp.gmail.com}
SMTP_PORT=${SMTP_PORT:-465}
SMTP_PASS=${SMTP_PASS// /}
MAIL_FROM=${MAIL_FROM:-$SMTP_USER}
HOST=$(hostname)

send_mail() {
  local subject=$1 body=$2 msg netrc rc
  msg=$(mktemp)
  netrc=$(mktemp)
  chmod 600 "$msg" "$netrc"
  printf 'machine %s login %s password %s\n' "$SMTP_HOST" "$SMTP_USER" "$SMTP_PASS" > "$netrc"
  printf 'From: RAID monitor <%s>\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n' \
    "$MAIL_FROM" "$MAIL_TO" "$subject" "$(date -R)" "$body" > "$msg"
  curl --silent --show-error --ssl-reqd \
    --url "smtps://${SMTP_HOST}:${SMTP_PORT}" \
    --netrc-file "$netrc" \
    --mail-from "$MAIL_FROM" --mail-rcpt "$MAIL_TO" \
    --upload-file "$msg"
  rc=$?
  rm -f "$msg" "$netrc"
  return $rc
}

if [[ -x $CLI ]]; then
  report=$(
    echo "=== Volume sets ===";  "$CLI" vsf info 2>&1
    echo; echo "=== RAID sets ==="; "$CLI" rsf info 2>&1
    echo; echo "=== Drives ===";    "$CLI" disk info 2>&1
  )
else
  report="Areca CLI not found at $CLI"
fi

if [[ ! -x $CLI ]] || ! grep -q 'Normal' <<<"$report"; then
  status=PROBLEM
elif grep -qiE 'degrad|fail|offline|incomplet|missing|rebuild' <<<"$report"; then
  status=PROBLEM
else
  status=OK
fi

mkdir -p "$STATE_DIR"
last=$(cat "$STATE_FILE" 2>/dev/null || echo UNKNOWN)
echo "$status" > "$STATE_FILE"
logger -t raid-check "RAID status: $status"

if [[ ${1:-} == --test ]]; then
  send_mail "[$HOST] RAID test message: status $status" "This is a test from raid-check.sh on $HOST.

$report" && echo "Test email sent. Status: $status"
elif [[ $status != "$last" && ! ( $last == UNKNOWN && $status == OK ) ]]; then
  if [[ $status == PROBLEM ]]; then
    subject="[$HOST] RAID PROBLEM - check the server"
    intro="The RAID array on $HOST needs attention. See docs/RAID-SETUP.md, Part 10 (When a drive fails)."
  else
    subject="[$HOST] RAID is healthy again"
    intro="The RAID array on $HOST is back to Normal."
  fi
  send_mail "$subject" "$intro

$report"
fi
