import { useFetch } from "../hooks";

export default function PinSightFlags() {
  const { data, error, loading } = useFetch<any>("/api/pinsight/flags?top=30");
  if (loading) return <div className="muted">Loading…</div>;
  if (error) return <div className="neg">Error: {error}</div>;
  if (!data || data.status !== "ok" || !data.items?.length)
    return <div className="muted">No flagged contracts.</div>;

  return (
    <div>
      <div className="muted mono" style={{ marginBottom: 12 }}>
        {data.count} flagged contracts (vol/OI ≥ 1, volume ≥ 1000) — sorted by vol/OI desc
      </div>
      <table>
        <thead>
          <tr>
            <th>Underlying</th>
            <th>Expiry</th>
            <th>Type</th>
            <th className="r">Strike</th>
            <th className="r">Volume</th>
            <th className="r">OI</th>
            <th className="r">Vol/OI</th>
            <th className="r">IV</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((r: any, i: number) => (
            <tr key={i}>
              <td className="amber">{r.underlying}</td>
              <td>{r.expiry}</td>
              <td className={r.type === "put" ? "neg" : "pos"}>{r.type}</td>
              <td className="r">{r.strike?.toFixed(0)}</td>
              <td className="r">{r.volume?.toLocaleString()}</td>
              <td className="r">{r.open_interest?.toLocaleString()}</td>
              <td className="r amber">{r.v_over_oi}</td>
              <td className="r">{r.iv?.toFixed(3) ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
