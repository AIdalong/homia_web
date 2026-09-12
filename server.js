// Homia Studio 本地服务：静态托管 + 配置落盘（data/*.json）+ 生图接口代理
// 用法：node server.js   然后打开 http://localhost:3899
// 直接用 file:// 打开 index.html 也能用，只是配置只存在浏览器 localStorage，接口只能直连。
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const dataDir = path.join(root, 'data');
const port = process.env.PORT || 3899;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const DEFAULTS = {
  sources: {
    prompt: '傍晚的花园，金色银杏叶落在门前，小狗安静等待回家的人。',
    holiday: '秋分', holidayDate: '2026-09-23', holidayNote: '昼夜均分，适合安静的秋日意象。',
    events: [{ date: '2026-09-12', desc: '周末家庭聚餐' }],
    location: '', weather: '晴朗', temperature: '23°C', season: '初秋', period: '傍晚',
    style: '现代东方极简, 装饰插画, 高级平面海报感, 留白均衡', elements: '植物枝叶, 花卉, 山水轮廓, 云气, 日月, 几何纹样, 印章, 边框',
    mood: '平静, 温暖', avoid: '照片写实, 任何四色（黑红黄白）以外的颜色, 蓝/青/绿/紫色天空与背景, 蓝紫渐变, 密集文字, 悬浮漂浮的无关物体, 农家院子/村庄/土墙/篱笆等乡土场景, 写实的人物特写, 图标拼贴, 元素罗列堆砌, 供桌/祭台式静物陈列, 祭祀供奉感, 门牌号过小或位置不突出, 门牌号大小或位置不稳定, 单侧或单角出现大片空白, 画面底部出现横条/色块/两个格子, 门牌号与背景图案互相遮挡或重叠穿插'
  },
  // device 只保留设备规格；门牌信息（doorTitle / doorNumber / doorShow）改为存浏览器本地，不落服务端
  device: { width: 800, height: 480, renderSize: '4' },
  // 和风天气：免费订阅用 devapi.qweather.com，付费订阅改成 api.qweather.com
  // autoIp=true 时先按出口 IP 定位城市；定位失败或想固定城市，把 city 填上即可
  geo: { qweatherKey: '', host: 'devapi.qweather.com', city: '', autoIp: true },
  api: {
    endpoint: 'https://your-api.example.com/v1/images/generations',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer YOUR_API_KEY' },
    body: { model: 'your-image-model', prompt: '{{prompt}}', size: '1024x1024' },
    responseImagePath: 'data.0.url'
  }
};
// 门牌信息属于终端用户自己的数据，只存浏览器本地：服务端下发与写入都要剔除
const DOOR_KEYS = ['doorTitle', 'doorNumber', 'doorShow'];
// 含密钥的配置文件绝不通过静态路由暴露（否则前端拿不到 key 的设计形同虚设）
const DENY_FILES = ['/data/api.json', '/data/geo.json', '/data/llm.json'];
// 远程写入 data/*.json 的管理口令；默认关闭，配置服务端配置请直接改文件
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();

function readJson(name, fallback) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
    return v && typeof v === 'object' ? v : fallback;
  } catch (e) { return fallback; }
}
function writeJson(name, obj) {
  fs.writeFileSync(path.join(dataDir, name), JSON.stringify(obj, null, 2) + '\n');
}
function ensure(name, fallback) {
  const cur = readJson(name, null);
  if (cur == null) { writeJson(name, fallback); return fallback; }
  return cur;
}
// 把 {{key}} 占位符替换进模板的字符串值内部（避免先 stringify 再替换时把引号/换行写坏）
function fillTemplate(value, map) {
  if (typeof value === 'string') {
    return Object.keys(map).reduce((s, k) => s.split('{{' + k + '}}').join(map[k]), value);
  }
  if (Array.isArray(value)) return value.map(v => fillTemplate(v, map));
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value).forEach(k => { out[k] = fillTemplate(value[k], map); });
    return out;
  }
  return value;
}
// 按 "choices.0.message.content" 这类路径从响应体里取文本
function pickPath(obj, p) {
  if (!p) return obj;
  return String(p).split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
}

// 首次启动生成默认文件；之后所有读写都直接走磁盘，外部手改 JSON 立即生效，无需重启
function loadAll() {
  return {
    sources: readJson('sources.json', DEFAULTS.sources),
    device: readJson('device.json', DEFAULTS.device),
    api: readJson('api.json', DEFAULTS.api)
  };
}
function ensureFiles() {
  ['sources', 'device', 'api', 'geo'].forEach(k => ensure(k + '.json', DEFAULTS[k]));
}
ensureFiles();

function reply(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
// 说明：城市只来自「浏览器端 IP 定位回传的城市名」或「geo.json 的 city」，服务端不再按出口 IP 定位（云端部署会失真）
async function getJson(url) {
  const upstream = await fetch(url);
  const text = await upstream.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* 非 JSON，交给下面统一报错 */ }
  if (!upstream.ok || !data) {
    throw new Error('HTTP ' + upstream.status + (text ? ' · ' + text.slice(0, 140) : ' · 空响应'));
  }
  return data;
}
async function readBody(req, limit) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw new Error('请求内容过大');
  }
  return raw;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // 前端用来确认「当前页面确实由本服务提供」，避免把 404 误判成接口报错
  if (req.method === 'GET' && url.pathname === '/api/ping') {
    return reply(res, 200, JSON.stringify({ ok: true, proxy: true }));
  }

  // 读取全部配置（含图片库索引）
  if (req.method === 'GET' && url.pathname === '/api/config') {
    const all = loadAll();
    const api = all.api || {};
    const geo = readJson('geo.json', DEFAULTS.geo); // loadAll 不含 geo，这里单独读
    const llm = readJson('llm.json', null); // LLM 生成生图 Prompt 的配置，只暴露「是否可用」，密钥留在服务端
    // 只下发非敏感字段：Authorization 等请求头始终留在服务端（api 的 key 不下发）
    const exposed = {
      endpoint: api.endpoint,
      method: api.method,
      body: api.body,
      responseImagePath: api.responseImagePath,
      configured: !/your-api\.example\.com|YOUR_API_KEY/.test(api.endpoint + JSON.stringify(api.headers || {}))
    };
    // key 绝不下发到浏览器；只暴露非敏感字段（host 等是公开域名，无泄露风险）
    const geoExposed = {
      host: (geo.host || DEFAULTS.geo.host).trim(),
      city: (geo.city || '').trim(),
      autoIp: geo.autoIp !== false
    };
    // device 不下发门牌信息（门牌只存在用户浏览器本地）
    const deviceExposed = {};
    Object.keys(all.device || {}).forEach(k => { if (DOOR_KEYS.indexOf(k) < 0) deviceExposed[k] = all.device[k]; });
    // LLM 只下发「是否已配置」，endpoint / headers / body 均含密钥，绝不下发
    const llmExposed = { configured: !!(llm && llm.endpoint && llm.body) };
    return reply(res, 200, JSON.stringify({
      // sources 只作为「首次访问的默认值」，用户改动仅存浏览器本地、不回写
      sources: all.sources, device: deviceExposed, api: exposed, geo: geoExposed, llm: llmExposed
    }));
  }

  // 写回配置：仅服务端管理员可用，且只允许 device / api；sources 与门牌属于用户本地数据，不接受回写
  if (req.method === 'POST' && url.pathname === '/api/config') {
    if (!ADMIN_TOKEN || req.headers['x-admin-token'] !== ADMIN_TOKEN) {
      return reply(res, 403, JSON.stringify({
        error: '配置写入已关闭：服务端配置请直接编辑 data/*.json 后重启；如需远程写入，请设置环境变量 ADMIN_TOKEN 并在请求头带 x-admin-token。'
      }));
    }
    try {
      const input = JSON.parse(await readBody(req, 2_000_000) || '{}');
      const current = loadAll();
      ['device', 'api'].forEach(k => {
        if (input[k] && typeof input[k] === 'object') {
          const next = k === 'api' ? input[k] : Object.assign({}, current[k], input[k]);
          if (k === 'device') DOOR_KEYS.forEach(dk => { delete next[dk]; });
          writeJson(k + '.json', next);
        }
      });
      reply(res, 200, JSON.stringify({ ok: true }));
    } catch (error) {
      reply(res, 400, JSON.stringify({ error: '配置写入失败：' + error.message }));
    }
    return;
  }

  // 实时天气：和风天气（密钥留在服务端，前端不接触）
  if (req.method === 'GET' && url.pathname === '/api/geo') {
    const conf = Object.assign({}, DEFAULTS.geo, readJson('geo.json', DEFAULTS.geo));
    const key = (conf.qweatherKey || '').trim();
    const host = (conf.host || DEFAULTS.geo.host).trim();
    if (!key) {
      return reply(res, 400, JSON.stringify({
        error: '未配置和风天气 Key：在 data/geo.json 填 qweatherKey 后重启服务。'
          + '申请入口 https://console.qweather.com → 项目管理 → 创建凭据（类型选「Web API」）'
      }));
    }
    const asked = (url.searchParams.get('city') || '').trim();
    const fixed = (conf.city || '').trim();
    // 城市只来自「浏览器端 IP 定位回传的城市名」或「geo.json 里固定的 city」，服务端不再按出口 IP 定位（部署在云端时会失真）
    let target = asked, source = asked ? 'city' : '';
    if (!target && fixed) { target = fixed; source = 'config'; }
    if (!target) {
      return reply(res, 400, JSON.stringify({
        error: '未能确定城市：浏览器端定位未返回城市，且 data/geo.json 未配置固定 city。请点「刷新实时天气」重试，或在 data/geo.json 的 city 填城市后重启。'
      }));
    }
    try {
      let lookup;
      try {
        lookup = await getJson('https://' + host + '/geo/v2/city/lookup?location='
          + encodeURIComponent(target) + '&key=' + encodeURIComponent(key));
      } catch (e) {
        if (/404/.test(e.message)) throw new Error('和风 Key 无效或已过期：城市查询(geoapi)返回 404 空响应，请在 data/geo.json 核对 qweatherKey（复制时别带空格，且未禁用/过期）');
        throw new Error('城市查询请求失败（geoapi.qweather.com）：' + e.message);
      }
      if (lookup.code !== '200' || !lookup.location || !lookup.location[0]) {
        throw new Error('城市查询失败：' + (lookup.message || lookup.code || '无匹配城市'));
      }
      const place = lookup.location[0];
      let now;
      try {
        now = await getJson('https://' + host + '/v7/weather/now?location='
          + encodeURIComponent(place.id) + '&key=' + encodeURIComponent(key));
      } catch (e) {
        if (/Invalid Host|403/.test(e.message)) throw new Error('host 与 Key 类型不符：免费开发版用 devapi.qweather.com，标准版用 api.qweather.com（当前 host=' + host + '）');
        throw new Error('天气查询请求失败（' + host + '）：' + e.message);
      }
      if (now.code !== '200' || !now.now) {
        throw new Error('天气查询失败：' + (now.message || now.code || '无数据')
          + '（若提示 Invalid Host，把 data/geo.json 的 host 改成 api.qweather.com）');
      }
      reply(res, 200, JSON.stringify({
        location: place.adm1 || place.name,
        city: place.name,
        source: source,
        weather: now.now.text,
        temperature: now.now.temp,
        humidity: now.now.humidity,
        reporttime: now.now.obsTime
      }));
    } catch (error) {
      const reason = error.cause && error.cause.message ? error.cause.message : error.message;
      reply(res, 502, JSON.stringify({ error: '天气服务请求失败：' + reason }));
    }
    return;
  }

  // 图片代理：让远端图片变成同源，避免 canvas 被污染而无法导出 PNG
  if (req.method === 'GET' && url.pathname === '/api/image') {
    const target = url.searchParams.get('url');
    if (!/^https?:\/\//i.test(target || '')) return reply(res, 400, JSON.stringify({ error: 'url 必须是 HTTP(S) 地址' }));
    try {
      const upstream = await fetch(target);
      if (!upstream.ok) return reply(res, upstream.status, JSON.stringify({ error: '图片服务返回 HTTP ' + upstream.status }));
      const buffer = Buffer.from(await upstream.arrayBuffer());
      const type = upstream.headers.get('content-type') || 'image/png';
      if (!/^image\//.test(type)) return reply(res, 415, JSON.stringify({ error: '目标地址返回的不是图片' }));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(buffer);
    } catch (error) {
      const reason = error.cause && error.cause.message ? error.cause.message : error.message;
      reply(res, 502, JSON.stringify({ error: '图片代理请求失败：' + reason }));
    }
    return;
  }

  // 生图接口代理
  if (req.method === 'POST' && url.pathname === '/api/generate') {
    try {
      const input = JSON.parse(await readBody(req, 2_000_000) || '{}');
      // 前端不下发密钥：缺少的 endpoint / headers 由服务端配置补齐
      const saved = readJson('api.json', DEFAULTS.api);
      const endpoint = input.endpoint || saved.endpoint;
      const headers = Object.assign({}, saved.headers || {}, input.headers || {});
      // 允许 http 是为了本地/局域网调试；接公网服务请用 https
      if (!/^https?:\/\//i.test(endpoint || '')) return reply(res, 400, JSON.stringify({ error: 'endpoint 必须是 HTTP(S) 地址' }));
      const upstream = await fetch(endpoint, {
        method: input.method || saved.method || 'POST',
        headers: headers,
        body: JSON.stringify(input.body || {})
      });
      const payload = await upstream.text();
      reply(res, upstream.status, payload, upstream.headers.get('content-type') || 'application/json; charset=utf-8');
    } catch (error) {
      const reason = error.cause && error.cause.message ? error.cause.message : error.message;
      console.error('Upstream image API request failed:', reason);
      reply(res, 502, JSON.stringify({ error: '代理请求失败：' + reason }));
    }
    return;
  }

  // LLM 生成生图 Prompt 代理：指令由前端按输入信息拼好，模板与密钥留在服务端 data/llm.json
  if (req.method === 'POST' && url.pathname === '/api/llm') {
    try {
      const input = JSON.parse(await readBody(req, 2_000_000) || '{}');
      const conf = readJson('llm.json', null);
      if (!conf || !conf.endpoint || !conf.body) {
        return reply(res, 400, JSON.stringify({
          error: '未配置 LLM：请在 data/llm.json 填写 endpoint / headers / body（body 里用 {{instruction}} 占位符接收指令）后重启服务。'
        }));
      }
      if (!/^https?:\/\//i.test(conf.endpoint)) return reply(res, 400, JSON.stringify({ error: 'llm.json 的 endpoint 必须是 HTTP(S) 地址' }));
      const instruction = String(input.instruction || '').trim();
      if (!instruction) return reply(res, 400, JSON.stringify({ error: '缺少 instruction：没有可用的输入信息来生成 Prompt。' }));
      const upstream = await fetch(conf.endpoint, {
        method: conf.method || 'POST',
        headers: conf.headers || {},
        body: JSON.stringify(fillTemplate(conf.body, { instruction: instruction }))
      });
      const text = await upstream.text();
      if (!upstream.ok) {
        return reply(res, 502, JSON.stringify({ error: 'LLM 请求失败：HTTP ' + upstream.status + (text ? ' · ' + text.slice(0, 200) : ' · 空响应') }));
      }
      let data = null;
      try { data = JSON.parse(text); } catch (e) { /* 非 JSON，交给下面统一报错 */ }
      if (!data) return reply(res, 502, JSON.stringify({ error: 'LLM 返回的不是 JSON：' + text.slice(0, 200) }));
      const path = conf.responseTextPath || 'choices.0.message.content';
      const prompt = pickPath(data, path);
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return reply(res, 502, JSON.stringify({ error: '按 responseTextPath=' + path + ' 没取到文本，请核对 data/llm.json 与响应体。' }));
      }
      reply(res, 200, JSON.stringify({ prompt: prompt.trim() }));
    } catch (error) {
      const reason = error.cause && error.cause.message ? error.cause.message : error.message;
      console.error('Upstream LLM request failed:', reason);
      reply(res, 502, JSON.stringify({ error: 'LLM 代理请求失败：' + reason }));
    }
    return;
  }

  // 静态文件
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  // 含密钥的配置、以及 .env/.git 等点文件，一律不对公网暴露
  if (DENY_FILES.indexOf(requested) >= 0 || /(^|\/)\./.test(requested)) {
    return reply(res, 403, 'Forbidden', 'text/plain');
  }
  const file = path.resolve(root, '.' + requested);
  if (!file.startsWith(root + path.sep)) return reply(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, (error, data) => error
    ? reply(res, 404, 'Not found', 'text/plain')
    : reply(res, 200, data, types[path.extname(file)] || 'application/octet-stream'));
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 ' + port + ' 已被其它程序占用：要么停掉它，要么换端口启动');
    console.error('  PowerShell:  $env:PORT=4000; node server.js');
    process.exit(1);
  }
  throw err;
});

server.listen(port, () => console.log('Homia Studio running at http://localhost:' + port));
