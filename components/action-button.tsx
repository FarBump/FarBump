"use client"

import { Button } from "@/components/ui/button"
import { Play, Square, Lock, Loader2 } from "lucide-react"

interface ActionButtonProps {
  isActive: boolean
  onToggle: () => void
  credits?: number
  balanceWei?: string | null // Credit balance in wei (for checking if user has any credit)
  isVerified?: boolean
  buyAmountUsd?: string
  loadingState?: string | null // Loading state message (e.g., "Checking Wallets...")
}

export function ActionButton({ 
  isActive, 
  onToggle, 
  credits = 0,
  balanceWei = null, 
  isVerified = false,
  buyAmountUsd = "0",
  loadingState = null
}: ActionButtonProps) {
  // Button is locked if:
  // - No credits (check both balanceWei and credits USD)
  // - Token not verified
  // - Buy amount not set or invalid
  // Check balanceWei first - user might have ETH credit even if USD conversion fails
  const hasCredit = balanceWei ? BigInt(balanceWei) > BigInt(0) : credits > 0
  const isLocked = !hasCredit || !isVerified || !buyAmountUsd || parseFloat(buyAmountUsd) <= 0
  const isLoading = !!loadingState

  return (
    <Button
      size="lg"
      onClick={isLocked || isLoading ? undefined : onToggle}
      disabled={isLocked || isLoading}
      className={`w-full h-14 text-base font-semibold transition-all ${
        isLocked
          ? "bg-muted text-muted-foreground cursor-not-allowed opacity-50"
          : isLoading
            ? "bg-primary/80 text-primary-foreground cursor-wait"
            : isActive
              ? "bg-destructive hover:bg-destructive/90 text-destructive-foreground"
              : "bg-primary hover:bg-primary/90 text-primary-foreground"
      }`}
    >
      {isLocked ? (
        <>
          <Lock className="mr-2 h-5 w-5" />
          No Fuel Detected
        </>
      ) : isLoading ? (
        <>
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          {loadingState}
        </>
      ) : isActive ? (
        <>
          <Square className="mr-2 h-5 w-5" />
          Stop Bumping
        </>
      ) : (
        <>
          <Play className="mr-2 h-5 w-5" />
          Start Bumping
        </>
      )}
    </Button>
  )
}
