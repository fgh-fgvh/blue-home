#!/bin/sh
# blue-hut 看护：每 60 秒检查一次端口；没通先等 8 秒复核（避开启动空窗），
# 仍不通才交给 ensure。绝不误杀正在启动的服务。
DIR=/root/blue-hut
cd "$DIR" || exit 1
alive() {
  CODE=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/room 2>/dev/null)
  [ -n "$CODE" ] && [ "$CODE" != "000" ]
}
while true; do
  if ! alive; then
    sleep 8
    if ! alive; then
      echo "[watchdog-hut] $(date '+%F %T') 复核后仍未通，交给 ensure" >> "$DIR/logs/watchdog.log"
      sh "$DIR/ensure-hut.sh"
      sleep 10
    fi
  fi
  sleep 60
done
