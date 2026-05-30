import { useFetch } from "../hooks";

export default function Overview() {
  const chain = useFetch<any>("/api/pinsight/chain");
  const flags = useFetch<any>("/api/pinsight/flags?top=5");
  const markets = useFetch<any>("/api/driftedge/markets?top=5");
  const books = useFetch<any>("/api/driftedge/books");

  return (
    <div className="grid grid-cols-4" style={{ marginBottom: 16 }}>
      <Kpi label="PinSight · Chain" value={chain.data?.contracts ?? "—"}
           sub={`${chain.data?.underlying ?? ""} · ${chain.data?.expiry ?? ""}`} />
      <Kpi label="PinSight · Underlying" value={chain.data?.underlying_price ?? "—"} />
      <Kpi label="PinSight · Flags" value={flags.data?.count ?? "—"} />
      <Kpi label="DriftEdge · Markets" value={markets.data?.count ?? "—"} />
      <Kpi label="DriftEdge · Books tracked" value={books.data?.count ?? "—"} />
      <Kpi label="DriftEdge · Snapshot ts" value={markets.data?.snapshot_ts?.slice(11, 19) ?? "—"}
           sub={markets.data?.snapshot_ts?.slice(0, 10) ?? ""} />
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: any; sub?: string }) {
  return (
    <div className="card kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="muted mono" style={{ fontSize: 10 }}>{sub}</div>}
    </div>
  );
}
