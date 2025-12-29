"use client"

import { useFarcasterMiniApp } from "@/components/miniapp-provider"
import { usePrivy } from "@privy-io/react-auth"
import { useEffect, useState } from "react"

interface FarcasterUser {
  fid?: number
  username?: string
  displayName?: string
  pfp?: {
    url?: string
  }
}

export function useFarcasterAuth() {
  const { context, isReady, isInWarpcast } = useFarcasterMiniApp()
  const { ready, authenticated, user, login } = usePrivy()
  const [farcasterUser, setFarcasterUser] = useState<FarcasterUser | null>(null)

  useEffect(() => {
    if (isReady && context && isInWarpcast) {
      // Extract Farcaster user data from context
      const userData: FarcasterUser = {
        fid: context.user?.fid,
        username: context.user?.username,
        displayName: context.user?.displayName,
        pfp: context.user?.pfp,
      }
      setFarcasterUser(userData)
    }
  }, [context, isReady, isInWarpcast])

  // Auto-login with Privy if in Warpcast and not authenticated
  useEffect(() => {
    if (isInWarpcast && isReady && ready && !authenticated && context?.user) {
      // Auto-login with Farcaster when in Warpcast
      login({
        method: "farcaster",
      }).catch((error) => {
        console.error("Auto-login failed:", error)
      })
    }
  }, [isInWarpcast, isReady, ready, authenticated, context, login])

  return {
    // Farcaster context
    farcasterContext: context,
    isInWarpcast,
    farcasterUser,
    
    // Privy auth
    isAuthenticated: authenticated,
    privyUser: user,
    privyReady: ready,
    
    // Combined state
    isLoading: !isReady || !ready,
    user: authenticated ? user : null,
  }
}
