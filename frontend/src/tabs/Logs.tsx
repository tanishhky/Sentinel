import { useState } from "react";
import { useFetch } from "../hooks";

export default function Logs() {
  const [source, setSource] = useState<"pinsight" | "driftedge">("driftedge");
  const { data, error, loading } = useFetch<any>(`/api/logs/${source}?max_lines=300`, 3000);

  return (
    <div>
      <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
        <button
          className={`tab ${source === "pinsight" ? "active" : ""}`}
          onClick={() => setSource("pinsight")}
        >
          PINSIGHT
        </button>
        <button
          className={`tab ${source === "driftedge" ? "active" : ""}`}
          onClick={() => setSource("driftedge")}
        >
          DRIFTEDGE
        </button>
        {loading && <span className="muted">loading…</span>}
        {error && <span className="neg">{error}</span>}
      </div>

      <div className="card">
        <div className="logs">
          {(data?.events ?? []).map((e: any, i: number) => (
            <div key={i} className={`log-line log-${(e.level ?? "info").toLowerCase()}`}>
              <span className="log-ts">{e.ts?.slice(11, 23)}</span>
              <span className="log-channel">{e.channel}</span>
              <span className="amber">{e.kind}</span>
              {Object.entries(e)
                .filter(([k]) => !["ts", "channel", "kind", "level", "run_id"].includes(k))
                .map(([k, v]) => (
                  <span key={k} className="muted">  {k}=<span className="mono">{
                    typeof v === "object" ? JSON.stringify(v) : String(v)
                  }</span></span>
                ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
