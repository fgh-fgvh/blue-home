#!/bin/sh
# 幂等守护 blue-hut（v2）
# 相对旧版改了两处：
#   1) 探活不再用 /dev/tcp（这台机器 /bin/sh 是 dash，/dev/tcp 是 bash 专有，会永久误判"不通"→ 看护每 60 秒自杀）
#   2) 清场只杀真正的 node server.js，且必须同目录，绝不误杀跑脚本的父 shell
DIR=${HUT_DIR:-/root/blue-hut}
cd "$DIR" || exit 1
mkdir -p logs
LOCK="$DIR/.ensure.lock"

if ! mkdir "$LOCK" 2>/dev/null; then
  NOW=$(date +%s)
  OLD=$(stat -c %Y "$LOCK" 2>/dev/null || echo "$NOW")
  if [ $((NOW - OLD)) -gt 120 ]; then
    rmdir "$LOCK" 2>/dev/null
    mkdir "$LOCK" 2>/dev/null || exit 0
  else
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT INT TERM
export HOME=/root

alive() {
  CODE=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HUT_PORT:-3001}/room" 2>/dev/null)
  [ -n "$CODE" ] && [ "$CODE" != "000" ]
}

# 只列：comm=node、cwd=本目录、命令行里带 server.js
mine() {
  for pid in $(pgrep -f "server.js" 2>/dev/null); do
    [ "$(cat /proc/"$pid"/comm 2>/dev/null)" = "node" ] || continue
    [ "$(readlink /proc/"$pid"/cwd 2>/dev/null)" = "$DIR" ] || continue
    case "$(tr '\0' ' ' < /proc/"$pid"/cmdline 2>/dev/null)" in
      *server.js*) echo "$pid" ;;
    esac
  done
}

# 1) 看护不在就拉起
if ! pgrep -f 'watchdog-hut.sh' >/dev/null 2>&1; then
  echo "[ensure-hut] $(date '+%F %T') 看护不在，拉起" >> "$DIR/logs/watchdog.log"
  nohup sh "$DIR/watchdog-hut.sh" >/dev/null 2>&1 &
fi

# 2) 端口活着 = 正常，收工
if alive; then exit 0; fi

# 3) 端口没通：先给 8 秒（可能正在启动），仍不通才处理
sleep 8
if alive; then exit 0; fi

# 4) 真死了：只清自己的残留进程
for pid in $(mine); do kill "$pid" 2>/dev/null && echo "[ensure-hut] 停 PID $pid"; done
sleep 2
for pid in $(mine); do kill -9 "$pid" 2>/dev/null && echo "[ensure-hut] 强停 PID $pid"; done
sleep 1

echo "[ensure-hut] $(date '+%F %T') 确认已死，清场后拉起" >> "$DIR/logs/watchdog.log"
nohup node server.js >> "$DIR/logs/hut.log" 2>&1 &
sleep 5
exit 0
