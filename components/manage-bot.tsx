"use client"

import { useState, useEffect, useMemo } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { usePublicClient } from "wagmi"
import { isAddress, formatUnits, parseUnits, type Address, type Hex } from "viem"
import { base } from "wagmi/chains"
import { useSmartWallets } from "@privy-io/react-auth/smart-wallets"
import { toast } from "sonner"
import { Send, Loader2, Maximize2 } from "lucide-react"
import { createSupabaseClient } from "@/lib/supabase"

// ERC20 ABI for balanceOf and transfer
const ERC20_ABI = [
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
  {
    constant: false,
    inputs: [
      { name: "_to", type: "address" },
      { name: "_value", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    type: "function",
  },
  {
    constant: true,
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
    type: "function",
  },
] as const

interface TokenInfo {
  address: string
  symbol: string
  decimals: number
  balance: bigint
  balanceFormatted: string
}

interface BotWallet {
  smartWalletAddress: string
  ownerAddress?: string
  network?: string
}

interface ManageBotProps {
  userAddress: string | null
  botWallets: BotWallet[] | null
}

export function ManageBot({ userAddress, botWallets }: ManageBotProps) {
  const { client: smartWalletClient } = useSmartWallets()
  const publicClient = usePublicClient()
  const supabase = createSupabaseClient()

  const [selectedToken, setSelectedToken] = useState<string>("")
  const [recipientAddress, setRecipientAddress] = useState<string>("")
  const [amount, setAmount] = useState<string>("")
  const [isLoadingTokens, setIsLoadingTokens] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [tokens, setTokens] = useState<TokenInfo[]>([])

  // Fetch token balances for all bot wallets
  // Uses API endpoint for faster batch fetching
  useEffect(() => {
    if (!botWallets || botWallets.length === 0 || !userAddress) {
      setTokens([])
      return
    }

    const fetchTokenBalances = async () => {
      setIsLoadingTokens(true)
      try {
        console.log(`📊 Fetching token balances for ${botWallets.length} bot wallets...`)
        
        // Use API endpoint for faster batch token balance fetching
        const response = await fetch("/api/bot/token-balances", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            botWallets: botWallets.map(w => w.smartWalletAddress),
          }),
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          console.error("❌ Failed to fetch token balances:", errorData)
          throw new Error(errorData.error || "Failed to fetch token balances")
        }

        const data = await response.json()
        console.log(`✅ Token balances response:`, data)
        
        if (data.success && data.tokens && Array.isArray(data.tokens)) {
          // Convert to TokenInfo format
          const tokenBalances: TokenInfo[] = data.tokens.map((token: any) => {
            const totalBalance = BigInt(token.totalBalance || "0")
            return {
              address: token.address,
              symbol: token.symbol,
              decimals: token.decimals,
              balance: totalBalance,
              balanceFormatted: formatUnits(totalBalance, token.decimals),
            }
          })
          
          console.log(`✅ Found ${tokenBalances.length} tokens with balances:`, tokenBalances.map(t => `${t.symbol}: ${t.balanceFormatted}`))
          setTokens(tokenBalances)
        } else {
          console.log("ℹ️ No tokens found or invalid response format")
          setTokens([])
        }
      } catch (error: any) {
        console.error("❌ Error fetching token balances:", error)
        toast.error("Failed to load token balances", {
          description: error.message || "Please try again",
        })
        setTokens([])
      } finally {
        setIsLoadingTokens(false)
      }
    }

    fetchTokenBalances()
  }, [botWallets, userAddress])

  // Get selected token info
  const selectedTokenInfo = useMemo(() => {
    return tokens.find((t) => t.address.toLowerCase() === selectedToken.toLowerCase())
  }, [tokens, selectedToken])

  // Handle Max button
  const handleMax = () => {
    if (selectedTokenInfo) {
      setAmount(selectedTokenInfo.balanceFormatted)
    }
  }

  // Handle Send
  const handleSend = async () => {
    if (!smartWalletClient || !selectedTokenInfo || !recipientAddress || !amount) {
      toast.error("Please fill in all fields")
      return
    }

    if (!isAddress(recipientAddress)) {
      toast.error("Invalid recipient address")
      return
    }

    if (!botWallets || botWallets.length === 0) {
      toast.error("No bot wallets found")
      return
    }

    try {
      setIsSending(true)

      // Parse amount
      const amountWei = parseUnits(amount, selectedTokenInfo.decimals)

      if (amountWei > selectedTokenInfo.balance) {
        toast.error(`Insufficient balance. Available: ${selectedTokenInfo.balanceFormatted} ${selectedTokenInfo.symbol}`)
        return
      }

      // Find bot wallet with sufficient balance
      let sourceWallet: BotWallet | null = null
      let sourceBalance = BigInt(0)

      for (const botWallet of botWallets) {
        try {
          const balance = await publicClient.readContract({
            address: selectedTokenInfo.address as Address,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [botWallet.smartWalletAddress as Address],
          })

          const balanceBigInt = BigInt(balance.toString())
          if (balanceBigInt >= amountWei) {
            sourceWallet = botWallet
            sourceBalance = balanceBigInt
            break
          }
        } catch (error) {
          console.warn(`Failed to check balance for ${botWallet.smartWalletAddress}:`, error)
        }
      }

      if (!sourceWallet) {
        toast.error(`No bot wallet has sufficient balance. Required: ${amount} ${selectedTokenInfo.symbol}`)
        return
      }

      // Encode transfer function call
      const { encodeFunctionData } = await import("viem")
      const transferData = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [recipientAddress as Address, amountWei],
      })

      console.log(`📤 Sending ${amount} ${selectedTokenInfo.symbol} from ${sourceWallet.smartWalletAddress} to ${recipientAddress}...`)

      // Send transaction using Privy Smart Wallet
      // Note: This will use the main Privy Smart Wallet, not the bot wallet
      // For bot wallet transactions, we need to use CDP SDK server-side
      // For now, we'll create an API endpoint to handle this

      const response = await fetch("/api/bot/send-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botWalletAddress: sourceWallet.smartWalletAddress,
          tokenAddress: selectedTokenInfo.address,
          recipientAddress: recipientAddress,
          amountWei: amountWei.toString(),
          decimals: selectedTokenInfo.decimals,
          symbol: selectedTokenInfo.symbol,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || "Failed to send token")
      }

      const result = await response.json()

      toast.success(`Successfully sent ${amount} ${selectedTokenInfo.symbol}!`, {
        description: "100% Gasless Transaction",
        action: {
          label: "View",
          onClick: () => window.open(`https://basescan.org/tx/${result.txHash}`, "_blank"),
        },
      })

      // Reset form
      setAmount("")
      setRecipientAddress("")

      // Refresh token balances
      // Trigger re-fetch by updating a dependency
      setTokens([...tokens])
    } catch (error: any) {
      console.error("Error sending token:", error)
      toast.error("Failed to send token", {
        description: error.message || "Unknown error occurred",
      })
    } finally {
      setIsSending(false)
    }
  }

  return (
    <Card className="glass-card border-border p-4">
      <h3 className="mb-4 text-sm font-semibold text-foreground">Send Token</h3>

      <div className="space-y-4">
        {/* Token Selection */}
        <div className="space-y-2">
          <Label htmlFor="token-select" className="text-xs text-muted-foreground">
            Select Token
          </Label>
          <Select value={selectedToken} onValueChange={setSelectedToken} disabled={isLoadingTokens}>
            <SelectTrigger id="token-select" className="w-full">
              <SelectValue placeholder={isLoadingTokens ? "Loading tokens..." : "Select Token"} />
            </SelectTrigger>
              <SelectContent>
                {tokens.length === 0 ? (
                  <SelectItem value="no-tokens" disabled>
                    No tokens found
                  </SelectItem>
                ) : (
                  tokens.map((token) => (
                    <SelectItem key={token.address} value={token.address}>
                      <div className="flex items-center justify-between w-full">
                        <span>{token.symbol}</span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {token.balanceFormatted}
                        </span>
                      </div>
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {selectedTokenInfo && (
              <p className="text-xs text-muted-foreground">
                Available: {selectedTokenInfo.balanceFormatted} {selectedTokenInfo.symbol}
              </p>
            )}
          </div>

        {/* Recipient Address */}
        <div className="space-y-2">
          <Label htmlFor="recipient-address" className="text-xs text-muted-foreground">
            Recipient Address
          </Label>
          <Input
            id="recipient-address"
            type="text"
            placeholder="0x..."
            value={recipientAddress}
            onChange={(e) => setRecipientAddress(e.target.value)}
            disabled={isSending}
            className="font-mono text-xs"
          />
        </div>

        {/* Amount */}
        <div className="space-y-2">
          <Label htmlFor="amount" className="text-xs text-muted-foreground">
            Amount
          </Label>
          <div className="relative">
            <Input
              id="amount"
              type="text"
              placeholder="0.0"
              value={amount}
              onChange={(e) => {
                // Allow only numbers and decimal point
                const value = e.target.value.replace(/[^0-9.]/g, "")
                setAmount(value)
              }}
              disabled={isSending || !selectedToken}
              className="pr-12 font-mono text-xs"
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="absolute right-1 top-1/2 h-6 -translate-y-1/2 px-2 text-xs"
              onClick={handleMax}
              disabled={isSending || !selectedTokenInfo}
            >
              <Maximize2 className="h-3 w-3 mr-1" />
              Max
            </Button>
          </div>
          {selectedTokenInfo && amount && (
            <p className="text-xs text-muted-foreground">
              ≈ {amount} {selectedTokenInfo.symbol}
            </p>
          )}
        </div>

        {/* Send Button */}
        <Button
          onClick={handleSend}
          disabled={isSending || !selectedToken || !recipientAddress || !amount || !selectedTokenInfo}
          className="w-full"
          size="sm"
        >
          {isSending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Sending...
            </>
          ) : (
            <>
              <Send className="mr-2 h-4 w-4" />
              Send
            </>
          )}
        </Button>
      </div>
    </Card>
  )
}

