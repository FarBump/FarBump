import { NextRequest, NextResponse } from "next/server"
import { createPublicClient, http, type Address, formatUnits } from "viem"
import { base } from "viem/chains"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const BASESCAN_API_URL = "https://api.basescan.org/api"
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
    const url = `${BASESCAN_API_URL}?module=account&action=tokentx&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`
    const response = await fetch(url, { next: { revalidate: 0 } })
    const data = await response.json()
    if (data.status !== "1" || !Array.isArray(data.result)) return []
    return data.result.map((tx: any) => tx.contractAddress.toLowerCase())
  } catch {
    return []
  }
}

export async function POST(request: NextRequest) {
  try {
    const { botWallets } = await request.json()
    if (!botWallets || botWallets.length === 0) {
      return NextResponse.json({ tokens: [] })
    }

    // 1. Discovery: Cari token dari history + sertakan WETH untuk dicek
    const discoveryResults = await Promise.all(botWallets.map((addr: string) => fetchTokenList(addr)))
    const uniqueTokens = Array.from(new Set([...discoveryResults.flat(), WETH_BASE.toLowerCase()]))

    const tokenDetails = await Promise.all(
      uniqueTokens.map(async (tokenAddr) => {
        const address = tokenAddr as Address
        try {
          // Cek saldo di 5 wallet secara paralel
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
            // Simpan rincian saldo per wallet untuk memudahkan looping saat kirim
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

    const filteredTokens = tokenDetails.filter((t) => t !== null)
    return NextResponse.json({ success: true, tokens: filteredTokens })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
