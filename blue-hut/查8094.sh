#!/bin/sh
# 查 8094：小屋后端（Ubuntu 侧）到底能不能叫醒 Operit
# 用法：sh 查8094.sh
# 结论只有三种：a) 某个地址能通   b) 端口不在这个网络里（netns 隔离）   c) 端口在但应用不答 HTTP
HUT_PORT=${HUT_PORT:-3001}
LANIP=${LANIP:-}
[ -z "$LANIP" ] && LANIP=$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p' | head -1)

echo "======== 0) 本机看到的监听 ========"
if command -v ss >/dev/null 2>&1; then
  ss -ltn 2>/dev/null | grep -E ":8094|:$HUT_PORT" || echo "  Ubuntu 侧看不到 8094 在监听（很可能它活在 Android 的另一个网络里）"
else
  echo "  没有 ss，跳过"
fi

echo "======== 1) 逐个地址试（每个最多 4 秒）========"
TRY() {
  LABEL=$1
  URL=$2
  CODE=$(curl -s -m 4 -o /tmp/_8094.out -w '%{http_code}' "$URL" 2>/dev/null)
  [ -z "$CODE" ] && CODE=000
  if [ "$CODE" = "000" ]; then
    echo "  $LABEL  不通（超时/拒绝）"
  else
    echo "  $LABEL  HTTP=$CODE  $(head -c 90 /tmp/_8094.out 2>/dev/null | tr '\n' ' ')"
  fi
}

echo "-- 小屋后端自己（对照，应该通）--"
TRY "$HUT_PORT http://127.0.0.1:$HUT_PORT/room/mcp.json" "http://127.0.0.1:$HUT_PORT/room/mcp.json"

echo "-- 8094 各种地址 --"
TRY "http://127.0.0.1:8094/"            "http://127.0.0.1:8094/"
TRY "http://localhost:8094/"            "http://localhost:8094/"
TRY "http://127.0.0.1:8094/api/external-chat" "http://127.0.0.1:8094/api/external-chat"
TRY "http://[::1]:8094/"                "http://[::1]:8094/"
case "$LANIP" in 169.254.*|"") echo "  （本机只有链路本地地址，跳过局域网探测）" ;; *) TRY "http://$LANIP:8094/" "http://$LANIP:8094/" ;; esac
case "$LANIP" in 169.254.*|"") ;; *) TRY "http://$LANIP:8094/api/external-chat" "http://$LANIP:8094/api/external-chat" ;; esac
TRY "https://127.0.0.1:8094/"           "https://127.0.0.1:8094/"

echo "======== 2) 结论怎么读 ========"
echo "  若上面 8094 全是「不通」，3001 是通的："
echo "    说明 8094 不在 Ubuntu 这个网络里（Operit 在 Android 自己的沙箱/网络里监听）。"
echo "    这条链别再折腾 OPERIT_BASE 了，换下面这条：让他自己来读。"
echo
echo "  若有某个地址返回了 HTTP 码："
echo "    把它填进后端："
echo "      OPERIT_BASE=<那个地址> sh /root/blue-hut/ensure-hut.sh   （或写进启动脚本的环境变量）"
echo
echo "  若返回 401/403：token 不对，换 /root/aisay-wake/operit.token 里那份。"
echo
echo "======== 3) 他读得到、你等得到的退路 ========"
echo "  她在页面打的话已经存在后端，随时可读："
echo "    curl -s http://127.0.0.1:$HUT_PORT/room/hersay | head -c 400"
echo "  他那边用自己的方式读这个地址就行（他的 MCP 能连 3001，这条实测是通的）。"
