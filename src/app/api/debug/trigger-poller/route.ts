/**
 * Manual poller trigger for debugging
 * GET /api/debug/trigger-poller
 * 
 * This endpoint manually runs a polling cycle to test task creation logic
 */
import { runPollCycle } from "@/lib/engine/poller";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    console.log("[DebugPoller] Manual trigger started");
    await runPollCycle();
    console.log("[DebugPoller] Manual trigger completed");
    
    return NextResponse.json({
      success: true,
      message: "Polling cycle executed. Check server logs for details.",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[DebugPoller] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
