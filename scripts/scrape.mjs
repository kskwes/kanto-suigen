// 東京都水道局「貯水量情報」ページをスクレイピングし、data/reservoir.json を生成する。
// 公式APIが存在しないため、サーバーサイドレンダリングされたHTML表をパースしている。
// ページの表組みが変わると壊れる可能性がある点に留意。
import * as cheerio from "cheerio";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://www.waterworks.metro.tokyo.lg.jp/suigen/suigen";
const KANAGAWA_API_URL = "https://kanagawa-dam.jp/api/water-storage-value.php?g=sagami";
const KANAGAWA_PAGE_URL = "https://kanagawa-dam.jp/web_data/saves_rainfall_sagami.html";
const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUTPUT_PATH = path.join(ROOT_DIR, "data", "reservoir.json");

// 東京都水道局「東京の水道水源」(https://www.waterworks.metro.tokyo.lg.jp/suigen/antei/02) に
// 記載されている、保有水源量に占める水系別の割合（固定値・都度スクレイピングはしていない）。
const SUPPLY_SHARE = {
  sourceUrl: "https://www.waterworks.metro.tokyo.lg.jp/suigen/antei/02",
  note: "東京都が保有する水源量(日量約680万m³)に占める割合。実際の給水量の内訳とは異なる場合がある。",
  groups: [
    { label: "利根川・荒川水系", systemNames: ["利根川水系", "荒川水系"], sharePercent: 80 },
    { label: "多摩川水系", systemNames: ["多摩川水系"], sharePercent: 17 },
    { label: "相模川水系等（神奈川県）", systemNames: ["相模川水系（神奈川県）"], sharePercent: 3 },
  ],
};

// 和暦→西暦の変換（令和 = 2018 + 年）。将来の改元にも簡単に追加できるようにしておく。
const ERA_BASE_YEAR = { 令和: 2018, 平成: 1988 };

function parseEraDate(text) {
  const m = text.match(/(令和|平成)(\d+)年(\d+)月(\d+)日/);
  if (!m) return null;
  const [, era, y, mo, d] = m;
  const year = ERA_BASE_YEAR[era] + Number(y);
  return `${year}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function toNumber(text) {
  if (text == null) return null;
  const t = text.replace(/,/g, "").replace(/\s+/g, "").trim();
  if (t === "" || t === "―" || t === "-" || t === "―&nbsp;") return null;
  const n = Number(t);
  return Number.isNaN(n) ? null : n;
}

// 貯水容量セルは「11,550(11,550)」のようなネスト表、または「2,000(0～1,600)」のようなプレーンテキストの
// 2パターンがある。総容量＝最初の数値、有効容量＝カッコ内の最後の数値として扱う。
function parseCapacityCell($, cell) {
  const raw = $(cell).text().replace(/\s+/g, "");
  const nums = (raw.match(/[\d,]+(?:\.\d+)?/g) || []).map((s) => Number(s.replace(/,/g, "")));
  return {
    raw,
    total: nums.length > 0 ? nums[0] : null,
    effective: nums.length > 1 ? nums[nums.length - 1] : null,
  };
}

function parseSystemTable($, table) {
  const captionRaw = $(table).find("caption").text().replace(/\s+/g, " ").trim();
  const match = captionRaw.match(/^(.+?水系)\s*(.+)$/);
  const name = match ? match[1].trim() : captionRaw;
  const observedAt = match ? match[2].trim() : null;

  const dams = [];
  let total = null;
  const comparison = {};

  $(table)
    .find("tbody > tr")
    .each((_, tr) => {
      const tds = $(tr).find("> td");

      if (tds.length === 5) {
        const damName = $(tds[0]).text().replace(/別ウインドで開く/g, "").trim();
        const capacity = parseCapacityCell($, tds[1]);
        const record = {
          name: damName,
          capacityTotal: capacity.total,
          capacityEffective: capacity.effective,
          capacityRaw: capacity.raw,
          storage: toNumber($(tds[2]).text()),
          storageRatePercent: toNumber($(tds[3]).text()),
          dailyChange: toNumber($(tds[4]).text()),
        };
        if (damName === "以上合計") {
          total = record;
        } else {
          dams.push(record);
        }
      } else if (tds.length === 4) {
        // 「前年同日量」「前々年同日量」の比較行（1列目はcolspan=2でダム名列が無い）
        const label = $(tds[0]).text().trim();
        const record = {
          storage: toNumber($(tds[1]).text()),
          storageRatePercent: toNumber($(tds[2]).text()),
        };
        if (label.includes("前々年同日")) comparison.twoYearsAgo = record;
        else if (label.includes("前年同日")) comparison.lastYear = record;
      }
    });

  return { name, observedAt, dams, total, comparison, external: false };
}

// 令和8年9月2日のような和暦文字列を経由せず、"YYYY-MM-DD" から通日(1〜366)を求める。
function dayOfYear(dateStr) {
  const dt = new Date(`${dateStr}T00:00:00+09:00`);
  const start = new Date(dt.getFullYear(), 0, 0);
  return Math.floor((dt - start) / 86400000);
}

function parseSeriesValue(v) {
  if (v == null) return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

// 神奈川県の公開値は単位が千m³なので、他の系列と揃えるため万m³に変換する。
function thousandToManM3(v) {
  return v == null ? null : Math.round((v / 10) * 10) / 10;
}

// 東京都水道局の管轄外（神奈川県企業庁）のデータ。相模湖・津久井湖・宮ヶ瀬湖の合計貯水量で、
// 東京都はここから川崎市の長沢浄水場経由で分水を受けている（東京都水道局のページ内の表には含まれない）。
// 失敗しても本体データの更新は止めたくないため、呼び出し側でtry/catchする前提。
async function fetchKanagawaSagami() {
  const res = await fetch(KANAGAWA_API_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; kanto-suigen-viz/1.0)" },
  });
  if (!res.ok) {
    throw new Error(`神奈川県(相模川水系)データの取得に失敗しました: HTTP ${res.status}`);
  }
  const json = await res.json();
  const doy = dayOfYear(json.lastUpdate);

  const currentStorage = thousandToManM3(parseSeriesValue(json.data.current[doy]));
  const prevDayStorage = thousandToManM3(parseSeriesValue(json.data.current[doy - 1]));
  const lastYearStorage = thousandToManM3(parseSeriesValue(json.data.last[doy]));
  const twoYearsAgoStorage = thousandToManM3(parseSeriesValue(json.data.beforeLast[doy]));
  const averageStorage = thousandToManM3(parseSeriesValue(json.data.avg[doy]));
  const currentRate = toNumber(String(json.storageRate));

  // 満水量(有効容量に相当する分母)が直接は取得できないため、当日の貯水量÷貯水率から逆算する近似値。
  // 洪水期/非洪水期で満水量自体が変わるため、他の日に同じ分母を当てはめた比較用の貯水率もあくまで近似。
  const impliedCapacity =
    currentStorage != null && currentRate ? currentStorage / (currentRate / 100) : null;
  const impliedRate = (storage) =>
    storage != null && impliedCapacity ? Math.round((storage / impliedCapacity) * 1000) / 10 : null;

  return {
    name: "相模川水系（神奈川県）",
    observedAt: `${json.lastUpdate}現在`,
    external: true,
    source: "神奈川県企業庁「かながわの水がめ」",
    sourceUrl: KANAGAWA_PAGE_URL,
    note:
      "相模湖・津久井湖・宮ヶ瀬湖の合計。東京都水道局の管轄外(神奈川県企業庁のデータ)で、東京都はこの水系から川崎市の長沢浄水場経由で分水を受けている。有効容量は当日の貯水率から逆算した近似値。",
    dams: null,
    total: {
      name: "以上合計",
      capacityTotal: null,
      capacityEffective: impliedCapacity != null ? Math.round(impliedCapacity * 10) / 10 : null,
      capacityRaw: null,
      storage: currentStorage,
      storageRatePercent: currentRate,
      dailyChange:
        currentStorage != null && prevDayStorage != null
          ? Math.round((currentStorage - prevDayStorage) * 10) / 10
          : null,
    },
    comparison: {
      lastYear: { storage: lastYearStorage, storageRatePercent: impliedRate(lastYearStorage) },
      twoYearsAgo: { storage: twoYearsAgoStorage, storageRatePercent: impliedRate(twoYearsAgoStorage) },
      average: { storage: averageStorage, storageRatePercent: impliedRate(averageStorage) },
    },
  };
}

async function main() {
  const res = await fetch(SOURCE_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; kanto-suigen-viz/1.0; +https://github.com/)" },
  });
  if (!res.ok) {
    throw new Error(`貯水量情報ページの取得に失敗しました: HTTP ${res.status}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);

  const sourceLabel = $("#h2_date").first().text().replace(/\s+/g, " ").trim();
  const sourceDate = parseEraDate(sourceLabel);
  if (!sourceDate) {
    throw new Error(`日付の解析に失敗しました（ページ構造が変わった可能性）: "${sourceLabel}"`);
  }

  const systems = $("table.tbl-c2")
    .toArray()
    .map((table) => parseSystemTable($, table));

  if (systems.length === 0 || systems.some((s) => !s.total)) {
    throw new Error("水系テーブルの解析に失敗しました（ページ構造が変わった可能性）");
  }

  try {
    systems.push(await fetchKanagawaSagami());
  } catch (err) {
    // 神奈川県側のデータは補助的な位置づけのため、失敗しても東京都水道局データの更新は継続する。
    console.warn("[scrape] 相模川水系(神奈川県)データの取得に失敗しました:", err.message);
  }

  const output = {
    fetchedAt: new Date().toISOString(),
    sourceLabel,
    sourceDate,
    sourceUrl: SOURCE_URL,
    supplyShare: SUPPLY_SHARE,
    systems,
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n", "utf-8");
  console.log(`Wrote ${OUTPUT_PATH} (systems=${systems.length}, sourceDate=${sourceDate})`);
}

main().catch((err) => {
  console.error("[scrape] failed:", err.message);
  process.exit(1);
});
