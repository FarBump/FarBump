"use client"

import { useEffect } from "react"
import { sdk } from "@farcaster/miniapp-sdk"
import { useFarcasterMiniApp } from "@/components/miniapp-provider"

/**
 * SDKReady component - calls sdk.actions.ready() after app is fully loaded
 * This is required to hide the splash screen and display the app content.
 * 
 * Reference: https://miniapps.farcaster.xyz/docs/getting-started#making-your-app-display
 * 
 * Important: If you don't call ready(), users will see an infinite loading screen.
 */
export function SDKReady() {
  const { isReady, isInWarpcast } = useFarcasterMiniApp()

  useEffect(() => {
    // Call ready() after app is fully loaded and ready to display
    // This must be called to hide the splash screen
    if (isReady && isInWarpcast) {
      sdk.actions.ready().catch((error: unknown) => {
        console.error("Failed to call SDK ready():", error)
      })
    }
  }, [isReady, isInWarpcast])

  return null
}

