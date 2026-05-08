#!/usr/bin/env bash
# All-in-one forward-VPS setup.
#  1. sysctl + iptables PORTFWD chain + DNAT rules to main-VPS IP:ports + MASQUERADE
#  2. persists rules (iptables-persistent)
#  3. installs tm-block-watch daemon + systemd unit
#  4. enables service, prints recent logs
#
# Edit FORWARD_RULES below if main-VPS IP:port list changes.
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

echo "[2/7] iptables chains + DNAT rules (iface=$IFACE pubip=$PUBIP) ..."
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

echo "[3/7] persisting iptables rules ..."
mkdir -p /etc/iptables
iptables-save > /etc/iptables/rules.v4
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y iptables-persistent >/dev/null 2>&1 || true
  command -v netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save >/dev/null 2>&1 || true
fi

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
echo "[4/7] using API_URL=$API_URL"

echo "[5/7] writing /usr/local/sbin/tm-block-watch.sh ..."
cat > /usr/local/sbin/tm-block-watch.sh <<DAEMON
#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL}"
API_TOKEN="${API_TOKEN}"

PROBE_HOSTS=(turkmenportal.com localspeed.telecom.tm speedtest.telecom.tm)
TICK=1
SILENCE_THRESHOLD=10
PROBE_TIMEOUT=5
COOLDOWN=90
CHAIN="PORTFWD"
TABLE="nat"

log() { echo "[\$(date -Is)] \$*"; }

read_counter() {
  iptables -t "\$TABLE" -nvxL "\$CHAIN" 2>/dev/null \
    | awk 'NR>2 {sum+=\$1} END {print sum+0}'
}

read_pubip() {
  local iface
  iface=\$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if(\$i=="dev"){print \$(i+1); exit}}')
  ip -4 addr show dev "\$iface" | awk '/inet /{print \$2}' | cut -d/ -f1 | head -n1
}

probe_one() { ping -c 1 -W "\$PROBE_TIMEOUT" "\$1" >/dev/null 2>&1; }

probe_all_fail() {
  local fail=0
  for h in "\${PROBE_HOSTS[@]}"; do
    if probe_one "\$h"; then
      log "probe OK: \$h"
      return 1
    fi
    fail=\$((fail + 1))
    log "probe FAIL: \$h"
  done
  [ "\$fail" -ge "\${#PROBE_HOSTS[@]}" ]
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
    || log "alert POST failed (will retry on next cycle)"
}

state="IDLE"
last_counter="\$(read_counter)"
silent_for=0
cooldown_left=0
pubip="\$(read_pubip)"

log "started — pubip=\$pubip chain=\$CHAIN initial_counter=\$last_counter probes=\${PROBE_HOSTS[*]}"

while true; do
  sleep "\$TICK"
  cur="\$(read_counter)"
  delta=\$((cur - last_counter))
  last_counter="\$cur"

  case "\$state" in
    IDLE)
      if [ "\$delta" -gt 0 ]; then
        state="ACTIVE"; silent_for=0
        log "state: IDLE → ACTIVE (delta=\$delta)"
      fi
      ;;
    ACTIVE)
      if [ "\$delta" -gt 0 ]; then
        silent_for=0
      else
        silent_for=\$((silent_for + TICK))
        if [ "\$silent_for" -ge "\$SILENCE_THRESHOLD" ]; then
          state="SUSPECT"
          log "state: ACTIVE → SUSPECT (silent \${silent_for}s)"
        fi
      fi
      ;;
    SUSPECT)
      if probe_all_fail; then
        pubip="\$(read_pubip)"
        send_alert "\$pubip" "\${SILENCE_THRESHOLD}s no traffic + \${#PROBE_HOSTS[@]} TM probes failed"
        state="COOLDOWN"; cooldown_left="\$COOLDOWN"
        log "state: SUSPECT → COOLDOWN (\${COOLDOWN}s)"
      else
        state="ACTIVE"; silent_for=0
        log "state: SUSPECT → ACTIVE (false alarm)"
      fi
      ;;
    COOLDOWN)
      cooldown_left=\$((cooldown_left - TICK))
      if [ "\$cooldown_left" -le 0 ]; then
        state="IDLE"; silent_for=0
        log "state: COOLDOWN → IDLE"
      fi
      ;;
  esac
done
DAEMON
chmod 0755 /usr/local/sbin/tm-block-watch.sh

echo "[6/7] writing systemd unit ..."
cat > /etc/systemd/system/tm-block-watch.service <<'UNIT'
[Unit]
Description=TM block detector — watches PORTFWD traffic and reports blocks to update-subscription-bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/sbin/tm-block-watch.sh
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

echo "[7/7] enabling service ..."
systemctl daemon-reload
systemctl enable --now tm-block-watch
systemctl restart tm-block-watch

systemctl --no-pager --lines=0 status tm-block-watch || true
echo
echo "----- last 20 log lines -----"
journalctl -u tm-block-watch -n 20 --no-pager || true
echo
echo "✅ done. pubip=$PUBIP iface=$IFACE"
echo "Follow logs: journalctl -u tm-block-watch -f"
