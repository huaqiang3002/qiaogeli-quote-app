const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 4173);
const PRICE_MARKUP = Number(process.env.PRICE_MARKUP || 50);
const SOURCE_URL =
  process.env.SOURCE_URL ||
  "http://www.xatdtx.com/m/ykbjdQuoteList.action?is_spqc=Y&is_dls=N&gsdm=61271&pp=&km=%E8%8B%B9%E6%9E%9C%E6%89%8B%E6%9C%BA&network=&bj=&tykhgsdm=";

const publicDir = path.join(__dirname, "public");
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

  const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (pageTitle) sourceTitle = cleanText(pageTitle[1]);

  const contentStart = html.indexOf('id="content"');
  const contentEnd = html.indexOf('<div class="ykbj_foot"', contentStart);
  const content =
    contentStart >= 0 ? html.slice(contentStart, contentEnd > contentStart ? contentEnd : undefined) : html;

  const tokenPattern =
    /<h4\b[\s\S]*?<\/h4>|<div\s+class=["'][^"']*\brow\b[^"']*["'][\s\S]*?<\/div>\s*<!--\s*结束行\s*-->/gi;

  for (const tokenMatch of content.matchAll(tokenPattern)) {
    const token = tokenMatch[0];
    if (/^<h4\b/i.test(token)) {
      currentGroup = cleanText(token);
      continue;
    }

    const nameMatch = token.match(
      /<div\s+class=["'][^"']*\bcol-xs-4\b[^"']*\bview-goods-type\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    );
    const priceMatch = token.match(
      /<div\s+class=["'][^"']*\bcol-xs-3\b[^"']*\bview-quote\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    );

    const name = cleanText(nameMatch && nameMatch[1]);
    const priceText = cleanText(priceMatch && priceMatch[1]);
    if (!name || !priceText) continue;

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

  return { sourceTitle, items };
}

async function fetchQuotes() {
  const url = new URL(SOURCE_URL);
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
  const parsed = parseQuotes(html);
  const now = new Date().toISOString();
  lastSnapshot = {
    ok: true,
    sourceUrl: url.toString(),
    title: parsed.sourceTitle,
    count: parsed.items.length,
    updatedAt: now,
    items: parsed.items,
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

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
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

  if (requestUrl.pathname === "/api/quotes") {
    try {
      const snapshot = await fetchQuotes();
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
