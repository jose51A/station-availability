import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import * as XLSX from "xlsx";

const DB_NAME = "StationAvailabilityDB";
const STORE_NAME = "files";
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
        store.createIndex("uploadedAt", "uploadedAt", { unique: false });
      }
    };
  });
}

async function saveFileToDB(name, processedData, rowCount) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const record = {
      name,
      processedData,
      rowCount,
      stationCount: processedData.stations.length,
      dayCount: processedData.days.length,
      uploadedAt: new Date().toISOString()
    };
    const req = store.add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllFilesFromDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt)));
    req.onerror = () => reject(req.error);
  });
}

async function getFileFromDB(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deleteFileFromDB(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function fmtRelativeDate(iso) {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return "ahora mismo";
  if (diffMin < 60) return `hace ${diffMin} min`;
  if (diffHr < 24) return `hace ${diffHr}h`;
  if (diffDay < 7) return `hace ${diffDay}d`;
  return date.toLocaleDateString();
}

const BUFFER_MINUTES = 60;

function parseTime(timeStr) {
  if (!timeStr) return null;
  const s = String(timeStr).trim();
  // Handle Excel serial time (fractional day)
  const num = parseFloat(s);
  if (!isNaN(num) && num > 0 && num < 2) {
    const totalMin = Math.round(num * 24 * 60);
    return totalMin;
  }
  // "8:32:00 a. m." or "8:32:00 a.m." or "8:32 AM" etc
  const match = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?\s*m\.?|p\.?\s*m\.?|am|pm)?/i);
  if (!match) return null;
  let h = parseInt(match[1]);
  const m = parseInt(match[2]);
  const period = (match[4] || "").replace(/[\s.]/g, "").toLowerCase();
  if (period === "pm" && h < 12) h += 12;
  if (period === "am" && h === 12) h = 0;
  return h * 60 + m;
}

function fmtTime(mins) {
  if (mins == null) return "--:--";
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function fmtDuration(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

function mergeBusyWindows(events) {
  const windows = [];
  for (const e of events) {
    const start = Math.max(0, e.time - BUFFER_MINUTES);
    const end = Math.min(1440, e.time + BUFFER_MINUTES);
    windows.push({ start, end, flt: e.flt, type: e.type });
  }
  windows.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const w of windows) {
    if (merged.length && w.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, w.end);
      merged[merged.length - 1].flights.push({ flt: w.flt, type: w.type });
    } else {
      merged.push({ start: w.start, end: w.end, flights: [{ flt: w.flt, type: w.type }] });
    }
  }
  return merged;
}

function getFreeWindows(busy) {
  const free = [];
  let cursor = 0;
  for (const b of busy) {
    if (b.start > cursor) free.push({ start: cursor, end: b.start });
    cursor = b.end;
  }
  if (cursor < 1440) free.push({ start: cursor, end: 1440 });
  return free;
}

function processData(rows) {
  // Detect column names (case insensitive, flexible matching)
  const headers = Object.keys(rows[0] || {});
  const find = (patterns) => headers.find(h => patterns.some(p => h.toLowerCase().replace(/[\s_]/g, "").includes(p)));

  const dayCol = find(["day", "fecha", "date"]);
  const depStaCol = find(["depsta", "deptsta", "departuresta", "depstation"]);
  const arvlStaCol = find(["arvlsta", "arrsta", "arrivalsta", "arvlstation"]);
  const depTimeCol = find(["deptime", "depttime", "departuretime"]);
  const arvlTimeCol = find(["arvltime", "arrtime", "arrivaltime", "avl time","avltime"]);
  const fltCol = find(["fltnum", "flightnum", "flight", "flt"]);
  const weekdayCol = find(["weekday", "diasemana", "dia"]);

  if (!depStaCol || !arvlStaCol || !depTimeCol || !arvlTimeCol) {
    return { error: `No se encontraron columnas necesarias. Columnas detectadas: ${headers.join(", ")}. Se necesitan: Dept Sta, Arvl Sta, Dept Time, Arvl Time.` };
  }

  const stationDayMap = {};
  const allStations = new Set();
  const allDays = new Set();

  for (const row of rows) {
    const day = row[dayCol] || "Unknown";
    const depSta = (row[depStaCol] || "").toString().trim().toUpperCase();
    const arvlSta = (row[arvlStaCol] || "").toString().trim().toUpperCase();
    const depTime = parseTime(row[depTimeCol]);
    const arvlTime = parseTime(row[arvlTimeCol]);
    const flt = row[fltCol] || "";

    if (!depSta && !arvlSta) continue;

    // Normalize day to string
    let dayStr = day;
    if (day instanceof Date) {
      dayStr = day.toISOString().split("T")[0];
    } else if (typeof day === "number") {
      // Excel serial date
      const d = new Date((day - 25569) * 86400000);
      dayStr = d.toISOString().split("T")[0];
    } else {
      dayStr = String(day).trim();
    }
    allDays.add(dayStr);

    if (depSta && depTime != null) {
      allStations.add(depSta);
      const key = `${depSta}|${dayStr}`;
      if (!stationDayMap[key]) stationDayMap[key] = { station: depSta, day: dayStr, events: [] };
      stationDayMap[key].events.push({ time: depTime, type: "DEP", flt });
    }
    if (arvlSta && arvlTime != null) {
      allStations.add(arvlSta);
      const key = `${arvlSta}|${dayStr}`;
      if (!stationDayMap[key]) stationDayMap[key] = { station: arvlSta, day: dayStr, events: [] };
      stationDayMap[key].events.push({ time: arvlTime, type: "ARR", flt });
    }
  }

  const results = {};
  for (const [key, data] of Object.entries(stationDayMap)) {
    const busy = mergeBusyWindows(data.events);
    const free = getFreeWindows(busy);
    const totalFree = free.reduce((s, f) => s + (f.end - f.start), 0);
    results[key] = { ...data, busy, free, totalFree, flightCount: data.events.length };
  }

  return {
    results,
    stations: [...allStations].sort(),
    days: [...allDays].sort(),
    totalRows: rows.length,
    weekdayCol
  };
}

function TimelineBar({ busy, free, compact = false }) {
  const h = compact ? 28 : 40;
  return (
    <div style={{ position: "relative", height: h, background: "var(--color-background-tertiary)", borderRadius: 6, overflow: "hidden", border: "0.5px solid var(--color-border-tertiary)" }}>
      {busy.map((b, i) => {
        const left = (b.start / 1440) * 100;
        const width = ((b.end - b.start) / 1440) * 100;
        return (
          <div key={`b${i}`} title={`Ocupado: ${fmtTime(b.start)}-${fmtTime(b.end)} (${b.flights?.length || 0} vuelos)`} style={{
            position: "absolute", top: 0, left: `${left}%`, width: `${width}%`, height: "100%",
            background: "#E24B4A", opacity: 0.75, display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 10, color: "#fff", fontWeight: 500, overflow: "hidden", whiteSpace: "nowrap"
          }}>
            {width > 6 && !compact ? `${fmtTime(b.start)}-${fmtTime(b.end)}` : ""}
          </div>
        );
      })}
      {free.map((f, i) => {
        const left = (f.start / 1440) * 100;
        const width = ((f.end - f.start) / 1440) * 100;
        const dur = f.end - f.start;
        return (
          <div key={`f${i}`} title={`Libre: ${fmtTime(f.start)}-${fmtTime(f.end)} (${fmtDuration(dur)})`} style={{
            position: "absolute", top: 0, left: `${left}%`, width: `${width}%`, height: "100%",
            background: "#639922", opacity: 0.65, display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 10, color: "#fff", fontWeight: 500, overflow: "hidden", whiteSpace: "nowrap"
          }}>
            {width > 8 && !compact ? fmtDuration(dur) : ""}
          </div>
        );
      })}
    </div>
  );
}

function TimeAxis() {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2, padding: "0 1px" }}>
      {["00", "03", "06", "09", "12", "15", "18", "21", "24"].map(h => <span key={h}>{h}:00</span>)}
    </div>
  );
}

function StationDetail({ data }) {
  if (!data) return null;
  const { station, day, busy, free, totalFree, flightCount } = data;
  return (
    <div style={{ background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", padding: "20px 24px", marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
        <div>
          <span style={{ fontSize: 20, fontWeight: 500, color: "var(--color-text-primary)", letterSpacing: "-0.02em" }}>{station}</span>
          <span style={{ fontSize: 13, color: "var(--color-text-secondary)", marginLeft: 12 }}>{day}</span>
        </div>
        <div style={{ display: "flex", gap: 20 }}>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Vuelos</div>
            <div style={{ fontSize: 18, fontWeight: 500 }}>{flightCount}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>Disponible</div>
            <div style={{ fontSize: 18, fontWeight: 500, color: "#639922" }}>{fmtDuration(totalFree)}</div>
          </div>
        </div>
      </div>
      <TimelineBar busy={busy} free={free} />
      <TimeAxis />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 16 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 6 }}>Ventanas disponibles</div>
          {free.length === 0 ? (
            <div style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>Sin ventanas libres</div>
          ) : free.map((f, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0", color: "var(--color-text-primary)" }}>
              <span>{fmtTime(f.start)} – {fmtTime(f.end)}</span>
              <span style={{ color: "#639922", fontWeight: 500 }}>{fmtDuration(f.end - f.start)}</span>
            </div>
          ))}
        </div>
        <div>
          <div style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 6 }}>Bloques ocupados</div>
          {busy.map((b, i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0", color: "var(--color-text-primary)" }}>
              <span>{fmtTime(b.start)} – {fmtTime(b.end)}</span>
              <span style={{ color: "#E24B4A", fontWeight: 500 }}>{b.flights?.length || 0} vuelo{(b.flights?.length || 0) !== 1 ? "s" : ""}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SummaryStats({ data }) {
  if (!data) return null;
  const { results, stations, days, totalRows } = data;
  const entries = Object.values(results);
  const avgFree = entries.length > 0 ? Math.round(entries.reduce((s, e) => s + e.totalFree, 0) / entries.length) : 0;
  const maxFreeEntry = entries.reduce((best, e) => (e.totalFree > (best?.totalFree || 0) ? e : best), null);
  const minFreeEntry = entries.reduce((worst, e) => (e.totalFree < (worst?.totalFree || Infinity) ? e : worst), null);

  const stats = [
    { label: "Registros procesados", value: totalRows.toLocaleString(), color: "var(--color-text-primary)" },
    { label: "Estaciones", value: stations.length, color: "var(--color-text-primary)" },
    { label: "Dias analizados", value: days.length, color: "var(--color-text-primary)" },
    { label: "Disponibilidad promedio", value: fmtDuration(avgFree), color: "#639922" },
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginBottom: 24 }}>
      {stats.map((s, i) => (
        <div key={i} style={{ background: "var(--color-background-secondary)", borderRadius: 8, padding: "12px 16px" }}>
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>{s.label}</div>
          <div style={{ fontSize: 22, fontWeight: 500, color: s.color }}>{s.value}</div>
        </div>
      ))}
    </div>
  );
}

function HeatmapView({ data, onSelect }) {
  if (!data) return null;
  const { results, stations, days } = data;
  const [sortBy, setSortBy] = useState("name");

  const sortedStations = useMemo(() => {
    const staCopy = [...stations];
    if (sortBy === "availability") {
      staCopy.sort((a, b) => {
        const aAvg = days.reduce((s, d) => s + (results[`${a}|${d}`]?.totalFree || 1440), 0) / days.length;
        const bAvg = days.reduce((s, d) => s + (results[`${b}|${d}`]?.totalFree || 1440), 0) / days.length;
        return aAvg - bAvg;
      });
    } else if (sortBy === "flights") {
      staCopy.sort((a, b) => {
        const aFlts = days.reduce((s, d) => s + (results[`${a}|${d}`]?.flightCount || 0), 0);
        const bFlts = days.reduce((s, d) => s + (results[`${b}|${d}`]?.flightCount || 0), 0);
        return bFlts - aFlts;
      });
    }
    return staCopy;
  }, [stations, days, results, sortBy]);

  const maxDaysShown = Math.min(days.length, 14);
  const shownDays = days.slice(0, maxDaysShown);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 500 }}>Mapa de calor — disponibilidad por estacion y dia</div>
        <div style={{ display: "flex", gap: 8, fontSize: 12 }}>
          <span style={{ color: "var(--color-text-tertiary)" }}>Ordenar:</span>
          {["name", "availability", "flights"].map(opt => (
            <button key={opt} onClick={() => setSortBy(opt)} style={{
              background: sortBy === opt ? "var(--color-background-info)" : "transparent",
              color: sortBy === opt ? "var(--color-text-info)" : "var(--color-text-secondary)",
              border: "0.5px solid " + (sortBy === opt ? "var(--color-border-info)" : "var(--color-border-tertiary)"),
              borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12
            }}>
              {opt === "name" ? "Nombre" : opt === "availability" ? "Disponibilidad" : "Vuelos"}
            </button>
          ))}
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: `80px repeat(${shownDays.length}, minmax(50px, 1fr))`, gap: 2, fontSize: 11 }}>
          <div style={{ fontWeight: 500, color: "var(--color-text-secondary)", padding: 4 }}>Estacion</div>
          {shownDays.map(d => {
            const short = d.length > 5 ? d.slice(5) : d;
            return <div key={d} style={{ fontWeight: 500, color: "var(--color-text-secondary)", padding: 4, textAlign: "center" }}>{short}</div>;
          })}
          {sortedStations.map(sta => (
            <>
              <div key={`l-${sta}`} style={{ fontWeight: 500, color: "var(--color-text-primary)", padding: 4, display: "flex", alignItems: "center" }}>{sta}</div>
              {shownDays.map(d => {
                const entry = results[`${sta}|${d}`];
                const free = entry ? entry.totalFree : 1440;
                const pct = free / 1440;
                const r = Math.round(226 * (1 - pct) + 99 * pct);
                const g = Math.round(75 * (1 - pct) + 153 * pct);
                const b2 = Math.round(74 * (1 - pct) + 34 * pct);
                return (
                  <div key={`${sta}-${d}`}
                    onClick={() => entry && onSelect(entry)}
                    style={{
                      background: `rgb(${r},${g},${b2})`,
                      opacity: entry ? 0.8 : 0.15,
                      color: "#fff", fontWeight: 500, fontSize: 10, display: "flex", alignItems: "center", justifyContent: "center",
                      borderRadius: 4, padding: 4, cursor: entry ? "pointer" : "default",
                      minHeight: 28, transition: "opacity 0.15s"
                    }}
                    title={entry ? `${sta} ${d}: ${fmtDuration(free)} libre (${entry.flightCount} vuelos)` : `${sta} ${d}: sin vuelos`}
                  >
                    {entry ? fmtDuration(free) : "—"}
                  </div>
                );
              })}
            </>
          ))}
        </div>
      </div>
      {days.length > maxDaysShown && (
        <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginTop: 8 }}>Mostrando {maxDaysShown} de {days.length} dias. Filtra por estacion para ver todos.</div>
      )}
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 10, fontSize: 11, color: "var(--color-text-tertiary)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <div style={{ width: 14, height: 14, borderRadius: 3, background: "rgb(226,75,74)", opacity: 0.8 }} />
          <span>Menos disponible</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <div style={{ width: 14, height: 14, borderRadius: 3, background: "rgb(140,120,50)", opacity: 0.8 }} />
          <span>Medio</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <div style={{ width: 14, height: 14, borderRadius: 3, background: "rgb(99,153,34)", opacity: 0.8 }} />
          <span>Mas disponible</span>
        </div>
      </div>
    </div>
  );
}

function StationListView({ data, selectedStation, selectedDay, onSelect }) {
  if (!data) return null;
  const { results, stations, days } = data;

  const filteredEntries = useMemo(() => {
    const stationSet = new Set(stations);
    return Object.values(results).filter(e => {
      if (!stationSet.has(e.station)) return false;
      if (selectedStation && e.station !== selectedStation) return false;
      if (selectedDay && e.day !== selectedDay) return false;
      return true;
    }).sort((a, b) => a.totalFree - b.totalFree);
  }, [results, stations, selectedStation, selectedDay]);

  return (
    <div>
      {filteredEntries.slice(0, 50).map((entry, i) => (
        <div key={i} onClick={() => onSelect(entry)} style={{
          display: "grid", gridTemplateColumns: "80px 100px 1fr 100px",
          alignItems: "center", gap: 12, padding: "10px 12px",
          borderBottom: "0.5px solid var(--color-border-tertiary)",
          cursor: "pointer", transition: "background 0.1s"
        }}
          onMouseEnter={e => e.currentTarget.style.background = "var(--color-background-secondary)"}
          onMouseLeave={e => e.currentTarget.style.background = "transparent"}
        >
          <span style={{ fontWeight: 500, fontSize: 14 }}>{entry.station}</span>
          <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{entry.day}</span>
          <TimelineBar busy={entry.busy} free={entry.free} compact />
          <span style={{ fontSize: 13, fontWeight: 500, color: "#639922", textAlign: "right" }}>{fmtDuration(entry.totalFree)}</span>
        </div>
      ))}
      {filteredEntries.length > 50 && (
        <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", padding: 12 }}>Mostrando 50 de {filteredEntries.length} registros. Usa los filtros para ver mas.</div>
      )}
      {filteredEntries.length === 0 && (
        <div style={{ padding: 24, textAlign: "center", color: "var(--color-text-tertiary)" }}>No hay datos para los filtros seleccionados.</div>
      )}
    </div>
  );
}

function getHourlyStatus(busy, hour) {
  const hStart = hour * 60;
  const hEnd = hStart + 60;
  for (const b of busy) {
    if (b.start < hEnd && b.end > hStart) {
      const overlapStart = Math.max(b.start, hStart);
      const overlapEnd = Math.min(b.end, hEnd);
      const overlapMin = overlapEnd - overlapStart;
      if (overlapMin >= 60) return { status: "full", minutes: 0 };
      if (overlapMin > 0) return { status: "partial", minutes: 60 - overlapMin };
    }
  }
  return { status: "free", minutes: 60 };
}

function HourlyView({ data, selectedStation, selectedDay }) {
  if (!data) return null;
  const { results, stations, days } = data;
  const filteredStations = selectedStation ? [selectedStation] : stations;
  const filteredDays = selectedDay ? [selectedDay] : days;
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const [expandedStation, setExpandedStation] = useState(null);

  const stationSummaries = useMemo(() => {
    return filteredStations.map(sta => {
      const dayData = filteredDays.map(day => {
        const entry = results[`${sta}|${day}`];
        if (!entry) return { day, hours: hours.map(() => ({ status: "free", minutes: 60 })), events: [], totalFree: 1440, busy: [], free: [{ start: 0, end: 1440 }] };
        const hourStatuses = hours.map(h => getHourlyStatus(entry.busy, h));
        return { day, hours: hourStatuses, events: entry.events, totalFree: entry.totalFree, busy: entry.busy, free: entry.free };
      });
      return { station: sta, days: dayData };
    });
  }, [filteredStations, filteredDays, results]);

  const cellStyle = (s) => {
    if (s.status === "free") return { bg: "#639922", op: 0.7 };
    if (s.status === "full") return { bg: "#E24B4A", op: 0.75 };
    return { bg: "#EF9F27", op: 0.7 };
  };

  return (
    <div>
      <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 8 }}>Vista hora por hora</div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, fontSize: 11, color: "var(--color-text-tertiary)" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 12, height: 12, borderRadius: 3, background: "#639922", opacity: 0.7, display: "inline-block" }} /> Libre (60 min)</span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 12, height: 12, borderRadius: 3, background: "#EF9F27", opacity: 0.7, display: "inline-block" }} /> Parcial</span>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 12, height: 12, borderRadius: 3, background: "#E24B4A", opacity: 0.75, display: "inline-block" }} /> Ocupada</span>
      </div>

      {stationSummaries.slice(0, 30).map(({ station, days: staDays }) => (
        <div key={station} style={{ marginBottom: 16, background: "var(--color-background-primary)", borderRadius: 12, border: "0.5px solid var(--color-border-tertiary)", overflow: "hidden" }}>
          <div onClick={() => setExpandedStation(expandedStation === station ? null : station)}
            style={{ padding: "10px 16px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--color-background-secondary)" }}>
            <span style={{ fontSize: 16, fontWeight: 500 }}>{station}</span>
            <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
              {staDays.length} dia{staDays.length !== 1 ? "s" : ""} — {expandedStation === station ? "colapsar" : "expandir"}
            </span>
          </div>

          {(expandedStation === station || filteredStations.length <= 3) && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, minWidth: 700 }}>
                <thead>
                  <tr>
                    <th style={{ position: "sticky", left: 0, background: "var(--color-background-primary)", zIndex: 2, padding: "8px 8px", textAlign: "left", fontWeight: 500, color: "var(--color-text-secondary)", borderBottom: "0.5px solid var(--color-border-tertiary)", minWidth: 70 }}>Dia</th>
                    {hours.map(h => (
                      <th key={h} style={{ padding: "8px 1px", textAlign: "center", fontWeight: 500, color: "var(--color-text-secondary)", borderBottom: "0.5px solid var(--color-border-tertiary)", minWidth: 24 }}>
                        {h.toString().padStart(2, "0")}
                      </th>
                    ))}
                    <th style={{ padding: "8px 8px", textAlign: "right", fontWeight: 500, color: "var(--color-text-secondary)", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>Libre</th>
                  </tr>
                </thead>
                <tbody>
                  {staDays.map(({ day, hours: hStatuses, totalFree, events, free }) => (
                    <tr key={day}>
                      <td style={{ position: "sticky", left: 0, background: "var(--color-background-primary)", zIndex: 1, padding: "3px 8px", fontWeight: 500, fontSize: 11, borderBottom: "0.5px solid var(--color-border-tertiary)", whiteSpace: "nowrap" }}>
                        {day.length > 5 ? day.slice(5) : day}
                      </td>
                      {hStatuses.map((s, hi) => {
                        const { bg, op } = cellStyle(s);
                        const hStr = `${hi.toString().padStart(2, "0")}:00–${(hi + 1).toString().padStart(2, "0")}:00`;
                        const tip = s.status === "free" ? `LIBRE ${hStr}` : s.status === "full" ? `OCUPADA ${hStr}` : `${s.minutes}min libre de ${hStr}`;
                        return (
                          <td key={hi} title={tip} style={{ padding: "2px 1px", borderBottom: "0.5px solid var(--color-border-tertiary)" }}>
                            <div style={{ background: bg, opacity: op, color: "#fff", borderRadius: 3, textAlign: "center", padding: "2px 0", fontWeight: 500, fontSize: 9, minHeight: 18, display: "flex", alignItems: "center", justifyContent: "center" }}>
                              {s.status === "partial" ? `${s.minutes}m` : ""}
                            </div>
                          </td>
                        );
                      })}
                      <td style={{ padding: "3px 8px", textAlign: "right", fontWeight: 500, color: "#639922", borderBottom: "0.5px solid var(--color-border-tertiary)", whiteSpace: "nowrap", fontSize: 12 }}>
                        {fmtDuration(totalFree)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filteredDays.length <= 7 && staDays.map(({ day, events, free }) => (
                events && events.length > 0 && (
                  <div key={`det-${day}`} style={{ padding: "10px 16px", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
                    {filteredDays.length > 1 && <div style={{ fontSize: 11, fontWeight: 500, color: "var(--color-text-tertiary)", marginBottom: 4 }}>{day}</div>}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <div>
                        <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginBottom: 4 }}>Vuelos ({events.length})</div>
                        {[...events].sort((a, b) => a.time - b.time).map((ev, i) => (
                          <div key={i} style={{ fontSize: 12, padding: "2px 0" }}>
                            <span style={{ color: ev.type === "DEP" ? "#E24B4A" : "#1D9E75", fontWeight: 500, fontSize: 10, marginRight: 4 }}>{ev.type === "DEP" ? "SAL" : "LLE"}</span>
                            {fmtTime(ev.time)} — Flt {ev.flt}
                            <span style={{ color: "var(--color-text-tertiary)", fontSize: 10, marginLeft: 4 }}>
                              (ocupa {fmtTime(Math.max(0, ev.time - 60))}–{fmtTime(Math.min(1440, ev.time + 60))})
                            </span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginBottom: 4 }}>Ventanas libres para soporte</div>
                        {free && free.map((f, i) => (
                          <div key={i} style={{ fontSize: 12, padding: "2px 0", display: "flex", justifyContent: "space-between" }}>
                            <span style={{ color: "#639922", fontWeight: 500 }}>{fmtTime(f.start)} – {fmtTime(f.end)}</span>
                            <span style={{ color: "var(--color-text-secondary)" }}>{fmtDuration(f.end - f.start)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )
              ))}
            </div>
          )}
        </div>
      ))}
      {filteredStations.length > 30 && (
        <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", padding: 12 }}>Mostrando 30 de {filteredStations.length} estaciones. Filtra para ver mas.</div>
      )}
    </div>
  );
}

function getWeekKey(dayStr) {
  const p = parseDayString(dayStr);
  if (!p) return null;
  const d = new Date(p.year, p.month, p.day);
  const dayOfWeek = (d.getDay() + 6) % 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - dayOfWeek);
  return `${monday.getFullYear()}-${(monday.getMonth() + 1).toString().padStart(2, "0")}-${monday.getDate().toString().padStart(2, "0")}`;
}

function OverviewView({ data, onNavigate, onSelectStation }) {
  if (!data) return null;
  const { results, stations, days, totalRows } = data;

  const analytics = useMemo(() => {
    const entries = Object.values(results);
    if (entries.length === 0) return null;

    const avgFreePerStation = {};
    const flightsPerStation = {};
    for (const sta of stations) {
      const staEntries = entries.filter(e => e.station === sta);
      const totalFree = staEntries.reduce((s, e) => s + e.totalFree, 0);
      const totalFlights = staEntries.reduce((s, e) => s + e.flightCount, 0);
      avgFreePerStation[sta] = staEntries.length > 0 ? totalFree / staEntries.length : 1440;
      flightsPerStation[sta] = totalFlights;
    }

    const sortedByAvail = [...stations].sort((a, b) => avgFreePerStation[b] - avgFreePerStation[a]);
    const sortedByFlights = [...stations].sort((a, b) => flightsPerStation[b] - flightsPerStation[a]);

    const hourlyLoad = Array(24).fill(0);
    for (const e of entries) {
      for (const b of e.busy) {
        const startH = Math.floor(b.start / 60);
        const endH = Math.ceil(b.end / 60);
        for (let h = startH; h < endH && h < 24; h++) hourlyLoad[h]++;
      }
    }
    const maxLoad = Math.max(...hourlyLoad, 1);

    const globalFreeMinutes = Array(1440).fill(0);
    for (const e of entries) {
      for (const f of e.free) {
        for (let m = f.start; m < f.end; m++) globalFreeMinutes[m]++;
      }
    }
    const totalStationDays = entries.length;
    const freePercentByHour = Array(24).fill(0);
    for (let h = 0; h < 24; h++) {
      let sum = 0;
      for (let m = h * 60; m < (h + 1) * 60; m++) sum += globalFreeMinutes[m];
      freePercentByHour[h] = totalStationDays > 0 ? (sum / 60 / totalStationDays) * 100 : 0;
    }

    const totalFreeAll = entries.reduce((s, e) => s + e.totalFree, 0);
    const avgFreeAll = totalFreeAll / entries.length;
    const totalFlights = entries.reduce((s, e) => s + e.flightCount, 0);
    const avgFlightsPerDay = days.length > 0 ? totalFlights / days.length : 0;

    return {
      avgFreeAll,
      totalFlights,
      avgFlightsPerDay,
      topFree: sortedByAvail.slice(0, 5),
      topBusy: sortedByAvail.slice(-5).reverse(),
      busiestStations: sortedByFlights.slice(0, 5),
      hourlyLoad,
      maxLoad,
      freePercentByHour,
      avgFreePerStation,
      flightsPerStation
    };
  }, [results, stations, days]);

  if (!analytics) return <div style={{ padding: 24, textAlign: "center", color: "var(--color-text-tertiary)" }}>Sin datos para mostrar</div>;

  const { avgFreeAll, totalFlights, avgFlightsPerDay, topFree, topBusy, busiestStations, hourlyLoad, maxLoad, freePercentByHour, avgFreePerStation, flightsPerStation } = analytics;

  const peakHour = hourlyLoad.indexOf(maxLoad);
  const quietHour = freePercentByHour.indexOf(Math.max(...freePercentByHour));

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 24 }}>
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 12, padding: "16px 18px" }}>
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Disponibilidad promedio</div>
          <div style={{ fontSize: 26, fontWeight: 500, color: "#639922", letterSpacing: "-0.02em" }}>{fmtDuration(Math.round(avgFreeAll))}</div>
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 2 }}>por estacion/dia</div>
        </div>
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 12, padding: "16px 18px" }}>
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Total de vuelos</div>
          <div style={{ fontSize: 26, fontWeight: 500, color: "var(--color-text-primary)", letterSpacing: "-0.02em" }}>{totalFlights.toLocaleString()}</div>
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 2 }}>{Math.round(avgFlightsPerDay)} en promedio/dia</div>
        </div>
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 12, padding: "16px 18px" }}>
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Hora pico global</div>
          <div style={{ fontSize: 26, fontWeight: 500, color: "#E24B4A", letterSpacing: "-0.02em" }}>{peakHour.toString().padStart(2, "0")}:00</div>
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 2 }}>mayor carga operativa</div>
        </div>
        <div style={{ background: "var(--color-background-secondary)", borderRadius: 12, padding: "16px 18px" }}>
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Mejor hora global</div>
          <div style={{ fontSize: 26, fontWeight: 500, color: "#185FA5", letterSpacing: "-0.02em" }}>{quietHour.toString().padStart(2, "0")}:00</div>
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 2 }}>mayor disponibilidad</div>
        </div>
      </div>

      <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "18px 20px", marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 500 }}>Distribucion de carga por hora del dia</div>
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>% de estaciones libres</div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 120, marginBottom: 6 }}>
          {freePercentByHour.map((pct, h) => {
            const height = Math.max(2, pct);
            const isPeak = h === peakHour;
            const isQuiet = h === quietHour;
            return (
              <div key={h} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                <div
                  title={`${h.toString().padStart(2, "0")}:00 — ${Math.round(pct)}% libre`}
                  style={{
                    width: "100%", height: `${height}%`, minHeight: 2,
                    background: isQuiet ? "#185FA5" : isPeak ? "#E24B4A" : "#639922",
                    opacity: isQuiet || isPeak ? 1 : 0.55,
                    borderRadius: "3px 3px 0 0", transition: "opacity 0.2s"
                  }}
                />
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 3, fontSize: 9, color: "var(--color-text-tertiary)", marginTop: 4 }}>
          {freePercentByHour.map((_, h) => (
            <div key={h} style={{ flex: 1, textAlign: "center" }}>{h % 3 === 0 ? h.toString().padStart(2, "0") : ""}</div>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, marginBottom: 16 }}>
        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "18px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12, color: "#639922", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#639922", display: "inline-block" }} />
            Mayor disponibilidad
          </div>
          {topFree.map((sta, i) => (
            <div key={sta} onClick={() => onSelectStation(sta)}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < topFree.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none", cursor: "pointer" }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-background-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", width: 14 }}>{i + 1}</span>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{sta}</span>
              </div>
              <span style={{ fontSize: 12, color: "#639922", fontWeight: 500 }}>{fmtDuration(Math.round(avgFreePerStation[sta]))}</span>
            </div>
          ))}
        </div>

        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "18px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12, color: "#E24B4A", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#E24B4A", display: "inline-block" }} />
            Menor disponibilidad
          </div>
          {topBusy.map((sta, i) => (
            <div key={sta} onClick={() => onSelectStation(sta)}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < topBusy.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none", cursor: "pointer" }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-background-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", width: 14 }}>{i + 1}</span>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{sta}</span>
              </div>
              <span style={{ fontSize: 12, color: "#E24B4A", fontWeight: 500 }}>{fmtDuration(Math.round(avgFreePerStation[sta]))}</span>
            </div>
          ))}
        </div>

        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "18px 20px" }}>
          <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 12, color: "var(--color-text-primary)", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--color-text-secondary)", display: "inline-block" }} />
            Mayor trafico
          </div>
          {busiestStations.map((sta, i) => (
            <div key={sta} onClick={() => onSelectStation(sta)}
              style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: i < busiestStations.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none", cursor: "pointer" }}
              onMouseEnter={e => e.currentTarget.style.background = "var(--color-background-secondary)"}
              onMouseLeave={e => e.currentTarget.style.background = "transparent"}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", width: 14 }}>{i + 1}</span>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{sta}</span>
              </div>
              <span style={{ fontSize: 12, color: "var(--color-text-secondary)", fontWeight: 500 }}>{flightsPerStation[sta]} vuelos</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ background: "var(--color-background-secondary)", borderRadius: 12, padding: "14px 18px", fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
        Explora los detalles con las vistas:
        <span onClick={() => onNavigate("heatmap")} style={{ color: "var(--color-text-info)", cursor: "pointer", fontWeight: 500, marginLeft: 6 }}>mapa de calor</span>
        <span style={{ margin: "0 4px" }}>·</span>
        <span onClick={() => onNavigate("compare")} style={{ color: "var(--color-text-info)", cursor: "pointer", fontWeight: 500 }}>comparar estaciones</span>
        <span style={{ margin: "0 4px" }}>·</span>
        <span onClick={() => onNavigate("hourly")} style={{ color: "var(--color-text-info)", cursor: "pointer", fontWeight: 500 }}>hora por hora</span>
        <span style={{ margin: "0 4px" }}>·</span>
        <span onClick={() => onNavigate("list")} style={{ color: "var(--color-text-info)", cursor: "pointer", fontWeight: 500 }}>lista completa</span>
      </div>
    </div>
  );
}

function CompareView({ data, selectedStations, onToggleStation, onClearSelection, selectedDay, onDaySelect }) {
  if (!data) return null;
  const { results, stations, days } = data;
  const [period, setPeriod] = useState("day");
  const [stationSearch, setStationSearch] = useState("");
  const MAX_SELECTION = 10;

  const weeks = useMemo(() => {
    const weekMap = new Map();
    for (const d of days) {
      const wk = getWeekKey(d);
      if (!wk) continue;
      if (!weekMap.has(wk)) weekMap.set(wk, []);
      weekMap.get(wk).push(d);
    }
    return [...weekMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [days]);

  const [selectedWeek, setSelectedWeek] = useState(() => weeks[0]?.[0] || "");

  useEffect(() => {
    if (period === "week" && !selectedWeek && weeks.length > 0) {
      setSelectedWeek(weeks[0][0]);
    }
  }, [period, weeks, selectedWeek]);

  const filteredList = useMemo(() => {
    const term = stationSearch.trim().toUpperCase();
    if (!term) return stations;
    return stations.filter(s => s.includes(term));
  }, [stations, stationSearch]);

  const comparisonData = useMemo(() => {
    if (selectedStations.length === 0) return [];

    const targetDays = period === "day"
      ? (selectedDay ? [selectedDay] : [days[0]])
      : (weeks.find(w => w[0] === selectedWeek)?.[1] || []);

    return selectedStations.map(sta => {
      if (period === "day" && targetDays.length === 1) {
        const entry = results[`${sta}|${targetDays[0]}`];
        return {
          station: sta,
          label: targetDays[0],
          busy: entry?.busy || [],
          free: entry?.free || [{ start: 0, end: 1440 }],
          totalFree: entry?.totalFree || 1440,
          flightCount: entry?.flightCount || 0,
          events: entry?.events || []
        };
      } else {
        const busyMinutes = new Array(1440).fill(0);
        let totalFlights = 0;
        for (const d of targetDays) {
          const entry = results[`${sta}|${d}`];
          if (!entry) continue;
          totalFlights += entry.flightCount;
          for (const b of entry.busy) {
            for (let m = b.start; m < b.end; m++) busyMinutes[m]++;
          }
        }
        const avgBusy = [];
        let curStart = null;
        const threshold = targetDays.length / 2;
        for (let m = 0; m < 1440; m++) {
          if (busyMinutes[m] >= threshold) {
            if (curStart === null) curStart = m;
          } else {
            if (curStart !== null) { avgBusy.push({ start: curStart, end: m }); curStart = null; }
          }
        }
        if (curStart !== null) avgBusy.push({ start: curStart, end: 1440 });

        const avgFree = [];
        let cursor = 0;
        for (const b of avgBusy) {
          if (b.start > cursor) avgFree.push({ start: cursor, end: b.start });
          cursor = b.end;
        }
        if (cursor < 1440) avgFree.push({ start: cursor, end: 1440 });

        const totalFree = avgFree.reduce((s, f) => s + (f.end - f.start), 0);
        return {
          station: sta,
          label: `Semana (${targetDays.length} dias)`,
          busy: avgBusy,
          free: avgFree,
          totalFree,
          flightCount: Math.round(totalFlights / Math.max(targetDays.length, 1)),
          events: []
        };
      }
    });
  }, [selectedStations, period, selectedDay, selectedWeek, days, weeks, results]);

  const commonFreeWindows = useMemo(() => {
    if (comparisonData.length < 2) return [];
    const minute = new Array(1440).fill(true);
    for (const cd of comparisonData) {
      const freeSet = new Array(1440).fill(false);
      for (const f of cd.free) {
        for (let m = f.start; m < f.end; m++) freeSet[m] = true;
      }
      for (let m = 0; m < 1440; m++) if (!freeSet[m]) minute[m] = false;
    }
    const windows = [];
    let start = null;
    for (let m = 0; m < 1440; m++) {
      if (minute[m]) { if (start === null) start = m; }
      else { if (start !== null) { windows.push({ start, end: m }); start = null; } }
    }
    if (start !== null) windows.push({ start, end: 1440 });
    return windows.filter(w => w.end - w.start >= 15);
  }, [comparisonData]);

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 16 }}>
        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "14px 16px", height: "fit-content" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Estaciones</div>
            <div style={{ fontSize: 11, color: selectedStations.length >= MAX_SELECTION ? "#E24B4A" : "var(--color-text-tertiary)" }}>
              {selectedStations.length}/{MAX_SELECTION}
            </div>
          </div>
          <input
            type="text"
            value={stationSearch}
            onChange={e => setStationSearch(e.target.value)}
            placeholder="Buscar..."
            style={{
              width: "100%", fontSize: 12, padding: "6px 10px", marginBottom: 8,
              borderRadius: 6, border: "0.5px solid var(--color-border-tertiary)",
              background: "var(--color-background-secondary)", color: "var(--color-text-primary)",
              outline: "none", boxSizing: "border-box", fontFamily: "inherit"
            }}
          />
          {selectedStations.length > 0 && (
            <button
              onClick={onClearSelection}
              style={{ fontSize: 11, padding: "4px 10px", marginBottom: 8, borderRadius: 6, border: "0.5px solid var(--color-border-tertiary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer", width: "100%" }}
            >
              Limpiar seleccion
            </button>
          )}
          <div style={{ maxHeight: 360, overflowY: "auto", marginTop: 4 }}>
            {filteredList.map(sta => {
              const isSelected = selectedStations.includes(sta);
              const disabled = !isSelected && selectedStations.length >= MAX_SELECTION;
              return (
                <label key={sta}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                    borderRadius: 6, cursor: disabled ? "not-allowed" : "pointer",
                    opacity: disabled ? 0.4 : 1,
                    background: isSelected ? "var(--color-background-info)" : "transparent"
                  }}
                  onMouseEnter={e => { if (!disabled && !isSelected) e.currentTarget.style.background = "var(--color-background-secondary)"; }}
                  onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    disabled={disabled}
                    onChange={() => onToggleStation(sta)}
                    style={{ cursor: disabled ? "not-allowed" : "pointer", margin: 0 }}
                  />
                  <span style={{ fontSize: 12, fontWeight: isSelected ? 500 : 400, color: isSelected ? "var(--color-text-info)" : "var(--color-text-primary)" }}>{sta}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 4, background: "var(--color-background-secondary)", borderRadius: 8, padding: 3 }}>
              {[{ id: "day", label: "Por dia" }, { id: "week", label: "Por semana" }].map(p => (
                <button key={p.id} onClick={() => setPeriod(p.id)} style={{
                  fontSize: 12, padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer",
                  background: period === p.id ? "var(--color-background-primary)" : "transparent",
                  color: period === p.id ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                  fontWeight: period === p.id ? 500 : 400
                }}>{p.label}</button>
              ))}
            </div>
            {period === "day" && (
              <CalendarPicker
                availableDays={days}
                selectedDay={selectedDay || days[0]}
                onSelect={onDaySelect}
              />
            )}
            {period === "week" && weeks.length > 0 && (
              <select
                value={selectedWeek}
                onChange={e => setSelectedWeek(e.target.value)}
                style={{ fontSize: 13, padding: "6px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)" }}
              >
                {weeks.map(([wk, wkDays]) => (
                  <option key={wk} value={wk}>Semana del {wk} ({wkDays.length}d)</option>
                ))}
              </select>
            )}
          </div>

          {selectedStations.length === 0 ? (
            <div style={{ padding: 40, textAlign: "center", color: "var(--color-text-tertiary)", background: "var(--color-background-secondary)", borderRadius: 12 }}>
              <div style={{ fontSize: 14, marginBottom: 4 }}>Selecciona hasta {MAX_SELECTION} estaciones</div>
              <div style={{ fontSize: 12 }}>del listado de la izquierda para comparar</div>
            </div>
          ) : (
            <>
              {commonFreeWindows.length > 0 && (
                <div style={{ background: "var(--color-background-primary)", border: "0.5px solid #639922", borderRadius: 12, padding: "14px 18px", marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "#3B6D11", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#639922", display: "inline-block" }} />
                    Ventanas comunes libres
                    <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", fontWeight: 400, marginLeft: 4 }}>
                      (todas las estaciones seleccionadas disponibles)
                    </span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {commonFreeWindows.map((w, i) => (
                      <div key={i} style={{
                        padding: "6px 12px", background: "#EAF3DE", color: "#3B6D11",
                        borderRadius: 6, fontSize: 12, fontWeight: 500
                      }}>
                        {fmtTime(w.start)} – {fmtTime(w.end)}
                        <span style={{ color: "#639922", marginLeft: 6, fontWeight: 400 }}>({fmtDuration(w.end - w.start)})</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12, padding: "16px 18px" }}>
                {comparisonData.map((cd, i) => (
                  <div key={cd.station} style={{ marginBottom: i < comparisonData.length - 1 ? 14 : 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                        <span style={{ fontSize: 14, fontWeight: 500 }}>{cd.station}</span>
                        <span style={{ fontSize: 11, color: "var(--color-text-tertiary)" }}>{cd.label}</span>
                      </div>
                      <div style={{ display: "flex", gap: 14, fontSize: 11 }}>
                        <span style={{ color: "var(--color-text-secondary)" }}>
                          <strong style={{ color: "var(--color-text-primary)", fontWeight: 500 }}>{cd.flightCount}</strong> vuelos
                        </span>
                        <span style={{ color: "#639922", fontWeight: 500 }}>{fmtDuration(cd.totalFree)} libre</span>
                      </div>
                    </div>
                    <TimelineBar busy={cd.busy} free={cd.free} />
                    {i === 0 && (
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "var(--color-text-tertiary)", marginTop: 2, padding: "0 1px" }}>
                        {["00", "03", "06", "09", "12", "15", "18", "21", "24"].map(h => <span key={h}>{h}:00</span>)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


function parseDayString(dayStr) {
  if (!dayStr) return null;
  const s = String(dayStr).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { year: +m[1], month: +m[2] - 1, day: +m[3] };
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return { year: +m[3], month: +m[1] - 1, day: +m[2] };
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (m) return { year: +m[3], month: +m[1] - 1, day: +m[2] };
  const d = new Date(s);
  if (!isNaN(d)) return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
  return null;
}

function StationFocusView({ data, selectedStation, selectedDay }) {
  if (!data) return null;
  const { results, days } = data;

  if (!selectedStation) {
    return (
      <div style={{
        padding: "60px 24px", textAlign: "center",
        background: "var(--color-background-secondary)", borderRadius: 16,
        border: "1px dashed var(--color-border-tertiary)"
      }}>
        <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 56, height: 56, borderRadius: "50%", background: "var(--color-background-primary)", marginBottom: 16, border: "0.5px solid var(--color-border-tertiary)" }}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--color-text-tertiary)" }}>
            <circle cx="11" cy="11" r="8"/>
            <line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
        </div>
        <div style={{ fontSize: 16, fontWeight: 500, color: "var(--color-text-primary)", marginBottom: 6 }}>
          Selecciona una estacion
        </div>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", maxWidth: 380, margin: "0 auto", lineHeight: 1.6 }}>
          Usa el buscador o el selector de arriba para elegir una estacion y ver su disponibilidad detallada.
        </div>
      </div>
    );
  }

  const analysis = useMemo(() => {
    const targetDays = selectedDay ? [selectedDay] : days;
    const entries = targetDays.map(d => results[`${selectedStation}|${d}`]).filter(Boolean);

    if (entries.length === 0) {
      return { noData: true, targetDays };
    }

    if (entries.length === 1) {
      const e = entries[0];
      const longestFree = e.free.reduce((max, f) => (f.end - f.start > (max ? max.end - max.start : 0) ? f : max), null);
      const peakEvents = [...e.events].sort((a, b) => a.time - b.time);

      let morning = 0, afternoon = 0, night = 0;
      for (const f of e.free) {
        const clip = (s, en) => Math.max(0, Math.min(f.end, en) - Math.max(f.start, s));
        morning += clip(360, 720);
        afternoon += clip(720, 1080);
        night += clip(1080, 1440);
      }

      return {
        mode: "day",
        day: targetDays[0],
        busy: e.busy,
        free: e.free,
        events: peakEvents,
        totalFree: e.totalFree,
        longestFree,
        flightCount: e.flightCount,
        morning, afternoon, night
      };
    }

    const busyMinutes = new Array(1440).fill(0);
    let totalFlights = 0;
    for (const e of entries) {
      totalFlights += e.flightCount;
      for (const b of e.busy) {
        for (let m = b.start; m < b.end; m++) busyMinutes[m]++;
      }
    }
    const threshold = entries.length / 2;
    const avgBusy = [];
    let curStart = null;
    for (let m = 0; m < 1440; m++) {
      if (busyMinutes[m] >= threshold) {
        if (curStart === null) curStart = m;
      } else {
        if (curStart !== null) { avgBusy.push({ start: curStart, end: m }); curStart = null; }
      }
    }
    if (curStart !== null) avgBusy.push({ start: curStart, end: 1440 });

    const avgFree = [];
    let cursor = 0;
    for (const b of avgBusy) {
      if (b.start > cursor) avgFree.push({ start: cursor, end: b.start });
      cursor = b.end;
    }
    if (cursor < 1440) avgFree.push({ start: cursor, end: 1440 });
    const totalFree = avgFree.reduce((s, f) => s + (f.end - f.start), 0);
    const longestFree = avgFree.reduce((max, f) => (f.end - f.start > (max ? max.end - max.start : 0) ? f : max), null);

    let morning = 0, afternoon = 0, night = 0;
    for (const f of avgFree) {
      const clip = (s, en) => Math.max(0, Math.min(f.end, en) - Math.max(f.start, s));
      morning += clip(360, 720);
      afternoon += clip(720, 1080);
      night += clip(1080, 1440);
    }

    return {
      mode: "range",
      daysCount: entries.length,
      busy: avgBusy,
      free: avgFree,
      totalFree,
      longestFree,
      flightCount: Math.round(totalFlights / entries.length),
      morning, afternoon, night
    };
  }, [selectedStation, selectedDay, days, results]);

  if (analysis.noData) {
    return (
      <div style={{
        padding: "48px 24px", textAlign: "center",
        background: "var(--color-background-secondary)", borderRadius: 16
      }}>
        <div style={{ fontSize: 15, fontWeight: 500, color: "var(--color-text-primary)", marginBottom: 6 }}>
          Sin datos para {selectedStation}
        </div>
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
          {selectedDay ? `No hay vuelos registrados el ${selectedDay}` : "Esta estacion no tiene vuelos registrados"}
        </div>
      </div>
    );
  }

  const { mode, day, daysCount, busy, free, events, totalFree, longestFree, flightCount, morning, afternoon, night } = analysis;

  const topWindows = [...free].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 6);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
        <h2 style={{ fontSize: 22, fontWeight: 500, color: "var(--color-text-primary)", letterSpacing: "-0.02em", margin: 0 }}>
          Estacion {selectedStation}
        </h2>
        <span style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
          {mode === "day" ? day : `promedio de ${daysCount} dias`}
        </span>
      </div>
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 20 }}>
        {flightCount} vuelo{flightCount !== 1 ? "s" : ""} {mode === "day" ? "el dia seleccionado" : "en promedio por dia"} · disponibilidad total de <strong style={{ color: "#639922", fontWeight: 500 }}>{fmtDuration(totalFree)}</strong>
      </div>

      <div style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#639922", display: "inline-block" }} />
          <span style={{ fontSize: 14, fontWeight: 500, color: "#3B6D11" }}>Ventanas disponibles</span>
          <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginLeft: 4 }}>
            {mode === "day" ? "(libres de operaciones)" : "(promedio del periodo)"}
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {topWindows.map((w, i) => {
            const dur = w.end - w.start;
            const isLongest = longestFree && w.start === longestFree.start && w.end === longestFree.end;
            return (
              <div key={i} style={{
                padding: "10px 16px",
                background: isLongest ? "#C0DD97" : "#EAF3DE",
                border: isLongest ? "1px solid #639922" : "0.5px solid #C0DD97",
                borderRadius: 10,
                color: "#27500A",
                fontSize: 13,
                fontWeight: 500,
                display: "flex",
                flexDirection: "column",
                gap: 2,
                minWidth: 140
              }}>
                <div>{fmtTime(w.start)} – {fmtTime(w.end)}</div>
                <div style={{ fontSize: 11, color: "#3B6D11", fontWeight: 400 }}>
                  {fmtDuration(dur)}{isLongest ? " · ventana mas larga" : ""}
                </div>
              </div>
            );
          })}
          {topWindows.length === 0 && (
            <div style={{ fontSize: 13, color: "var(--color-text-tertiary)", fontStyle: "italic", padding: "8px 0" }}>
              Esta estacion no tiene ventanas libres en el periodo seleccionado.
            </div>
          )}
        </div>
      </div>

      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 8 }}>
          Linea de tiempo del dia
        </div>
        <TimelineBar busy={busy} free={free} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 4, padding: "0 1px" }}>
          {["00:00", "03:00", "06:00", "09:00", "12:00", "15:00", "18:00", "21:00", "24:00"].map(h => <span key={h}>{h}</span>)}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10, marginBottom: 18 }}>
        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Manana</div>
          <div style={{ fontSize: 16, fontWeight: 500, color: "var(--color-text-primary)" }}>{fmtDuration(Math.round(morning))}</div>
          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>06:00 – 12:00</div>
        </div>
        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Tarde</div>
          <div style={{ fontSize: 16, fontWeight: 500, color: "var(--color-text-primary)" }}>{fmtDuration(Math.round(afternoon))}</div>
          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>12:00 – 18:00</div>
        </div>
        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Noche</div>
          <div style={{ fontSize: 16, fontWeight: 500, color: "var(--color-text-primary)" }}>{fmtDuration(Math.round(night))}</div>
          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>18:00 – 24:00</div>
        </div>
        <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 10, padding: "12px 14px" }}>
          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 4 }}>Ventana mas larga</div>
          <div style={{ fontSize: 16, fontWeight: 500, color: "#639922" }}>{longestFree ? fmtDuration(longestFree.end - longestFree.start) : "—"}</div>
          <div style={{ fontSize: 10, color: "var(--color-text-tertiary)", marginTop: 2 }}>
            {longestFree ? `${fmtTime(longestFree.start)} – ${fmtTime(longestFree.end)}` : "sin datos"}
          </div>
        </div>
      </div>

      {mode === "day" && events && events.length > 0 && (
        <details style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: 12 }}>
          <summary style={{
            padding: "12px 18px", cursor: "pointer", fontSize: 13, fontWeight: 500,
            color: "var(--color-text-secondary)", display: "flex", alignItems: "center",
            justifyContent: "space-between", listStyle: "none", userSelect: "none"
          }}>
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transition: "transform 0.2s" }} className="chevron">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
              Vuelos del dia
            </span>
            <span style={{ fontSize: 11, color: "var(--color-text-tertiary)", fontWeight: 400 }}>
              {events.length} vuelo{events.length !== 1 ? "s" : ""}
            </span>
          </summary>
          <div style={{ padding: "4px 18px 14px", borderTop: "0.5px solid var(--color-border-tertiary)" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 8, paddingTop: 10 }}>
              {events.map((ev, i) => (
                <div key={i} style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                  <span style={{
                    fontSize: 9, fontWeight: 500, padding: "2px 6px", borderRadius: 4,
                    background: ev.type === "DEP" ? "#FCEBEB" : "#E1F5EE",
                    color: ev.type === "DEP" ? "#A32D2D" : "#0F6E56"
                  }}>
                    {ev.type === "DEP" ? "SAL" : "LLE"}
                  </span>
                  <span style={{ color: "var(--color-text-primary)", fontWeight: 500 }}>{fmtTime(ev.time)}</span>
                  <span style={{ color: "var(--color-text-tertiary)" }}>Flt {ev.flt}</span>
                </div>
              ))}
            </div>
          </div>
          <style>{`
            details[open] .chevron { transform: rotate(90deg); }
            summary::-webkit-details-marker { display: none; }
          `}</style>
        </details>
      )}
    </div>
  );
}

function CalendarPicker({ availableDays, selectedDay, onSelect }) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => {
    const first = availableDays[0] ? parseDayString(availableDays[0]) : null;
    if (first) return new Date(first.year, first.month, 1);
    return new Date();
  });
  const popoverRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const dayMap = useMemo(() => {
    const map = new Map();
    for (const d of availableDays) {
      const p = parseDayString(d);
      if (p) map.set(`${p.year}-${p.month}-${p.day}`, d);
    }
    return map;
  }, [availableDays]);

  const monthName = viewMonth.toLocaleDateString("es", { month: "long", year: "numeric" });
  const firstDay = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const lastDay = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0);
  const startWeekday = (firstDay.getDay() + 6) % 7;
  const daysInMonth = lastDay.getDate();

  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7 !== 0) cells.push(null);

  const selectedParsed = selectedDay ? parseDayString(selectedDay) : null;

  const prevMonth = () => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1));
  const nextMonth = () => setViewMonth(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1));

  const buttonLabel = selectedDay || "Seleccionar dia";

  return (
    <div style={{ position: "relative" }} ref={popoverRef}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          fontSize: 13, padding: "6px 12px", borderRadius: 8,
          border: "0.5px solid var(--color-border-tertiary)",
          background: selectedDay ? "var(--color-background-info)" : "var(--color-background-primary)",
          color: selectedDay ? "var(--color-text-info)" : "var(--color-text-primary)",
          cursor: "pointer", minWidth: 160, textAlign: "left",
          display: "flex", alignItems: "center", gap: 8
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span style={{ flex: 1 }}>{buttonLabel}</span>
        {selectedDay && (
          <span
            onClick={(e) => { e.stopPropagation(); onSelect(""); }}
            style={{ color: "var(--color-text-tertiary)", fontSize: 16, lineHeight: 1, padding: "0 2px" }}
            title="Limpiar"
          >×</span>
        )}
      </button>

      {open && (
        <div style={{
          position: "absolute", top: "100%", left: 0, marginTop: 6, zIndex: 100,
          background: "var(--color-background-primary)",
          border: "0.5px solid var(--color-border-secondary)",
          borderRadius: 12, padding: 12, minWidth: 280,
          boxShadow: "0 4px 16px rgba(0,0,0,0.12)"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <button onClick={prevMonth} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: "4px 8px", borderRadius: 4, fontSize: 16 }}>‹</button>
            <span style={{ fontSize: 13, fontWeight: 500, textTransform: "capitalize", color: "var(--color-text-primary)" }}>{monthName}</span>
            <button onClick={nextMonth} style={{ background: "transparent", border: "none", cursor: "pointer", color: "var(--color-text-secondary)", padding: "4px 8px", borderRadius: 4, fontSize: 16 }}>›</button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 4 }}>
            {["L", "M", "M", "J", "V", "S", "D"].map((d, i) => (
              <div key={i} style={{ fontSize: 10, fontWeight: 500, color: "var(--color-text-tertiary)", textAlign: "center", padding: "4px 0" }}>{d}</div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
            {cells.map((d, i) => {
              if (d === null) return <div key={i} />;
              const key = `${viewMonth.getFullYear()}-${viewMonth.getMonth()}-${d}`;
              const dayValue = dayMap.get(key);
              const hasData = !!dayValue;
              const isSelected = selectedParsed && selectedParsed.year === viewMonth.getFullYear() && selectedParsed.month === viewMonth.getMonth() && selectedParsed.day === d;
              return (
                <button
                  key={i}
                  disabled={!hasData}
                  onClick={() => { if (hasData) { onSelect(dayValue); setOpen(false); } }}
                  style={{
                    fontSize: 12, padding: "8px 0", borderRadius: 6,
                    border: "none", cursor: hasData ? "pointer" : "default",
                    background: isSelected ? "#185FA5" : hasData ? "var(--color-background-info)" : "transparent",
                    color: isSelected ? "#fff" : hasData ? "var(--color-text-info)" : "var(--color-text-tertiary)",
                    fontWeight: hasData ? 500 : 400,
                    opacity: hasData ? 1 : 0.4,
                    position: "relative"
                  }}
                  title={hasData ? `Ver ${dayValue}` : "Sin datos"}
                >
                  {d}
                </button>
              );
            })}
          </div>

          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "0.5px solid var(--color-border-tertiary)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: "var(--color-background-info)", display: "inline-block" }} />
              Con datos
            </div>
            <button
              onClick={() => { onSelect(""); setOpen(false); }}
              style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "0.5px solid var(--color-border-tertiary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}
            >
              Todos los dias
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [view, setView] = useState("station");
  const [selectedStation, setSelectedStation] = useState("");
  const [selectedDay, setSelectedDay] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [detailEntry, setDetailEntry] = useState(null);
  const [savedFiles, setSavedFiles] = useState([]);
  const [currentFileName, setCurrentFileName] = useState("");
  const [compareStations, setCompareStations] = useState([]);
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);
  const searchBarRef = useRef(null);
  const fileRef = useRef();

  const refreshSavedFiles = useCallback(async () => {
    try {
      const files = await getAllFilesFromDB();
      setSavedFiles(files);
    } catch (e) {
      console.error("Error cargando archivos:", e);
    }
  }, []);

  useEffect(() => {
    refreshSavedFiles();
  }, [refreshSavedFiles]);

  useEffect(() => {
    if (!showSearchDropdown) return;
    const onClickOutside = (e) => {
      if (searchBarRef.current && !searchBarRef.current.contains(e.target)) {
        setShowSearchDropdown(false);
      }
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [showSearchDropdown]);

  const filteredStations = useMemo(() => {
    if (!data) return [];
    if (!searchTerm.trim()) return data.stations;
    const term = searchTerm.trim().toUpperCase();
    return data.stations.filter(s => s.includes(term));
  }, [data, searchTerm]);

  const handleFile = useCallback(async (file) => {
    setLoading(true);
    setError(null);
    setData(null);
    setDetailEntry(null);

    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws);

      if (rows.length === 0) {
        setError("El archivo no tiene datos.");
        setLoading(false);
        return;
      }

      const result = processData(rows);
      if (result.error) {
        setError(result.error);
      } else {
        setData(result);
        setCurrentFileName(file.name);
        setView("station");
        setCompareStations([]);
        try {
          await saveFileToDB(file.name, result, rows.length);
          await refreshSavedFiles();
        } catch (saveErr) {
          console.error("No se pudo guardar:", saveErr);
        }
      }
    } catch (e) {
      setError(`Error al procesar: ${e.message}`);
    }
    setLoading(false);
  }, [refreshSavedFiles]);

  const handleLoadSaved = useCallback(async (id) => {
    setLoading(true);
    setError(null);
    try {
      const file = await getFileFromDB(id);
      if (file) {
        setData(file.processedData);
        setCurrentFileName(file.name);
        setDetailEntry(null);
        setView("station");
        setCompareStations([]);
      }
    } catch (e) {
      setError(`Error al cargar archivo guardado: ${e.message}`);
    }
    setLoading(false);
  }, []);

  const handleDeleteSaved = useCallback(async (id, name, e) => {
    e.stopPropagation();
    if (!confirm(`Eliminar "${name}" del historial?`)) return;
    try {
      await deleteFileFromDB(id);
      await refreshSavedFiles();
    } catch (err) {
      setError(`Error al eliminar: ${err.message}`);
    }
  }, [refreshSavedFiles]);

  const handleToggleCompareStation = useCallback((sta) => {
    setCompareStations(prev => {
      if (prev.includes(sta)) return prev.filter(s => s !== sta);
      if (prev.length >= 10) return prev;
      return [...prev, sta];
    });
  }, []);

  const handleClearCompare = useCallback(() => setCompareStations([]), []);

  const handleOverviewSelectStation = useCallback((sta) => {
    setSelectedStation(sta);
    setView("heatmap");
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }, [handleFile]);

  return (
    <div style={{ fontFamily: "var(--font-sans)", maxWidth: 1000, margin: "0 auto", padding: "0.5rem 0" }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 500, color: "var(--color-text-primary)", letterSpacing: "-0.03em", marginBottom: 4 }}>
          Analisis de disponibilidad de estaciones
        </h1>
        <p style={{ fontSize: 14, color: "var(--color-text-secondary)", margin: 0 }}>
          Sube tu Excel con datos de vuelos para calcular ventanas de soporte disponibles por estacion.
        </p>
      </div>

      {!data && !loading && (
        <div
          onDrop={handleDrop}
          onDragOver={e => e.preventDefault()}
          onClick={() => fileRef.current?.click()}
          style={{
            border: "2px dashed var(--color-border-secondary)", borderRadius: 16, padding: "48px 24px",
            textAlign: "center", cursor: "pointer", background: "var(--color-background-secondary)",
            transition: "border-color 0.2s"
          }}
        >
          <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: "none" }}
            onChange={e => e.target.files[0] && handleFile(e.target.files[0])} />
          <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.3 }}>+</div>
          <div style={{ fontSize: 16, fontWeight: 500, color: "var(--color-text-primary)", marginBottom: 6 }}>
            Arrastra tu archivo Excel aqui
          </div>
          <div style={{ fontSize: 13, color: "var(--color-text-tertiary)" }}>
            o haz clic para seleccionar (.xlsx, .xls, .csv)
          </div>
          <div style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginTop: 16, maxWidth: 500, margin: "16px auto 0", lineHeight: 1.6 }}>
            Columnas requeridas: Day, Dept Sta, Arvl Sta, Dept Time, Arvl Time, Flt Num.
            La estacion se marca ocupada 1 hora antes y 1 hora despues de cada vuelo.
          </div>
        </div>
      )}

      {!data && !loading && savedFiles.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Archivos guardados ({savedFiles.length})
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 12 }}>
            {savedFiles.map(file => (
              <div key={file.id}
                onClick={() => handleLoadSaved(file.id)}
                style={{
                  background: "var(--color-background-primary)",
                  border: "0.5px solid var(--color-border-tertiary)",
                  borderRadius: 12, padding: "14px 16px", cursor: "pointer",
                  transition: "all 0.15s", position: "relative"
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--color-border-secondary)"; e.currentTarget.style.background = "var(--color-background-secondary)"; }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--color-border-tertiary)"; e.currentTarget.style.background = "var(--color-background-primary)"; }}
              >
                <button
                  onClick={(e) => handleDeleteSaved(file.id, file.name, e)}
                  style={{
                    position: "absolute", top: 8, right: 8, background: "transparent",
                    border: "none", cursor: "pointer", color: "var(--color-text-tertiary)",
                    fontSize: 18, padding: "2px 8px", borderRadius: 4, lineHeight: 1
                  }}
                  title="Eliminar"
                  onMouseEnter={e => e.currentTarget.style.color = "#E24B4A"}
                  onMouseLeave={e => e.currentTarget.style.color = "var(--color-text-tertiary)"}
                >×</button>
                <div style={{ fontSize: 14, fontWeight: 500, color: "var(--color-text-primary)", marginBottom: 6, paddingRight: 24, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={file.name}>
                  {file.name}
                </div>
                <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginBottom: 8 }}>
                  {fmtRelativeDate(file.uploadedAt)}
                </div>
                <div style={{ display: "flex", gap: 12, fontSize: 11, color: "var(--color-text-secondary)" }}>
                  <span><strong style={{ color: "var(--color-text-primary)", fontWeight: 500 }}>{file.rowCount?.toLocaleString() || "?"}</strong> registros</span>
                  <span><strong style={{ color: "var(--color-text-primary)", fontWeight: 500 }}>{file.stationCount}</strong> estaciones</span>
                  <span><strong style={{ color: "var(--color-text-primary)", fontWeight: 500 }}>{file.dayCount}</strong> dias</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 12, textAlign: "center" }}>
            Los archivos se guardan localmente en tu navegador. Nunca salen de tu computadora.
          </div>
        </div>
      )}

      {loading && (
        <div style={{ textAlign: "center", padding: 48 }}>
          <div style={{ fontSize: 16, color: "var(--color-text-secondary)" }}>Procesando datos...</div>
          <div style={{ fontSize: 13, color: "var(--color-text-tertiary)", marginTop: 8 }}>Calculando ventanas de disponibilidad para todas las estaciones</div>
        </div>
      )}

      {error && (
        <div style={{ background: "var(--color-background-danger)", border: "0.5px solid var(--color-border-danger)", borderRadius: 8, padding: "12px 16px", color: "var(--color-text-danger)", fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {data && (
        <>
          {currentFileName && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, fontSize: 12, color: "var(--color-text-secondary)" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
              </svg>
              <span style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>{currentFileName}</span>
              <span style={{ color: "var(--color-text-tertiary)" }}>— guardado automaticamente</span>
            </div>
          )}
          {view !== "overview" && view !== "compare" && view !== "station" && <SummaryStats data={data} />}

          {view !== "overview" && view !== "compare" && (
          <div style={{ marginBottom: 12 }} ref={searchBarRef}>
            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <div style={{ position: "absolute", left: 14, display: "flex", alignItems: "center", color: "var(--color-text-tertiary)", pointerEvents: "none" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8"/>
                  <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
              </div>
              <input
                type="text"
                value={searchTerm}
                onChange={e => { setSearchTerm(e.target.value); setDetailEntry(null); setShowSearchDropdown(true); }}
                onFocus={() => setShowSearchDropdown(true)}
                placeholder="Buscar estacion (ej: PTY, DAV, MIA...)"
                style={{
                  width: "100%", fontSize: 14, lineHeight: "20px",
                  padding: "10px 38px 10px 38px", margin: 0,
                  borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)",
                  background: "var(--color-background-primary)", color: "var(--color-text-primary)",
                  outline: "none", boxSizing: "border-box", fontFamily: "inherit"
                }}
              />
              {searchTerm && (
                <button
                  onClick={() => { setSearchTerm(""); setShowSearchDropdown(false); }}
                  style={{
                    position: "absolute", right: 8, background: "transparent",
                    border: "none", cursor: "pointer", color: "var(--color-text-tertiary)",
                    fontSize: 20, padding: "4px 10px", lineHeight: 1, display: "flex",
                    alignItems: "center", justifyContent: "center"
                  }}
                  title="Limpiar busqueda"
                >×</button>
              )}

              {showSearchDropdown && searchTerm.trim() && (
                <div style={{
                  position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, zIndex: 50,
                  background: "var(--color-background-primary)",
                  border: "0.5px solid var(--color-border-secondary)",
                  borderRadius: 10, maxHeight: 320, overflowY: "auto",
                  boxShadow: "0 4px 16px rgba(0,0,0,0.1)"
                }}>
                  {filteredStations.length === 0 ? (
                    <div style={{ padding: "14px 16px", fontSize: 13, color: "var(--color-text-tertiary)", textAlign: "center" }}>
                      No se encontraron estaciones con "{searchTerm}"
                    </div>
                  ) : (
                    <>
                      <div style={{ padding: "8px 14px 4px", fontSize: 10, color: "var(--color-text-tertiary)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                        {filteredStations.length} coincidencia{filteredStations.length !== 1 ? "s" : ""}
                      </div>
                      {filteredStations.slice(0, 50).map(sta => {
                        const term = searchTerm.trim().toUpperCase();
                        const idx = sta.indexOf(term);
                        const before = sta.slice(0, idx);
                        const match = sta.slice(idx, idx + term.length);
                        const after = sta.slice(idx + term.length);
                        const isSelected = selectedStation === sta;
                        return (
                          <div
                            key={sta}
                            onClick={() => {
                              setSelectedStation(sta);
                              setSearchTerm("");
                              setShowSearchDropdown(false);
                              setDetailEntry(null);
                            }}
                            style={{
                              padding: "10px 16px", cursor: "pointer", fontSize: 14,
                              borderTop: "0.5px solid var(--color-border-tertiary)",
                              background: isSelected ? "var(--color-background-info)" : "transparent",
                              display: "flex", alignItems: "center", gap: 10,
                              transition: "background 0.1s"
                            }}
                            onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "var(--color-background-secondary)"; }}
                            onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }}>
                              <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>
                            </svg>
                            <span style={{ fontWeight: 500, color: "var(--color-text-primary)" }}>
                              {before}
                              <span style={{ background: "#FAC775", color: "#633806", padding: "0 2px", borderRadius: 2 }}>{match}</span>
                              {after}
                            </span>
                            {isSelected && (
                              <span style={{ marginLeft: "auto", fontSize: 10, color: "var(--color-text-info)", fontWeight: 500 }}>SELECCIONADA</span>
                            )}
                          </div>
                        );
                      })}
                      {filteredStations.length > 50 && (
                        <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--color-text-tertiary)", borderTop: "0.5px solid var(--color-border-tertiary)", textAlign: "center" }}>
                          Mostrando 50 de {filteredStations.length}. Afina tu busqueda.
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
          )}

          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
            {view !== "overview" && view !== "compare" && (
              <>
                <select value={selectedStation} onChange={e => { setSelectedStation(e.target.value); setDetailEntry(null); }}
                  style={{ fontSize: 13, padding: "6px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", minWidth: 120 }}>
                  <option value="">Todas las estaciones ({filteredStations.length})</option>
                  {filteredStations.map(s => <option key={s} value={s}>{s}</option>)}
                </select>

                <CalendarPicker
                  availableDays={data.days}
                  selectedDay={selectedDay}
                  onSelect={(d) => { setSelectedDay(d); setDetailEntry(null); }}
                />
              </>
            )}

            <div style={{ flex: 1 }} />

            <div style={{ display: "flex", gap: 4, background: "var(--color-background-secondary)", borderRadius: 8, padding: 3, flexWrap: "wrap" }}>
              {[
                { id: "station", label: "Estacion" },
                { id: "overview", label: "Resumen" },
                { id: "compare", label: "Comparar" },
                { id: "heatmap", label: "Mapa de calor" },
                { id: "hourly", label: "Hora por hora" },
                { id: "list", label: "Lista" }
              ].map(v => (
                <button key={v.id} onClick={() => setView(v.id)} style={{
                  fontSize: 12, padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer",
                  background: view === v.id ? "var(--color-background-primary)" : "transparent",
                  color: view === v.id ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                  fontWeight: view === v.id ? 500 : 400, boxShadow: view === v.id ? "0 0.5px 2px rgba(0,0,0,0.08)" : "none"
                }}>{v.label}</button>
              ))}
            </div>

            <button onClick={() => { setData(null); setSelectedStation(""); setSelectedDay(""); setSearchTerm(""); setDetailEntry(null); setError(null); setCurrentFileName(""); setCompareStations([]); setView("station"); }}
              style={{ fontSize: 12, padding: "5px 14px", borderRadius: 6, border: "0.5px solid var(--color-border-tertiary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}>
              Cargar otro archivo
            </button>
          </div>

          {detailEntry && <StationDetail data={detailEntry} />}

          {view === "station" && (
            <StationFocusView
              data={data}
              selectedStation={selectedStation}
              selectedDay={selectedDay}
            />
          )}
          {view === "overview" && (
            <OverviewView
              data={data}
              onNavigate={(v) => setView(v)}
              onSelectStation={handleOverviewSelectStation}
            />
          )}
          {view === "compare" && (
            <CompareView
              data={data}
              selectedStations={compareStations}
              onToggleStation={handleToggleCompareStation}
              onClearSelection={handleClearCompare}
              selectedDay={selectedDay}
              onDaySelect={setSelectedDay}
            />
          )}
          {view === "heatmap" && (
            <HeatmapView data={{ ...data, results: data.results, stations: selectedStation ? [selectedStation] : filteredStations, days: selectedDay ? [selectedDay] : data.days }}
              onSelect={setDetailEntry} />
          )}
          {view === "hourly" && (
            <HourlyView data={{ ...data, stations: filteredStations }} selectedStation={selectedStation} selectedDay={selectedDay} />
          )}
          {view === "list" && (
            <StationListView data={{ ...data, stations: filteredStations }} selectedStation={selectedStation} selectedDay={selectedDay} onSelect={setDetailEntry} />
          )}

          <div style={{ marginTop: 24, padding: "16px 20px", background: "var(--color-background-secondary)", borderRadius: 12, fontSize: 12, color: "var(--color-text-tertiary)", lineHeight: 1.7 }}>
            <strong style={{ color: "var(--color-text-secondary)" }}>Como leer los resultados:</strong> Cada estacion se marca como ocupada desde 1 hora antes hasta 1 hora despues de cada vuelo (salida o llegada). Las ventanas verdes en la linea de tiempo son los periodos donde puedes hacer soporte a los equipos sin interferir con operaciones de vuelo. Haz clic en cualquier celda o fila para ver el detalle completo.
          </div>
        </>
      )}
    </div>
  );
}