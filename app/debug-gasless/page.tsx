"use client"

import { useState } from "react"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { parseEther, type Address } from "viem"

export default function DebugGaslessPage() {
  const { client: smartWalletClient } = useSmartWallets()
  const [logs, setLogs] = useState<string[]>([])
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState<any>(null)

  const addLog = (message: string) => {
    setLogs((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${message}`])
    console.log(message)
  }

  const sendGaslessTransaction = async () => {
    setError(null)
    setIsPending(true)
    setLogs([])
    
    addLog("🚀 Starting gasless transaction test...")

    try {
      // Check Smart Wallet Client
      if (!smartWalletClient) {
        throw new Error("Smart Wallet client not found. Please connect your wallet.")
      }

      const smartWalletAddress = smartWalletClient.account?.address
      if (!smartWalletAddress) {
        throw new Error("Smart Wallet address not found.")
      }

      addLog(`✅ Smart Wallet connected: ${smartWalletAddress}`)

      // Transaction parameters
      const to: Address = "0x2D20B703c92BB5133f6e6151aaEB51598068d434"
      const value = parseEther("0.0001")

      addLog(`📤 Preparing transaction...`)
      addLog(`   → To: ${to}`)
      addLog(`   → Value: 0.0001 ETH`)
      addLog(`   → Data: 0x (empty, simple ETH transfer)`)
      addLog(`   → Paymaster: Auto (Privy Dashboard configuration)`)

      // Send transaction (let Privy handle sponsorship automatically)
      addLog(`⏳ Sending transaction...`)
      
      const txHash = await smartWalletClient.sendTransaction({
        to: to,
        value: value,
        data: "0x" as const,
      }) as `0x${string}`

      addLog(`✅ Transaction submitted!`)
      addLog(`   → Hash: ${txHash}`)
      addLog(`   → View on BaseScan: https://basescan.org/tx/${txHash}`)

      // Wait for confirmation
      addLog(`⏳ Waiting for confirmation...`)
      
      // Note: In a real scenario, you might want to wait for receipt
      // For testing purposes, we'll just log the hash
      
    } catch (err: any) {
      addLog(`❌ Transaction failed!`)
      addLog(`   → Error: ${err.message || "Unknown error"}`)
      setError(err)
      
      // Log full error details
      if (err.cause) {
        addLog(`   → Cause: ${JSON.stringify(err.cause, null, 2)}`)
      }
      if (err.details) {
        addLog(`   → Details: ${JSON.stringify(err.details, null, 2)}`)
      }
    } finally {
      setIsPending(false)
    }
  }

  const isConnected = !!smartWalletClient?.account?.address
  const smartWalletAddress = smartWalletClient?.account?.address

  return (
    <div className="container mx-auto p-6 max-w-2xl">
      <h1 className="text-3xl font-bold mb-6">Gasless Transaction Test</h1>
      
      {/* Connection Status */}
      <div className="mb-6 p-4 rounded-lg border-2">
        <h2 className="text-xl font-semibold mb-2">Smart Wallet Status</h2>
        {isConnected ? (
          <div className="space-y-1">
            <p className="text-green-600">✅ Connected</p>
            <p className="text-sm text-gray-600 break-all">
              Address: {smartWalletAddress}
            </p>
          </div>
        ) : (
          <p className="text-red-600">❌ Not Connected - Please connect your wallet</p>
        )}
      </div>

      {/* Test Button */}
      <div className="mb-6">
        <button
          onClick={sendGaslessTransaction}
          disabled={!isConnected || isPending}
          className="w-full py-4 px-6 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-lg"
        >
          {isPending ? "Sending..." : "Kirim 0.0001 ETH (Gasless Test)"}
        </button>
      </div>

      {/* Logs Display */}
      {logs.length > 0 && (
        <div className="mb-6 p-4 bg-gray-100 rounded-lg border">
          <h2 className="text-xl font-semibold mb-2">Transaction Logs</h2>
          <div className="bg-white p-4 rounded border max-h-96 overflow-y-auto">
            <pre className="text-sm whitespace-pre-wrap font-mono">
              {logs.join("\n")}
            </pre>
          </div>
        </div>
      )}

      {/* Error Display (JSON) */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 rounded-lg border-2 border-red-200">
          <h2 className="text-xl font-semibold mb-2 text-red-800">Error Details (JSON)</h2>
          <div className="bg-white p-4 rounded border max-h-96 overflow-y-auto">
            <pre className="text-xs whitespace-pre-wrap font-mono text-red-900">
              {JSON.stringify(error, Object.getOwnPropertyNames(error), 2)}
            </pre>
          </div>
        </div>
      )}

      {/* Instructions */}
      <div className="mt-6 p-4 bg-blue-50 rounded-lg border border-blue-200">
        <h2 className="text-lg font-semibold mb-2">Test Information</h2>
        <ul className="text-sm space-y-1 text-gray-700">
          <li>• <strong>To:</strong> 0x2D20B703c92BB5133f6e6151aaEB51598068d434 (Bot Wallet)</li>
          <li>• <strong>Value:</strong> 0.0001 ETH</li>
          <li>• <strong>Type:</strong> Simple ETH transfer (no contract call)</li>
          <li>• <strong>Paymaster:</strong> Auto-configured via Privy Dashboard</li>
          <li>• <strong>Purpose:</strong> Test if allowlist error occurs on minimal transaction</li>
        </ul>
      </div>
    </div>
  )
}

