#!/usr/bin/env bash
# All-in-one forward-VPS setup.
#  1. sysctl + iptables PORTFWD chain + DNAT rules to main-VPS IP:ports + MASQUERADE
#  2. persists rules (iptables-persistent)
#  3. installs tm-block-watch daemon: ACTIVE probing strategy
#       - every ~TICK seconds, opens a TCP handshake (port 443) to each
#         TM probe host until one succeeds
#       - on FAIL_THRESHOLD consecutive all-fail rounds → POST alert + exit
#       - stealth: TCP-handshake only, NO HTTP request, NO access-log trace
#       - detection latency: ~TICK * FAIL_THRESHOLD (≈30s by default)
#  4. installs systemd unit (Restart=on-failure so clean exit stays stopped)
#
# Edit FORWARD_RULES below if main-VPS IP:port list changes.
# Edit PROBE_HOSTS (in daemon template) to change which TM hosts we probe.
#
# Usage:
#   sudo ./bootstrap.sh
#   sudo ./bootstrap.sh <bot-host:port>
#   sudo BOT_HOST=<bot-host:port> ./bootstrap.sh

set -euo pipefail

# ---- main-VPS forwards: "<port> <ip>" ----------------------------------------
FORWARD_RULES=(
  "46707 114.129.8.29"
  "8080  38.180.164.187"
  "1080  217.149.30.32"
  "49402 65.109.220.230"
  "1900  185.167.97.52"
  "443   51.77.32.235"
  "8443  91.107.252.130"
)

# ---- daemon constants --------------------------------------------------------
API_TOKEN="l3AFI8Cil4-fTfZFbZGpisNxmtw0IGGtjAzDMJYqbassBxeqo-kkYSrOReDxVWh6"

# ------------------------------------------------------------------------------

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

IFACE="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')"
PUBIP="$(ip -4 addr show dev "$IFACE" | awk '/inet /{print $2}' | cut -d/ -f1 | head -n1)"

echo "[1/7] sysctl (ip_forward + rp_filter) ..."
sysctl -w net.ipv4.ip_forward=1 >/dev/null
sysctl -w net.ipv4.conf.all.rp_filter=0 >/dev/null
sysctl -w net.ipv4.conf.default.rp_filter=0 >/dev/null
sysctl -w "net.ipv4.conf.${IFACE}.rp_filter=0" >/dev/null || true
mkdir -p /etc/sysctl.d
cat > /etc/sysctl.d/99-portfwd.conf <<SYS
net.ipv4.ip_forward=1
net.ipv4.conf.all.rp_filter=0
net.ipv4.conf.default.rp_filter=0
SYS

echo "[2/7] installing packages (iptables-persistent, curl, coreutils) ..."
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y iptables-persistent curl coreutils >/dev/null 2>&1 || true
fi

echo "[3/7] iptables NAT chains + DNAT rules (iface=$IFACE pubip=$PUBIP) ..."
iptables -t nat -N PORTFWD 2>/dev/null || true
iptables -t nat -F PORTFWD
iptables -N PORTFWD_FWD 2>/dev/null || true
iptables -F PORTFWD_FWD

iptables -t nat -C PREROUTING -i "$IFACE" -j PORTFWD 2>/dev/null \
  || iptables -t nat -I PREROUTING 1 -i "$IFACE" -j PORTFWD
iptables -t nat -C OUTPUT -d "$PUBIP/32" -j PORTFWD 2>/dev/null \
  || iptables -t nat -I OUTPUT 1 -d "$PUBIP/32" -j PORTFWD
iptables -C FORWARD -j PORTFWD_FWD 2>/dev/null \
  || iptables -I FORWARD 1 -j PORTFWD_FWD
iptables -C PORTFWD_FWD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null \
  || iptables -A PORTFWD_FWD -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

iptables -t nat -C POSTROUTING -o "$IFACE" -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -o "$IFACE" -j MASQUERADE

for r in "${FORWARD_RULES[@]}"; do
  read -r port ip <<<"$r"
  iptables -t nat -A PORTFWD -p tcp --dport "$port" -j DNAT --to-destination "$ip:$port"
  iptables -t nat -A PORTFWD -p udp --dport "$port" -j DNAT --to-destination "$ip:$port"
  iptables -A PORTFWD_FWD -p tcp -d "$ip" --dport "$port" -j ACCEPT
  iptables -A PORTFWD_FWD -p udp -d "$ip" --dport "$port" -j ACCEPT
done

echo "[4/7] persisting iptables NAT/filter rules ..."
mkdir -p /etc/iptables
iptables-save > /etc/iptables/rules.v4
command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null 2>&1 || true

BOT_HOST="${BOT_HOST:-${1:-}}"
if [ -z "$BOT_HOST" ]; then
  echo
  echo "Enter bot host as domain-or-ip:port (e.g. bot.example.com:3000 or 1.2.3.4:3000)"
  read -r -p "  bot host: " BOT_HOST
fi
[ -z "$BOT_HOST" ] && { echo "ERROR: bot host is required." >&2; exit 1; }

BOT_HOST="${BOT_HOST#http://}"
BOT_HOST="${BOT_HOST#https://}"
BOT_HOST="${BOT_HOST%/}"
API_URL="http://${BOT_HOST}"
echo "[5/7] using API_URL=$API_URL"

echo "[6/7] writing /usr/local/sbin/tm-block-watch.sh ..."
cat > /usr/local/sbin/tm-block-watch.sh <<DAEMON
#!/usr/bin/env bash
# tm-block-watch — ACTIVE probing variant.
#
# Strategy:
#   Every ~TICK seconds, attempt a TCP handshake (port 443) to each TM
#   probe host. Stop on first success. If ALL hosts fail FAIL_THRESHOLD
#   rounds in a row → TM unreachable → POST alert + exit.
#
# Stealth properties of the probe:
#   - Pure TCP SYN/ACK/FIN — NO HTTP request, NO TLS handshake started
#   - Server sees an opened-then-closed socket with zero bytes transferred
#   - Apache/nginx/Cloudflare etc. do NOT log abandoned pre-request sockets
#   - Probe order is SHUFFLED per round (Fisher-Yates) so no single host
#     bears the full probe load → ~33 % of rounds each on average
#   - 20 % of rounds probe only ONE host → average ~2 conn/host/min,
#     invisible noise for any high-traffic site
#   - ±5 s jitter on the sleep interval so the cadence is not periodic
#
# Detection latency under block:  TICK * FAIL_THRESHOLD  ≈ 30 s

set -euo pipefail

API_URL="${API_URL}"
API_TOKEN="${API_TOKEN}"

# ---- probe config ----
PROBE_HOSTS=(turkmenportal.com localspeed.telecom.tm speedtest.telecom.tm)
PROBE_PORT=443
PROBE_TIMEOUT=3       # seconds per TCP-connect attempt
TICK=10               # base interval between rounds (jittered ±2 s)
FAIL_THRESHOLD=3      # consecutive all-fail rounds before raising alert

# bash builtin date formatter — no fork to /bin/date per log line
log() {
  local ts
  printf -v ts '%(%Y-%m-%dT%H:%M:%S%z)T' -1
  echo "[\$ts] \$*"
}

read_iface() {
  ip route get 1.1.1.1 2>/dev/null \
    | awk '{for(i=1;i<=NF;i++) if(\$i=="dev"){print \$(i+1); exit}}'
}

read_pubip() {
  local iface; iface="\$(read_iface)"
  ip -4 addr show dev "\$iface" | awk '/inet /{print \$2}' | cut -d/ -f1 | head -n1
}

# TCP handshake only. Uses bash's /dev/tcp + coreutils \`timeout\` so the
# connect attempt is bounded (the kernel default connect timeout is ~75s).
# Returns 0 on successful handshake, non-zero otherwise.
probe_one() {
  local host="\$1"
  timeout "\$PROBE_TIMEOUT" bash -c "exec 9<>/dev/tcp/\$host/\$PROBE_PORT" 2>/dev/null
}

# A round succeeds if ANY probe host accepts a TCP handshake.
#
# Stealth tweaks vs. naïve fixed-order:
#   - Fisher-Yates shuffle (pure bash, no forks) randomises which host gets
#     hit first each round → load distributed ~evenly across the 3 hosts
#     instead of host #1 carrying the entire probe pattern.
#   - 20 % of rounds probe ONE host only (random pick); the other 80 %
#     iterate the full shuffled list and short-circuit on first success.
#     This breaks the "fixed 1-conn-per-10s per IP" pattern that long-term
#     traffic analysis could correlate.
probe_round() {
  local hosts=("\${PROBE_HOSTS[@]}")
  local n=\${#hosts[@]}
  local i j tmp
  for (( i = n - 1; i > 0; i-- )); do
    j=\$(( RANDOM % (i + 1) ))
    tmp=\${hosts[i]}; hosts[i]=\${hosts[j]}; hosts[j]=\$tmp
  done

  local limit=\$n
  (( RANDOM % 5 == 0 )) && limit=1   # 20 % of rounds: single-host probe

  local k
  for (( k = 0; k < limit; k++ )); do
    probe_one "\${hosts[k]}" && return 0
  done
  return 1
}

send_alert() {
  local current_ip="\$1" reason="\$2"
  local body
  body=\$(printf '{"type":"forward","currentIp":"%s","reason":"%s"}' "\$current_ip" "\$reason")
  log "POST \$API_URL/alert/blocked  body=\$body"
  curl -fsS -m 15 \
    -H "Authorization: Bearer \$API_TOKEN" \
    -H "Content-Type: application/json" \
    -X POST "\$API_URL/alert/blocked" \
    -d "\$body" \
    || log "alert POST failed"
}

# ±5 s jitter so the probe cadence isn't perfectly periodic (harder to
# correlate by long-window pattern analysis on the target side).
sleep_jittered() {
  local jitter=\$(( (RANDOM % 11) - 5 ))   # -5 .. +5
  local s=\$(( TICK + jitter ))
  [ "\$s" -lt 1 ] && s=1
  sleep "\$s"
}

watch_loop() {
  local fail_streak=0
  local pubip; pubip="\$(read_pubip)"

  log "started — pubip=\$pubip probes=\${PROBE_HOSTS[*]} port=\$PROBE_PORT tick=\${TICK}s threshold=\$FAIL_THRESHOLD"

  while true; do
    if probe_round; then
      if [ "\$fail_streak" -gt 0 ]; then
        log "probes recovered after \$fail_streak failed round(s)"
      fi
      fail_streak=0
    else
      fail_streak=\$((fail_streak + 1))
      log "round FAIL (\$fail_streak/\$FAIL_THRESHOLD) — every TM host unreachable on tcp/\$PROBE_PORT"
      if [ "\$fail_streak" -ge "\$FAIL_THRESHOLD" ]; then
        pubip="\$(read_pubip)"
        send_alert "\$pubip" "\$((fail_streak * TICK))s active-probe failure to TM hosts"
        log "alert sent — exiting (replacement forward VPS will take over)"
        exit 0
      fi
    fi
    sleep_jittered
  done
}

watch_loop
DAEMON
chmod 0755 /usr/local/sbin/tm-block-watch.sh

echo "[7/7] writing systemd unit + enabling service ..."
cat > /etc/systemd/system/tm-block-watch.service <<'UNIT'
[Unit]
Description=TM block detector — active TCP-handshake probing of TM hosts; alerts bot on outage
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/sbin/tm-block-watch.sh
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# resource caps — stay tiny, never compete with forwarded traffic
Nice=10
IOSchedulingClass=idle
CPUSchedulingPolicy=batch
MemoryMax=32M
CPUQuota=5%
TasksMax=16
LimitNOFILE=256

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now tm-block-watch
systemctl restart tm-block-watch

systemctl --no-pager --lines=0 status tm-block-watch || true
echo
echo "----- last 20 log lines -----"
journalctl -u tm-block-watch -n 20 --no-pager || true
echo
echo "done. pubip=$PUBIP iface=$IFACE"
echo "Follow logs: journalctl -u tm-block-watch -f"
