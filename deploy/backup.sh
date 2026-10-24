#!/usr/bin/env bash
# The tracker's database, sealed with age to a public key and copied to an R2 bucket:
# under daily/ every night and also under weekly/ on Sundays (UTC), which the bucket's
# lifecycle rules keep 14 and 56 days. The bucket credential is a curl configuration
# (user = "ACCESS:SECRET") that only 20q-backup.service receives. Restore: age --decrypt
# with the identity kept off the host, stop 20q-tracker.timer and 20q.service, put the
# file at /var/lib/20q/20q.sqlite owned by q20-tracker, start both.
set -euo pipefail
: "${Q20_BACKUP_AGE_RECIPIENT:?}" "${Q20_BACKUP_S3_ENDPOINT:?}" "${Q20_BACKUP_S3_BUCKET:?}"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
name="20q-$(date -u +%Y%m%dT%H%M%SZ).sqlite.age"
sqlite3 /var/lib/20q/20q.sqlite ".backup '$work/20q.sqlite'"
age --encrypt --recipient "$Q20_BACKUP_AGE_RECIPIENT" --output "$work/$name" "$work/20q.sqlite"
# The bucket refuses a body whose digest is not this one.
digest="$(sha256sum "$work/$name" | cut -d' ' -f1)"
folders=daily
[ "$(date -u +%u)" != 7 ] || folders="daily weekly"
for folder in $folders; do
  curl -fsS --retry 3 --config "$CREDENTIALS_DIRECTORY/s3" --aws-sigv4 aws:amz:auto:s3 \
    --header "x-amz-content-sha256: $digest" --upload-file "$work/$name" \
    "$Q20_BACKUP_S3_ENDPOINT/$Q20_BACKUP_S3_BUCKET/$folder/$name"
  echo "Copied $folder/$name ($(stat -c %s "$work/$name") bytes)."
done
