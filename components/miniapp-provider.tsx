"use client"

import { createContext, useContext, useEffect, useState, ReactNode } from "react"

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
    // Check if running in Warpcast
    const checkWarpcast = () => {
      if (typeof window !== "undefined") {
        // Check for Farcaster Mini App context
        const farcaster = (window as any).farcaster
        if (farcaster) {
          setIsInWarpcast(true)
          
          // Initialize Mini App context
          farcaster
            .context()
            .then((ctx: any) => {
              setContext(ctx)
              setIsReady(true)
            })
            .catch((error: Error) => {
              console.error("Failed to get Farcaster context:", error)
              setIsReady(false)
            })
        } else {
          // Not in Warpcast, but still allow app to run
          setIsInWarpcast(false)
          setIsReady(true)
        }
      }
    }

    checkWarpcast()

    // Listen for context updates
    if (typeof window !== "undefined" && (window as any).farcaster) {
      const farcaster = (window as any).farcaster
      
      // Subscribe to context changes
      if (farcaster.onContextChange) {
        farcaster.onContextChange((newContext: any) => {
          setContext(newContext)
        })
      }
    }
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

