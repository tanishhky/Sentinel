import { useFetch } from "../hooks";

export default function DriftEdgeBooks() {
  const { data, error, loading } = useFetch<any>("/api/driftedge/books");
  if (loading) return <div className="muted">Loading…</div>;
  if (error) return <div className="neg">Error: {error}</div>;
  if (!data || data.status !== "ok" || !data.items?.length)
    return <div className="muted">No orderbook snapshots yet. Start the DriftEdge poll daemon.</div>;

  return (
    <div>
      <div className="muted mono" style={{ marginBottom: 12 }}>
        {data.count} markets being tracked · sorted by most recent activity
      </div>
      <table>
        <thead>
          <tr>
            <th>Market ID</th>
            <th className="r">Snapshots today</th>
            <th>Last snapshot</th>
            <th>File mtime</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((r: any, i: number) => (
            <tr key={i}>
              <td className="amber mono">{r.market_id}</td>
              <td className="r">{r.snapshot_count_today}</td>
              <td className="muted mono">{r.last_snapshot_ts ?? "—"}</td>
              <td className="muted mono">{r.file_mtime}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
