const state = {
  allItems: [],
  visibleItems: [],
  previousPrices: new Map(),
  selectedGroup: "全部",
  timer: null,
  busy: false,
  updatedAt: null,
};

const els = {
  keywordInput: document.querySelector("#keywordInput"),
  intervalSelect: document.querySelector("#intervalSelect"),
  refreshButton: document.querySelector("#refreshButton"),
  exportButton: document.querySelector("#exportButton"),
  categorySelect: document.querySelector("#categorySelect"),
  categoryList: document.querySelector("#categoryList"),
  categoryHint: document.querySelector("#categoryHint"),
  quoteBody: document.querySelector("#quoteBody"),
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  totalCount: document.querySelector("#totalCount"),
  minPrice: document.querySelector("#minPrice"),
  maxPrice: document.querySelector("#maxPrice"),
  updatedAt: document.querySelector("#updatedAt"),
};

function money(value) {
  if (value === null || Number.isNaN(value)) return "-";
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatTime(iso) {
  if (!iso) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(iso));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setStatus(type, text) {
  els.statusDot.className = `dot ${type || ""}`.trim();
  els.statusText.textContent = text;
}

function getGroups(items) {
  const counts = new Map();
  for (const item of items) {
    counts.set(item.group, (counts.get(item.group) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-CN"));
}

function renderCategories(items) {
  const groups = getGroups(items);
  const total = items.length;
  els.categoryHint.textContent = `${groups.length} 个分类，${total} 条报价`;

  const currentGroupExists = state.selectedGroup === "全部" || groups.some(([group]) => group === state.selectedGroup);
  if (!currentGroupExists) state.selectedGroup = "全部";

  els.categorySelect.innerHTML = [
    `<option value="全部">全部 ${total}</option>`,
    ...groups.map(([group, count]) => `<option value="${escapeHtml(group)}">${escapeHtml(group)} ${count}</option>`),
  ].join("");
  els.categorySelect.value = state.selectedGroup;

  const buttons = [
    `<button type="button" class="category-chip ${state.selectedGroup === "全部" ? "active" : ""}" data-group="全部">全部 ${total}</button>`,
    ...groups.map(
      ([group, count]) =>
        `<button type="button" class="category-chip ${state.selectedGroup === group ? "active" : ""}" data-group="${escapeHtml(group)}">${escapeHtml(group)} ${count}</button>`
    ),
  ];
  els.categoryList.innerHTML = buttons.join("");
}

function applyFilters() {
  const keyword = els.keywordInput.value.trim().toLowerCase();
  state.visibleItems = state.allItems.filter((item) => {
    const matchGroup = state.selectedGroup === "全部" || item.group === state.selectedGroup;
    const matchKeyword =
      !keyword ||
      item.name.toLowerCase().includes(keyword) ||
      item.group.toLowerCase().includes(keyword) ||
      item.priceText.toLowerCase().includes(keyword);
    return matchGroup && matchKeyword;
  });

  renderSummary(state.visibleItems, state.updatedAt);
  renderTable(state.visibleItems);
}

function renderSummary(items, updatedAt) {
  const prices = items.map((item) => item.price).filter((price) => typeof price === "number");
  els.totalCount.textContent = String(items.length);
  els.minPrice.textContent = prices.length ? money(Math.min(...prices)) : "-";
  els.maxPrice.textContent = prices.length ? money(Math.max(...prices)) : "-";
  els.updatedAt.textContent = formatTime(updatedAt);
}

function renderTable(items) {
  if (!items.length) {
    els.quoteBody.innerHTML = '<tr><td colspan="4" class="empty">没有匹配的报价</td></tr>';
    return;
  }

  const rows = items
    .map((item) => {
      const previous = state.previousPrices.get(item.id);
      const changed = typeof previous === "number" && previous !== item.price;
      const delta = changed && typeof item.price === "number" ? item.price - previous : 0;
      const deltaClass = delta > 0 ? "up" : delta < 0 ? "down" : "same";
      const deltaText = delta > 0 ? `+${money(delta)}` : delta < 0 ? money(delta) : "持平";

      return `<tr class="${changed ? "changed" : ""}">
        <td class="group" data-label="分类">${escapeHtml(item.group)}</td>
        <td data-label="商品">${escapeHtml(item.name)}</td>
        <td class="price" data-label="报价">${escapeHtml(item.priceText)}</td>
        <td class="delta ${deltaClass}" data-label="变化">${deltaText}</td>
      </tr>`;
    })
    .join("");

  els.quoteBody.innerHTML = rows;
}

async function refreshQuotes() {
  if (state.busy) return;
  state.busy = true;
  setStatus("", "正在刷新");

  try {
    const response = await fetch("/api/quotes", { cache: "no-store" });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "刷新失败");
    }

    state.allItems = data.items;
    state.updatedAt = data.updatedAt;
    renderCategories(data.items);
    applyFilters();
    state.previousPrices = new Map(data.items.map((item) => [item.id, item.price]));
    setStatus("live", `已更新 ${formatTime(data.updatedAt)}`);
  } catch (error) {
    setStatus("error", error.message);
  } finally {
    state.busy = false;
  }
}

function resetTimer() {
  clearInterval(state.timer);
  state.timer = setInterval(refreshQuotes, Number(els.intervalSelect.value) * 1000);
}

function exportCsv() {
  const header = ["分类", "商品", "报价"];
  const rows = state.visibleItems.map((item) => [item.group, item.name, item.priceText]);
  const csv = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `报价-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

let keywordTimer = null;
els.keywordInput.addEventListener("input", () => {
  clearTimeout(keywordTimer);
  keywordTimer = setTimeout(applyFilters, 160);
});
els.categoryList.addEventListener("click", (event) => {
  const button = event.target.closest(".category-chip");
  if (!button) return;
  state.selectedGroup = button.dataset.group;
  renderCategories(state.allItems);
  applyFilters();
});
els.categorySelect.addEventListener("change", () => {
  state.selectedGroup = els.categorySelect.value;
  renderCategories(state.allItems);
  applyFilters();
});
els.intervalSelect.addEventListener("change", resetTimer);
els.refreshButton.addEventListener("click", refreshQuotes);
els.exportButton.addEventListener("click", exportCsv);

resetTimer();
refreshQuotes();
