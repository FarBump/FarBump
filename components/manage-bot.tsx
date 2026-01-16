"use client"

import { useState, useEffect, useMemo } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatUnits, isAddress, type Address } from "viem"
import { toast } from "sonner"
import { Send, Loader2, RefreshCw, Wallet } from "lucide-react"

interface TokenInfo {
  contractAddress: string
  symbol: string
  name: string
  decimals: number
  balance: string
  balanceFormatted: string
  walletBalances: { address: string; balance: string }[] // Data saldo per wallet dari API
}

interface BotWallet {
  smartWalletAddress: string
  ownerAddress?: string
}

interface ManageBotProps {
  userAddress: string | null
  botWallets: BotWallet[] | null
}

export function ManageBot({ userAddress, botWallets }: ManageBotProps) {
  const [selectedToken, setSelectedToken] = useState<string>("")
  const [recipientAddress, setRecipientAddress] = useState<string>(userAddress || "")
  const [isLoadingTokens, setIsLoadingTokens] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [tokens, setTokens] = useState<TokenInfo[]>([])

  // 1. Fetch token balances (Discovery)
  const fetchTokenBalances = async () => {
    if (!botWallets || botWallets.length === 0) return

    setIsLoadingTokens(true)
    try {
      const response = await fetch("/api/bot/token-balances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botWallets: botWallets.map(w => w.smartWalletAddress),
        }),
      })

      const data = await response.json()
      
      if (data.success && data.tokens) {
        setTokens(data.tokens)
      } else {
        setTokens([])
      }
    } catch (error) {
      console.error("Discovery Error:", error)
      toast.error("Failed to discover tokens")
    } finally {
      setIsLoadingTokens(false)
    }
  }

  // Auto-fetch saat komponen mount
  useEffect(() => {
    fetchTokenBalances()
  }, [botWallets])

  // 2. Memoized Selected Token Info
  const selectedTokenInfo = useMemo(() => {
    return tokens.find((t) => t.address.toLowerCase() === selectedToken.toLowerCase()) || null
  }, [tokens, selectedToken])

  // 3. Handle Send (Withdraw All Loop)
  const handleWithdrawAll = async () => {
    if (!selectedTokenInfo || !recipientAddress) {
      toast.error("Please select a token and recipient")
      return
    }

    if (!isAddress(recipientAddress)) {
      toast.error("Invalid recipient address")
      return
    }

    setIsSending(true)
    let successCount = 0
    let failCount = 0

    try {
      // Loop melalui setiap wallet yang memiliki saldo untuk token terpilih
      for (const wb of selectedTokenInfo.walletBalances) {
        if (BigInt(wb.balance) > BigInt(0)) {
          try {
            const response = await fetch("/api/bot/send-token", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                botWalletAddress: wb.address,
                tokenAddress: selectedTokenInfo.address,
                recipientAddress: recipientAddress,
                amountWei: wb.balance,
                symbol: selectedTokenInfo.symbol,
              }),
            })

            if (response.ok) successCount++
            else failCount++
          } catch (e) {
            failCount++
          }
        }
      }

      if (successCount > 0) {
        toast.success(`Withdrawal Complete`, {
          description: `Successfully cleared ${successCount} wallets.`,
        })
      }
      
      if (failCount > 0) {
        toast.error(`Some transfers failed (${failCount})`)
      }

      // Refresh data
      setSelectedToken("")
      fetchTokenBalances()
    } catch (error) {
      toast.error("Process failed")
    } finally {
      setIsSending(false)
    }
  }

  return (
    <Card className="glass-card border-border p-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Wallet className="h-4 w-4" /> Manage Bot Assets
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={fetchTokenBalances}
          disabled={isLoadingTokens}
          className="h-8 w-8 p-0"
        >
          <RefreshCw className={`h-4 w-4 ${isLoadingTokens ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <div className="space-y-4">
        {/* Token Selection */}
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Select Token to Withdraw</Label>
          <Select value={selectedToken} onValueChange={setSelectedToken} disabled={isLoadingTokens || isSending}>
            <SelectTrigger className="w-full font-mono text-xs">
              <SelectValue placeholder={isLoadingTokens ? "Scanning wallets..." : "Select Token"} />
            </SelectTrigger>
            <SelectContent>
              {tokens.length === 0 ? (
                <SelectItem value="none" disabled>No Tokens Found</SelectItem>
              ) : (
                tokens.map((token) => (
                  <SelectItem key={token.address} value={token.address}>
                    {token.name} ({token.symbol}) — {token.balanceFormatted}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </div>

        {/* Recipient - Default to User Wallet */}
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Recipient Address</Label>
          <Input
            value={recipientAddress}
            onChange={(e) => setRecipientAddress(e.target.value)}
            placeholder="0x..."
            className="font-mono text-xs"
            disabled={isSending}
          />
        </div>

        {/* Total Amount (Read Only) */}
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Total Amount to Withdraw</Label>
          <div className="relative">
            <Input
              readOnly
              value={selectedTokenInfo ? `${selectedTokenInfo.balanceFormatted} ${selectedTokenInfo.symbol}` : "0.00"}
              className="bg-muted/50 font-mono text-xs"
            />
          </div>
          <p className="text-[10px] text-muted-foreground italic">
            *This will drain the selected token from all 5 bot wallets.
          </p>
        </div>

        {/* Action Button */}
        <Button
          onClick={handleWithdrawAll}
          disabled={isSending || !selectedToken || tokens.length === 0}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white"
        >
          {isSending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Processing Withdrawals...
            </>
          ) : (
            <>
              <Send className="mr-2 h-4 w-4" />
              Withdraw All Funds
            </>
          )}
        </Button>
      </div>
    </Card>
  )
}
