"use client"

import { Button } from "@/components/ui/button"
import { Play, Square, Lock } from "lucide-react"

interface ActionButtonProps {
  isActive: boolean
  onToggle: () => void
  credits?: number
  isVerified?: boolean
  buyAmountUsd?: string
}

export function ActionButton({ 
  isActive, 
  onToggle, 
  credits = 0, 
  isVerified = false,
  buyAmountUsd = "0"
}: ActionButtonProps) {
  // Button is locked if:
  // - No credits
  // - Token not verified
  // - Buy amount not set or invalid
  const isLocked = credits === 0 || !isVerified || !buyAmountUsd || parseFloat(buyAmountUsd) <= 0

  return (
    <Button
      size="lg"
      onClick={isLocked ? undefined : onToggle}
      disabled={isLocked}
      className={`w-full h-14 text-base font-semibold transition-all ${
        isLocked
          ? "bg-muted text-muted-foreground cursor-not-allowed opacity-50"
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
