import { useEffect, useState } from "react";
import Overview from "./tabs/Overview";
import PinSightChain from "./tabs/PinSightChain";
import PinSightFlags from "./tabs/PinSightFlags";
import DriftEdgeMarkets from "./tabs/DriftEdgeMarkets";
import DriftEdgeBooks from "./tabs/DriftEdgeBooks";
import Logs from "./tabs/Logs";

type TabId =
  | "overview"
  | "ps-chain"
  | "ps-flags"
  | "de-markets"
  | "de-books"
  | "logs";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview",   label: "OVERVIEW" },
  { id: "ps-chain",   label: "PINSIGHT · CHAIN" },
  { id: "ps-flags",   label: "PINSIGHT · FLAGS" },
  { id: "de-markets", label: "DRIFTEDGE · MARKETS" },
  { id: "de-books",   label: "DRIFTEDGE · BOOKS" },
  { id: "logs",       label: "LOGS" },
];

export default function App() {
  const [tab, setTab] = useState<TabId>("overview");
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="app">
      <header className="header">
        <span className="brand">▲ SENTINEL</span>
        <span className="muted mono">PINSIGHT · DRIFTEDGE</span>
        <span style={{ marginLeft: "auto" }} className="mono muted">
          {now.toISOString().replace("T", " ").slice(0, 19)}Z
        </span>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="content">
        {tab === "overview"   && <Overview />}
        {tab === "ps-chain"   && <PinSightChain />}
        {tab === "ps-flags"   && <PinSightFlags />}
        {tab === "de-markets" && <DriftEdgeMarkets />}
        {tab === "de-books"   && <DriftEdgeBooks />}
        {tab === "logs"       && <Logs />}
      </main>
    </div>
  );
}
