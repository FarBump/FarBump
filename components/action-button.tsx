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
  hasBotWallets?: boolean // Whether user has 5 bot wallets created
}

export function ActionButton({ 
  isActive, 
  onToggle, 
  credits = 0,
  balanceWei = null, 
  isVerified = false,
  buyAmountUsd = "0",
  loadingState = null,
  hasBotWallets = false
}: ActionButtonProps) {
  // CRITICAL: Check credit using BigInt to avoid precision loss
  // balance_wei is stored as string in database, must use BigInt for comparison
  const hasCredit = balanceWei ? BigInt(balanceWei) > BigInt(0) : credits > 0
  
  // Button is locked if:
  // - No credits (check balanceWei first using BigInt)
  // - Token not verified (only required if bot wallets exist)
  // - Buy amount not set or invalid (only required if bot wallets exist)
  // If no bot wallets, user can still click to generate wallets (token verification not required yet)
  const isLocked = !hasCredit || (hasBotWallets && (!isVerified || !buyAmountUsd || parseFloat(buyAmountUsd) <= 0))
  const isLoading = !!loadingState
  
  // Determine button text based on state:
  // - If credit 0: 'No fuel detected'
  // - If credit > 0 but bot wallets not created: 'Generate Bot Wallet'
  // - If credit > 0 and bot wallets exist: 'Start Bumping' (or 'Stop Bumping' if active)
  const getButtonText = () => {
    if (isActive) {
      return "Stop Bumping"
    }
    if (!hasCredit) {
      return "No Fuel Detected"
    }
    if (!hasBotWallets) {
      return "Generate Bot Wallet"
    }
    return "Start Bumping"
  }
  
  const buttonText = getButtonText()

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
          {buttonText}
        </>
      ) : isLoading ? (
        <>
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          {loadingState}
        </>
      ) : isActive ? (
        <>
          <Square className="mr-2 h-5 w-5" />
          {buttonText}
        </>
      ) : (
        <>
          <Play className="mr-2 h-5 w-5" />
          {buttonText}
        </>
      )}
    </Button>
  )
}
