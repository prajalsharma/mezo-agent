#!/bin/sh
# Start as root, hand the data volume to the unprivileged user, then drop
# privileges and exec the app.
#
# WHY THIS EXISTS. A `chown` in the Dockerfile runs at BUILD time, and Railway
# mounts its persistent volume over /data at RUNTIME — so the build-time
# ownership is discarded and the mount arrives owned by root. A container that
# had already dropped to `node` (uid 1000) then got EACCES on the very file
# holding every user's encrypted key, and crash-looped on boot. That is exactly
# what happened, and it is why the ownership fix has to happen at runtime,
# against the mount that actually exists.
#
# `exec` matters throughout: node must end up as the direct successor of PID 1
# so Railway's SIGTERM on redeploy reaches the graceful shutdown handler in
# src/index.ts, rather than killing a shell wrapper (which Railway reports as
# "Deployment crashed").
set -e

DATA_DIR="${DATA_DIR:-/data}"
APP_USER="${APP_USER:-node}"

# Shell-quote the command so it can be passed through `su -c` intact. Doing this
# with positional parameters instead is subtly implementation-dependent, and a
# quoting bug here means a crash-loop in production.
shquote() {
  for arg in "$@"; do
    printf "'%s' " "$(printf '%s' "$arg" | sed "s/'/'\\\\''/g")"
  done
}

if [ "$(id -u)" = "0" ]; then
  # Every step here is BEST-EFFORT and must not abort the boot. If the volume is
  # missing or unwritable, the store raises a message that names the cause and
  # the fix; a bare `mkdir: Read-only file system` from a shell wrapper, under
  # `set -e`, would replace that with a cryptic crash-loop. (Caught by the
  # simulated-root test below, not by inspection.)
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  # -R because a volume from an earlier root-owned deploy already holds files
  # that the unprivileged user must be able to read.
  chown -R "$APP_USER":"$APP_USER" "$DATA_DIR" 2>/dev/null || true
  chmod 700 "$DATA_DIR" 2>/dev/null || true

  # Drop privileges with whichever tool this base image ships. On Debian
  # bookworm `setpriv` and `runuser` live in util-linux-extra, which slim images
  # do NOT install, so `su` (from util-linux proper) is usually the one that
  # runs. Trying all three keeps this working across base-image changes.
  #
  # Each is PROBED before it is exec'd. `exec` is the point of no return: if the
  # command turns out not to work (missing PAM config, a locked account, a
  # base-image quirk) the container dies and crash-loops, which is the failure
  # mode this whole file exists to prevent. A probe costs one fork.
  if command -v setpriv >/dev/null 2>&1 && setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups -- true 2>/dev/null; then
    exec setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups -- "$@"
  fi
  if command -v runuser >/dev/null 2>&1 && runuser -u "$APP_USER" -- true 2>/dev/null; then
    exec runuser -u "$APP_USER" -- "$@"
  fi
  if command -v su >/dev/null 2>&1 && su -s /bin/sh -c 'exit 0' "$APP_USER" 2>/dev/null; then
    exec su -s /bin/sh -c "exec $(shquote "$@")" "$APP_USER"
  fi

  # NEVER crash-loop over this. A bot running as root is a far smaller problem
  # than a bot that is down: while it restarts every few seconds nobody can
  # reach their funds at all. Log it loudly and keep serving.
  echo "[entrypoint] WARNING: no setpriv/runuser/su found - continuing as ROOT." >&2
  exec "$@"
fi

# Already unprivileged (a platform that sets its own USER). Nothing to fix here;
# if the volume is not writable the store says so clearly on boot.
exec "$@"
