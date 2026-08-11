#!/usr/bin/env python3
"""Redundant-path SSH runner for the lab WHM / WordPress MCP servers.

Provides TWO layers of redundancy so we never lose access:
  - Routes: SSH_HOSTS is a comma-separated list tried in order (e.g. the public
    hostname first, then the headscale mesh IP). First reachable+authenticating
    host wins.
  - Auth:   for each host, SSH key (SSH_KEY) is tried first, then password
    (SSH_PASSWORD). Either alone is sufficient.

Env vars:
  SSH_HOSTS     comma-separated hosts to try in order (SSH_HOST also accepted)
  SSH_USER      login user (default: root)
  SSH_PORT      port (default: 22)
  SSH_KEY       path to a private key file (optional)
  SSH_PASSWORD  login password (optional)
  SSH_COMMAND   command to run remotely
  SSH_TIMEOUT   overall command timeout in seconds (default: 60)

Emits one JSON line: {"exit_code","stdout","stderr","via_host","auth_method"}.
Never raises to the caller — every failure is reported as exit_code -1 with the
aggregated reasons in stderr, so the Node side always gets structured output.
"""
import os
import sys
import json

try:
    import paramiko
except Exception as e:  # pragma: no cover
    print(json.dumps({"exit_code": -1, "stdout": "",
                      "stderr": f"paramiko import failed: {e}"}))
    sys.exit(0)


def _new_client():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    return c


def _connect(host, port, user, key, password, timeout):
    """Return (client, method) on success, or (None, reasons) on failure."""
    reasons = []
    common = dict(hostname=host, port=port, username=user,
                  timeout=min(timeout, 20), banner_timeout=20, auth_timeout=20,
                  look_for_keys=False, allow_agent=False)
    if key and os.path.exists(key):
        c = _new_client()
        try:
            c.connect(key_filename=key, **common)
            return c, "key"
        except Exception as e:
            reasons.append(f"key:{type(e).__name__}")
            try:
                c.close()
            except Exception:
                pass
    if password:
        c = _new_client()
        try:
            c.connect(password=password, **common)
            return c, "password"
        except Exception as e:
            reasons.append(f"password:{type(e).__name__}")
            try:
                c.close()
            except Exception:
                pass
    return None, ";".join(reasons) or "no-auth-available"


def main():
    raw_hosts = os.environ.get("SSH_HOSTS") or os.environ.get("SSH_HOST", "")
    hosts = [h.strip() for h in raw_hosts.split(",") if h.strip()]
    user = os.environ.get("SSH_USER", "root")
    port = int(os.environ.get("SSH_PORT", "22"))
    key = os.environ.get("SSH_KEY", "")
    password = os.environ.get("SSH_PASSWORD", "")
    command = os.environ.get("SSH_COMMAND", "")
    timeout = int(os.environ.get("SSH_TIMEOUT", "60"))

    if not hosts or not command:
        print(json.dumps({"exit_code": -1, "stdout": "",
                          "stderr": "SSH_HOSTS and SSH_COMMAND are required"}))
        return

    errors = []
    for host in hosts:
        client, method = _connect(host, port, user, key, password, timeout)
        if client is None:
            errors.append(f"{host}: {method}")
            continue
        try:
            stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
            out = stdout.read().decode("utf-8", "replace")
            err = stderr.read().decode("utf-8", "replace")
            code = stdout.channel.recv_exit_status()
            print(json.dumps({"exit_code": code, "stdout": out, "stderr": err,
                              "via_host": host, "auth_method": method}))
            return
        except Exception as e:
            errors.append(f"{host}(exec):{type(e).__name__}:{e}")
        finally:
            try:
                client.close()
            except Exception:
                pass

    print(json.dumps({"exit_code": -1, "stdout": "",
                      "stderr": "all routes failed: " + " | ".join(errors)}))


if __name__ == "__main__":
    main()
