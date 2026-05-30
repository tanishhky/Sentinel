import { useFetch } from "../hooks";

export default function DriftEdgeMarkets() {
  const { data, error, loading } = useFetch<any>("/api/driftedge/markets?top=50");
  if (loading) return <div className="muted">Loading…</div>;
  if (error) return <div className="neg">Error: {error}</div>;
  if (!data || data.status !== "ok") return <div className="muted">No DriftEdge data yet.</div>;

  return (
    <div>
      <div className="muted mono" style={{ marginBottom: 12 }}>
        Snapshot: {data.snapshot_ts ?? "—"} · {data.count} markets · sorted by 24h volume
      </div>
      <table>
        <thead>
          <tr>
            <th>Question</th>
            <th>Category</th>
            <th className="r">Yes</th>
            <th className="r">No</th>
            <th className="r">Spread</th>
            <th className="r">Vol 24h</th>
            <th>End</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((r: any) => (
            <tr key={r.market_id}>
              <td style={{ maxWidth: 480, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.question}
              </td>
              <td className="muted">{r.category ?? ""}</td>
              <td className="r pos">{(r.yes_price ?? 0).toFixed(3)}</td>
              <td className="r neg">{(r.no_price ?? 0).toFixed(3)}</td>
              <td className="r muted">{r.spread != null ? r.spread.toFixed(3) : "—"}</td>
              <td className="r amber">${Math.round(r.volume_24h ?? 0).toLocaleString()}</td>
              <td className="muted mono" style={{ fontSize: 10 }}>{r.end_date?.slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
