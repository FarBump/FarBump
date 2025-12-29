"use client"

import { createContext, useContext, useEffect, useState, ReactNode } from "react"
import { sdk } from "@farcaster/miniapp-sdk"

interface FarcasterMiniAppContextType {
  context: any
  isReady: boolean
  isInWarpcast: boolean
}

const FarcasterMiniAppContext = createContext<FarcasterMiniAppContextType>({
  context: null,
  isReady: false,
  isInWarpcast: false,
})

export function useFarcasterMiniApp() {
  return useContext(FarcasterMiniAppContext)
}

interface MiniAppProviderProps {
  children: ReactNode
}

export function MiniAppProvider({ children }: MiniAppProviderProps) {
  const [context, setContext] = useState<any>(null)
  const [isReady, setIsReady] = useState(false)
  const [isInWarpcast, setIsInWarpcast] = useState(false)

  useEffect(() => {
    // Check if running in Warpcast and initialize SDK
    const initializeSDK = async () => {
      if (typeof window === "undefined") return

      try {
        // Try to get context - if this succeeds, we're in Warpcast
        const ctx = await sdk.context()
        
        // We're in Warpcast
        setIsInWarpcast(true)
        setContext(ctx)
        setIsReady(true)
        
        // IMPORTANT: Call ready() to hide splash screen and display app
        // Reference: https://miniapps.farcaster.xyz/docs/getting-started#making-your-app-display
        // After your app loads, you must call sdk.actions.ready()
        // If you don't call ready(), users will see an infinite loading screen
        await sdk.actions.ready()
      } catch (error) {
        // Not in Warpcast or SDK not available
        // Still allow app to run outside Warpcast
        console.log("Not running in Warpcast or SDK not available:", error)
        setIsInWarpcast(false)
        setIsReady(true)
      }
    }

    // Initialize after component mounts
    initializeSDK()
  }, [])

  return (
    <FarcasterMiniAppContext.Provider
      value={{
        context,
        isReady,
        isInWarpcast,
      }}
    >
      {children}
    </FarcasterMiniAppContext.Provider>
  )
}
