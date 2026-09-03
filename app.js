const DATA_URL = "./data/reservoir.json";

const els = {
  sourceDate: document.getElementById("source-date"),
  fetchedAt: document.getElementById("fetched-at"),
  refreshBtn: document.getElementById("refresh-btn"),
  errorBanner: document.getElementById("error-banner"),
  supplyShare: document.getElementById("supply-share"),
  overview: document.getElementById("overview"),
  systems: document.getElementById("systems"),
};

let lastData = null;

function fmt(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return "―";
  return n.toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtSigned(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return "―";
  const sign = n > 0 ? "+" : "";
  return `${sign}${fmt(n, digits)}`;
}

function deltaClass(n, { upIsGood = true } = {}) {
  if (n == null || Number.isNaN(n) || n === 0) return "neutral";
  const isUp = n > 0;
  return isUp === upIsGood ? "positive" : "negative";
}

// 貯水率(有効容量比)にもとづく、このサイト独自の危機度区分。
// 東京都・国が公表する取水制限基準とは異なる。
function crisisLevel(rate) {
  if (rate == null) return { key: "unknown", label: "データなし", icon: "?" };
  if (rate >= 80) return { key: "good", label: "順調", icon: "◎" };
  if (rate >= 50) return { key: "warning", label: "やや注意", icon: "▲" };
  if (rate >= 30) return { key: "serious", label: "警戒", icon: "■" };
  return { key: "critical", label: "危機的", icon: "✕" };
}

function badge(level) {
  const span = document.createElement("span");
  span.className = `badge status-${level.key}`;
  span.innerHTML = `<span class="status-icon">${level.icon}</span>${level.label}`;
  return span;
}

function weightedOverall(systems) {
  let storageSum = 0;
  let capacitySum = 0;
  let lastYearStorageSum = 0;
  let lastYearCapacityKnown = true;
  let dailyChangeSum = 0;
  let dailyChangeKnown = true;

  for (const sys of systems) {
    const t = sys.total;
    if (!t) continue;
    const capacity = t.capacityEffective ?? t.capacityTotal;
    if (capacity != null && t.storage != null) {
      storageSum += t.storage;
      capacitySum += capacity;
    }
    if (sys.comparison?.lastYear?.storage != null && capacity != null) {
      lastYearStorageSum += sys.comparison.lastYear.storage;
    } else {
      lastYearCapacityKnown = false;
    }
    if (t.dailyChange != null) {
      dailyChangeSum += t.dailyChange;
    } else {
      dailyChangeKnown = false;
    }
  }

  const rate = capacitySum > 0 ? (storageSum / capacitySum) * 100 : null;
  const lastYearRate = lastYearCapacityKnown && capacitySum > 0 ? (lastYearStorageSum / capacitySum) * 100 : null;

  return {
    storage: storageSum,
    capacity: capacitySum,
    rate,
    lastYearRate,
    dailyChange: dailyChangeKnown ? dailyChangeSum : null,
  };
}

function renderSupplyShareBar(data) {
  if (!els.supplyShare) return;
  els.supplyShare.innerHTML = "";
  const share = data.supplyShare;
  if (!share || !Array.isArray(share.groups)) return;

  const card = document.createElement("div");
  card.className = "supply-share-card";
  card.innerHTML = `
    <h2 class="section-title">東京の水はどこから来ている？</h2>
    <p class="supply-share-note">
      東京都が保有する水源(日量約680万m³)の内訳です。バーの<strong>幅</strong>が水源としての依存度、
      <strong>色</strong>が現在の貯水状況（危機度）を表します。
      <a href="${share.sourceUrl}" target="_blank" rel="noopener">出典: 東京都水道局</a>
    </p>
  `;

  const segments = share.groups.map((group) => {
    const matched = data.systems.filter((s) => group.systemNames.includes(s.name));
    const stat = weightedOverall(matched);
    const level = matched.length > 0 ? crisisLevel(stat.rate) : crisisLevel(null);
    return { group, stat, level };
  });

  const bar = document.createElement("div");
  bar.className = "supply-bar";
  for (const seg of segments) {
    const div = document.createElement("div");
    div.className = `supply-segment status-${seg.level.key}`;
    div.style.width = `${seg.group.sharePercent}%`;
    // 幅が狭いセグメントに文字を詰め込んで見切れさせない(measure-firstの方針)
    if (seg.group.sharePercent >= 8) {
      div.textContent = `${seg.group.sharePercent}%`;
    }
    div.title = `${seg.group.label}: 供給割合${seg.group.sharePercent}%${
      seg.stat.rate != null ? `、現在の貯水率 ${fmt(seg.stat.rate)}%` : "、データなし"
    }`;
    bar.appendChild(div);
  }
  card.appendChild(bar);

  const legend = document.createElement("div");
  legend.className = "supply-legend";
  legend.innerHTML = segments
    .map((seg) => {
      const b = badge(seg.level).outerHTML;
      return `
      <div class="supply-legend-item">
        ${b}
        <span class="supply-legend-label">${seg.group.label}（${seg.group.sharePercent}%）</span>
        <span class="supply-legend-rate">${
          seg.stat.rate != null ? `貯水率 ${fmt(seg.stat.rate)}%` : "データなし"
        }</span>
      </div>`;
    })
    .join("");
  card.appendChild(legend);

  els.supplyShare.appendChild(card);
}

function renderOverview(data) {
  els.overview.innerHTML = "";
  const overall = weightedOverall(data.systems.filter((s) => !s.external));
  const level = crisisLevel(overall.rate);

  const tiles = [
    {
      label: "東京都全体の貯水率（加重平均）",
      value: overall.rate != null ? `${fmt(overall.rate)}%` : "―",
      delta: null,
      badge: level,
    },
    {
      label: "前日からの増減量",
      value: overall.dailyChange != null ? `${fmtSigned(overall.dailyChange, 1)}` : "―",
      unit: "万m³",
      deltaClass: deltaClass(overall.dailyChange),
    },
    {
      label: "前年同日との差（貯水率）",
      value:
        overall.lastYearRate != null && overall.rate != null
          ? fmtSigned(overall.rate - overall.lastYearRate, 1)
          : "―",
      unit: "ポイント",
      deltaClass:
        overall.lastYearRate != null && overall.rate != null
          ? deltaClass(overall.rate - overall.lastYearRate)
          : "neutral",
      note:
        overall.lastYearRate != null ? `前年同日: ${fmt(overall.lastYearRate)}%` : null,
    },
  ];

  for (const tile of tiles) {
    const div = document.createElement("div");
    div.className = "stat-tile";
    const valueLine = tile.unit ? `${tile.value} <span class="muted" style="font-size:14px;">${tile.unit}</span>` : tile.value;
    div.innerHTML = `
      <p class="stat-label">${tile.label}</p>
      <p class="stat-value ${tile.deltaClass ? `delta ${tile.deltaClass}` : ""}">${valueLine}</p>
      ${tile.note ? `<p class="stat-delta muted">${tile.note}</p>` : ""}
    `;
    if (tile.badge) {
      div.querySelector(".stat-label").after(badge(tile.badge));
    }
    els.overview.appendChild(div);
  }
}

function renderMeter(rate, lastYearRate) {
  const wrap = document.createElement("div");
  wrap.className = "meter-wrap";

  const level = crisisLevel(rate);
  const scaleMax = Math.max(120, Math.ceil(((rate ?? 0) + 10) / 10) * 10);
  const fillWidth = rate != null ? Math.min(100, (rate / scaleMax) * 100) : 0;
  const fullLinePos = (100 / scaleMax) * 100;

  wrap.innerHTML = `
    <div class="meter-labels">
      <span>貯水率</span>
      <span class="meter-value">${rate != null ? fmt(rate) + "%" : "―"}</span>
    </div>
    <div class="meter-track" role="img" aria-label="貯水率 ${rate != null ? fmt(rate) + "%" : "データなし"}${
    lastYearRate != null ? `、前年同日 ${fmt(lastYearRate)}%` : ""
  }">
      <div class="meter-fill status-${level.key}" style="width:${fillWidth}%"></div>
      <div class="meter-full-line" style="left:${fullLinePos}%"></div>
      ${
        lastYearRate != null
          ? `<div class="meter-marker" style="left:${Math.min(100, (lastYearRate / scaleMax) * 100)}%"></div>
             <div class="meter-marker-label" style="left:${Math.min(100, (lastYearRate / scaleMax) * 100)}%">前年 ${fmt(lastYearRate)}%</div>`
          : ""
      }
    </div>
  `;
  return wrap;
}

function renderDamBreakdown(system) {
  const details = document.createElement("details");
  details.className = "dam-breakdown";
  const summary = document.createElement("summary");
  summary.textContent = `ダムごとの内訳（${system.dams.length}件）`;
  details.appendChild(summary);

  const maxRate = Math.max(100, ...system.dams.map((d) => d.storageRatePercent ?? 0));
  const scaleMax = Math.ceil((maxRate + 10) / 10) * 10;
  const fullLinePos = (100 / scaleMax) * 100;

  const chart = document.createElement("div");
  chart.className = "bar-chart";
  const sorted = [...system.dams].sort((a, b) => (b.storageRatePercent ?? -1) - (a.storageRatePercent ?? -1));
  for (const dam of sorted) {
    const row = document.createElement("div");
    row.className = "bar-row";
    const width = dam.storageRatePercent != null ? Math.min(100, (dam.storageRatePercent / scaleMax) * 100) : 0;
    row.innerHTML = `
      <span class="bar-name" title="${dam.name}">${dam.name}</span>
      <span class="bar-track">
        <span class="bar-fill" style="width:${width}%"></span>
        <span class="full-line" style="left:${fullLinePos}%"></span>
      </span>
      <span class="bar-value">${dam.storageRatePercent != null ? fmt(dam.storageRatePercent) + "%" : "―"}</span>
    `;
    chart.appendChild(row);
  }
  details.appendChild(chart);

  const tableWrap = document.createElement("div");
  tableWrap.className = "data-table-wrap";
  const table = document.createElement("table");
  table.className = "data-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>ダム名</th>
        <th>総容量(万m³)</th>
        <th>有効容量(万m³)</th>
        <th>貯水量(万m³)</th>
        <th>貯水率(%)</th>
        <th>前日増減(万m³)</th>
      </tr>
    </thead>
    <tbody>
      ${system.dams
        .map(
          (d) => `
        <tr>
          <td>${d.name}</td>
          <td>${d.capacityTotal != null ? fmt(d.capacityTotal, 0) : "―"}</td>
          <td>${d.capacityEffective != null ? fmt(d.capacityEffective, 0) : "―"}</td>
          <td>${fmt(d.storage)}</td>
          <td>${fmt(d.storageRatePercent)}</td>
          <td>${fmtSigned(d.dailyChange)}</td>
        </tr>`
        )
        .join("")}
    </tbody>
  `;
  tableWrap.appendChild(table);
  details.appendChild(tableWrap);

  return details;
}

function renderSystemCard(system) {
  const card = document.createElement("article");
  card.className = "system-card";

  const t = system.total;
  const rate = t?.storageRatePercent ?? null;
  const lastYearRate = system.comparison?.lastYear?.storageRatePercent ?? null;
  const level = crisisLevel(rate);

  const header = document.createElement("div");
  header.className = "system-card-header";
  header.innerHTML = `<h2>${system.name}</h2>`;
  header.appendChild(badge(level));
  card.appendChild(header);

  const observed = document.createElement("p");
  observed.className = "system-observed";
  observed.textContent = system.observedAt ? `${system.observedAt}の値` : "";
  card.appendChild(observed);

  card.appendChild(renderMeter(rate, lastYearRate));

  const stats = document.createElement("dl");
  stats.className = "stats-grid";
  stats.innerHTML = `
    <div>
      <dt>貯水量 / 有効容量</dt>
      <dd>${fmt(t?.storage)} / ${t?.capacityEffective != null ? fmt(t.capacityEffective, 0) : "―"} 万m³</dd>
    </div>
    <div>
      <dt>前日からの増減</dt>
      <dd class="delta ${deltaClass(t?.dailyChange)}">${t?.dailyChange != null ? fmtSigned(t.dailyChange) + " 万m³" : "―"}</dd>
    </div>
    <div>
      <dt>前年同日との差</dt>
      <dd class="delta ${
        rate != null && lastYearRate != null ? deltaClass(rate - lastYearRate) : "neutral"
      }">${rate != null && lastYearRate != null ? fmtSigned(rate - lastYearRate) + " pt" : "―"}</dd>
    </div>
  `;
  card.appendChild(stats);

  if (Array.isArray(system.dams) && system.dams.length > 0) {
    card.appendChild(renderDamBreakdown(system));
  } else if (system.external) {
    const src = document.createElement("p");
    src.className = "system-source-note muted";
    src.innerHTML = `出典: <a href="${system.sourceUrl}" target="_blank" rel="noopener">${system.source}</a>${
      system.note ? `<br>${system.note}` : ""
    }`;
    card.appendChild(src);
  }

  return card;
}

function renderSystems(data) {
  els.systems.innerHTML = "";
  for (const system of data.systems) {
    els.systems.appendChild(renderSystemCard(system));
  }
}

function renderHeader(data) {
  els.sourceDate.textContent = `データ基準日: ${data.sourceLabel}`;
  const fetched = new Date(data.fetchedAt);
  els.fetchedAt.textContent = `（取得: ${fetched.toLocaleString("ja-JP")}）`;
}

function showError(message) {
  els.errorBanner.hidden = false;
  els.errorBanner.textContent = message;
}

function clearError() {
  els.errorBanner.hidden = true;
  els.errorBanner.textContent = "";
}

async function loadData({ bust = false } = {}) {
  els.refreshBtn.disabled = true;
  els.refreshBtn.textContent = "更新中…";
  try {
    const url = bust ? `${DATA_URL}?t=${Date.now()}` : DATA_URL;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`データの取得に失敗しました (HTTP ${res.status})`);
    const data = await res.json();
    lastData = data;
    clearError();
    renderHeader(data);
    renderSupplyShareBar(data);
    renderOverview(data);
    renderSystems(data);
  } catch (err) {
    console.error(err);
    if (location.protocol === "file:") {
      showError(
        "このページを直接ファイルとして開いている（file://）ため、データを読み込めません。ローカルで確認する場合は、このフォルダで `python3 -m http.server 8000` などのHTTPサーバーを起動し、http://localhost:8000/ から開いてください。"
      );
    } else if (lastData) {
      showError(`最新データの取得に失敗したため、前回表示分を表示しています（${err.message}）`);
    } else {
      showError(`データの読み込みに失敗しました。時間をおいて再度お試しください。（${err.message}）`);
    }
  } finally {
    els.refreshBtn.disabled = false;
    els.refreshBtn.textContent = "更新する";
  }
}

els.refreshBtn.addEventListener("click", () => loadData({ bust: true }));

loadData();
