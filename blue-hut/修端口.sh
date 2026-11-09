#!/bin/sh
# 修端口：把 /root/blue-hut 里多余的 node server.js 收掉，只留干净的一份
# 用法：sh 修端口.sh
DIR=${HUT_DIR:-/root/blue-hut}
API_PORT=${API_PORT:-3000}
HUT_PORT=${HUT_PORT:-3001}
HTTPS_PORT=${HTTPS_PORT:-3002}

cd "$DIR" 2>/dev/null || { echo "找不到 $DIR"; exit 1; }
mkdir -p logs

# 端口探活：curl 拿不到响应就算死（不依赖 /dev/tcp，各版本 sh 都能用）
alive() {
  CODE=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$1/" 2>/dev/null)
  [ "$CODE" != "000" ] && [ -n "$CODE" ]
}

echo "======== 1) 现在端口谁占着 ========"
for p in "$API_PORT" "$HUT_PORT" "$HTTPS_PORT"; do
  if alive "$p"; then echo "  $p  有人"; else echo "  $p  空着 / 不通"; fi
done

echo "======== 2) 小屋后端有几份 ========"
CNT=0
for pid in $(pgrep -f "server.js" 2>/dev/null); do
  [ "$(cat /proc/"$pid"/comm 2>/dev/null)" = "node" ] || continue
  CWD=$(readlink /proc/"$pid"/cwd 2>/dev/null)
  [ "$CWD" = "$DIR" ] || continue
  # 确认它的启动参数确实是 server.js
  CMD=$(tr '\0' ' ' < /proc/"$pid"/cmdline 2>/dev/null)
  case "$CMD" in *server.js*) ;; *) continue ;; esac
  echo "  PID $pid  已运行 $(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')"
  CNT=$((CNT + 1))
done
[ "$CNT" = "0" ] && echo "  没有（干净）"

echo "======== 3) 收掉多余的 ========"
for pid in $(pgrep -f "server.js" 2>/dev/null); do
  [ "$(cat /proc/"$pid"/comm 2>/dev/null)" = "node" ] || continue
  CWD=$(readlink /proc/"$pid"/cwd 2>/dev/null)
  [ "$CWD" = "$DIR" ] || continue
  CMD=$(tr '\0' ' ' < /proc/"$pid"/cmdline 2>/dev/null)
  case "$CMD" in *server.js*) ;; *) continue ;; esac
  kill "$pid" 2>/dev/null && echo "  已停止 PID $pid"
done
sleep 2
for pid in $(pgrep -f "server.js" 2>/dev/null); do
  [ "$(cat /proc/"$pid"/comm 2>/dev/null)" = "node" ] || continue
  CWD=$(readlink /proc/"$pid"/cwd 2>/dev/null)
  [ "$CWD" = "$DIR" ] || continue
  CMD=$(tr '\0' ' ' < /proc/"$pid"/cmdline 2>/dev/null)
  case "$CMD" in *server.js*) ;; *) continue ;; esac
  kill -9 "$pid" 2>/dev/null && echo "  强停 PID $pid（它没肯退）"
done
sleep 1

echo "======== 4) 复核端口 ========"
BUSY=""
for p in "$API_PORT" "$HUT_PORT" "$HTTPS_PORT"; do
  alive "$p" && BUSY="$BUSY $p"
done
if [ -n "$BUSY" ]; then
  echo "  还有端口被别的程序占着：$BUSY"
  echo "  这不是小屋后端（它已经全停了）。可能别的 App 或另一个 node 在用。"
  echo "  两个办法："
  echo "    a. 看谁在用：  ps -ef | grep -i node"
  echo "    b. 直接换端口跑（不用管它）："
  echo "       HUT_PORT=$((HUT_PORT + 2)) API_PORT=$((API_PORT + 2)) HTTPS_PORT=$((HTTPS_PORT + 2)) sh 修端口.sh"
  echo "       页面开 http://127.0.0.1:$((HUT_PORT + 2))/room"
  echo "       MCP 填 http://127.0.0.1:$((HUT_PORT + 2))/room/sse"
  exit 0
fi

echo "======== 5) 拉起一份 ========"
export HOME=/root
nohup node server.js >> "$DIR/logs/hut.log" 2>&1 &
sleep 4
OK=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  if alive "$HUT_PORT"; then OK=1; break; fi
  sleep 2
done

if [ -n "$OK" ]; then
  echo "  起来了：http://127.0.0.1:$HUT_PORT/room"
  echo "  自检：$(curl -s -m 6 http://127.0.0.1:"$HUT_PORT"/room/mcp.json 2>/dev/null | head -c 120)"
  echo "  以后别再手动起第二份；让工作流跑 ensure-hut.sh 就够。"
else
  echo "  没起来，日志最后 15 行："
  tail -n 15 "$DIR/logs/hut.log"
fi
