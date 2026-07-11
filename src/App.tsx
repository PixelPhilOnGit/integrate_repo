import { useState } from "react";
import reactLogo from "./assets/react.svg";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

function App() {

  const [tab, setTab] = useState<"ts2date" | "date2ts">("ts2date");

  // Tab 1: timestamp → date
  const [timestamp, setTimestamp] = useState("");
  const [dateResult, setDateResult] = useState("");

  // Tab 2: date → timestamp
  const [dateInput, setDateInput] = useState("");
  const [tsResult, setTsResult] = useState("");


  async function convertTs2Date() {
      try {
        const result = await invoke("timestamp_to_date", { timestamp: parseInt(timestamp)});
        setDateResult(result as string);
      } catch (e) {
        setDateResult(`Error: ${e}`);
      }
  }

  async function convertDate2Ts() {
      try {
        const result = await invoke("date_to_timestamp", { dateStr: dateInput });
        setTsResult(result!.toString());
      } catch (e) {
        setTsResult(`Error: ${e}`);
      }
    }

  return (
    <main className="container">
        <h1>Time Converter</h1>

        <div className="tabs">
          <button
            className={tab === "ts2date" ? "tab active" : "tab"}
            onClick={() => setTab("ts2date")}
          >
            Timestamp → Date
          </button>
          <button
            className={tab === "date2ts" ? "tab active" : "tab"}
            onClick={() => setTab("date2ts")}
          >
            Date → Timestamp
          </button>
        </div>

        {tab === "ts2date" && (
          <div className="card">
            <label>Unix Timestamp (seconds):</label>
            <input
              value={timestamp}
              onChange={(e) => setTimestamp(e.target.value)}
              placeholder="e.g. 1705312200"
            />
            <button onClick={convertTs2Date}>Convert</button>
            {dateResult && <p className="result">{dateResult}</p>}
          </div>
        )}

        {tab === "date2ts" && (
          <div className="card">
            <label>Date Time:</label>
            <input
              value={dateInput}
              onChange={(e) => setDateInput(e.target.value)}
              placeholder="2024-01-15 08:30:00"
            />
            <button onClick={convertDate2Ts}>Convert</button>
            {tsResult && <p className="result">{tsResult}</p>}
          </div>
        )}
      </main>
  );
}

export default App;
