"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const REQUIRED = ["component_id", "lot_id", "time_hr"];
const MEASUREMENTS = ["leakagecurrentua", "iddqua", "onresistanceohm"];
const MEASUREMENT_NAMES = {
  leakagecurrentua: "Leakage current (µA)",
  iddqua: "IDDQ (µA)",
  onresistanceohm: "ON resistance (Ω)",
};
const PAGE_COPY = {
  overview: { label: "Overview", eyebrow: "PREDICTIVE SCREENING · 168 HOUR OUTLOOK", title: "Burn-in analytics", description: "Review component degradation, compare lot populations, and prioritize early investigation." },
  "lot-analysis": { label: "Lot analysis", eyebrow: "BATCH CONTEXT", title: "Lot analysis", description: "Compare lot-level risk and find shared degradation patterns across manufacturing batches." },
  components: { label: "Components", eyebrow: "COMPONENT REVIEW", title: "Component screening", description: "Review early drift, population deviation, 168-hour estimates, and component-level risk." },
  method: { label: "Method", eyebrow: "INTEGRATED PIPELINE", title: "PhyMamba-XGB method", description: "See how temporal signals, physics context, risk fusion, and lot review fit together." },
};

function keyOf(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseCsv(text) {
  const lines = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell); cell = "";
      if (row.some((value) => value.trim())) lines.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value.trim())) lines.push(row);
  if (lines.length < 2) throw new Error("The CSV has no measurement rows.");
  const headers = lines[0].map((value) => value.trim().replace(/^\uFEFF/, ""));
  const index = Object.fromEntries(headers.map((header, i) => [keyOf(header), i]));
  const missing = REQUIRED.filter((name) => index[keyOf(name)] === undefined);
  if (missing.length) throw new Error(`Missing required column${missing.length > 1 ? "s" : ""}: ${missing.map((name) => ({ component_id: "Component_ID", lot_id: "Lot_ID", time_hr: "Time_hr" })[name]).join(", ")}.`);
  const measurements = headers.filter((header) => MEASUREMENTS.includes(keyOf(header)));
  if (!measurements.length) throw new Error("Include at least one supported measurement column: Leakage_Current_uA, IDDQ_uA, or ON_Resistance_Ohm.");
  const rows = lines.slice(1).map((cells, i) => {
    const get = (name) => (index[keyOf(name)] === undefined ? "" : cells[index[keyOf(name)]]?.trim() ?? "");
    const numeric = (field) => {
      const raw = get(field);
      return raw === "" ? Number.NaN : Number(raw);
    };
    const out = {
      component: get("Component_ID"), lot: get("Lot_ID"), family: get("Component_Family") || "Unspecified",
      time: numeric("Time_hr"), temperature: numeric("Temperature_C"), voltage: numeric("Voltage_V"),
      sourceRow: i + 2,
    };
    for (const header of measurements) {
      const raw = cells[index[keyOf(header)]]?.trim() ?? "";
      out[keyOf(header)] = raw === "" ? Number.NaN : Number(raw);
    }
    return out;
  }).filter((item) => item.component && item.lot && Number.isFinite(item.time));
  if (!rows.length) throw new Error("No usable rows found. Check Component_ID, Lot_ID, and Time_hr values.");
  return { rows, measurements };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustZ(value, peers) {
  const center = median(peers);
  const mad = median(peers.map((item) => Math.abs(item - center))) * 1.4826;
  const spread = mad || Math.max(Math.abs(center) * 0.05, 1e-6);
  return (value - center) / spread;
}

function bounded(value, min = 0, max = 1) { return Math.max(min, Math.min(max, value)); }
function riskBand(score) { return score >= 65 ? "Alert" : score >= 38 ? "Monitor" : "Normal"; }
function formatNumber(value, places = 2) {
  return Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: places, minimumFractionDigits: 0 }) : "—";
}

function analyze(rows, signal) {
  const groups = new Map();
  rows.forEach((row) => {
    const value = row[signal];
    if (!Number.isFinite(value)) return;
    const id = row.component;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  });
  const items = [...groups.entries()].map(([id, records]) => {
    records.sort((a, b) => a.time - b.time);
    const lot = records[0].lot;
    const family = records[0].family;
    const usable = records.filter((row) => row.lot === lot);
    const points = usable.map((row) => ({ time: row.time, value: row[signal], temperature: row.temperature })).filter((point) => Number.isFinite(point.value));
    const early = points.filter((point) => point.time <= 24);
    const first = early[0] || points[0];
    const lastEarly = early[early.length - 1] || points[Math.min(1, points.length - 1)] || first;
    const latest = points[points.length - 1];
    const elapsed = Math.max(1, lastEarly.time - first.time);
    const slope = (lastEarly.value - first.value) / elapsed;
    const temp = [first.temperature, lastEarly.temperature].filter(Number.isFinite);
    const meanTemp = temp.length ? temp.reduce((a, b) => a + b, 0) / temp.length : 125;
    const kelvin = meanTemp + 273.15;
    const accel = bounded(Math.exp((0.7 / 8.617e-5) * (1 / 398.15 - 1 / kelvin)), 0.5, 2.5);
    const forecast = lastEarly.value + slope * (168 - lastEarly.time) * accel;
    return { id, lot, family, points, first: first.value, early: lastEarly.value, latest: latest.value, latestTime: latest.time, slope, accel, forecast, count: points.length };
  }).filter((item) => item.points.length);

  const byFamily = (item) => items.filter((peer) => peer.family === item.family && peer.id !== item.id);
  for (const item of items) {
    const peers = byFamily(item);
    const peerSet = peers.length >= 4 ? peers : items.filter((peer) => peer.id !== item.id);
    const peerSlope = peerSet.map((peer) => peer.slope * peer.accel);
    const peerLatest = peerSet.map((peer) => peer.latest);
    const peerForecast = peerSet.map((peer) => peer.forecast);
    item.driftZ = robustZ(item.slope * item.accel, peerSlope);
    item.populationZ = robustZ(item.latest, peerLatest);
    item.forecastZ = robustZ(item.forecast, peerForecast);
    item.temporal = bounded((Math.abs(item.driftZ) - 1) / 4);
    item.population = bounded((Math.abs(item.populationZ) - 1) / 4);
    item.physics = bounded((Math.abs(item.driftZ) - 1) / 4 + Math.max(0, 1 - item.accel) * 0.1);
    item.future = bounded((Math.abs(item.forecastZ) - 1) / 4);
    item.risk = Math.round(100 * (0.36 * item.temporal + 0.28 * item.population + 0.20 * item.physics + 0.16 * item.future));
    item.status = riskBand(item.risk);
    item.contributions = [
      { name: "Temporal drift vs peers", value: 36 * item.temporal },
      { name: "Population deviation", value: 28 * item.population },
      { name: "Temperature adjusted drift", value: 20 * item.physics },
      { name: "168 h forecast deviation", value: 16 * item.future },
    ].sort((a, b) => b.value - a.value);
  }
  return items.sort((a, b) => b.risk - a.risk);
}

function Icon({ name, size = 18 }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M20 16v4H4v-4"/></>,
    chart: <><path d="M4 19V5m0 14h16"/><path d="m7 15 4-4 3 2 5-6"/></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></>,
    arrow: <><path d="M5 12h14m-6-6 6 6-6 6"/></>,
    download: <><path d="M12 4v12m0 0 5-5m-5 5-5-5"/><path d="M4 20h16"/></>,
    check: <><path d="m5 12 4 4L19 6"/></>,
    alert: <><path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v4m0 3h.01"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    chip: <><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4m6-4v4m-6 12v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4"/></>,
  };
  return <svg {...common}>{paths[name] || paths.grid}</svg>;
}

function MiniTrend({ points, color = "#315e84", width = 116, height = 34 }) {
  if (!points?.length) return null;
  const values = points.map((point) => point.value);
  const low = Math.min(...values); const high = Math.max(...values); const range = high - low || 1;
  const coords = values.map((value, index) => `${(index / Math.max(1, values.length - 1)) * width},${height - 3 - ((value - low) / range) * (height - 7)}`).join(" ");
  return <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label="Measurement trend"><polyline points={coords} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />{points.length > 0 && <circle cx={(Math.max(0, points.length - 1) / Math.max(1, points.length - 1)) * width} cy={height - 3 - ((values[values.length - 1] - low) / range) * (height - 7)} r="2.5" fill={color} />}</svg>;
}

function RiskBadge({ status }) { return <span className={`risk-badge ${status.toLowerCase()}`}><span />{status}</span>; }

export default function Home() {
  const [rows, setRows] = useState([]);
  const [measurements, setMeasurements] = useState([]);
  const [selectedSignal, setSelectedSignal] = useState("leakagecurrentua");
  const [fileName, setFileName] = useState("PS170_synthetic_burnin_dataset.csv");
  const [sampleMode, setSampleMode] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All status");
  const [lotFilter, setLotFilter] = useState("All lots");
  const [selectedId, setSelectedId] = useState("");
  const [section, setSection] = useState("overview");
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);

  const ingest = (text, name, isSample = false) => {
    try {
      const parsed = parseCsv(text);
      setRows(parsed.rows); setMeasurements(parsed.measurements.map(keyOf));
      setFileName(name); setSampleMode(isSample); setError(""); setLotFilter("All lots"); setStatusFilter("All status");
      const defaultSignal = parsed.measurements.find((header) => keyOf(header) === selectedSignal) || parsed.measurements[0];
      setSelectedSignal(keyOf(defaultSignal));
      setSelectedId("");
    } catch (issue) { setError(issue.message || "Unable to read this CSV."); }
  };

  useEffect(() => {
    fetch("/data/PS170_synthetic_burnin_dataset.csv").then((response) => {
      if (!response.ok) throw new Error("Sample unavailable");
      return response.text();
    }).then((text) => ingest(text, "PS170_synthetic_burnin_dataset.csv", true)).catch(() => {});
    // The bundled sample makes the dashboard useful on first open; user uploads replace it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = useMemo(() => analyze(rows, selectedSignal), [rows, selectedSignal]);
  const lots = useMemo(() => [...new Set(items.map((item) => item.lot))].sort(), [items]);
  const selected = items.find((item) => item.id === selectedId) || items[0];
  const visible = items.filter((item) => (statusFilter === "All status" || item.status === statusFilter)
    && (lotFilter === "All lots" || item.lot === lotFilter)
    && `${item.id} ${item.lot} ${item.family}`.toLowerCase().includes(search.toLowerCase()));
  const alertCount = items.filter((item) => item.status === "Alert").length;
  const monitorCount = items.filter((item) => item.status === "Monitor").length;
  const lotSummary = lots.map((lot) => {
    const members = items.filter((item) => item.lot === lot);
    const alerts = members.filter((item) => item.status === "Alert").length;
    const monitors = members.filter((item) => item.status === "Monitor").length;
    const mean = members.reduce((sum, item) => sum + item.risk, 0) / Math.max(1, members.length);
    const flaggedPct = Math.round(100 * (alerts + monitors) / Math.max(1, members.length));
    return { lot, count: members.length, alerts, monitors, mean: Math.round(mean), flaggedPct, status: alerts >= 2 || mean >= 50 ? "Review" : alerts || monitors >= 2 ? "Monitor" : "Stable" };
  });

  const handleFile = async (file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) { setError("Choose a .csv file to analyze."); return; }
    ingest(await file.text(), file.name);
  };

  const exportResults = () => {
    if (!items.length) return;
    const columns = ["Component_ID", "Lot_ID", "Component_Family", "Risk_Score", "Status", `${MEASUREMENT_NAMES[selectedSignal] || selectedSignal} at latest`, "Predicted_168h", "Latest_Time_hr", "Population_Z", "Temperature_Adjusted_Drift_Z", "Explanation"];
    const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const output = [columns, ...items.map((item) => [item.id, item.lot, item.family, item.risk, item.status, item.latest, item.forecast, item.latestTime, item.populationZ.toFixed(2), item.driftZ.toFixed(2), item.contributions.slice(0, 2).map((factor) => factor.name).join("; ")])].map((line) => line.map(escape).join(",")).join("\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([output], { type: "text/csv;charset=utf-8" })); link.download = `${fileName.replace(/\.csv$/i, "")}_phymamba_screening.csv`; link.click(); URL.revokeObjectURL(link.href);
  };

  const moveTo = (target) => { setSection(target); window.scrollTo(0, 0); };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Icon name="chip" size={20} /></div><div><div className="brand-title">PHY<span>MAMBA</span></div><div className="brand-subtitle">XGB · BURN-IN ANALYTICS</div></div></div>
      <div className="workspace-tag">SCREENING WORKSPACE</div>
      <nav className="side-nav" aria-label="Dashboard sections">
        {[{ id: "overview", label: "Overview", icon: "grid" }, { id: "lot-analysis", label: "Lot analysis", icon: "layers" }, { id: "components", label: "Components", icon: "chip" }, { id: "method", label: "Method", icon: "chart" }].map((item) => <button className={section === item.id ? "nav-item active" : "nav-item"} aria-current={section === item.id ? "page" : undefined} key={item.id} onClick={() => moveTo(item.id)}><Icon name={item.icon} size={17} />{item.label}{item.id === "components" && <span className="nav-count">{items.length || "—"}</span>}</button>)}
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-status"><span className="online-dot" />Local analysis ready</div><div className="sidebar-note">PhyMamba-XGB<br />Decision support prototype</div></div>
    </aside>

    <main className="main-area" onDragOver={(event) => { if (event.dataTransfer?.types?.includes("Files")) { event.preventDefault(); setDragging(true); } }} onDragLeave={(event) => { if (event.target === event.currentTarget) setDragging(false); }}>
      <header className="topbar"><div className="breadcrumbs">Qualification <span>/</span> {PAGE_COPY[section].label}</div><div className="topbar-right"><span className="model-status"><span className="status-dot" /> Local scoring ready</span><div className="avatar">QA</div></div></header>
      <div className="content">
        <section className="page-heading"><div><div className="eyebrow">{PAGE_COPY[section].eyebrow}</div><h1>{PAGE_COPY[section].title}</h1><p>{PAGE_COPY[section].description}</p></div><button className="button button-secondary export-button" onClick={exportResults} disabled={!items.length}><Icon name="download" size={16} />Export results</button></section>

        <section className="dataset-strip" aria-label="Active dataset">
          <div className="file-emblem"><Icon name="layers" size={19} /></div><div className="dataset-copy"><div className="dataset-title">{fileName}<span className={sampleMode ? "sample-tag" : "uploaded-tag"}>{sampleMode ? "SAMPLE DATA" : "UPLOADED"}</span></div><div className="dataset-meta">{rows.length.toLocaleString()} measurements <span>·</span> {items.length.toLocaleString()} components <span>·</span> {lots.length} lots</div></div>
          <label className="signal-control"><span>Signal</span><select value={selectedSignal} onChange={(event) => setSelectedSignal(event.target.value)}>{measurements.map((signal) => <option key={signal} value={signal}>{MEASUREMENT_NAMES[signal] || signal}</option>)}</select></label>
          <button className="button button-primary" onClick={() => fileRef.current?.click()}><Icon name="upload" size={16} />Upload CSV</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => handleFile(event.target.files?.[0])} />
        </section>
        <div className={dragging ? "drop-overlay visible" : "drop-overlay"} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); handleFile(event.dataTransfer.files?.[0]); }}><div className="drop-box"><Icon name="upload" size={25} /><strong>Drop a CSV file to analyze</strong><span>Component_ID, Lot_ID, Time_hr, and one supported measurement column</span></div></div>
        {error && <div className="error-banner"><Icon name="alert" size={17} /><span>{error}</span><button aria-label="Dismiss" onClick={() => setError("")}><Icon name="close" size={16} /></button></div>}

        {section === "overview" && <section className="metric-grid" aria-label="Screening summary">
          <article className="metric-card"><div className="metric-top"><span>Components screened</span><span className="metric-icon blue"><Icon name="chip" size={17} /></span></div><div className="metric-value">{items.length.toLocaleString()}</div><div className="metric-foot">Across <b>{lots.length}</b> manufacturing lots</div></article>
          <article className="metric-card"><div className="metric-top"><span>Alert</span><span className="metric-icon red"><Icon name="alert" size={17} /></span></div><div className="metric-value">{alertCount.toLocaleString()}</div><div className="metric-foot"><span className="tiny-dot red-dot" />Requires engineering review</div></article>
          <article className="metric-card"><div className="metric-top"><span>Monitor</span><span className="metric-icon amber"><Icon name="chart" size={17} /></span></div><div className="metric-value">{monitorCount.toLocaleString()}</div><div className="metric-foot"><span className="tiny-dot amber-dot" />Watch trajectory progression</div></article>
          <article className="metric-card"><div className="metric-top"><span>Lots for review</span><span className="metric-icon slate"><Icon name="layers" size={17} /></span></div><div className="metric-value">{lotSummary.filter((lot) => lot.status === "Review").length.toLocaleString()}<small> / {lots.length}</small></div><div className="metric-foot">Population patterns aggregated by lot</div></article>
        </section>}

        {section === "overview" && <section className="overview-queue"><div className="section-heading"><div><div className="eyebrow">PRIORITY REVIEW</div><h2>Components needing attention</h2><p>Highest-risk components from the active dataset.</p></div><button className="text-button" onClick={() => moveTo("components")}>Open component review <Icon name="arrow" size={15} /></button></div><div className="queue-list">{items.filter((item) => item.status !== "Normal").slice(0, 4).map((item) => <button className="queue-row" key={item.id} onClick={() => { setSelectedId(item.id); moveTo("components"); }}><span className="queue-id">{item.id}<small>{item.lot} · {item.family}</small></span><span className="queue-score">{item.risk}<small>/100</small></span><RiskBadge status={item.status} /><Icon name="arrow" size={15} /></button>)}{items.length > 0 && !items.some((item) => item.status !== "Normal") && <div className="queue-empty"><span className="online-dot" />No components are currently in Alert or Monitor.</div>}{!items.length && <div className="queue-empty">Upload a dataset to populate the review queue.</div>}</div></section>}

        {section === "lot-analysis" && <section className="section-block"><div className="section-heading"><div><div className="eyebrow">BATCH CONTEXT</div><h2>Lot-level view</h2><p>Aggregate component risk to surface shared degradation patterns.</p></div><button className="text-button" onClick={() => moveTo("components")}>View components <Icon name="arrow" size={15} /></button></div>
          <div className="table-wrap lot-table-wrap"><table className="data-table lot-table"><thead><tr><th>Lot</th><th>Parts</th><th>Alert</th><th>Monitor</th><th>Flagged</th><th>Mean risk</th><th>Disposition</th></tr></thead><tbody>{lotSummary.length ? lotSummary.map((lot) => <tr key={lot.lot} onClick={() => { setLotFilter(lot.lot); moveTo("components"); }}><td><button className="lot-link" onClick={(event) => { event.stopPropagation(); setLotFilter(lot.lot); moveTo("components"); }}>{lot.lot}</button></td><td>{lot.count}</td><td><span className="count-alert">{lot.alerts}</span></td><td><span className="count-monitor">{lot.monitors}</span></td><td><div className="flagged-cell"><div className="progress-track"><i style={{ width: `${lot.flaggedPct}%` }} /></div><span>{lot.flaggedPct}%</span></div></td><td><div className="risk-number"><span className={lot.mean >= 65 ? "risk-high" : lot.mean >= 38 ? "risk-mid" : "risk-low"}>{lot.mean}</span><span className="out-of">/100</span></div></td><td><span className={`lot-state ${lot.status.toLowerCase()}`}><i />{lot.status}</span></td></tr>) : <tr><td className="empty-cell" colSpan="7">Upload burn-in measurements to build a lot summary.</td></tr>}</tbody></table></div>
        </section>}

        {section === "components" && <>
        <section className="section-block component-section"><div className="section-heading"><div><div className="eyebrow">COMPONENT REVIEW</div><h2>Component screening</h2><p>Risk combines early drift, temperature-adjusted behavior, peer deviation, and forecast context.</p></div><div className="filter-row"><label className="search-box"><Icon name="search" size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search ID or family" /></label><select className="filter-select" value={lotFilter} onChange={(event) => setLotFilter(event.target.value)}><option>All lots</option>{lots.map((lot) => <option key={lot}>{lot}</option>)}</select><select className="filter-select" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option>All status</option><option>Alert</option><option>Monitor</option><option>Normal</option></select></div></div>
          <div className="table-wrap"><table className="data-table component-table"><thead><tr><th>Component</th><th>Lot / family</th><th>Trend</th><th>Latest <small>({MEASUREMENT_NAMES[selectedSignal] || selectedSignal})</small></th><th>168 h estimate</th><th>Peer deviation</th><th>Risk</th><th>Status</th></tr></thead><tbody>{visible.length ? visible.slice(0, 100).map((item) => <tr className={selected?.id === item.id ? "selected-row" : ""} key={item.id} onClick={() => setSelectedId(item.id)}><td><button className="component-link" onClick={(event) => { event.stopPropagation(); setSelectedId(item.id); }}>{item.id}</button></td><td><div className="lot-family"><b>{item.lot}</b><span>{item.family}</span></div></td><td><MiniTrend points={item.points} color={item.status === "Alert" ? "#b54848" : item.status === "Monitor" ? "#a06c20" : "#476d89"} /></td><td className="numeric">{formatNumber(item.latest, 4)}</td><td className="numeric">{formatNumber(item.forecast, 4)}</td><td><span className={Math.abs(item.populationZ) >= 2 ? "deviation high" : "deviation"}>{item.populationZ > 0 ? "+" : ""}{formatNumber(item.populationZ, 1)}σ</span></td><td><div className="risk-number"><span className={item.risk >= 65 ? "risk-high" : item.risk >= 38 ? "risk-mid" : "risk-low"}>{item.risk}</span><span className="out-of">/100</span></div></td><td><RiskBadge status={item.status} /></td></tr>) : <tr><td className="empty-cell" colSpan="8">No components match these filters.</td></tr>}</tbody></table></div>
          {visible.length > 100 && <div className="table-caption">Showing the 100 highest-risk components out of {visible.length}. Export results to download the full screening output.</div>}
        </section>

        {selected && <section className="detail-grid" aria-label={`Explanation for ${selected.id}`}><article className="detail-card trend-card"><div className="card-heading"><div><div className="eyebrow">SELECTED COMPONENT</div><h3>{selected.id}<span className="heading-divider">·</span><span className="muted-heading">{selected.lot} / {selected.family}</span></h3></div><RiskBadge status={selected.status} /></div><div className="detail-stats"><div><span>Latest measurement</span><b>{formatNumber(selected.latest, 4)} <small>{selectedSignal.includes("ohm") ? "Ω" : "µA"}</small></b><em>at {selected.latestTime} h</em></div><div><span>168 h estimate</span><b>{formatNumber(selected.forecast, 4)} <small>{selectedSignal.includes("ohm") ? "Ω" : "µA"}</small></b><em>early trajectory extrapolation</em></div><div><span>Temperature factor</span><b>{formatNumber(selected.accel, 2)}<small>×</small></b><em>Arrhenius adjusted</em></div></div><div className="trend-chart"><div className="chart-labels"><span>{MEASUREMENT_NAMES[selectedSignal] || selectedSignal}</span><span>{selected.points[0]?.time} h — {selected.latestTime} h</span></div><MiniTrend points={selected.points} width={560} height={105} color="#315e84" /><div className="chart-axis"><span>{selected.points[0]?.time} h</span><span>Burn-in time</span><span>{selected.latestTime} h</span></div></div></article>
          <article className="detail-card explain-card"><div className="eyebrow">RISK CONTRIBUTIONS</div><h3>Why this component was flagged</h3><p className="explain-intro">Largest inputs to the prototype risk score. Values are normalized feature contributions, not SHAP outputs.</p><div className="contribution-list">{selected.contributions.map((factor) => <div className="contribution" key={factor.name}><div className="contribution-label"><span>{factor.name}</span><b>{Math.round(factor.value)}%</b></div><div className="contribution-track"><i style={{ width: `${bounded(factor.value / 36) * 100}%` }} /></div></div>)}</div><div className="peer-callout"><span>Peer deviation</span><b>{selected.populationZ > 0 ? "+" : ""}{formatNumber(selected.populationZ, 2)}σ</b><span>within {selected.family} peer context</span></div></article></section>}
        </>}

        {section === "method" && <section className="method-section"><div className="method-heading"><div><div className="eyebrow">INTEGRATED PIPELINE</div><h2>PhyMamba-XGB decision path</h2><p>Temporal features, physics-informed signals, and population context are combined for screening.</p></div><span className="prototype-badge">PROTOTYPE SCORING</span></div><div className="pipeline"><div className="pipeline-step"><span className="step-index">01</span><b>Temporal pattern</b><span>Early burn-in drift and trajectory shape</span><small>MAMBA-INSPIRED FEATURES</small></div><div className="pipeline-arrow"><Icon name="arrow" size={15} /></div><div className="pipeline-step"><span className="step-index">02</span><b>Physics context</b><span>Temperature-adjusted degradation rate</span><small>ARRHENIUS / PINN-INSPIRED</small></div><div className="pipeline-arrow"><Icon name="arrow" size={15} /></div><div className="pipeline-step"><span className="step-index">03</span><b>Risk & forecast</b><span>Peer-aware risk tier and 168 h estimate</span><small>BOOSTED-STYLE FUSION</small></div><div className="pipeline-arrow"><Icon name="arrow" size={15} /></div><div className="pipeline-step"><span className="step-index">04</span><b>Lot review</b><span>Aggregate alerts for shared patterns</span><small>ENGINEERING EXPLANATION</small></div></div><div className="method-note"><Icon name="alert" size={16} /><p><b>Validation note</b> This dashboard currently uses transparent browser-side scoring rules inspired by the proposed architecture. It does not run trained Mamba, PINN, XGBoost, or SHAP models. Risk tiers are for prototype review and should be calibrated against validated models and engineering limits before operational use.</p></div></section>}
        <footer className="footer"><span>PhyMamba-XGB <span className="footer-dot">·</span> Burn-in screening workspace</span><span>Local CSV processing <span className="footer-dot">·</span> No upload to a server</span></footer>
      </div>
    </main>
  </div>;
}
