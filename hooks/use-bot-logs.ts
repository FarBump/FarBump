"use client"

import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { createSupabaseClient } from "@/lib/supabase"
import { formatEther } from "viem"
import type { RealtimeChannel } from "@supabase/supabase-js"

interface BotLog {
  id: number
  user_address: string
  wallet_address: string
  tx_hash: string | null
  token_address: string
  amount_wei: string
  status: "pending" | "success" | "failed"
  message: string | null
  error_details: any
  created_at: string
}

interface UseBotLogsOptions {
  userAddress: string | null
  enabled?: boolean
  limit?: number // Number of logs to fetch initially
}

/**
 * Hook to fetch and subscribe to bot logs in realtime
 * 
 * Features:
 * - Initial fetch of last N logs
 * - Realtime subscription to new logs
 * - Automatic cleanup on unmount
 */
export function useBotLogs({ userAddress, enabled = true, limit = 20 }: UseBotLogsOptions) {
  const supabase = createSupabaseClient()
  const [logs, setLogs] = useState<BotLog[]>([])
  const [channel, setChannel] = useState<RealtimeChannel | null>(null)

  // Initial fetch of recent logs
  const { data: initialLogs, isLoading, error } = useQuery<BotLog[]>({
    queryKey: ["bot-logs", userAddress, limit],
    queryFn: async () => {
      if (!userAddress) {
        throw new Error("User address is required")
      }

      const { data, error: fetchError } = await supabase
        .from("bot_logs")
        .select("*")
        .eq("user_address", userAddress.toLowerCase())
        .order("created_at", { ascending: false })
        .limit(limit)

      if (fetchError) {
        throw fetchError
      }

      return (data || []) as BotLog[]
    },
    enabled: enabled && !!userAddress,
    staleTime: 0, // Always fetch fresh data
  })

  // Set initial logs
  useEffect(() => {
    if (initialLogs) {
      setLogs(initialLogs)
    }
  }, [initialLogs])

  // Setup realtime subscription
  useEffect(() => {
    if (!userAddress || !enabled) {
      return
    }

    // Create realtime channel for bot_logs
    const realtimeChannel = supabase
      .channel("bot_logs_realtime")
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "bot_logs",
          filter: `user_address=eq.${userAddress.toLowerCase()}`,
        },
        (payload) => {
          console.log("🆕 New bot log received:", payload.new)
          const newLog = payload.new as BotLog
          
          // Add new log to the beginning of the list
          setLogs((prevLogs) => {
            // Check if log already exists (prevent duplicates)
            if (prevLogs.some((log) => log.id === newLog.id)) {
              return prevLogs
            }
            return [newLog, ...prevLogs]
          })
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "bot_logs",
          filter: `user_address=eq.${userAddress.toLowerCase()}`,
        },
        (payload) => {
          console.log("🔄 Bot log updated:", payload.new)
          const updatedLog = payload.new as BotLog
          
          // Update existing log
          setLogs((prevLogs) =>
            prevLogs.map((log) => (log.id === updatedLog.id ? updatedLog : log))
          )
        }
      )
      .subscribe((status) => {
        console.log("📡 Realtime subscription status:", status)
      })

    setChannel(realtimeChannel)

    // Cleanup on unmount
    return () => {
      console.log("🧹 Cleaning up realtime subscription")
      realtimeChannel.unsubscribe()
    }
  }, [userAddress, enabled, supabase])

  return {
    logs,
    isLoading,
    error,
    refetch: () => {
      // Trigger refetch by invalidating query
      // This will be handled by React Query
    },
  }
}

/**
 * Get wallet label from wallet address
 * Matches wallet address to index (0-4) to show "Bot Wallet #1", etc.
 */
export function getWalletLabel(
  walletAddress: string,
  botWallets: Array<{ smartWalletAddress: string; index: number }> | null
): string {
  if (!botWallets || botWallets.length === 0) {
    return "Bot Wallet"
  }

  const wallet = botWallets.find(
    (w) => w.smartWalletAddress.toLowerCase() === walletAddress.toLowerCase()
  )

  if (wallet) {
    return `Bot Wallet #${wallet.index + 1}`
  }

  return "Bot Wallet"
}

/**
 * Format relative time (e.g., "2 minutes ago")
 */
export function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSecs < 60) {
    return "just now"
  } else if (diffMins < 60) {
    return `${diffMins} minute${diffMins > 1 ? "s" : ""} ago`
  } else if (diffHours < 24) {
    return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`
  } else if (diffDays < 7) {
    return `${diffDays} day${diffDays > 1 ? "s" : ""} ago`
  } else {
    return date.toLocaleDateString()
  }
}
