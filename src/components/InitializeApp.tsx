/**
 * Initialize App Component
 * Initializes the polling system on app startup
 * This component runs client-side and calls the /api/health endpoint
 * which triggers server-side polling initialization
 */

"use client";

import { useEffect } from "react";

export function InitializeApp() {
  useEffect(() => {
    // Call health endpoint to initialize polling system
    const initializePolling = async () => {
      try {
        console.log("[InitializeApp] Initializing polling system...");
        const response = await fetch("/api/health");
        const data = await response.json();

        if (response.ok) {
          console.log("[InitializeApp] ✓ Polling system initialized", data);
        } else {
          console.error("[InitializeApp] ✗ Failed to initialize polling system:", data);
        }
      } catch (error) {
        console.error("[InitializeApp] Error during initialization:", error);
      }
    };

    // Initialize on mount
    initializePolling();
  }, []);

  // This component doesn't render anything
  return null;
}
