"use client"

import { Card } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Activity, ExternalLink, Loader2, Wallet } from "lucide-react"
import { useBotLogs, getWalletLabel, formatRelativeTime } from "@/hooks/use-bot-logs"
import { useBotWallets } from "@/hooks/use-bot-wallets"
import { useCreditBalance } from "@/hooks/use-credit-balance"
import { formatEther } from "viem"
import { useBotSession } from "@/hooks/use-bot-session"

interface BotLiveActivityProps {
  userAddress: string | null
  enabled?: boolean
}

/**
 * Bot Live Activity Component
 * 
 * Displays real-time bot logs from Supabase with:
 * - Realtime updates via Supabase subscriptions
 * - Wallet labels (Bot Wallet #1, #2, etc.)
 * - Status badges (Success, Failed, Pending)
 * - Transaction links to BaseScan
 * - Relative timestamps
 * - Smooth animations for new logs
 * - Aggregated wallet status overview
 */
export function BotLiveActivity({ userAddress, enabled = true }: BotLiveActivityProps) {
  // Get bot session for active status FIRST (before using it in other hooks)
  // Always call hook to maintain hook order (React Rules of Hooks)
  const { session } = useBotSession(userAddress)

  // Determine if bot is actually running
  const isBotRunning = enabled && !!userAddress && !!session && session.status === "running"

  // Get bot wallets for wallet labels
  // Only fetch when bot is actually active to avoid unnecessary API calls
  // Always call hook to maintain hook order (React Rules of Hooks)
  const { 
    data: botWallets, 
    isLoading: isLoadingWallets,
    error: walletsError 
  } = useBotWallets({
    userAddress,
    enabled: isBotRunning,
  })
  
  // Log errors but don't crash the component
  if (walletsError) {
    console.error("⚠️ Error loading bot wallets:", walletsError)
  }

  // Get bot logs with realtime subscription
  // Always call hook to maintain hook order (React Rules of Hooks)
  const { logs, isLoading: isLoadingLogs } = useBotLogs({
    userAddress,
    enabled: enabled && !!userAddress,
    limit: 20, // Initial load: last 20 logs
  })

  // Get credit balance for aggregated status
  // Always call hook to maintain hook order (React Rules of Hooks)
  const { data: creditData } = useCreditBalance(userAddress, {
    enabled: enabled && !!userAddress,
  })

  // Calculate aggregated credit from bot wallets
  // Note: This would require fetching balances from blockchain
  // For now, we'll use the user's credit balance as proxy
  const aggregatedCredit = creditData?.balanceEth || "0"

  // Count active wallets (all 5 wallets are ready if bot wallets exist)
  const activeWalletsCount = botWallets?.length || 0
  const totalWallets = 5

  // Don't render if not enabled (but hooks are still called to maintain order)
  if (!enabled || !userAddress) {
    return null
  }

  return (
    <Card className="glass-card border-border p-4">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold text-foreground">Live Activity</h2>
        </div>
        {isBotRunning && (
          <Badge variant="default" className="animate-pulse">
            Active
          </Badge>
        )}
      </div>

      {/* Aggregated Wallet Status Overview */}
      <div className="mb-4 grid grid-cols-2 gap-3 rounded-lg border border-border bg-secondary/20 p-3">
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Active Bots</span>
          </div>
          <p className="text-sm font-semibold text-foreground">
            {activeWalletsCount}/{totalWallets} Wallets Ready
          </p>
        </div>
        <div>
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs text-muted-foreground">Total Credit</span>
          </div>
          <p className="text-sm font-semibold text-foreground">
            {parseFloat(aggregatedCredit).toFixed(6)} ETH
          </p>
        </div>
      </div>

      {/* Live Activity Feed */}
      <ScrollArea className="h-64 rounded-lg border border-border bg-secondary/20">
        {isLoadingLogs || isLoadingWallets ? (
          <div className="flex h-full items-center justify-center p-8">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="ml-2 text-xs text-muted-foreground">Loading logs...</span>
          </div>
        ) : logs.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8">
            <p className="text-center text-sm text-muted-foreground">
              {isBotRunning
                ? "Waiting for bot transactions..."
                : "No activity yet. Start bumping to see live transactions."}
            </p>
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {logs.map((log, index) => {
              const walletLabel = getWalletLabel(log.wallet_address, botWallets || [])
              const amountEth = formatEther(BigInt(log.amount_wei))

              return (
                <div
                  key={log.id}
                  className="flex items-center justify-between rounded-md bg-card/50 p-3 transition-all duration-200 hover:bg-card/80 animate-in fade-in slide-in-from-top-2"
                  style={{
                    animationDelay: `${index * 50}ms`,
                  }}
                >
                    <div className="flex flex-1 items-center gap-3 min-w-0">
                      {/* Status Badge */}
                      <Badge
                        variant={
                          log.status === "success"
                            ? "default" // Green (default variant)
                            : log.status === "failed"
                              ? "destructive" // Red
                              : "secondary" // Yellow/Orange (pending)
                        }
                        className="shrink-0"
                      >
                        {log.status === "success"
                          ? "Success"
                          : log.status === "failed"
                            ? "Failed"
                            : "Processing"}
                      </Badge>

                      {/* Activity Info */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="text-xs font-medium text-foreground truncate">
                            {walletLabel}
                          </p>
                          {log.tx_hash && (
                            <a
                              href={`https://basescan.org/tx/${log.tx_hash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="shrink-0 text-muted-foreground hover:text-primary transition-colors"
                              title="View on BaseScan"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Swapped {parseFloat(amountEth).toFixed(6)} ETH for token
                        </p>
                        {log.message && (
                          <p className="mt-1 text-xs text-muted-foreground italic truncate">
                            {log.message}
                          </p>
                        )}
                      </div>

                      {/* Timestamp */}
                      <span className="shrink-0 text-xs text-muted-foreground ml-2">
                        {formatRelativeTime(log.created_at)}
                      </span>
                    </div>
                  </div>
                )
              })}
          </div>
        )}
      </ScrollArea>
    </Card>
  )
}

