const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 4173);
const PRICE_MARKUP = Number(process.env.PRICE_MARKUP || 50);
const DEFAULT_SOURCE_URL =
  "http://www.xatdtx.com/m/ykbjdQuoteList.action?is_spqc=Y&is_dls=N&gsdm=61271&pp=&km=&network=&bj=&tykhgsdm=";
const SOURCE_URL = process.env.SOURCE_URL || DEFAULT_SOURCE_URL;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "Hq@18609142259!";
const SITE_ORIGIN = process.env.SITE_ORIGIN || "https://quote.qiaogeli.cn";
const WECHAT_APP_ID = process.env.WECHAT_APP_ID || "wx9d1d61bb3652ba92";
const WECHAT_APP_SECRET = process.env.WECHAT_APP_SECRET || "";
const WECHAT_AUTH_AUTO = process.env.WECHAT_AUTH_AUTO !== "0";

const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const visitsFile = path.join(dataDir, "visits.jsonl");
const quotesCacheFile = path.join(dataDir, "quotes-cache.json");
let lastSnapshot = { ok: false, items: [], updatedAt: null, error: null };
let officialTokenCache = { token: "", expiresAt: 0 };
let jsapiTicketCache = { ticket: "", expiresAt: 0 };

const CATEGORY_ORDER = [
  "苹果手机",
  "平板",
  "电脑",
  "手表",
  "配件",
  "大疆",
  "华为",
  "泡泡玛特",
];

const APPLE_PHONE_BRAND_ORDER = [
  "苹果17",
  "苹果17Air",
  "苹果17e",
  "苹果17pro",
  "苹果17promax",
  "苹果16",
  "苹果16e",
  "苹果16pro",
  "苹果16promax",
  "苹果15",
];

const TABLET_BRAND_ORDER = [
  "2025款11代pad",
  "24款mini7",
  "2026款Air8 11寸 M4芯片",
  "2026款Air8 13寸 M4芯片",
  "25款Pro 11寸 M5芯片",
  "25款Pro 13寸 M5芯片",
];

const ULTRA3_CODE_ORDER = [
  "WJ4",
  "0M4",
  "WL4",
  "WN4",
  "WQ4",
  "0U4",
  "0W4",
  "1A4",
  "WT4",
  "WV4",
  "1E4",
  "1L4",
  "WX4",
  "0A4",
  "0G4",
  "1P4",
  "1R4",
  "1U4",
];

function quoteText(group, name) {
  return `${group || ""} ${name || ""}`;
}

function classifyQuoteGroup(group, name) {
  const text = quoteText(group, name);
  if (/泡泡玛特|心底密码|坐坐派对|前方高能|单品系列|拉布布|LABUBU/i.test(text)) {
    return "泡泡玛特";
  }
  if (/大疆|DJI|Pocket|Osmo/i.test(text)) return "大疆";
  if (/华为|HUAWEI|Mate|Pura|nova|折叠屏/i.test(text) && !/大疆|DJI/i.test(text)) {
    return "华为";
  }
  if (/MacBook|Mac\s*mini|Mac\s*Studio|Mac\s*Pro|iMac|苹果电脑|笔记本|电脑|主机|13\.6寸\s*air|15寸\s*air|14寸\s*pro|16寸\s*pro|26款13寸A18Pro|13寸A18Pro/i.test(text)) {
    return "电脑";
  }
  if (/AirPods|耳机|充电|保护壳|保护膜|数据线|充电器|键盘|鼠标|触控板|Apple\s*Pencil|Pencil|手写笔|配件/i.test(text)) {
    return "配件";
  }
  if (/iPad|平板|\bpad\b|mini7|Air[678]\s*(11寸|13寸)|Pro\s*(11寸|13寸)|11代pad/i.test(text)) {
    return "平板";
  }
  if (/Apple\s*Watch|Watch|手表|Ultra|UItra/i.test(text)) return "手表";
  if (/iPhone|苹果手机|苹果/i.test(text)) return "苹果手机";
  return cleanGroupName(group) || "其他";
}

function classifyQuoteBrand(group, name, displayGroup) {
  const text = quoteText(group, name);
  if (displayGroup === "苹果手机") {
    const rank = applePhoneRank(text);
    const index = Math.floor(rank / 10);
    const suffix = rank % 10;
    const generation = 30 - index;
    if (!Number.isFinite(generation) || generation <= 0) return cleanGroupName(group) || "苹果手机";
    if (suffix === 0) return `苹果${generation}`;
    if (suffix === 1) return `苹果${generation}Air`;
    if (suffix === 2) return `苹果${generation}e`;
    if (suffix === 3) return `苹果${generation}pro`;
    if (suffix === 4) return `苹果${generation}promax`;
  }
  if (displayGroup === "平板") {
    return cleanGroupName(group) || "平板";
  }
  return cleanGroupName(group) || displayGroup || "其他";
}

function markupForQuote(group, name) {
  const normalizedGroup = classifyQuoteGroup(group, name);
  const text = quoteText(group, name);
  if (normalizedGroup === "华为") return 100;
  if (normalizedGroup === "电脑") return 100;
  if (normalizedGroup === "配件" && /键盘|Keyboard/i.test(text)) return 100;
  if (normalizedGroup === "配件" && /蓝牙耳机|AirPods|耳机/i.test(text)) return 50;
  if (normalizedGroup === "配件" || normalizedGroup === "手表") return 30;
  return PRICE_MARKUP;
}

function categoryRank(group) {
  const index = CATEGORY_ORDER.indexOf(group);
  return index >= 0 ? index : CATEGORY_ORDER.length;
}

function applePhoneRank(text) {
  const value = String(text || "");
  const model = value.match(/(?:iPhone\s*)?(\d{2})(?:\s*(Pro\s*Max|promax|Air|e|Pro|Plus|MAX|Max))?/i);
  if (!model) return 9999;

  const generation = Number(model[1]);
  const suffix = String(model[2] || "").replace(/\s+/g, "").toLowerCase();
  const suffixRank = suffix === "" ? 0 : suffix === "air" ? 1 : suffix === "e" ? 2 : suffix === "pro" ? 3 : suffix === "promax" || suffix === "max" ? 4 : 5;
  return (30 - generation) * 10 + suffixRank;
}

function quoteSortKey(item) {
  if (item.group === "苹果手机") return applePhoneRank(item.name);
  return 0;
}

function brandRank(item) {
  if (item.group === "苹果手机") {
    const index = APPLE_PHONE_BRAND_ORDER.indexOf(item.brand);
    return index >= 0 ? index : APPLE_PHONE_BRAND_ORDER.length;
  }
  if (item.group === "平板") {
    const index = TABLET_BRAND_ORDER.indexOf(item.brand);
    return index >= 0 ? index : TABLET_BRAND_ORDER.length;
  }
  return 0;
}

function priceRank(item) {
  return typeof item.price === "number" ? item.price : Number.POSITIVE_INFINITY;
}

function colorRank(item) {
  const text = String(item.name || "");
  const colorMatch = text.match(
    /(白色|黑色|青雾蓝|鼠尾绿|薰衣紫|深空灰|星光|银色|蓝色|蓝|粉色|粉|紫色|紫|午夜|天蓝|原色|曜石黑|云锦白|寰宇红|赤兔红|雪域白|靛蓝色|柑橘黄|桃粉色)/
  );
  return colorMatch ? colorMatch[1] : "";
}

function ultra3Rank(item) {
  const code = String(item.name || "").match(/\(([A-Z0-9]+)\)\s*$/i)?.[1]?.toUpperCase();
  const index = ULTRA3_CODE_ORDER.indexOf(code);
  return index >= 0 ? index : ULTRA3_CODE_ORDER.length;
}

function isUltra3(item) {
  return /U(?:l|I)?tra3/i.test(String(item.name || ""));
}

function sortQuotes(items) {
  return items.sort((a, b) => {
    const categoryDiff = categoryRank(a.group) - categoryRank(b.group);
    if (categoryDiff) return categoryDiff;
    if (a.group === "电脑" && b.group === "电脑") {
      const priceDiff = priceRank(a) - priceRank(b);
      if (priceDiff) return priceDiff;
    }
    const brandDiff = brandRank(a) - brandRank(b);
    if (brandDiff) return brandDiff;
    if (a.brand && b.brand && a.brand === b.brand) {
      const priceDiff = priceRank(a) - priceRank(b);
      if (priceDiff) return priceDiff;
      if (a.group === "苹果手机") {
        const colorDiff = colorRank(a).localeCompare(colorRank(b), "zh-CN");
        if (colorDiff) return colorDiff;
      }
    }
    if (
      a.group === "手表" &&
      b.group === "手表" &&
      isUltra3(a) &&
      isUltra3(b)
    ) {
      const ultraDiff = ultra3Rank(a) - ultra3Rank(b);
      if (ultraDiff) return ultraDiff;
    }
    const modelDiff = quoteSortKey(a) - quoteSortKey(b);
    if (modelDiff) return modelDiff;
    return `${a.originalGroup || ""} ${a.name}`.localeCompare(`${b.originalGroup || ""} ${b.name}`, "zh-CN", {
      numeric: true,
    });
  });
}

function readQuoteCache() {
  try {
    const snapshot = JSON.parse(fs.readFileSync(quotesCacheFile, "utf8"));
    if (snapshot && Array.isArray(snapshot.items) && snapshot.items.length) {
      return { ...snapshot, ok: true, items: sortQuotes(snapshot.items) };
    }
  } catch {}
  return null;
}

function writeQuoteCache(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items) || !snapshot.items.length) return;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(quotesCacheFile, JSON.stringify(snapshot, null, 2));
}

const cachedSnapshot = readQuoteCache();
if (cachedSnapshot) lastSnapshot = cachedSnapshot;

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
    const displayGroup = classifyQuoteGroup(currentGroup, name);
    const brand = classifyQuoteBrand(currentGroup, name, displayGroup);
    const markup = markupForQuote(currentGroup, name);
    const displayPrice = Number.isFinite(numericPrice) ? numericPrice + markup : null;
    items.push({
      id: `${displayGroup}|${brand}|${currentGroup}|${name}`,
      group: displayGroup,
      brand,
      originalGroup: currentGroup,
      name,
      originalPrice: Number.isFinite(numericPrice) ? numericPrice : null,
      markup,
      price: displayPrice,
      priceText: displayPrice === null ? priceText : String(displayPrice),
    });
  }

  return { sourceTitle, items: sortQuotes(items), pageCount };
}

function cleanGroupName(value) {
  return String(value || "")
    .replace(/\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*$/g, "")
    .trim();
}

function isExcludedQuote(group, name) {
  const text = `${group} ${name}`;
  return /泡泡玛特|心底密码|坐坐派对|前方高能|单品系列|拉布布|LABUBU|苹果15\s*pro(?:max)?|15\s*Pro(?:\s*Max)?|22款pad\s*10代|24款Air6|2025款Air7\s*(?:11寸|13寸)|25款Air7\s*(?:11寸|13寸)/i.test(text);
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

  if (!items.length) {
    const cached = readQuoteCache() || (lastSnapshot.items.length ? lastSnapshot : null);
    if (cached) {
      lastSnapshot = {
        ...cached,
        ok: true,
        sourceUrl: url.toString(),
        error: "源站暂时返回空列表，已显示最近一次有效报价",
      };
      return lastSnapshot;
    }
  }

  const now = new Date().toISOString();
  lastSnapshot = {
    ok: true,
    sourceUrl: url.toString(),
    title: parsed.sourceTitle,
    count: items.length,
    updatedAt: now,
    items: sortQuotes(items),
    error: null,
  };
  writeQuoteCache(lastSnapshot);
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
    shareDebug: records
      .filter((record) => record.type === "wechat_share")
      .slice(-30)
      .reverse()
      .map((record) => ({
        ts: record.ts,
        status: record.category,
        detail: record.keyword,
        ip: record.ip,
        ua: record.ua,
      })),
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

function isWechatUa(userAgent) {
  return /MicroMessenger/i.test(String(userAgent || ""));
}

function wechatVersionFromUa(userAgent) {
  const match = String(userAgent || "").match(/MicroMessenger\/([\d.]+)/i);
  return match ? match[1] : "";
}

function shareTagFromPath(value) {
  try {
    return new URL(String(value || "/"), SITE_ORIGIN).searchParams.get("share") || "";
  } catch {
    return "";
  }
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function signValue(value) {
  return require("node:crypto").createHmac("sha256", ADMIN_PASS).update(value).digest("base64url");
}

function encodeSignedCookie(data) {
  const payload = Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  return `${payload}.${signValue(payload)}`;
}

function decodeSignedCookie(value) {
  const [payload, signature] = String(value || "").split(".");
  if (!payload || !signature || signValue(payload) !== signature) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function currentWechatUser(req) {
  return decodeSignedCookie(parseCookies(req).qg_wechat);
}

function safeReturnPath(value) {
  const text = String(value || "/");
  if (!text.startsWith("/") || text.startsWith("//") || text.includes("\\")) return "/";
  return text.slice(0, 300);
}

function encodeState(returnTo) {
  return Buffer.from(safeReturnPath(returnTo), "utf8").toString("base64url").slice(0, 120);
}

function decodeState(state) {
  try {
    return safeReturnPath(Buffer.from(String(state || ""), "base64url").toString("utf8"));
  } catch {
    return "/";
  }
}

async function fetchWechatJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const data = await response.json();
  if (!response.ok || data.errcode) {
    throw new Error(data.errmsg || `WeChat HTTP ${response.status}`);
  }
  return data;
}

async function getOfficialAccessToken() {
  if (officialTokenCache.token && officialTokenCache.expiresAt > Date.now() + 60000) {
    return officialTokenCache.token;
  }
  const tokenUrl = new URL("https://api.weixin.qq.com/cgi-bin/stable_token");
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credential",
      appid: WECHAT_APP_ID,
      secret: WECHAT_APP_SECRET,
      force_refresh: false,
    }),
  });
  const data = await response.json();
  if (!response.ok || data.errcode || !data.access_token) {
    throw new Error(data.errmsg || `WeChat token HTTP ${response.status}`);
  }
  officialTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(300, Number(data.expires_in || 7200) - 120) * 1000,
  };
  return officialTokenCache.token;
}

async function getJsapiTicket() {
  if (jsapiTicketCache.ticket && jsapiTicketCache.expiresAt > Date.now() + 60000) {
    return jsapiTicketCache.ticket;
  }
  const accessToken = await getOfficialAccessToken();
  const ticketUrl = new URL("https://api.weixin.qq.com/cgi-bin/ticket/getticket");
  ticketUrl.searchParams.set("access_token", accessToken);
  ticketUrl.searchParams.set("type", "jsapi");
  const response = await fetch(ticketUrl);
  const data = await response.json();
  if (!response.ok || data.errcode || !data.ticket) {
    throw new Error(data.errmsg || `WeChat ticket HTTP ${response.status}`);
  }
  jsapiTicketCache = {
    ticket: data.ticket,
    expiresAt: Date.now() + Math.max(300, Number(data.expires_in || 7200) - 120) * 1000,
  };
  return jsapiTicketCache.ticket;
}

async function wechatJsConfig(pageUrl) {
  if (!WECHAT_APP_ID || !WECHAT_APP_SECRET) {
    return { configured: false };
  }
  const ticket = await getJsapiTicket();
  const nonceStr = crypto.randomBytes(8).toString("hex");
  const timestamp = Math.floor(Date.now() / 1000);
  const url = String(pageUrl || SITE_ORIGIN).split("#")[0];
  const raw = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
  const signature = crypto.createHash("sha1").update(raw).digest("hex");
  return {
    configured: true,
    appId: WECHAT_APP_ID,
    timestamp,
    nonceStr,
    signature,
    jsApiList: ["updateAppMessageShareData", "updateTimelineShareData", "onMenuShareAppMessage", "onMenuShareTimeline"],
  };
}

async function getOfficialWechatProfile(openid) {
  const accessToken = await getOfficialAccessToken();
  const profileUrl = new URL("https://api.weixin.qq.com/cgi-bin/user/info");
  profileUrl.searchParams.set("access_token", accessToken);
  profileUrl.searchParams.set("openid", openid);
  profileUrl.searchParams.set("lang", "zh_CN");
  return fetchWechatJson(profileUrl);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

function wechatAuthStatus(req) {
  const user = currentWechatUser(req);
  return {
    configured: Boolean(WECHAT_APP_ID && WECHAT_APP_SECRET),
    auto: WECHAT_AUTH_AUTO,
    inWechat: isWechatUa(req.headers["user-agent"]),
    authenticated: Boolean(user && user.openid),
    user: user
      ? {
          openid: user.openid,
          nickname: user.nickname || "",
          headimgurl: user.headimgurl || "",
        }
      : null,
  };
}

function startWechatAuth(req, res, requestUrl) {
  if (!WECHAT_APP_ID || !WECHAT_APP_SECRET) {
    sendHtml(
      res,
      503,
      "<!doctype html><meta charset='utf-8'><title>微信授权未配置</title><p>微信授权还缺少 AppSecret，请先在服务器配置 WECHAT_APP_SECRET。</p>"
    );
    return;
  }
  const returnTo = safeReturnPath(requestUrl.searchParams.get("return") || "/");
  const callback = `${SITE_ORIGIN}/auth/wechat/callback`;
  const authUrl = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
  authUrl.searchParams.set("appid", WECHAT_APP_ID);
  authUrl.searchParams.set("redirect_uri", callback);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "snsapi_userinfo");
  authUrl.searchParams.set("state", encodeState(returnTo));
  redirect(res, `${authUrl.toString()}#wechat_redirect`);
}

async function finishWechatAuth(req, res, requestUrl) {
  try {
    const code = requestUrl.searchParams.get("code");
    if (!code) throw new Error("missing code");
    const tokenUrl = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
    tokenUrl.searchParams.set("appid", WECHAT_APP_ID);
    tokenUrl.searchParams.set("secret", WECHAT_APP_SECRET);
    tokenUrl.searchParams.set("code", code);
    tokenUrl.searchParams.set("grant_type", "authorization_code");
    const token = await fetchWechatJson(tokenUrl);

    const userUrl = new URL("https://api.weixin.qq.com/sns/userinfo");
    userUrl.searchParams.set("access_token", token.access_token);
    userUrl.searchParams.set("openid", token.openid);
    userUrl.searchParams.set("lang", "zh_CN");
    const profile = await fetchWechatJson(userUrl);
    const user = {
      openid: profile.openid || token.openid,
      nickname: profile.nickname || "",
      sex: profile.sex || 0,
      province: profile.province || "",
      city: profile.city || "",
      country: profile.country || "",
      headimgurl: profile.headimgurl || "",
      authedAt: new Date().toISOString(),
    };
    res.writeHead(302, {
      Location: decodeState(requestUrl.searchParams.get("state")),
      "Set-Cookie": `qg_wechat=${encodeURIComponent(encodeSignedCookie(user))}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax; Secure`,
      "Cache-Control": "no-store",
    });
    res.end();
  } catch (error) {
    sendHtml(
      res,
      502,
      `<!doctype html><meta charset="utf-8"><title>微信授权失败</title><p>微信授权失败：${String(error.message || error)}</p><p><a href="/">返回报价</a></p>`
    );
  }
}

function logVisit(req, event = {}) {
  ensureDataDir();
  const ip = clientIp(req);
  const ua = req.headers["user-agent"] || "";
  const wechat = currentWechatUser(req);
  const record = {
    ts: new Date().toISOString(),
    ip,
    ua,
    visitorId: wechat?.openid || visitorIdFrom(ip, ua),
    device: deviceFromUa(ua),
    browser: browserFromUa(ua),
    referer: req.headers.referer || "",
    type: String(event.type || "pageview").slice(0, 40),
    path: String(event.path || "").slice(0, 200),
    category: String(event.category || "").slice(0, 120),
    keyword: String(event.keyword || "").slice(0, 120),
    count: Number(event.count || 0) || 0,
    wechatOpenid: wechat?.openid || "",
    wechatNickname: wechat?.nickname || "",
    wechatAvatar: wechat?.headimgurl || "",
    isWechat: isWechatUa(ua),
    wechatVersion: wechatVersionFromUa(ua),
    shareTag: shareTagFromPath(event.path || req.headers.referer || ""),
  };
  fs.appendFile(visitsFile, `${JSON.stringify(record)}\n`, () => {});
}

function buildVisitors(records) {
  const visitors = new Map();
  for (const record of records) {
    const id = record.wechatOpenid || record.visitorId || visitorIdFrom(record.ip, record.ua);
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
        wechatOpenid: record.wechatOpenid || "",
        wechatNickname: record.wechatNickname || "",
        wechatAvatar: record.wechatAvatar || "",
        isWechat: Boolean(record.isWechat || isWechatUa(record.ua)),
        wechatVersion: record.wechatVersion || wechatVersionFromUa(record.ua),
        shareTags: new Set(),
        categories: new Set(),
        keywords: new Set(),
        referers: new Set(),
      };
    item.firstSeen = String(item.firstSeen) < String(record.ts) ? item.firstSeen : record.ts;
    item.lastSeen = String(item.lastSeen) > String(record.ts) ? item.lastSeen : record.ts;
    item.events += 1;
    item.wechatOpenid = item.wechatOpenid || record.wechatOpenid || "";
    item.wechatNickname = item.wechatNickname || record.wechatNickname || "";
    item.wechatAvatar = item.wechatAvatar || record.wechatAvatar || "";
    item.isWechat = item.isWechat || Boolean(record.isWechat || isWechatUa(record.ua));
    item.wechatVersion = item.wechatVersion || record.wechatVersion || wechatVersionFromUa(record.ua);
    if (record.shareTag) item.shareTags.add(record.shareTag);
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
      shareTags: [...item.shareTags].slice(-8),
    }));
}

function adminStats() {
  const records = readVisits();
  const today = new Date().toISOString().slice(0, 10);
  const pageviews = records.filter((record) => record.type === "pageview");
  const dataViews = records.filter((record) => record.type === "data_view");
  const wechatRecords = records.filter((record) => record.isWechat || isWechatUa(record.ua));
  const wechatPageviews = wechatRecords.filter((record) => record.type === "pageview");
  const uniqueIps = new Set(records.map((record) => record.ip).filter(Boolean));
  return {
    wechatAuthConfigured: Boolean(WECHAT_APP_ID && WECHAT_APP_SECRET),
    wechatAuthAuto: WECHAT_AUTH_AUTO,
    totalEvents: records.length,
    totalVisits: pageviews.length,
    todayVisits: pageviews.filter((record) => String(record.ts).startsWith(today)).length,
    dataViews: dataViews.length,
    uniqueIps: uniqueIps.size,
    wechatUsers: new Set(records.map((record) => record.wechatOpenid).filter(Boolean)).size,
    wechatVisitors: new Set(
      wechatRecords.map((record) => record.wechatOpenid || record.visitorId || visitorIdFrom(record.ip, record.ua))
    ).size,
    wechatVisits: wechatPageviews.length,
    devices: topCounts(records, "device"),
    categories: topCounts(records.filter((record) => record.type === "category"), "category"),
    keywords: topCounts(records.filter((record) => record.type === "search"), "keyword"),
    visitors: buildVisitors(records),
    recentWechat: wechatRecords
      .slice(-120)
      .reverse()
      .map((record) => ({
        ...record,
        action: actionText(record),
        browser: record.browser || browserFromUa(record.ua),
        visitorId: record.wechatOpenid || record.visitorId || visitorIdFrom(record.ip, record.ua),
        wechatVersion: record.wechatVersion || wechatVersionFromUa(record.ua),
      })),
    recent: records
      .slice(-120)
      .reverse()
      .map((record) => ({
        ...record,
        action: actionText(record),
        browser: record.browser || browserFromUa(record.ua),
        visitorId: record.wechatOpenid || record.visitorId || visitorIdFrom(record.ip, record.ua),
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
    h1{font-size:24px;margin:0 0 6px} p{margin:0;color:#65717b;font-size:13px;line-height:1.6}
    .grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px}.card,section{background:#fff;border:1px solid #dce2e6;border-radius:8px}
    .card{padding:14px}.card span{display:block;color:#65717b;font-size:13px;margin-bottom:6px}.card strong{font-size:24px}
    section{margin-top:12px;padding:14px;overflow:auto}h2{font-size:17px;margin:0 0 10px}
    table{width:100%;border-collapse:collapse;font-size:13px;min-width:880px}th,td{border-bottom:1px solid #e7ecef;padding:9px 8px;text-align:left;vertical-align:top}
    th{background:#f0f3f5;color:#38424c;font-weight:650}.muted{color:#65717b}.tag{display:inline-block;background:#eef6ff;color:#0958b8;border:1px solid #d7eaff;border-radius:999px;padding:2px 7px;margin:0 4px 4px 0}
    .avatar{width:30px;height:30px;border-radius:50%;vertical-align:middle;margin-right:6px}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
    input,button{height:34px;border:1px solid #cfd7de;border-radius:6px;background:#fff;padding:0 10px;font:inherit}button{cursor:pointer;background:#0969da;color:#fff;border-color:#0969da}
    @media(max-width:900px){.grid{grid-template-columns:1fr 1fr}header{display:block}}
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>报价访问后台</h1>
        <p id="authTip">正在读取公众号授权状态...</p>
      </div>
      <button onclick="location.reload()">刷新</button>
    </header>
    <div class="grid">
      <div class="card"><span>总打开次数</span><strong id="totalVisits">-</strong></div>
      <div class="card"><span>今日打开</span><strong id="todayVisits">-</strong></div>
      <div class="card"><span>查看报价数据</span><strong id="dataViews">-</strong></div>
      <div class="card"><span>独立 IP</span><strong id="uniqueIps">-</strong></div>
      <div class="card"><span>微信授权用户</span><strong id="wechatUsers">-</strong></div>
      <div class="card"><span>记录事件</span><strong id="totalEvents">-</strong></div>
    </div>
    <section>
      <h2>访客列表</h2>
      <div class="toolbar">
        <input id="visitorFilter" placeholder="搜索微信昵称 / OpenID / IP / 分类 / 搜索词" />
        <button id="exportVisitors">导出访客 CSV</button>
      </div>
      <table>
        <thead><tr><th>访客</th><th>最后访问</th><th>打开/看数据</th><th>看过分类</th><th>搜索词</th><th>来源</th></tr></thead>
        <tbody id="visitors"></tbody>
      </table>
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
    let stats=null;
    function esc(v){return String(v||"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]))}
    function time(v){try{return new Date(v).toLocaleString("zh-CN",{hour12:false})}catch{return v||""}}
    function tags(values){return (values&&values.length?values:["-"]).map(v=>v==="-"?"<span class='muted'>-</span>":"<span class='tag'>"+esc(v)+"</span>").join("")}
    function csvCell(v){return '"'+String(v||"").replace(/"/g,'""')+'"'}
    function downloadCsv(name, rows){const csv="\\ufeff"+rows.map(row=>row.map(csvCell).join(",")).join("\\n");const url=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));const a=document.createElement("a");a.href=url;a.download=name;a.click();URL.revokeObjectURL(url)}
    function visitorName(v){return v.wechatNickname?("<div><img class='avatar' src='"+esc(v.wechatAvatar)+"'><strong>"+esc(v.wechatNickname)+"</strong></div><span class='muted'>OpenID "+esc(v.wechatOpenid)+"</span><br>"):"<div class='muted'>未授权微信</div>"}
    function renderVisitors(){const q=document.getElementById("visitorFilter").value.trim().toLowerCase();const rows=(stats.visitors||[]).filter(v=>JSON.stringify(v).toLowerCase().includes(q));document.getElementById("visitors").innerHTML=rows.map(v=>"<tr><td>"+visitorName(v)+"<strong>"+esc(v.ip)+"</strong><br><span class='muted'>"+esc(v.id)+" / "+esc(v.device)+" / "+esc(v.browser)+"</span></td><td>"+esc(time(v.lastSeen))+"<br><span class='muted'>首次 "+esc(time(v.firstSeen))+"</span></td><td>"+esc(v.pageviews)+" / "+esc(v.dataViews)+"<br><span class='muted'>事件 "+esc(v.events)+"</span></td><td>"+tags(v.categories)+"</td><td>"+tags(v.keywords)+"</td><td>"+tags(v.referers)+"</td></tr>").join("")||"<tr><td colspan='6' class='muted'>暂无记录</td></tr>"}
    fetch("/api/admin/stats").then(r=>r.json()).then(d=>{stats=d;document.getElementById("authTip").textContent=d.wechatAuthConfigured?"公众号授权已配置，微信内访问会记录昵称、头像和 OpenID。":"公众号授权代码已上线，但还未配置 AppSecret；当前仍按 IP 和设备统计。";for(const k of ["totalVisits","todayVisits","dataViews","uniqueIps","wechatUsers","totalEvents"])document.getElementById(k).textContent=d[k]||0;renderVisitors();document.getElementById("recent").innerHTML=(d.recent||[]).map(r=>"<tr><td>"+esc(time(r.ts))+"</td><td>"+(r.wechatNickname?("<strong>"+esc(r.wechatNickname)+"</strong><br>"):"")+"<strong>"+esc(r.ip)+"</strong><br><span class='muted'>"+esc(r.visitorId)+"</span></td><td>"+esc(r.device)+"<br><span class='muted'>"+esc(r.browser)+"</span></td><td>"+esc(r.action)+"</td><td>"+esc(r.category||r.keyword||("-"+(r.count?(" / "+r.count+"条"):"")))+"</td><td>"+esc(r.referer)+"</td></tr>").join("");document.getElementById("visitorFilter").addEventListener("input",renderVisitors);document.getElementById("exportVisitors").addEventListener("click",()=>{const rows=[["访客ID","微信昵称","OpenID","IP","设备","浏览器","首次访问","最后访问","打开次数","查看数据次数","分类","搜索词","来源"]];for(const v of stats.visitors||[])rows.push([v.id,v.wechatNickname||"",v.wechatOpenid||"",v.ip,v.device,v.browser,time(v.firstSeen),time(v.lastSeen),v.pageviews,v.dataViews,(v.categories||[]).join(" / "),(v.keywords||[]).join(" / "),(v.referers||[]).join(" / ")]);downloadCsv("报价访问访客.csv",rows)})});
  </script>
</body>
</html>`;
}

function wechatAdminPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>微信访问记录</title>
  <style>
    body{margin:0;background:#f4f6f8;color:#17202a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
    main{width:min(1180px,calc(100% - 24px));margin:18px auto 32px}header{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}
    h1{font-size:24px;margin:0 0 6px}p{margin:0;color:#65717b;font-size:13px;line-height:1.6}a{color:#0969da}
    .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:14px}.card,section{background:#fff;border:1px solid #dce2e6;border-radius:8px}
    .card{padding:14px}.card span{display:block;color:#65717b;font-size:13px;margin-bottom:6px}.card strong{font-size:25px}
    section{padding:14px;margin-top:12px;overflow:auto}h2{font-size:17px;margin:0 0 10px}
    table{width:100%;border-collapse:collapse;font-size:13px;min-width:920px}th,td{border-bottom:1px solid #e7ecef;padding:9px 8px;text-align:left;vertical-align:top}th{background:#f0f3f5}
    .muted{color:#65717b}.tag{display:inline-block;background:#eaf7ee;color:#137333;border:1px solid #ccebd5;border-radius:999px;padding:2px 7px;margin:0 4px 4px 0}
    input,button{height:34px;border:1px solid #cfd7de;border-radius:6px;padding:0 10px;font:inherit}button{background:#087f5b;color:#fff;border-color:#087f5b;cursor:pointer}
    .toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}.avatar{width:30px;height:30px;border-radius:50%;vertical-align:middle;margin-right:6px}
    @media(max-width:760px){.grid{grid-template-columns:1fr 1fr}header{display:block}}
  </style>
</head>
<body>
  <main>
    <header>
      <div><h1>微信访问记录</h1><p>识别微信内置浏览器访问。当前个人未认证公众号无法获取昵称时，以访客编号、IP、设备和行为区分。</p></div>
      <p><a href="/admin">返回全部访问后台</a></p>
    </header>
    <div class="grid">
      <div class="card"><span>微信访客</span><strong id="wechatVisitors">-</strong></div>
      <div class="card"><span>微信打开次数</span><strong id="wechatVisits">-</strong></div>
      <div class="card"><span>微信授权用户</span><strong id="wechatUsers">-</strong></div>
      <div class="card"><span>微信行为记录</span><strong id="wechatEvents">-</strong></div>
    </div>
    <section>
      <h2>微信访客</h2>
      <div class="toolbar"><input id="filter" placeholder="搜索 IP、访客编号、分类、关键词" /><button id="export">导出 CSV</button></div>
      <table><thead><tr><th>访客</th><th>最后访问</th><th>打开/看报价</th><th>分类</th><th>搜索词</th><th>分享来源</th></tr></thead><tbody id="visitors"></tbody></table>
    </section>
    <section>
      <h2>最近微信访问</h2>
      <table><thead><tr><th>时间</th><th>访客/IP</th><th>设备</th><th>微信版本</th><th>动作</th><th>分类/搜索</th><th>分享来源</th></tr></thead><tbody id="records"></tbody></table>
    </section>
  </main>
  <script>
    let data=null;
    const esc=v=>String(v||"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]));
    const time=v=>{try{return new Date(v).toLocaleString("zh-CN",{hour12:false})}catch{return v||""}};
    const tags=v=>(v&&v.length?v:["-"]).map(x=>x==="-"?"<span class='muted'>-</span>":"<span class='tag'>"+esc(x)+"</span>").join("");
    const csv=v=>'"'+String(v||"").replace(/"/g,'""')+'"';
    function name(v){return v.wechatNickname?("<div><img class='avatar' src='"+esc(v.wechatAvatar)+"'><strong>"+esc(v.wechatNickname)+"</strong></div>"):"<strong>微信访客</strong><br>"}
    function render(){const q=document.getElementById("filter").value.toLowerCase();const list=(data.visitors||[]).filter(v=>v.isWechat&&JSON.stringify(v).toLowerCase().includes(q));document.getElementById("visitors").innerHTML=list.map(v=>"<tr><td>"+name(v)+"<span class='muted'>"+esc(v.ip)+" / "+esc(v.id)+"</span></td><td>"+esc(time(v.lastSeen))+"</td><td>"+esc(v.pageviews)+" / "+esc(v.dataViews)+"</td><td>"+tags(v.categories)+"</td><td>"+tags(v.keywords)+"</td><td>"+tags(v.shareTags)+"</td></tr>").join("")||"<tr><td colspan='6' class='muted'>暂无微信访客</td></tr>"}
    fetch("/api/admin/stats").then(r=>r.json()).then(d=>{data=d;document.getElementById("wechatVisitors").textContent=d.wechatVisitors||0;document.getElementById("wechatVisits").textContent=d.wechatVisits||0;document.getElementById("wechatUsers").textContent=d.wechatUsers||0;document.getElementById("wechatEvents").textContent=(d.recentWechat||[]).length;render();document.getElementById("records").innerHTML=(d.recentWechat||[]).map(r=>"<tr><td>"+esc(time(r.ts))+"</td><td>"+(r.wechatNickname?("<strong>"+esc(r.wechatNickname)+"</strong><br>"):"<strong>微信访客</strong><br>")+"<span class='muted'>"+esc(r.ip)+" / "+esc(r.visitorId)+"</span></td><td>"+esc(r.device)+"</td><td>"+esc(r.wechatVersion||"未知")+"</td><td>"+esc(r.action)+"</td><td>"+esc(r.category||r.keyword||"-")+"</td><td>"+esc(r.shareTag||"-")+"</td></tr>").join("")||"<tr><td colspan='7' class='muted'>暂无微信访问记录</td></tr>";document.getElementById("filter").addEventListener("input",render);document.getElementById("export").addEventListener("click",()=>{const rows=[["访客编号","微信昵称","OpenID","IP","设备","微信版本","最后访问","打开次数","查看报价次数","分类","搜索词","分享来源"]];for(const v of (d.visitors||[]).filter(v=>v.isWechat))rows.push([v.id,v.wechatNickname||"",v.wechatOpenid||"",v.ip,v.device,v.wechatVersion,time(v.lastSeen),v.pageviews,v.dataViews,(v.categories||[]).join("/"),(v.keywords||[]).join("/"),(v.shareTags||[]).join("/")]);const content="\\ufeff"+rows.map(r=>r.map(csv).join(",")).join("\\n");const url=URL.createObjectURL(new Blob([content],{type:"text/csv;charset=utf-8"}));const a=document.createElement("a");a.href=url;a.download="微信访问记录.csv";a.click();URL.revokeObjectURL(url)})});
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

  if (requestUrl.pathname === "/api/auth/status") {
    sendJson(res, 200, wechatAuthStatus(req));
    return;
  }

  if (requestUrl.pathname === "/api/wechat/js-config") {
    try {
      const pageUrl = requestUrl.searchParams.get("url") || `${SITE_ORIGIN}/`;
      sendJson(res, 200, await wechatJsConfig(pageUrl));
    } catch (error) {
      sendJson(res, 500, { configured: false, error: String(error.message || error) });
    }
    return;
  }

  if (requestUrl.pathname === "/auth/wechat") {
    startWechatAuth(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname === "/auth/wechat/callback") {
    await finishWechatAuth(req, res, requestUrl);
    return;
  }

  if (requestUrl.pathname === "/auth/wechat/logout") {
    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": "qg_wechat=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure",
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  if (requestUrl.pathname === "/admin/wechat") {
    if (!requireAdmin(req, res)) return;
    sendHtml(res, 200, wechatAdminPage());
    return;
  }

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

  if (requestUrl.pathname === "/api/admin/wechat/profile") {
    if (!requireAdmin(req, res)) return;
    const openid = String(requestUrl.searchParams.get("openid") || "");
    if (!/^o[A-Za-z0-9_-]{20,}$/.test(openid)) {
      sendJson(res, 400, { ok: false, error: "Invalid openid" });
      return;
    }
    try {
      const profile = await getOfficialWechatProfile(openid);
      sendJson(res, 200, {
        ok: true,
        subscribe: profile.subscribe || 0,
        openid: profile.openid || openid,
        nickname: profile.nickname || "",
        headimgurl: profile.headimgurl || "",
        unionid: profile.unionid || "",
        subscribe_time: profile.subscribe_time || 0,
      });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error.message });
    }
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
