#!/usr/bin/env bash
# All-in-one forward-VPS setup.
#  1. sysctl + iptables PORTFWD chain + DNAT rules to main-VPS IP:ports + MASQUERADE
#  2. persists rules (iptables-persistent)
#  3. installs ipset + writes a HARDCODED static TM (Turkmenistan) CIDR list
#  4. installs tm-block-watch daemon: counts ONLY TM-source traffic to forwarded
#     IP:port pairs via mangle/TM_WATCH chain.
#       - IDLE: waits for first TM-source packet to a forwarded port
#       - ACTIVE: TM traffic flowing
#       - SUSPECT: TM traffic stopped for SILENCE_THRESHOLD; runs final TM
#                  probe pings — if all fail, POST alert + EXIT (no cooldown,
#                  a replacement forward VPS will take over)
#  5. installs systemd unit (Restart=on-failure so clean exit stays stopped)
#
# Edit FORWARD_RULES below if main-VPS IP:port list changes.
# Edit TM_CIDRS below to update the Turkmenistan IP blocklist.
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
PORTFWD_DIR="/etc/portfwd"
TM_LIST_PATH="${PORTFWD_DIR}/tm-cidrs.txt"
RULES_PATH="${PORTFWD_DIR}/rules.txt"

# ---- TM CIDR list (HARDCODED, static) ----------------------------------------
# Curated Turkmenistan blocks — primarily AS20661 (Turkmentelecom, the national
# backbone) and AS51495 (Ashgabat City Telephone Network), plus other registered
# TM ranges. Update this list manually if BGP allocations change.
TM_CIDRS=(
  "5.62.60.0/22"
  "5.181.108.0/22"
  "31.28.0.0/19"
  "31.31.224.0/19"
  "41.220.184.0/22"
  "80.83.224.0/20"
  "81.21.135.0/24"
  "81.95.176.0/20"
  "82.131.0.0/19"
  "85.94.0.0/19"
  "89.235.96.0/20"
  "92.62.124.0/22"
  "95.85.96.0/19"
  "159.255.160.0/19"
  "178.236.144.0/20"
  "185.94.96.0/22"
  "195.158.0.0/19"
  "213.230.64.0/19"
  "217.174.224.0/19"
)

# ------------------------------------------------------------------------------

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

IFACE="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')"
PUBIP="$(ip -4 addr show dev "$IFACE" | awk '/inet /{print $2}' | cut -d/ -f1 | head -n1)"

echo "[1/9] sysctl (ip_forward + rp_filter) ..."
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

echo "[2/9] installing packages (iptables-persistent, ipset, curl) ..."
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y >/dev/null 2>&1 || true
  apt-get install -y iptables-persistent ipset curl >/dev/null 2>&1 || true
fi

echo "[3/9] iptables NAT chains + DNAT rules (iface=$IFACE pubip=$PUBIP) ..."
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

echo "[4/9] writing forward rules + static TM CIDR list to ${PORTFWD_DIR} ..."
mkdir -p "$PORTFWD_DIR"

: > "$RULES_PATH"
for r in "${FORWARD_RULES[@]}"; do
  echo "$r" >> "$RULES_PATH"
done
chmod 0644 "$RULES_PATH"

: > "$TM_LIST_PATH"
for c in "${TM_CIDRS[@]}"; do echo "$c" >> "$TM_LIST_PATH"; done
chmod 0644 "$TM_LIST_PATH"
echo "    wrote ${#TM_CIDRS[@]} TM CIDRs to $TM_LIST_PATH"

echo "[5/9] persisting iptables NAT/filter rules ..."
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
echo "[6/9] using API_URL=$API_URL"

echo "[7/9] writing /usr/local/sbin/tm-block-watch.sh ..."
cat > /usr/local/sbin/tm-block-watch.sh <<DAEMON
#!/usr/bin/env bash
# tm-block-watch
#   setup  -> (re)build ipset tm_ips + mangle/TM_WATCH chain from
#             ${RULES_PATH} and ${TM_LIST_PATH}. Idempotent.
#   watch  -> main loop: read TM_WATCH counter, on silence run TM probes
#             and POST alert to bot.
set -euo pipefail

API_URL="${API_URL}"
API_TOKEN="${API_TOKEN}"
RULES_PATH="${RULES_PATH}"
TM_LIST_PATH="${TM_LIST_PATH}"

IPSET_NAME="tm_ips"
MANGLE_CHAIN="TM_WATCH"
PROBE_HOSTS=(turkmenportal.com localspeed.telecom.tm speedtest.telecom.tm)
TICK=5
SILENCE_THRESHOLD=15
PROBE_TIMEOUT=3
# no COOLDOWN: after a confirmed block we send the alert and exit — a new
# forward VPS will take over, so this daemon has nothing left to watch.

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

read_counter() {
  iptables -t mangle -nvxL "\$MANGLE_CHAIN" 2>/dev/null \
    | awk 'NR>2 {sum+=\$1} END {print sum+0}'
}

probe_one() { ping -c 1 -W "\$PROBE_TIMEOUT" "\$1" >/dev/null 2>&1; }

# Returns 0 if EVERY probe host failed; short-circuits on first success.
probe_all_fail() {
  local h
  for h in "\${PROBE_HOSTS[@]}"; do
    probe_one "\$h" && { log "probe OK: \$h (skip alert)"; return 1; }
  done
  log "probes all failed: \${PROBE_HOSTS[*]}"
  return 0
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

setup() {
  command -v ipset >/dev/null 2>&1 || { echo "ipset not installed" >&2; exit 1; }
  [ -s "\$TM_LIST_PATH" ] || { echo "missing \$TM_LIST_PATH" >&2; exit 1; }
  [ -s "\$RULES_PATH" ]   || { echo "missing \$RULES_PATH"   >&2; exit 1; }

  local iface; iface="\$(read_iface)"
  [ -n "\$iface" ] || { echo "could not detect default iface" >&2; exit 1; }

  # (re)build ipset of TM CIDRs in a single ipset-restore call (one fork)
  local cidr count=0 restore_cmds
  restore_cmds="create \$IPSET_NAME hash:net family inet -exist"\$'\n'
  restore_cmds+="flush \$IPSET_NAME"\$'\n'
  while IFS= read -r cidr; do
    cidr="\${cidr%%#*}"
    cidr="\${cidr//[[:space:]]/}"
    [ -n "\$cidr" ] || continue
    restore_cmds+="add \$IPSET_NAME \$cidr"\$'\n'
    count=\$((count + 1))
  done < "\$TM_LIST_PATH"
  printf '%s' "\$restore_cmds" | ipset restore -exist
  log "setup: ipset \$IPSET_NAME populated with \$count CIDRs"

  # (re)build mangle TM_WATCH chain
  iptables -t mangle -N "\$MANGLE_CHAIN" 2>/dev/null || true
  iptables -t mangle -F "\$MANGLE_CHAIN"
  iptables -t mangle -C PREROUTING -i "\$iface" -j "\$MANGLE_CHAIN" 2>/dev/null \
    || iptables -t mangle -I PREROUTING 1 -i "\$iface" -j "\$MANGLE_CHAIN"

  # Build CSV port list, then add ONE tcp + ONE udp rule using -m multiport.
  # Counter sum = TM-source packets to any forwarded port. Two rules instead
  # of 2*N keeps the chain tiny → kernel matching + counter readback are O(1)-ish.
  local ports="" line port
  while IFS= read -r line; do
    line="\${line%%#*}"
    [ -n "\${line//[[:space:]]/}" ] || continue
    read -r port _ <<<"\$line"
    [ -n "\$port" ] || continue
    ports="\${ports:+\$ports,}\$port"
  done < "\$RULES_PATH"
  [ -n "\$ports" ] || { echo "no ports parsed from \$RULES_PATH" >&2; exit 1; }

  iptables -t mangle -A "\$MANGLE_CHAIN" \
    -m set --match-set "\$IPSET_NAME" src \
    -p tcp -m multiport --dports "\$ports" -j RETURN
  iptables -t mangle -A "\$MANGLE_CHAIN" \
    -m set --match-set "\$IPSET_NAME" src \
    -p udp -m multiport --dports "\$ports" -j RETURN
  log "setup: \$MANGLE_CHAIN watching ports=\$ports on iface=\$iface (2 rules)"
}

watch_loop() {
  local state="IDLE"
  local last_counter; last_counter="\$(read_counter)"
  local silent_for=0
  local pubip; pubip="\$(read_pubip)"

  log "started — pubip=\$pubip chain=mangle/\$MANGLE_CHAIN initial_counter=\$last_counter probes=\${PROBE_HOSTS[*]}"

  while true; do
    sleep "\$TICK"
    local cur delta
    cur="\$(read_counter)"
    delta=\$((cur - last_counter))
    last_counter="\$cur"

    case "\$state" in
      IDLE)
        if [ "\$delta" -gt 0 ]; then
          state="ACTIVE"; silent_for=0
          log "state: IDLE → ACTIVE (delta=\$delta TM bytes)"
        fi
        ;;
      ACTIVE)
        if [ "\$delta" -gt 0 ]; then
          silent_for=0
        else
          silent_for=\$((silent_for + TICK))
          if [ "\$silent_for" -ge "\$SILENCE_THRESHOLD" ]; then
            state="SUSPECT"
            log "state: ACTIVE → SUSPECT (no TM traffic for \${silent_for}s)"
          fi
        fi
        ;;
      SUSPECT)
        if probe_all_fail; then
          pubip="\$(read_pubip)"
          send_alert "\$pubip" "\${SILENCE_THRESHOLD}s no TM-source traffic + \${#PROBE_HOSTS[@]} TM probes failed"
          log "alert sent — exiting (a new forward VPS will take over)"
          exit 0
        else
          state="ACTIVE"; silent_for=0
          log "state: SUSPECT → ACTIVE (false alarm — TM probes OK)"
        fi
        ;;
    esac
  done
}

cmd="\${1:-watch}"
case "\$cmd" in
  setup) setup ;;
  watch) watch_loop ;;
  *) echo "usage: \$0 {setup|watch}" >&2; exit 2 ;;
esac
DAEMON
chmod 0755 /usr/local/sbin/tm-block-watch.sh

echo "[8/9] writing systemd unit ..."
cat > /etc/systemd/system/tm-block-watch.service <<'UNIT'
[Unit]
Description=TM block detector — counts TM-source traffic to forwarded ports, alerts bot on stoppage
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStartPre=/usr/local/sbin/tm-block-watch.sh setup
ExecStart=/usr/local/sbin/tm-block-watch.sh watch
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# resource caps — keep this lightweight, never compete with forwarded traffic
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

echo "[9/9] enabling service ..."
systemctl daemon-reload
systemctl enable --now tm-block-watch
systemctl restart tm-block-watch

systemctl --no-pager --lines=0 status tm-block-watch || true
echo
echo "----- last 20 log lines -----"
journalctl -u tm-block-watch -n 20 --no-pager || true
echo
echo "done. pubip=$PUBIP iface=$IFACE"
echo "  TM CIDRs : $TM_LIST_PATH ($(wc -l <"$TM_LIST_PATH") entries)"
echo "  forwards : $RULES_PATH"
echo "Follow logs: journalctl -u tm-block-watch -f"
echo "Inspect counters: iptables -t mangle -nvxL TM_WATCH"
echo "Inspect TM ipset: ipset list tm_ips | head"
