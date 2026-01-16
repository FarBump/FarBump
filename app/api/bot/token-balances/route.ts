import { NextRequest, NextResponse } from "next/server"
import { createPublicClient, http, type Address, formatUnits } from "viem"
import { base } from "viem/chains"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const WETH_BASE = "0x4200000000000000000000000000000000000006"

const ERC20_ABI = [
  { inputs: [{ name: "_owner", type: "address" }], name: "balanceOf", outputs: [{ name: "balance", type: "uint256" }], type: "function" },
  { inputs: [], name: "decimals", outputs: [{ name: "", type: "uint8" }], type: "function" },
  { inputs: [], name: "symbol", outputs: [{ name: "", type: "string" }], type: "function" },
  { inputs: [], name: "name", outputs: [{ name: "", type: "string" }], type: "function" },
] as const

const publicClient = createPublicClient({
  chain: base,
  transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),
})

async function fetchTokenList(address: string): Promise<string[]> {
  try {
    const apiKey = process.env.BASESCAN_API_KEY
    if (!apiKey) return []

    /**
     * UPDATE V2: 
     * BaseScan bermigrasi ke Etherscan V2. 
     * Kita tambahkan chainid=8453 (Base Mainnet) untuk kompatibilitas.
     */
    const url = `https://api.basescan.org/api?chainid=8453&module=account&action=tokentx&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`

    const response = await fetch(url, { cache: 'no-store' })
    const data = await response.json()

    // Jika tidak ada transaksi, API V2 mengembalikan status 0 dengan pesan tertentu
    if (data.status === "0") {
      console.log(`Info for ${address}: ${data.message}`)
      return []
    }

    if (data.status !== "1" || !Array.isArray(data.result)) return []
    
    return data.result.map((tx: any) => tx.contractAddress.toLowerCase())
  } catch (error) {
    console.error("Discovery Error:", error)
    return []
  }
}

export async function POST(request: NextRequest) {
  try {
    const { botWallets } = await request.json()
    if (!botWallets || botWallets.length === 0) {
      return NextResponse.json({ success: true, tokens: [] })
    }

    // 1. Discovery: Dapatkan riwayat token dari BaseScan
    const discoveryResults = await Promise.all(botWallets.map((addr: string) => fetchTokenList(addr)))
    
    // Pastikan WETH selalu dicek, lalu gabungkan dengan token hasil discovery
    const uniqueTokens = Array.from(new Set([...discoveryResults.flat(), WETH_BASE.toLowerCase()]))

    // 2. Fetch Detail & Saldo
    const tokenDetails = await Promise.all(
      uniqueTokens.map(async (tokenAddr) => {
        const address = tokenAddr as Address
        try {
          const balances = await Promise.all(
            botWallets.map((wallet: string) =>
              publicClient.readContract({
                address,
                abi: ERC20_ABI,
                functionName: "balanceOf",
                args: [wallet as Address],
              }).catch(() => BigInt(0))
            )
          )

          const totalBalance = balances.reduce((acc, curr) => acc + curr, BigInt(0))
          
          // Filter: Jika total saldo 0 di semua wallet, jangan tampilkan di dropdown
          if (totalBalance === BigInt(0)) return null

          const [symbol, name, decimals] = await Promise.all([
            publicClient.readContract({ address, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "???"),
            publicClient.readContract({ address, abi: ERC20_ABI, functionName: "name" }).catch(() => "Unknown"),
            publicClient.readContract({ address, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18),
          ])

          return {
            address: tokenAddr,
            symbol,
            name,
            decimals: Number(decimals),
            balanceWei: totalBalance.toString(),
            balanceFormatted: formatUnits(totalBalance, Number(decimals)),
            walletBalances: botWallets.map((w: string, i: number) => ({
              address: w,
              balance: balances[i].toString()
            }))
          }
        } catch {
          return null
        }
      })
    )

    const tokens = tokenDetails.filter((t) => t !== null)
    return NextResponse.json({ success: true, tokens })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
