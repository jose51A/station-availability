import { useState, useMemo, useCallback, useRef } from "react";
import * as XLSX from "xlsx";

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
  const arvlTimeCol = find(["arvltime", "arrtime", "arrivaltime"]);
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

export default function App() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [view, setView] = useState("heatmap");
  const [selectedStation, setSelectedStation] = useState("");
  const [selectedDay, setSelectedDay] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [detailEntry, setDetailEntry] = useState(null);
  const fileRef = useRef();

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
      }
    } catch (e) {
      setError(`Error al procesar: ${e.message}`);
    }
    setLoading(false);
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
          <SummaryStats data={data} />

          <div style={{ position: "relative", marginBottom: 12 }}>
            <input
              type="text"
              value={searchTerm}
              onChange={e => { setSearchTerm(e.target.value); setDetailEntry(null); }}
              placeholder="Buscar estacion (ej: PTY, DAV, MIA...)"
              style={{
                width: "100%", fontSize: 14, padding: "10px 14px 10px 38px",
                borderRadius: 10, border: "0.5px solid var(--color-border-tertiary)",
                background: "var(--color-background-primary)", color: "var(--color-text-primary)",
                outline: "none", boxSizing: "border-box"
              }}
            />
            <div style={{ position: "absolute", left: 14, top: "50%", transform: "translateY(-50%)", color: "var(--color-text-tertiary)", pointerEvents: "none" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </div>
            {searchTerm && (
              <button
                onClick={() => setSearchTerm("")}
                style={{
                  position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                  background: "transparent", border: "none", cursor: "pointer",
                  color: "var(--color-text-tertiary)", fontSize: 18, padding: "4px 8px"
                }}
                title="Limpiar busqueda"
              >×</button>
            )}
            {searchTerm && (
              <div style={{ fontSize: 11, color: "var(--color-text-tertiary)", marginTop: 6, marginLeft: 4 }}>
                {filteredStations.length} estacion{filteredStations.length !== 1 ? "es" : ""} coinciden con "{searchTerm}"
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
            <select value={selectedStation} onChange={e => { setSelectedStation(e.target.value); setDetailEntry(null); }}
              style={{ fontSize: 13, padding: "6px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", minWidth: 120 }}>
              <option value="">Todas las estaciones ({filteredStations.length})</option>
              {filteredStations.map(s => <option key={s} value={s}>{s}</option>)}
            </select>

            <select value={selectedDay} onChange={e => { setSelectedDay(e.target.value); setDetailEntry(null); }}
              style={{ fontSize: 13, padding: "6px 12px", borderRadius: 8, border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", minWidth: 140 }}>
              <option value="">Todos los dias</option>
              {data.days.map(d => <option key={d} value={d}>{d}</option>)}
            </select>

            <div style={{ flex: 1 }} />

            <div style={{ display: "flex", gap: 4, background: "var(--color-background-secondary)", borderRadius: 8, padding: 3 }}>
              {[{ id: "heatmap", label: "Mapa de calor" }, { id: "hourly", label: "Hora por hora" }, { id: "list", label: "Lista" }].map(v => (
                <button key={v.id} onClick={() => setView(v.id)} style={{
                  fontSize: 12, padding: "5px 14px", borderRadius: 6, border: "none", cursor: "pointer",
                  background: view === v.id ? "var(--color-background-primary)" : "transparent",
                  color: view === v.id ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                  fontWeight: view === v.id ? 500 : 400, boxShadow: view === v.id ? "0 0.5px 2px rgba(0,0,0,0.08)" : "none"
                }}>{v.label}</button>
              ))}
            </div>

            <button onClick={() => { setData(null); setSelectedStation(""); setSelectedDay(""); setSearchTerm(""); setDetailEntry(null); setError(null); }}
              style={{ fontSize: 12, padding: "5px 14px", borderRadius: 6, border: "0.5px solid var(--color-border-tertiary)", background: "transparent", color: "var(--color-text-secondary)", cursor: "pointer" }}>
              Cargar otro archivo
            </button>
          </div>

          {detailEntry && <StationDetail data={detailEntry} />}

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