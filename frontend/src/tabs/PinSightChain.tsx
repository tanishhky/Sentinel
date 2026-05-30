import { useFetch } from "../hooks";

export default function PinSightChain() {
  const { data, error, loading } = useFetch<any>("/api/pinsight/chain");
  if (loading) return <div className="muted">Loading…</div>;
  if (error) return <div className="neg">Error: {error}</div>;
  if (!data || data.status !== "ok")
    return <div className="muted">No chain data yet. Run <code>pinsight fetch-chain SPY</code>.</div>;

  return (
    <div>
      <div className="grid grid-cols-4" style={{ marginBottom: 16 }}>
        <Kpi label="Underlying" value={data.underlying} />
        <Kpi label="Spot" value={`$${(data.underlying_price ?? 0).toFixed(2)}`} />
        <Kpi label="Expiry" value={data.expiry} />
        <Kpi label="Contracts" value={`${data.contracts} (${data.calls}C/${data.puts}P)`} />
      </div>
      <div className="card">
        <div className="card-title">SNAPSHOT METADATA</div>
        <table>
          <tbody>
            <tr><td className="muted">Snapshot UTC</td><td className="mono">{data.snapshot_ts}</td></tr>
            <tr><td className="muted">Call volume</td><td className="mono r">{data.total_call_vol?.toLocaleString()}</td></tr>
            <tr><td className="muted">Put volume</td><td className="mono r">{data.total_put_vol?.toLocaleString()}</td></tr>
            <tr><td className="muted">File</td><td className="mono" style={{ fontSize: 10 }}>{data.file_path}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Kpi({ label, value }: any) {
  return (
    <div className="card kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value mono">{value}</div>
    </div>
  );
}
