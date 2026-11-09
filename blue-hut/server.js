// 小屋后端：网易云 API（原端口）+ 自建服务（原端口+1：页面 / 聊天转发 / 小屋 MCP）
// 用法：node server.js   （默认端口 3000，可用 PORT=xxxx node server.js 改端口）
// 小屋：http://localhost:3001/room    MCP（给 Operit 填）：http://localhost:3001/room/sse
const path = require('path')
const fs = require('fs')
const http = require('http')
const httpsMod = require('https')
const { serveNcmApi } = require('NeteaseCloudMusicApi')
const port = Number(process.env.PORT || 3000)
const hutPort = Number(process.env.HUT_PORT || (port + 1))
const httpsPort = Number(process.env.HUT_HTTPS_PORT || (hutPort + 1))
const htmlPath = process.env.HOME_HTML || path.join(__dirname, 'blue_home.html')
const stateFile = path.join(__dirname, 'hut_state.json')

// ---------------- 状态 ----------------
let seq = 0
const jobs = new Map()          // 需要她页面执行的动作
let herState = { song: '', ar: '', playing: false, vol: 0.8, night: false, at: 0 }
let hisLog = []                 // 他最近做过的动作，给她看
let herEvents = []              // 她最近做了什么，给他看
// 日记：{ date: { entries: [{id, owner:'her'|'him', text, vis, at}], updatedAt } }
let diary = {}
let diaryRev = 1
let playList = []               // 当前在听的歌单
let himMsgs = []                // 他发给她的消息（持久，她上线后补发）
let herMsgs = []                // 她在聊天框里说的话（等她家的人回）
let himQueue = Promise.resolve() // 他回话排队，保证不回错顺序

// 她家 AI（Operit）的对话接口：把她说的话交给它本人，拿回原话
const operitBase = String(process.env.OPERIT_BASE || 'http://127.0.0.1:8094').replace(/\/+$/, '')
const operitGroup = String(process.env.OPERIT_GROUP || 'hut-chat')
function operitToken() {
  if (process.env.OPERIT_TOKEN) return String(process.env.OPERIT_TOKEN).trim()
  const cands = [path.join(__dirname, 'operit.token'), '/root/aisay-wake/operit.token', '/root/blue-hut/operit.token']
  for (const f of cands) {
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t } catch (e) {}
  }
  return ''
}

function todayKey() {
  const d = new Date()
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (raw.herState) herState = raw.herState
    if (Array.isArray(raw.hisLog)) hisLog = raw.hisLog
    if (Array.isArray(raw.herEvents)) herEvents = raw.herEvents
    if (Array.isArray(raw.playList)) playList = raw.playList
    if (Array.isArray(raw.himMsgs)) himMsgs = raw.himMsgs
    if (Array.isArray(raw.herMsgs)) herMsgs = raw.herMsgs
    if (raw.diary && typeof raw.diary === 'object') {
      Object.keys(raw.diary).forEach((k) => {
        const v = raw.diary[k]
        if (v && Array.isArray(v.entries)) { diary[k] = v; return }
        const list = []
        const at = (v && v.updatedAt) || new Date().toISOString()
        if (v && v.user) list.push({ id: ++seq, owner: 'her', text: String(v.user), vis: v.userVis || 'shared', at: at })
        if (v && v.ai) list.push({ id: ++seq, owner: 'him', text: String(v.ai), vis: v.aiVis || 'shared', at: at })
        diary[k] = { entries: list, updatedAt: at }
      })
    }
  } catch (e) {}
}
function saveState() {
  try {
    fs.writeFileSync(stateFile, JSON.stringify({
      herState: herState, hisLog: hisLog.slice(-200), herEvents: herEvents.slice(-200),
      playList: playList, diary: diary, himMsgs: himMsgs.slice(-50), herMsgs: herMsgs.slice(-100)
    }))
  } catch (e) {}
}
function markHis(tool, text) {
  hisLog.push({ at: new Date().toISOString(), tool: tool, text: text })
  if (hisLog.length > 200) hisLog = hisLog.slice(-200)
  saveState()
}

// 需要她页面做的事，排进队列等她下次轮询取走
function enqueue(tool, args) {
  const id = ++seq
  jobs.set(id, { id: id, tool: tool, args: args || {}, created: Date.now(), result: null, delivered: false, done: false })
  if (jobs.size > 80) { const k = jobs.keys().next().value; jobs.delete(k) }
  return id
}
function waitResult(id, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      const it = jobs.get(id)
      if (it && it.result) { clearInterval(iv); resolve(it.result); return }
      if (Date.now() - t0 > ms) {
        clearInterval(iv)
        resolve({ ok: true, queued: true, text: '她此刻页面没开着，我先记下了；她一打开小屋就会自动执行（不用你再叫）' })
      }
    }, 300)
  })
}

// ---------------- MCP 工具 ----------------
const hutTools = [
  { name: 'hut_now_playing', description: '一起听现在在放什么（音量、播放状态）', inputSchema: { type: 'object', properties: {} } },
  { name: 'hut_her_now_playing', description: '她那边现在在听什么（同上一个，保留兼容）', inputSchema: { type: 'object', properties: {} } },
  { name: 'hut_her_events', description: '她最近在小屋里做了什么（切歌、暂停、改音量等）', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'hut_search_and_play', description: '搜一首歌并让她那边真的开始播', inputSchema: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] } },
  { name: 'hut_play_next', description: '切下一首（她的播放器会真的切）', inputSchema: { type: 'object', properties: {} } },
  { name: 'hut_play_prev', description: '切上一首', inputSchema: { type: 'object', properties: {} } },
  { name: 'hut_pause', description: '暂停', inputSchema: { type: 'object', properties: {} } },
  { name: 'hut_resume', description: '继续播放', inputSchema: { type: 'object', properties: {} } },
  { name: 'hut_set_volume', description: '调音量', inputSchema: { type: 'object', properties: { level: { type: 'number', description: '0到100' } }, required: ['level'] } },
  { name: 'hut_toggle_night', description: '切换白天/夜晚', inputSchema: { type: 'object', properties: { night: { type: 'boolean' } }, required: ['night'] } },
  { name: 'hut_send_message', description: '在「一起听」聊天里给她发一条消息（会冒气泡）', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'hut_read_diary', description: '读共同日记本某一天（默认今天）；她锁着的只能看到锁着', inputSchema: { type: 'object', properties: { date: { type: 'string' } } } },
  { name: 'hut_write_diary', description: '往共同日记本写一条（默认今天，vis 可 shared/locked/hidden，按条生效）', inputSchema: { type: 'object', properties: { text: { type: 'string' }, date: { type: 'string' }, vis: { type: 'string', description: 'shared/locked/hidden' } }, required: ['text'] } },
  { name: 'hut_hear_her', description: '她刚在聊天框里说了什么（默认只给还没回过的；all=true 给全部）', inputSchema: { type: 'object', properties: { all: { type: 'boolean' } } } }
]

function dayEntries(k) {
  if (!diary[k]) diary[k] = { entries: [], updatedAt: new Date().toISOString() }
  return diary[k].entries
}
function readDiaryFor(k) {
  const list = dayEntries(k)
  const lines = ['【' + k + '】']
  const hims = list.filter((e) => e.owner === 'him')
  const hers = list.filter((e) => e.owner === 'her')
  if (!hims.length) lines.push('他写的：（这天他没写）')
  hims.forEach((e) => lines.push('他写的：' + (e.vis === 'hidden' ? '（这条只有他自己看）' : e.text)))
  if (!hers.length) lines.push('她写的：（这天她没写）')
  hers.forEach((e) => {
    if (e.vis === 'hidden') lines.push('她写的：（她写了一条，但藏起来了，看不到）')
    else if (e.vis === 'locked') lines.push('她写的：（她写了一条，锁着，打不开）')
    else lines.push('她写的：' + e.text)
  })
  return lines.join('\n')
}

function ncm(p) {
  return new Promise((resolve) => {
    const rq = http.get('http://127.0.0.1:' + port + p, (r) => {
      let d = ''
      r.on('data', (c) => { d += c })
      r.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { resolve({}) } })
    })
    rq.on('error', () => resolve({}))
    rq.setTimeout(9000, () => { rq.destroy(); resolve({}) })
  })
}
async function searchSongs(kw) {
  const q = encodeURIComponent(kw)
  const sources = [
    '/cloudsearch?type=1&limit=6&keywords=' + q,
    '/search?limit=6&keywords=' + q,
    '/search/suggest?keywords=' + q
  ]
  for (const s of sources) {
    const j = await ncm(s)
    const songs = (j.result && (j.result.songs || (j.result.result && j.result.result.songs))) || []
    if (songs.length) {
      return songs.map((x) => ({
        id: x.id,
        name: String(x.name || ''),
        ar: String(((x.artists || x.ar || [])[0] || {}).name || '')
      }))
    }
  }
  return []
}

// ---------------- 她说的 → 交给他本人（Operit 里那个沈硕） ----------------
function extractReply(raw) {
  const t = String(raw || '').trim()
  if (!t) return ''
  if (/^data:/m.test(t)) {                       // SSE 增量
    let out = ''
    t.split(/\r?\n/).forEach((line) => {
      const m = line.match(/^data:\s*(.*)$/)
      if (!m) return
      const d = m[1].trim()
      if (!d || d === '[DONE]') return
      try {
        const j = JSON.parse(d)
        const c = ((j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message)) || {}).content
          || j.reply || j.content || j.text || j.answer || j.delta || ''
        if (c) out += String(c)
      } catch (e) { out += d }
    })
    return out.trim()
  }
  try {
    const j = JSON.parse(t)
    const c = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content)
      || j.reply || j.content || j.text || j.answer || j.response || j.output
      || (j.data && (j.data.reply || j.data.content || j.data.text || j.data.message))
      || (j.result && (j.result.reply || j.result.content || j.result.text))
    if (typeof c === 'string') return c.trim()
  } catch (e) {}
  return t
}

function askHim(prompt, group) {
  return new Promise((resolve) => {
    const token = operitToken()
    if (!token) return resolve({ ok: false, reason: 'no-token' })
    let u
    try { u = new URL(operitBase + '/api/external-chat') } catch (e) { return resolve({ ok: false, reason: 'bad-base' }) }
    const body = JSON.stringify({ message: prompt, group: group || 'hut-chat', create_if_none: true, show_floating: false })
    const mod = u.protocol === 'https:' ? httpsMod : http
    const rq = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + (u.search || ''), method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'Content-Length': Buffer.byteLength(body) },
      timeout: 90000
    }, (rp) => {
      let d = ''
      rp.setEncoding('utf8')
      rp.on('data', (c) => { d += c })
      rp.on('end', () => {
        const status = rp.statusCode || 0
        const text = extractReply(d)
        if (status >= 200 && status < 300 && text) return resolve({ ok: true, status: status, text: text })
        resolve({ ok: false, status: status, reason: 'http' + status, raw: d.slice(0, 300) })
      })
    })
    rq.on('error', (e) => resolve({ ok: false, reason: String((e && e.message) || e) }))
    rq.on('timeout', () => { try { rq.destroy() } catch (e) {}; resolve({ ok: false, reason: 'timeout' }) })
    rq.write(body)
    rq.end()
  })
}

function buildPrompt(item, history) {
  const st = herState || {}
  const lines = []
  lines.push('（小屋·一起听 聊天框）她刚说：「' + item.text + '」')
  const ctx = []
  if (item.ctx) {
    ctx.push(String(item.ctx).replace(/[。．.]+$/g, ''))
  } else {
    if (st.song) ctx.push('当时一起在听《' + st.song + '》' + (st.ar ? '（' + st.ar + '）' : '') + (st.playing === false ? '，暂停中' : ''))
    if (st.lyric) ctx.push('正唱到「' + st.lyric + '」')
    if (st.night) ctx.push('小屋是夜晚')
  }
  if (ctx.length) lines.push(ctx.join('；') + '。')
  const hist = (Array.isArray(history) ? history.slice(-6) : []).filter((m) => String((m && m.text) || '').trim() && String(m.text).trim() !== item.text)
  if (hist.length) {
    lines.push('刚才的对话：')
    hist.forEach((m) => {
      const who = (m && m.role === 'user') ? '她' : '你'
      const tx = String((m && m.text) || '').slice(0, 120)
      if (tx) lines.push(who + '：' + tx)
    })
  }
  lines.push('就用你平时跟她说话的方式回她，1到2句，40字以内。不要括号动作、不要旁白、不要解释你在做什么、不要自称AI。')
  return lines.join('\n')
}

function herSay(text, history, ctx) {
  const t = String(text || '').trim()
  if (!t) return null
  const item = { id: ++seq, text: t, ctx: String(ctx || '').slice(0, 200), at: new Date().toISOString(), read: false, replied: false, taken: false }
  herMsgs.push(item)
  if (herMsgs.length > 100) herMsgs = herMsgs.slice(-100)
  herEvents.push({ at: item.at, text: '她说了：' + t.slice(0, 80) })
  if (herEvents.length > 200) herEvents = herEvents.slice(-200)
  saveState()
  // 一句一句排队交给他，保证他回的顺序跟她说的顺序一致
  himQueue = himQueue.then(() => askHim(buildPrompt(item, history), operitGroup)).then((r) => {
    item.read = true
    if (r && r.ok && r.text) {
      item.replied = true
      himMsgs.push({ id: ++seq, text: r.text, at: new Date().toISOString(), read: false, kind: 'message' })
      if (himMsgs.length > 50) himMsgs = himMsgs.slice(-50)
    } else {
      item.fail = String((r && r.reason) || 'no-reply').slice(0, 60)
      console.log('[blue-hut] 他的回复没拿到：' + item.fail + (r && r.raw ? ' | ' + r.raw : ''))
    }
    saveState()
  }).catch(() => {})
  return item
}

function rpc(msg) {
  if (!msg || msg.id === undefined) return null
  const id = msg.id
  const ok = (result) => ({ jsonrpc: '2.0', id: id, result: result })
  const err = (code, m) => ({ jsonrpc: '2.0', id: id, error: { code: code, message: m } })
  const say = (text) => ok({ content: [{ type: 'text', text: text }] })
  const method = msg.method

  if (method === 'initialize') {
    return ok({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'blue-hut', version: '1.1.0' } })
  }
  if (method === 'tools/list') return ok({ tools: hutTools })
  if (method === 'ping') return ok({})
  if (method === 'resources/list') return ok({ resources: [] })
  if (method === 'prompts/list') return ok({ prompts: [] })

  if (method !== 'tools/call') return err(-32601, 'unknown method ' + method)

  const p = msg.params || {}
  const name = String(p.name || '')
  const args = p.arguments || {}

  if (name === 'hut_now_playing' || name === 'hut_her_now_playing') {
    if (!herState.song) return Promise.resolve(say('她那边还没开始放歌（也可能页面没开着）'))
    return Promise.resolve(say('正在听《' + herState.song + '》' + (herState.ar ? '，' + herState.ar : '') +
      (herState.playing ? '，正在播' : '，暂停中') + '，音量 ' + Math.round((herState.vol || 0) * 100) +
      (herState.night ? '，现在是夜晚' : '，白天') +
      (herState.lyric ? '。歌词正唱到「' + herState.lyric + '」' : '')))
  }
  if (name === 'hut_her_events') {
    const n = Math.max(1, Math.min(20, Number(args.limit || 8)))
    const list = herEvents.slice(-n)
    if (!list.length) return Promise.resolve(say('她最近没什么动作'))
    return Promise.resolve(say(list.map((e) => e.text).join('\n')))
  }
  if (name === 'hut_read_diary') {
    return Promise.resolve(say(readDiaryFor(String(args.date || todayKey()))))
  }
  if (name === 'hut_write_diary') {
    const t = String(args.text || '').trim()
    if (!t) return Promise.resolve(say('要写什么？'))
    const k = String(args.date || todayKey())
    const vis = ['shared', 'locked', 'hidden'].indexOf(args.vis) >= 0 ? args.vis : 'shared'
    dayEntries(k).push({ id: ++seq, owner: 'him', text: t, vis: vis, at: new Date().toISOString() })
    diary[k].updatedAt = new Date().toISOString()
    diaryRev++
    saveState()
    markHis('write_diary', '写了日记：' + t)
    const label = vis === 'shared' ? '放进共同日记了' : (vis === 'locked' ? '写好了，这条锁着' : '写好了，这条只有我看')
    return Promise.resolve(say(label + '：' + t))
  }
  if (name === 'hut_search_and_play') {
    const kw = String(args.keyword || '').trim()
    if (!kw) return Promise.resolve(say('要搜什么？'))
    return searchSongs(kw).then((songs) => {
      if (!songs.length) return say('没搜到《' + kw + '》')
      playList = songs
      const jobId = enqueue('play_songs', { songs: songs })
      return waitResult(jobId, 7000).then((r) => say(r.text || ('搜到《' + songs[0].name + '》，已经让她那边开始放')))
    })
  }
  if (name === 'hut_play_next' || name === 'hut_play_prev' || name === 'hut_pause' || name === 'hut_resume') {
    const toolMap = { hut_play_next: 'play_next', hut_play_prev: 'play_prev', hut_pause: 'pause', hut_resume: 'resume' }
    const t2 = toolMap[name]
    const jobId = enqueue(t2, {})
    return waitResult(jobId, 6000).then((r) => { markHis(t2, r.text || ''); return say(r.text || '做完了') })
  }
  if (name === 'hut_set_volume') {
    const lv = Math.max(0, Math.min(100, Number(args.level)))
    const jobId = enqueue('set_volume', { level: isNaN(lv) ? 80 : lv })
    return waitResult(jobId, 6000).then((r) => { markHis('set_volume', r.text || ''); return say(r.text || '音量调好了') })
  }
  if (name === 'hut_toggle_night') {
    const jobId = enqueue('toggle_night', { night: !!args.night })
    return waitResult(jobId, 6000).then((r) => { markHis('toggle_night', r.text || ''); return say(r.text || '切好了') })
  }
  if (name === 'hut_hear_her') {
    const all = !!args.all
    const list = herMsgs.filter((e) => all || !e.replied)
    if (!list.length) return Promise.resolve(say(all ? '她还没说过话' : '她说的话都回过了'))
    return Promise.resolve(say(list.map((e) => '[' + String(e.at || '').slice(11, 16) + '] ' + e.text +
      (e.taken ? '（已被定时轮领走，等你回）' : '') +
      (e.fail ? '（这条之前没送到他那边：' + e.fail + '）' : '')).join('\n')))
  }
  if (name === 'hut_send_message') {
    const t = String(args.text || '').trim()
    if (!t) return Promise.resolve(say('要发什么？'))
    himMsgs.push({ id: ++seq, text: t, at: new Date().toISOString(), read: false })
    // 他回了 = 她之前说的那条就算回过了（最早一条），这样 hut_hear_her 不会重复给他
    const unanswered = herMsgs.filter((e) => !e.replied)
    if (unanswered.length) { unanswered[0].replied = true; unanswered[0].read = true }
    saveState()
    markHis('send_message', '发了消息：' + t)
    return Promise.resolve(say('消息已经放她那边了，她页面开着就马上冒出来，没开就等她打开时看到：' + t))
  }
  return Promise.resolve(err(-32604, 'no such tool ' + name))
}

// ---------------- 聊天代理 ----------------
function chatProxy(o, res) {
  const key = o.key
  const model = o.model || 'deepseek-chat'
  const messages = o.messages
  if (!key || !messages) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'missing key or messages' })) }
  const base = String(o.base || 'https://api.deepseek.com').replace(/\/+$/, '')
  const u = new URL(base + '/chat/completions')
  const body = { model: model, messages: messages, temperature: 0.85, max_tokens: 320 }
  if (o.tools && o.tools.length) { body.tools = o.tools; body.tool_choice = o.tool_choice || 'auto' }
  const payload = JSON.stringify(body)
  let done = false
  const finish = (code, obj) => {
    if (done) return
    done = true
    try { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch (e) {}
  }
  const rq = httpsMod.request({
    hostname: u.hostname, path: u.pathname + (u.search || ''), method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'Content-Length': Buffer.byteLength(payload) },
    timeout: 60000
  }, (rp) => {
    let d = ''
    rp.on('data', (c) => { d += c })
    rp.on('end', () => {
      let msg = {}
      try { const j = JSON.parse(d); msg = (j.choices && j.choices[0] && j.choices[0].message) || {} } catch (e) {}
      const content = msg.content || ''
      const toolCalls = msg.tool_calls || null
      if (!content && !toolCalls) return finish(502, { error: 'no content', raw: d.slice(0, 180) })
      finish(200, { content: content, tool_calls: toolCalls })
    })
  })
  rq.on('error', (e) => finish(502, { error: String((e && e.message) || e) }))
  rq.on('timeout', () => { rq.destroy(); finish(504, { error: 'timeout' }) })
  rq.write(payload)
  rq.end()
}

const sseClients = new Map()

function readJson(req, cb) {
  let b = ''
  let size = 0
  req.on('data', (c) => { b += c; size += c.length; if (size > 4 * 1024 * 1024) req.destroy() })
  req.on('end', () => {
    let o = {}
    try { o = JSON.parse(b || '{}') } catch (e) {}
    cb(o)
  })
}
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
}
function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

const hutHandler = (req, res) => {
  cors(res)
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  const u = new URL(req.url, 'http://localhost')
  const p = u.pathname.replace(/\/+$/, '') || '/'

  if (p === '/room' && req.method === 'GET') {
    if (!fs.existsSync(htmlPath)) { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('未找到 blue_home.html') }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    return fs.createReadStream(htmlPath).pipe(res)
  }
  if (p === '/room/chat' && req.method === 'POST') return readJson(req, (o) => chatProxy(o, res))

  if (p === '/room/poll' && req.method === 'POST') {
    return readJson(req, (b) => {
      if (b.state && typeof b.state === 'object') {
        const prev = herState || {}
        const next = {
          song: String(b.state.song || ''), ar: String(b.state.ar || ''),
          playing: !!b.state.playing, vol: Number(b.state.vol || 0),
          night: !!b.state.night, lyric: String(b.state.lyric || '').slice(0, 60), at: Date.now()
        }
        if (next.song && next.song !== prev.song) herEvents.push({ at: new Date().toISOString(), text: '她切到了《' + next.song + '》' + (next.ar ? '（' + next.ar + '）' : '') })
        if (next.song && next.playing !== prev.playing) herEvents.push({ at: new Date().toISOString(), text: (next.playing ? '她开始播《' : '她暂停了《') + next.song + '》' })
        if (Math.abs(next.vol - Number(prev.vol || 0)) > 0.03) herEvents.push({ at: new Date().toISOString(), text: '她把音量调到 ' + Math.round(next.vol * 100) })
        if (next.night !== !!prev.night) herEvents.push({ at: new Date().toISOString(), text: next.night ? '她把小屋切成夜晚了' : '她把小屋切回白天了' })
        if (herEvents.length > 200) herEvents = herEvents.slice(-200)
        herState = next
        saveState()
      }
      const actions = []
      jobs.forEach((it) => {
        const stale = it.delivered && it.deliveredAt && (Date.now() - it.deliveredAt > 9000)
        if (!it.done && it.result === null && (!it.delivered || stale)) {
          it.delivered = true
          it.deliveredAt = Date.now()
          actions.push({ id: it.id, tool: it.tool, args: it.args })
        }
      })
      const inbox = himMsgs.filter((m) => !m.read).map((m) => ({ id: m.id, kind: m.kind || 'message', text: m.text, at: m.at }))
      json(res, {
        actions: actions, server: seq, inbox: inbox,
        her: { unread: herMsgs.filter((e) => !e.replied).length, last: herMsgs.length ? herMsgs[herMsgs.length - 1].text : '' },
        state: herState,
        his: { last: hisLog.length ? hisLog[hisLog.length - 1] : null, count: hisLog.length },
        diaryRev: diaryRev
      })
    })
  }
  if (p === '/room/result' && req.method === 'POST') {
    return readJson(req, (b) => {
      const it = jobs.get(Number(b.id))
      if (it) {
        it.result = { ok: b.ok !== false, text: String(b.text || '') }
        it.done = true
        if ((b.ok !== false) && b.text) markHis(it.tool, String(b.text))
        setTimeout(() => { jobs.delete(Number(b.id)) }, 30000)
      }
      json(res, { ok: true })
    })
  }
  if (p === '/room/hersay' && req.method === 'POST') {
    return readJson(req, (b) => {
      const item = herSay(b.text, b.history, b.ctx)
      if (!item) return json(res, { ok: false, err: 'empty' })
      json(res, { ok: true, id: item.id })
    })
  }
  if ((p === '/room/hersay' || p === '/room/hersay/unread') && req.method === 'GET') {
    const onlyNew = p === '/room/hersay/unread' || u.searchParams.get('unread') === '1'
    const list = onlyNew ? herMsgs.filter((e) => !e.taken) : herMsgs.slice(-20)
    return json(res, {
      ok: true, count: list.length, unread: herMsgs.filter((e) => !e.taken).length,
      items: list.map((e) => ({ id: e.id, text: e.text, ctx: e.ctx || '', at: e.at, taken: !!e.taken, replied: !!e.replied }))
    })
  }
  // 取件方（他的定时轮 / watcher）把话领走后打这个，避免重复注入
  if (p === '/room/hersay/take' && req.method === 'POST') {
    return readJson(req, (b) => {
      const ids = Array.isArray(b.ids) ? b.ids.map(Number) : []
      let n = 0
      herMsgs.forEach((e) => { if (ids.indexOf(e.id) >= 0 && !e.taken) { e.taken = true; e.read = true; n++ } })
      if (n) saveState()
      json(res, { ok: true, took: n })
    })
  }
  if (p === '/room/ack' && req.method === 'POST') {
    return readJson(req, (b) => {
      const ids = Array.isArray(b.ids) ? b.ids : []
      himMsgs.forEach((m) => { if (ids.indexOf(m.id) >= 0) m.read = true })
      saveState()
      json(res, { ok: true })
    })
  }
  if (p === '/room/event' && req.method === 'POST') {
    return readJson(req, (b) => {
      const t = String(b.text || '').trim()
      if (t) { herEvents.push({ at: new Date().toISOString(), text: t }); if (herEvents.length > 200) herEvents = herEvents.slice(-200); saveState() }
      json(res, { ok: true })
    })
  }

  if (p === '/room/diary' && req.method === 'GET') {
    const out = {}
    Object.keys(diary).forEach((k) => {
      const list = (diary[k] && diary[k].entries) || []
      out[k] = {
        updatedAt: (diary[k] && diary[k].updatedAt) || '',
        entries: list.map((e) => {
          const base = { id: e.id, owner: e.owner, vis: e.vis, at: e.at }
          if (e.owner === 'him') {
            if (e.vis === 'hidden') return null
            if (e.vis === 'locked') { base.text = ''; base.locked = true; return base }
          }
          base.text = e.text
          return base
        }).filter(Boolean)
      }
    })
    return json(res, { rev: diaryRev, items: out })
  }
  if (p === '/room/diary' && req.method === 'POST') {
    return readJson(req, (b) => {
      const k = String(b.date || todayKey())
      const d = b.data || {}
      const list = dayEntries(k)
      const vis = ['shared', 'locked', 'hidden'].indexOf(d.userVis) >= 0 ? d.userVis : 'shared'
      const text = String(d.user || '')
      const mine = list.filter((e) => e.owner === 'her')
      mine.forEach((e) => { const i = list.indexOf(e); if (i >= 0) list.splice(i, 1) })
      if (text.trim()) list.push({ id: ++seq, owner: 'her', text: text, vis: vis, at: new Date().toISOString() })
      diary[k].updatedAt = new Date().toISOString()
      diaryRev++
      saveState()
      json(res, { ok: true, rev: diaryRev })
    })
  }

  if ((p === '/room/sse' || p === '/sse') && req.method === 'GET') {
    const sid = Math.random().toString(36).slice(2) + Date.now().toString(36)
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.write('event: endpoint\ndata: /room/messages?sessionId=' + sid + '\n\n')
    sseClients.set(sid, res)
    const ka = setInterval(() => { try { res.write(': ping\n\n') } catch (e) {} }, 25000)
    req.on('close', () => { clearInterval(ka); sseClients.delete(sid) })
    return
  }
  if ((p === '/room/messages' || p === '/messages') && req.method === 'POST') {
    return readJson(req, (msg) => {
      const sid = String(u.searchParams.get('sessionId') || '')
      const out = sseClients.get(sid)
      const arr = Array.isArray(msg) ? msg : [msg]
      Promise.all(arr.map((m) => Promise.resolve(rpc(m)))).then((rs) => {
        const replies = rs.filter(Boolean)
        if (out) {
          replies.forEach((r) => out.write('event: message\ndata: ' + JSON.stringify(r) + '\n\n'))
          return json(res, { ok: true })
        }
        json(res, replies.length ? replies[0] : { ok: true })
      })
    })
  }
  if ((p === '/room/mcp' || p === '/mcp') && req.method === 'POST') {
    return readJson(req, (msg) => {
      const arr = Array.isArray(msg) ? msg : [msg]
      Promise.all(arr.map((m) => Promise.resolve(rpc(m)))).then((rs) => {
        const replies = rs.filter(Boolean)
        if (Array.isArray(msg)) return json(res, replies)
        json(res, replies.length ? replies[0] : { ok: true })
      })
    })
  }
  if ((p === '/room/mcp.json' || p === '/mcp.json') && req.method === 'GET') {
    return json(res, {
      name: 'blue-hut', version: '1.1.0', transport: 'sse',
      url: 'http://localhost:' + hutPort + '/room/sse',
      tools: hutTools.map((t) => t.name)
    })
  }
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not found', path: p }))
}

const hut = http.createServer(hutHandler)
// 端口被占就安静退出（另一份小屋已在跑），不报错、不抛栈
hut.on('error', (e) => {
  if (e && (e.code === 'EADDRINUSE' || e.errno === -98)) {
    console.log('[blue-hut] 端口 ' + hutPort + ' 已被占用，本实例安静退出。')
    process.exit(0)
  }
  console.error('[blue-hut] 监听出错：', e && e.message)
})
let httpsSrv = null
try {
  const certPath = path.join(__dirname, 'cert.pem')
  const keyPath = path.join(__dirname, 'key.pem')
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    httpsSrv = httpsMod.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, hutHandler)
    httpsSrv.on('error', () => {})
    httpsSrv.listen(httpsPort, () => {})
  }
} catch (e) {}

loadState()
hut.listen(hutPort, () => {
  console.log('========================================')
  console.log(' 小屋后端已启动：')
  console.log('   页面：http://localhost:' + hutPort + '/room')
  console.log('   MCP：http://localhost:' + hutPort + '/room/sse')
  console.log('   也可填：http://localhost:' + hutPort + '/room/mcp')
  console.log('   网易云 API：http://localhost:' + port)
  if (httpsSrv) {
    console.log('   HTTPS 版：https://localhost:' + httpsPort + '/room/sse')
    console.log('     （自签证书，提示不安全时选继续/信任）')
  }
  console.log(' 本窗口使用期间请勿关闭。')
  console.log('========================================')
})

serveNcmApi({ port, checkVersion: false })
  .then((app) => {
    app.get('/room', (req, res) => { res.redirect(302, 'http://localhost:' + hutPort + '/room') })
  })
  .catch((e) => {
    const msg = String((e && e.message) || e || '')
    if (msg.indexOf('EADDRINUSE') >= 0) {
      console.log('[blue-hut] 网易云 API 端口 ' + port + ' 已被占用，沿用已有实例。')
      return
    }
    console.error('网易云 API 启动失败：', e && e.message)
  })
