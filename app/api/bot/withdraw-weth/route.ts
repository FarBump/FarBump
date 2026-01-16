import { NextRequest, NextResponse } from "next/server"

import { type Address, type Hex, encodeFunctionData, createPublicClient, http } from "viem"

import { base } from "viem/chains"

import { createSupabaseServiceClient } from "@/lib/supabase"

import { CdpClient } from "@coinbase/cdp-sdk"



export const dynamic = "force-dynamic"

export const runtime = "nodejs"



const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const

const WETH_ABI = [

{ inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ name: "", type: "uint256" }], stateMutability: "view", type: "function" },

{ inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], name: "approve", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" },

{ inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], name: "transfer", outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable", type: "function" }

] as const



const publicClient = createPublicClient({

chain: base,

transport: http(process.env.NEXT_PUBLIC_BASE_RPC_URL),

})



export async function POST(request: NextRequest) {

try {

const { botWalletAddresses, tokenAddress, recipientAddress } = await request.json()


if (!botWalletAddresses || !tokenAddress || !recipientAddress) {

return NextResponse.json({ error: "Missing required fields" }, { status: 400 })

}



const supabase = createSupabaseServiceClient()

const cdp = new CdpClient()

const results = []



for (const address of botWalletAddresses) {

try {

const { data: bot } = await supabase

.from("wallets_data")

.select("*")

.ilike("smart_account_address", address)

.single()



if (!bot) {

results.push({ address, status: "failed", error: "Wallet not found in DB" })

continue

}



const ownerAccount = await cdp.evm.getAccount({ address: bot.owner_address as Address })

const smartAccount = await cdp.evm.getSmartAccount({

owner: ownerAccount,

address: address as Address

})



const sellBalanceWei = await publicClient.readContract({

address: tokenAddress as Address,

abi: WETH_ABI,

functionName: "balanceOf",

args: [address as Address],

})



if (sellBalanceWei > 0n) {

// Request quote dengan header yang benar

const url = new URL("https://api.0x.org/gasless/quote")

url.searchParams.append("chainId", "8453")

url.searchParams.append("sellToken", tokenAddress.toLowerCase())

url.searchParams.append("buyToken", WETH_ADDRESS.toLowerCase())

url.searchParams.append("sellAmount", sellBalanceWei.toString())

url.searchParams.append("taker", address.toLowerCase())



const quoteRes = await fetch(url.toString(), {

headers: {

"0x-api-key": process.env.ZEROX_API_KEY || "",

"0x-version": "v2", // Header wajib untuk Gasless API

"Accept": "application/json"

}

})


const contentType = quoteRes.headers.get("content-type")

if (!quoteRes.ok || !contentType || !contentType.includes("application/json")) {

const errorText = await quoteRes.text()

throw new Error(`0x API Error (${quoteRes.status}): ${errorText}`)

}


const quote = await quoteRes.json()



// Cek apakah approval diperlukan

if (quote.issues?.allowance) {

const approvalTarget = quote.issues.allowance.spender as Address


// Jika ada gasless approval yang tersedia

if (quote.approval) {

// Sign EIP-712 message untuk gasless approval

const approvalSignature = await smartAccount.signTypedData(quote.approval.eip712)


// Kirim approval signature (implementasi tergantung CDP SDK)

// Ini adalah placeholder - sesuaikan dengan CDP SDK Anda

} else {

// Fallback ke standard approval jika gasless approval tidak tersedia

const approveCall = {

to: tokenAddress as Address,

data: encodeFunctionData({

abi: WETH_ABI,

functionName: "approve",

args: [approvalTarget, sellBalanceWei],

}),

value: 0n

}


const approveOp = await (smartAccount as any).sendUserOperation({

network: "base",

calls: [approveCall],

isSponsored: true

})

await approveOp.wait()

}

}



// Sign EIP-712 message untuk swap

if (quote.permit2?.eip712) {

const swapSignature = await smartAccount.signTypedData(quote.permit2.eip712)


// Append signature ke transaction data

const signatureLengthInHex = (swapSignature.length / 2 - 1).toString(16).padStart(64, '0')

const transactionData = (quote.transaction.data + signatureLengthInHex + swapSignature.slice(2)) as Hex


const swapCall = {

to: quote.transaction.to as Address,

data: transactionData,

value: BigInt(quote.transaction.value || 0)

}



const swapOp = await (smartAccount as any).sendUserOperation({

network: "base",

calls: [swapCall],

isSponsored: true

})

await swapOp.wait()

}

}



// Transfer WETH ke recipient

const finalWethBalance = await publicClient.readContract({

address: WETH_ADDRESS,

abi: WETH_ABI,

functionName: "balanceOf",

args: [address as Address],

})



if (finalWethBalance > 0n) {

const transferData = encodeFunctionData({

abi: WETH_ABI,

functionName: "transfer",

args: [recipientAddress as Address, finalWethBalance],

})



const transferOp = await (smartAccount as any).sendUserOperation({

network: "base",

calls: [{ to: WETH_ADDRESS, data: transferData, value: 0n }],

isSponsored: true

})

await transferOp.wait()

}



// Update database

await supabase.from("bot_wallet_credits").update({ weth_balance_wei: "0" }).eq("bot_wallet_address", address.toLowerCase())

await supabase.from("wallets_data").update({ last_balance_update: new Date().toISOString() }).eq("smart_account_address", address)



results.push({ address, status: "success", amount: finalWethBalance.toString() })



} catch (err: any) {

results.push({ address, status: "failed", error: err.message })

}

}



return NextResponse.json({ success: true, details: results })

} catch (error: any) {

return NextResponse.json({ error: error.message }, { status: 500 })

}

}
