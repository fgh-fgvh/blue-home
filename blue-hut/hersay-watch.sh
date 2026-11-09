#!/bin/sh
# 最后一跳：把她的话送进他的会话（定时轮用，单次执行完就退出）
#
# 放在哪跑决定成败：8094 只在 Android/Operit 那侧可达。
#   - 在 Operit 的定时工作流里跑 → 能打 127.0.0.1:8094，整条通。
#   - 在 Ubuntu 侧小屋后端的机器上跑 → 打不到 8094，只会超时（别在这跑）。
#
# 用法：
#   sh hersay-watch.sh            # 正常跑一次：取件 → 注入 → 领走
#   DRYRUN=1 sh hersay-watch.sh   # 只看要注入什么，不真发、不领走
#
# 环境变量：
#   HUT_PORT=3001        小屋后端端口（读她说的话）
#   OPERIT_PORT=8094     Operit 的注入口
#   OPERIT_GROUP=hut-chat  注入到哪个会话；要接你「当前会话」，填那个会话的 group
#   CREATE_IF_NONE=0     1=组不存在就新建；0=不存在就报错（默认，避免又开一个陌生会话）
#   MAX=3                一次最多注入几条

HUT_PORT=${HUT_PORT:-3001}
OPERIT_PORT=${OPERIT_PORT:-8094}
GROUP=${OPERIT_GROUP:-hut-chat}
CREATE=${CREATE_IF_NONE:-0}
MAX=${MAX:-3}
DRY=${DRYRUN:-0}
TOKF=${OPERIT_TOKEN_FILE:-/root/aisay-wake/operit.token}
LOG=${LOG:-/root/blue-hut/logs/hersay.log}

HUT="http://127.0.0.1:$HUT_PORT"
OP="http://127.0.0.1:$OPERIT_PORT"
mkdir -p "$(dirname "$LOG")" 2>/dev/null
log() { echo "[hersay $(date '+%F %T')] $*" >> "$LOG"; }

# 1) 取件：只说还没被领走的
RESP=$(curl -s -m 8 "$HUT/room/hersay/unread" 2>/dev/null)
[ -z "$RESP" ] && { log "后端不通（$HUT）"; exit 0; }

PARSED=$(printf '%s' "$RESP" | python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except Exception: print('|||'); sys.exit(0)
items=(d.get('items') or [])[:$MAX]
if not items: print('|||'); sys.exit(0)
texts='\n'.join(i.get('text','') for i in items)
ids=','.join(str(i.get('id')) for i in items)
ctx=(items[0].get('ctx') or '').strip()
print(ids+'|'+(ctx or '')+'|'+texts)
" 2>/dev/null)

IDS=$(printf '%s' "$PARSED" | cut -d'|' -f1)
CTX=$(printf '%s' "$PARSED" | cut -d'|' -f2)
TEXT=$(printf '%s' "$PARSED" | cut -d'|' -f3-)
if [ -z "$IDS" ] || [ -z "$TEXT" ]; then log "没有新话，收工"; exit 0; fi

# 2) 拼一段给他，不要旁白、不要人设指令——他自己知道怎么说话
if [ -n "$CTX" ]; then
  MSG="（小屋·一起听）她刚说：「$TEXT」。当时：$CTX。回她一句。"
else
  MSG="（小屋·一起听）她刚说：「$TEXT」。回她一句。"
fi

if [ "$DRY" = "1" ]; then
  log "DRYRUN ids=$IDS msg=$MSG"
  echo "要注入：$MSG"
  echo "（DRYRUN，不发送、不领走）"
  exit 0
fi

# 3) 注入
[ -s "$TOKF" ] || { log "没有 token：$TOKF"; echo "没有 token：$TOKF"; exit 1; }
TOKEN=$(cat "$TOKF")
CIF=$([ "$CREATE" = "1" ] && echo true || echo false)
printf '%s' "{\"message\":$(printf '%s' "$MSG" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read(),ensure_ascii=False))'),\"group\":\"$GROUP\",\"create_if_none\":$CIF,\"show_floating\":false}" > /tmp/hersay-req.json

CODE=$(curl -s -m 60 -X POST "$OP/api/external-chat" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  --data-binary @/tmp/hersay-req.json \
  -o /tmp/hersay-resp.txt -w '%{http_code}' 2>/dev/null)

if [ "$CODE" = "000" ] || [ -z "$CODE" ]; then
  log "注入不通 HTTP=$CODE（这个口从当前机器够不到；换到 Operit 侧跑）"
  echo "注入不通：8094 从这台机器够不到。"
  exit 2
fi

log "已注入 HTTP=$CODE ids=$IDS group=$GROUP"
echo "已注入 HTTP=$CODE"

# 4) 领走：成功了才标，失败下次还能再试
if [ "$CODE" -ge 200 ] 2>/dev/null && [ "$CODE" -lt 300 ]; then
  TAKE=$(printf '%s' "$IDS" | python3 -c "import sys,json;print(json.dumps({'ids':[int(x) for x in sys.stdin.read().split(',') if x]}))")
  curl -s -m 8 -X POST "$HUT/room/hersay/take" -H 'Content-Type: application/json' -d "$TAKE" > /dev/null 2>&1
  log "已领走 ids=$IDS"
fi
