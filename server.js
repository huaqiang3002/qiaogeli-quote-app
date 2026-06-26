const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 4173);
const PRICE_MARKUP = Number(process.env.PRICE_MARKUP || 50);
const DEFAULT_SOURCE_URL =
  "http://www.xatdtx.com/m/ykbjdQuoteList.action?is_spqc=Y&is_dls=N&gsdm=61271&pp=&km=&network=&bj=&tykhgsdm=";
const SOURCE_URL = process.env.SOURCE_URL || DEFAULT_SOURCE_URL;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "Hq@18609142259!";

const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const visitsFile = path.join(dataDir, "visits.jsonl");
let lastSnapshot = { ok: false, items: [], updatedAt: null, error: null };

function cleanText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function parseQuotes(html) {
  const items = [];
  let currentGroup = "未分类";
  let sourceTitle = "产品报价单";
  let pageCount = 1;

  const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (pageTitle) sourceTitle = cleanText(pageTitle[1]);
  const pageCountMatch = html.match(/var\s+pageCount\s*=\s*['"]?(\d+)['"]?/i);
  if (pageCountMatch) pageCount = Number(pageCountMatch[1]) || 1;

  const contentStart = html.indexOf('id="content"');
  const contentEnd = html.indexOf('<div class="ykbj_foot"', contentStart);
  const content =
    contentStart >= 0 ? html.slice(contentStart, contentEnd > contentStart ? contentEnd : undefined) : html;

  const tokenPattern =
    /<h4\b[\s\S]*?<\/h4>|<div\s+class\s*=\s*["'][^"']*\brow\b[^"']*["'][^>]*>\s*<div\s+class\s*=\s*["'][^"']*\bcol-xs-4\b[^"']*\bview-goods-type\b[^"']*["'][^>]*>[\s\S]*?<\/div>\s*<div\s+class\s*=\s*["'][^"']*\bcol-xs-3\b[^"']*\bview-quote\b[^"']*["'][^>]*>[\s\S]*?<\/div>\s*<\/div>/gi;

  for (const tokenMatch of content.matchAll(tokenPattern)) {
    const token = tokenMatch[0];
    if (/^<h4\b/i.test(token)) {
      currentGroup = cleanGroupName(cleanText(token));
      continue;
    }

    const nameMatch = token.match(
      /<div\s+class\s*=\s*["'][^"']*\bcol-xs-4\b[^"']*\bview-goods-type\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    );
    const priceMatch = token.match(
      /<div\s+class\s*=\s*["'][^"']*\bcol-xs-3\b[^"']*\bview-quote\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    );

    const name = cleanText(nameMatch && nameMatch[1]);
    const priceText = cleanText(priceMatch && priceMatch[1]);
    if (!name || !priceText) continue;
    if (isExcludedQuote(currentGroup, name)) continue;

    const numericPrice = Number(priceText.replace(/[^\d.-]/g, ""));
    const displayPrice = Number.isFinite(numericPrice) ? numericPrice + PRICE_MARKUP : null;
    items.push({
      id: `${currentGroup}|${name}`,
      group: currentGroup,
      name,
      originalPrice: Number.isFinite(numericPrice) ? numericPrice : null,
      price: displayPrice,
      priceText: displayPrice === null ? priceText : String(displayPrice),
    });
  }

  return { sourceTitle, items, pageCount };
}

function cleanGroupName(value) {
  return String(value || "")
    .replace(/\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*$/g, "")
    .trim();
}

function isExcludedQuote(group, name) {
  const text = `${group} ${name}`;
  return /泡泡玛特|心底密码|坐坐派对|前方高能|单品系列|拉布布|LABUBU/i.test(text);
}

function cookieHeader(headers) {
  const raw = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  const setCookies = raw.length ? raw : [headers.get("set-cookie")].filter(Boolean);
  return setCookies.map((cookie) => cookie.split(";")[0]).join("; ");
}

function formBody(data) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    body.set(key, String(value ?? ""));
  }
  return body;
}

async function fetchQuotes() {
  const url = new URL(SOURCE_URL);
  url.searchParams.set("km", "");
  url.searchParams.set("datetime", Date.now().toString());

  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
  });

  if (!response.ok) {
    throw new Error(`源站请求失败：HTTP ${response.status}`);
  }

  const html = await response.text();
  const sessionCookie = cookieHeader(response.headers);
  const parsed = parseQuotes(html);
  const items = [...parsed.items];

  for (let currentPage = 2; currentPage <= parsed.pageCount; currentPage += 1) {
    const nextResponse = await fetch("http://www.xatdtx.com/m/mobileYkfetchNextList.action", {
      method: "POST",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        Accept: "text/html,*/*;q=0.8",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Cookie: sessionCookie,
        Referer: url.toString(),
      },
      body: formBody({
        is_spqc: "Y",
        start: (currentPage - 1) * 200 + 2,
        km: "",
        pp: "",
        arg_name: "",
        s_jg: "0",
        e_jg: "9999999",
        lastpp: "",
        type: "",
        bj: "",
        tykhgsdm: "",
        currentPage,
        lastname: "",
        date: Date.now(),
        is_dls: "N",
      }),
    });

    if (!nextResponse.ok) break;
    const nextHtml = await nextResponse.text();
    const nextParsed = parseQuotes(nextHtml);
    if (!nextParsed.items.length) break;
    items.push(...nextParsed.items);
  }

  const now = new Date().toISOString();
  lastSnapshot = {
    ok: true,
    sourceUrl: url.toString(),
    title: parsed.sourceTitle,
    count: items.length,
    updatedAt: now,
    items,
    error: null,
  };
  return lastSnapshot;
}

function filterItems(snapshot, keyword) {
  const q = String(keyword || "").trim().toLowerCase();
  if (!q) return snapshot;

  const items = snapshot.items.filter(
    (item) =>
      item.name.toLowerCase().includes(q) ||
      item.group.toLowerCase().includes(q) ||
      item.priceText.toLowerCase().includes(q)
  );

  return {
    ...snapshot,
    count: items.length,
    items,
  };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20000) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return String(Array.isArray(forwarded) ? forwarded[0] : forwarded || req.socket.remoteAddress || "")
    .split(",")[0]
    .trim();
}

function deviceFromUa(userAgent) {
  const ua = String(userAgent || "");
  if (/MicroMessenger/i.test(ua)) return "微信";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Macintosh/i.test(ua)) return "Mac";
  return "其他";
}

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function logVisit(req, event = {}) {
  ensureDataDir();
  const record = {
    ts: new Date().toISOString(),
    ip: clientIp(req),
    ua: req.headers["user-agent"] || "",
    device: deviceFromUa(req.headers["user-agent"]),
    referer: req.headers.referer || "",
    type: String(event.type || "pageview").slice(0, 40),
    path: String(event.path || "").slice(0, 200),
    category: String(event.category || "").slice(0, 120),
    keyword: String(event.keyword || "").slice(0, 120),
  };
  fs.appendFile(visitsFile, `${JSON.stringify(record)}\n`, () => {});
}

function readVisits() {
  try {
    return fs
      .readFileSync(visitsFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .slice(-2000);
  } catch {
    return [];
  }
}

function topCounts(records, key, limit = 10) {
  const counts = new Map();
  for (const record of records) {
    const value = String(record[key] || "").trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function adminStats() {
  const records = readVisits();
  const today = new Date().toISOString().slice(0, 10);
  const pageviews = records.filter((record) => record.type === "pageview");
  const uniqueIps = new Set(records.map((record) => record.ip).filter(Boolean));
  return {
    totalEvents: records.length,
    totalVisits: pageviews.length,
    todayVisits: pageviews.filter((record) => String(record.ts).startsWith(today)).length,
    uniqueIps: uniqueIps.size,
    devices: topCounts(records, "device"),
    categories: topCounts(records.filter((record) => record.type === "category"), "category"),
    keywords: topCounts(records.filter((record) => record.type === "search"), "keyword"),
    recent: records.slice(-80).reverse(),
  };
}

function requireAdmin(req, res) {
  const header = req.headers.authorization || "";
  const prefix = "Basic ";
  if (header.startsWith(prefix)) {
    const decoded = Buffer.from(header.slice(prefix.length), "base64").toString("utf8");
    const splitAt = decoded.indexOf(":");
    const user = decoded.slice(0, splitAt);
    const pass = decoded.slice(splitAt + 1);
    if (user === ADMIN_USER && pass === ADMIN_PASS) return true;
  }
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Qiaogeli Admin"',
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end("需要后台账号密码");
  return false;
}

function adminPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>报价访问后台</title>
  <style>
    body{margin:0;background:#f5f7f8;color:#182026;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
    main{width:min(1100px,calc(100% - 24px));margin:18px auto}
    h1{font-size:24px;margin:0 0 14px}
    .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
    .card{background:#fff;border:1px solid #dce2e6;border-radius:8px;padding:14px}
    .card span{display:block;color:#65717b;font-size:13px;margin-bottom:6px}
    .card strong{font-size:24px}
    section{background:#fff;border:1px solid #dce2e6;border-radius:8px;margin-top:12px;padding:14px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{border-bottom:1px solid #e7ecef;padding:8px;text-align:left;vertical-align:top}
    th{background:#f0f3f5}
    ul{margin:0;padding-left:18px}
    @media(max-width:760px){.grid{grid-template-columns:1fr 1fr} table{font-size:12px}}
  </style>
</head>
<body>
  <main>
    <h1>报价访问后台</h1>
    <div class="grid">
      <div class="card"><span>总访问</span><strong id="totalVisits">-</strong></div>
      <div class="card"><span>今日访问</span><strong id="todayVisits">-</strong></div>
      <div class="card"><span>独立 IP</span><strong id="uniqueIps">-</strong></div>
      <div class="card"><span>事件数</span><strong id="totalEvents">-</strong></div>
    </div>
    <section><h2>热门设备</h2><ul id="devices"></ul></section>
    <section><h2>热门分类</h2><ul id="categories"></ul></section>
    <section><h2>热门搜索</h2><ul id="keywords"></ul></section>
    <section>
      <h2>最近访问</h2>
      <table>
        <thead><tr><th>时间</th><th>IP</th><th>设备</th><th>事件</th><th>分类/搜索</th><th>来源</th></tr></thead>
        <tbody id="recent"></tbody>
      </table>
    </section>
  </main>
  <script>
    function esc(v){return String(v||"").replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]})}
    function list(id, arr){document.getElementById(id).innerHTML=(arr.length?arr:[{name:"暂无",count:""}]).map(x=>"<li>"+esc(x.name)+" "+esc(x.count)+"</li>").join("")}
    fetch("/api/admin/stats").then(r=>r.json()).then(d=>{
      for (const k of ["totalVisits","todayVisits","uniqueIps","totalEvents"]) document.getElementById(k).textContent=d[k];
      list("devices", d.devices); list("categories", d.categories); list("keywords", d.keywords);
      document.getElementById("recent").innerHTML=d.recent.map(r=>"<tr><td>"+esc(r.ts)+"</td><td>"+esc(r.ip)+"</td><td>"+esc(r.device)+"</td><td>"+esc(r.type)+"</td><td>"+esc(r.category||r.keyword)+"</td><td>"+esc(r.referer)+"</td></tr>").join("");
    });
  </script>
</body>
</html>`;
}

function browserFromUa(userAgent) {
  const ua = String(userAgent || "");
  if (/MicroMessenger/i.test(ua)) return "微信内置浏览器";
  if (/Edg\//i.test(ua)) return "Edge";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return "Safari";
  return "未知浏览器";
}

function shortHash(value) {
  return require("node:crypto").createHash("sha1").update(String(value || "")).digest("hex").slice(0, 10);
}

function visitorIdFrom(ip, ua) {
  return shortHash(`${ip || ""}|${ua || ""}`);
}

function deviceFromUa(userAgent) {
  const ua = String(userAgent || "");
  if (/MicroMessenger/i.test(ua)) return "微信";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Macintosh/i.test(ua)) return "Mac";
  return "其他";
}

function logVisit(req, event = {}) {
  ensureDataDir();
  const ip = clientIp(req);
  const ua = req.headers["user-agent"] || "";
  const record = {
    ts: new Date().toISOString(),
    ip,
    ua,
    visitorId: visitorIdFrom(ip, ua),
    device: deviceFromUa(ua),
    browser: browserFromUa(ua),
    referer: req.headers.referer || "",
    type: String(event.type || "pageview").slice(0, 40),
    path: String(event.path || "").slice(0, 200),
    category: String(event.category || "").slice(0, 120),
    keyword: String(event.keyword || "").slice(0, 120),
    count: Number(event.count || 0) || 0,
  };
  fs.appendFile(visitsFile, `${JSON.stringify(record)}\n`, () => {});
}

function actionText(record) {
  const labels = {
    pageview: "打开页面",
    data_view: "查看报价数据",
    category: "查看分类",
    search: "搜索产品",
  };
  return labels[record.type] || record.type || "访问";
}

function buildVisitors(records) {
  const visitors = new Map();
  for (const record of records) {
    const id = record.visitorId || visitorIdFrom(record.ip, record.ua);
    const item =
      visitors.get(id) ||
      {
        id,
        ip: record.ip || "",
        device: record.device || deviceFromUa(record.ua),
        browser: record.browser || browserFromUa(record.ua),
        firstSeen: record.ts,
        lastSeen: record.ts,
        pageviews: 0,
        dataViews: 0,
        events: 0,
        categories: new Set(),
        keywords: new Set(),
        referers: new Set(),
      };
    item.firstSeen = String(item.firstSeen) < String(record.ts) ? item.firstSeen : record.ts;
    item.lastSeen = String(item.lastSeen) > String(record.ts) ? item.lastSeen : record.ts;
    item.events += 1;
    if (record.type === "pageview") item.pageviews += 1;
    if (record.type === "data_view") item.dataViews += 1;
    if (record.category) item.categories.add(record.category);
    if (record.keyword) item.keywords.add(record.keyword);
    if (record.referer) item.referers.add(record.referer);
    visitors.set(id, item);
  }

  return [...visitors.values()]
    .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
    .slice(0, 200)
    .map((item) => ({
      ...item,
      categories: [...item.categories].slice(-8),
      keywords: [...item.keywords].slice(-8),
      referers: [...item.referers].slice(-3),
    }));
}

function adminStats() {
  const records = readVisits();
  const today = new Date().toISOString().slice(0, 10);
  const pageviews = records.filter((record) => record.type === "pageview");
  const dataViews = records.filter((record) => record.type === "data_view");
  const uniqueIps = new Set(records.map((record) => record.ip).filter(Boolean));
  return {
    totalEvents: records.length,
    totalVisits: pageviews.length,
    todayVisits: pageviews.filter((record) => String(record.ts).startsWith(today)).length,
    dataViews: dataViews.length,
    uniqueIps: uniqueIps.size,
    devices: topCounts(records, "device"),
    categories: topCounts(records.filter((record) => record.type === "category"), "category"),
    keywords: topCounts(records.filter((record) => record.type === "search"), "keyword"),
    visitors: buildVisitors(records),
    recent: records
      .slice(-120)
      .reverse()
      .map((record) => ({
        ...record,
        action: actionText(record),
        browser: record.browser || browserFromUa(record.ua),
        visitorId: record.visitorId || visitorIdFrom(record.ip, record.ua),
      })),
  };
}

function adminPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>报价访问后台</title>
  <style>
    body{margin:0;background:#f4f6f8;color:#17202a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
    main{width:min(1180px,calc(100% - 24px));margin:18px auto 34px}
    header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}
    h1{font-size:24px;margin:0 0 6px}
    p{margin:0;color:#65717b;font-size:13px;line-height:1.6}
    a{color:#0969da}
    .grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}
    .card{background:#fff;border:1px solid #dce2e6;border-radius:8px;padding:14px}
    .card span{display:block;color:#65717b;font-size:13px;margin-bottom:6px}
    .card strong{font-size:24px}
    section{background:#fff;border:1px solid #dce2e6;border-radius:8px;margin-top:12px;padding:14px;overflow:auto}
    h2{font-size:17px;margin:0 0 10px}
    table{width:100%;border-collapse:collapse;font-size:13px;min-width:780px}
    th,td{border-bottom:1px solid #e7ecef;padding:9px 8px;text-align:left;vertical-align:top}
    th{background:#f0f3f5;color:#38424c;font-weight:650}
    ul{margin:0;padding-left:18px}
    .lists{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
    .muted{color:#65717b}
    .tag{display:inline-block;background:#eef6ff;color:#0958b8;border:1px solid #d7eaff;border-radius:999px;padding:2px 7px;margin:0 4px 4px 0}
    .toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
    input,button{height:34px;border:1px solid #cfd7de;border-radius:6px;background:#fff;padding:0 10px;font:inherit}
    button{cursor:pointer;background:#0969da;color:#fff;border-color:#0969da}
    @media(max-width:860px){.grid{grid-template-columns:1fr 1fr}.lists{grid-template-columns:1fr}header{display:block}}
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>报价访问后台</h1>
        <p>后台入口：<a href="/admin">/admin</a>。目前能识别到 IP、设备、浏览器、访问时间、看过的分类和搜索词；微信昵称需要后续接公众号授权登录。</p>
      </div>
      <button onclick="location.reload()">刷新</button>
    </header>
    <div class="grid">
      <div class="card"><span>总打开次数</span><strong id="totalVisits">-</strong></div>
      <div class="card"><span>今日打开</span><strong id="todayVisits">-</strong></div>
      <div class="card"><span>查看报价数据</span><strong id="dataViews">-</strong></div>
      <div class="card"><span>独立 IP</span><strong id="uniqueIps">-</strong></div>
      <div class="card"><span>记录事件</span><strong id="totalEvents">-</strong></div>
    </div>
    <section>
      <h2>访客列表</h2>
      <div class="toolbar">
        <input id="visitorFilter" placeholder="搜索 IP / 设备 / 分类 / 搜索词" />
        <button id="exportVisitors">导出访客 CSV</button>
      </div>
      <table>
        <thead><tr><th>访客</th><th>最后访问</th><th>打开/看数据</th><th>看过分类</th><th>搜索词</th><th>来源</th></tr></thead>
        <tbody id="visitors"></tbody>
      </table>
    </section>
    <section class="lists">
      <div><h2>热门设备</h2><ul id="devices"></ul></div>
      <div><h2>热门分类</h2><ul id="categories"></ul></div>
      <div><h2>热门搜索</h2><ul id="keywords"></ul></div>
    </section>
    <section>
      <h2>最近访问记录</h2>
      <table>
        <thead><tr><th>时间</th><th>访客/IP</th><th>设备</th><th>动作</th><th>分类/搜索</th><th>来源</th></tr></thead>
        <tbody id="recent"></tbody>
      </table>
    </section>
  </main>
  <script>
    let stats = null;
    function esc(v){return String(v||"").replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]})}
    function time(v){try{return new Date(v).toLocaleString("zh-CN",{hour12:false})}catch{return v||""}}
    function list(id, arr){document.getElementById(id).innerHTML=(arr&&arr.length?arr:[{name:"暂无",count:""}]).map(x=>"<li>"+esc(x.name)+" "+esc(x.count)+"</li>").join("")}
    function tags(values){return (values&&values.length?values:["-"]).map(v=>v==="-"?"<span class='muted'>-</span>":"<span class='tag'>"+esc(v)+"</span>").join("")}
    function csvCell(v){return '"'+String(v||"").replace(/"/g,'""')+'"'}
    function downloadCsv(name, rows){
      const csv="\\ufeff"+rows.map(row=>row.map(csvCell).join(",")).join("\\n");
      const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
      const a=document.createElement("a"); a.href=url; a.download=name; a.click(); URL.revokeObjectURL(url);
    }
    function renderVisitors(){
      const q=document.getElementById("visitorFilter").value.trim().toLowerCase();
      const rows=(stats.visitors||[]).filter(v=>JSON.stringify(v).toLowerCase().includes(q));
      document.getElementById("visitors").innerHTML=rows.map(v=>
        "<tr><td><strong>"+esc(v.ip)+"</strong><br><span class='muted'>"+esc(v.id)+" / "+esc(v.device)+" / "+esc(v.browser)+"</span></td>"+
        "<td>"+esc(time(v.lastSeen))+"<br><span class='muted'>首次 "+esc(time(v.firstSeen))+"</span></td>"+
        "<td>"+esc(v.pageviews)+" / "+esc(v.dataViews)+"<br><span class='muted'>事件 "+esc(v.events)+"</span></td>"+
        "<td>"+tags(v.categories)+"</td><td>"+tags(v.keywords)+"</td><td>"+tags(v.referers)+"</td></tr>"
      ).join("") || "<tr><td colspan='6' class='muted'>暂无记录</td></tr>";
    }
    fetch("/api/admin/stats").then(r=>r.json()).then(d=>{
      stats=d;
      for (const k of ["totalVisits","todayVisits","dataViews","uniqueIps","totalEvents"]) document.getElementById(k).textContent=d[k]||0;
      list("devices", d.devices); list("categories", d.categories); list("keywords", d.keywords);
      renderVisitors();
      document.getElementById("recent").innerHTML=(d.recent||[]).map(r=>
        "<tr><td>"+esc(time(r.ts))+"</td><td><strong>"+esc(r.ip)+"</strong><br><span class='muted'>"+esc(r.visitorId)+"</span></td>"+
        "<td>"+esc(r.device)+"<br><span class='muted'>"+esc(r.browser)+"</span></td><td>"+esc(r.action)+"</td>"+
        "<td>"+esc(r.category||r.keyword||("-"+(r.count?(" / "+r.count+"条"):"")))+"</td><td>"+esc(r.referer)+"</td></tr>"
      ).join("");
      document.getElementById("visitorFilter").addEventListener("input", renderVisitors);
      document.getElementById("exportVisitors").addEventListener("click", function(){
        const rows=[["访客ID","IP","设备","浏览器","首次访问","最后访问","打开次数","查看数据次数","分类","搜索词","来源"]];
        for (const v of stats.visitors||[]) rows.push([v.id,v.ip,v.device,v.browser,time(v.firstSeen),time(v.lastSeen),v.pageviews,v.dataViews,(v.categories||[]).join(" / "),(v.keywords||[]).join(" / "),(v.referers||[]).join(" / ")]);
        downloadCsv("报价访问访客.csv", rows);
      });
    });
  </script>
</body>
</html>`;
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
  };

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname === "/admin") {
    if (!requireAdmin(req, res)) return;
    sendHtml(res, 200, adminPage());
    return;
  }

  if (requestUrl.pathname === "/api/admin/stats") {
    if (!requireAdmin(req, res)) return;
    sendJson(res, 200, adminStats());
    return;
  }

  if (requestUrl.pathname === "/api/track" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const event = body ? JSON.parse(body) : {};
      logVisit(req, event);
      sendJson(res, 200, { ok: true });
    } catch {
      sendJson(res, 400, { ok: false });
    }
    return;
  }

  if (requestUrl.pathname === "/api/quotes") {
    try {
      const snapshot = await fetchQuotes();
      logVisit(req, {
        type: "data_view",
        path: requestUrl.pathname,
        keyword: requestUrl.searchParams.get("keyword") || "",
        count: snapshot.count,
      });
      sendJson(res, 200, filterItems(snapshot, requestUrl.searchParams.get("keyword")));
    } catch (error) {
      sendJson(res, 502, {
        ...filterItems(lastSnapshot, requestUrl.searchParams.get("keyword")),
        ok: false,
        error: error.message,
      });
    }
    return;
  }

  const safePath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  sendFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`报价小程序已启动：http://localhost:${PORT}`);
  console.log(`数据源：${SOURCE_URL}`);
});
