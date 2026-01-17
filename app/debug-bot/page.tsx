"use client";
import { useState } from "react";

export default function DebugBotPage() {
  const [botAddress, setBotAddress] = useState(""); // Input smart account address
  const [recipient, setRecipient] = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");

  const handleProcess = async (endpoint: string, body: object) => {
    setLoading(true);
    setStatus("Executing transaction...");
    try {
      const res = await fetch(`/api/debug/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) setStatus(`Success! Hash: ${data.txHash}`);
      else setStatus(`Error: ${data.error}`);
    } catch (e) {
      setStatus("Request failed. Check console.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-10 space-y-8 bg-white text-black min-h-screen">
      <h1 className="text-2xl font-bold border-b pb-4">CDP Bot Debugger (Non-Gasless Swap)</h1>

      <div className="space-y-4 p-6 border rounded-lg bg-gray-50">
        <h2 className="font-semibold text-blue-600">Step 1: Identify Wallet</h2>
        <input
          placeholder="Smart Account Address (0x...)"
          className="w-full p-2 border rounded"
          value={botAddress}
          onChange={(e) => setBotAddress(e.target.value)}
        />
        <p className="text-xs text-gray-500 italic">*Alamat ini akan dicari di database Supabase untuk mendapatkan owner_address.</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="p-4 border rounded-lg space-y-3">
          <h3 className="font-bold">A. Liquidation</h3>
          <p className="text-xs">Unwrap WETH (Gasless) lalu Swap Token ke WETH (Bayar Gas).</p>
          <button
            onClick={() => handleProcess("swap-flow", { botAddress, tokenAddress: "0x..." })} // Ganti dengan token target
            disabled={loading || !botAddress}
            className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700 disabled:bg-gray-300"
          >
            Unwrap + Swap
          </button>
        </div>

        <div className="p-4 border rounded-lg space-y-3">
          <h3 className="font-bold">B. Exit Strategy</h3>
          <input
            placeholder="Recipient Address"
            className="w-full p-2 border text-sm rounded"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
          />
          <button
            onClick={() => handleProcess("wrap-send", { botAddress, recipient })}
            disabled={loading || !botAddress || !recipient}
            className="w-full bg-green-600 text-white py-2 rounded hover:bg-green-700 disabled:bg-gray-300"
          >
            Wrap + Send All (Gasless)
          </button>
        </div>
      </div>

      <div className="p-4 bg-black rounded font-mono text-sm text-green-400 overflow-x-auto">
        <span className="text-gray-500">$ Status:</span> {status}
      </div>
    </div>
  );
}
