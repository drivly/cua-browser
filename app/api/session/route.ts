import { NextResponse } from "next/server";
import Browserbase from "@browserbasehq/sdk";
import { chromium } from "playwright-core";

type BrowserbaseRegion =
  | "us-west-2"
  | "us-east-1"
  | "eu-central-1"
  | "ap-southeast-1";

// Exact timezone matches for east coast cities
const exactTimezoneMap: Record<string, BrowserbaseRegion> = {
  "America/New_York": "us-east-1",
  "America/Detroit": "us-east-1",
  "America/Toronto": "us-east-1",
  "America/Montreal": "us-east-1",
  "America/Boston": "us-east-1",
  "America/Chicago": "us-east-1",
};

// Prefix-based region mapping
const prefixToRegion: Record<string, BrowserbaseRegion> = {
  America: "us-west-2",
  US: "us-west-2",
  Canada: "us-west-2",
  Europe: "eu-central-1",
  Africa: "eu-central-1",
  Asia: "ap-southeast-1",
  Australia: "ap-southeast-1",
  Pacific: "ap-southeast-1",
};

// Offset ranges to regions (inclusive bounds)
const offsetRanges: {
  min: number;
  max: number;
  region: BrowserbaseRegion;
}[] = [
  { min: -24, max: -4, region: "us-west-2" }, // UTC-24 to UTC-4
  { min: -3, max: 4, region: "eu-central-1" }, // UTC-3 to UTC+4
  { min: 5, max: 24, region: "ap-southeast-1" }, // UTC+5 to UTC+24
];

function getClosestRegion(timezone?: string): BrowserbaseRegion {
  try {
    if (!timezone) {
      return "us-west-2"; // Default if no timezone provided
    }

    // Check exact matches first
    if (timezone in exactTimezoneMap) {
      return exactTimezoneMap[timezone];
    }

    // Check prefix matches
    const prefix = timezone.split("/")[0];
    if (prefix in prefixToRegion) {
      return prefixToRegion[prefix];
    }

    // Use offset-based fallback
    const date = new Date();
    // Create a date formatter for the given timezone
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    // Get the timezone offset in minutes
    const timeString = formatter.format(date);
    const testDate = new Date(timeString);
    const hourOffset = (testDate.getTime() - date.getTime()) / (1000 * 60 * 60);

    const matchingRange = offsetRanges.find(
      (range) => hourOffset >= range.min && hourOffset <= range.max
    );

    return matchingRange?.region ?? "us-west-2";
  } catch {
    return "us-west-2";
  }
}

async function createSession(timezone?: string) {
  const bb = new Browserbase({
    apiKey: process.env.BROWSERBASE_API_KEY!,
  });

  console.log("timezone ", timezone);
  console.log("getClosestRegion(timezone)", getClosestRegion(timezone));

  const session = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID!,
    keepAlive: true,
    region: getClosestRegion(timezone),
    timeout: 600,
    browserSettings: {
      fingerprint: {
        browsers: ["chrome", "firefox", "edge", "safari"],
        devices: ["desktop", "mobile"],
        locales: ["en-US", "en-GB"],
        operatingSystems: ["android", "ios", "linux", "macos", "windows"],
        screen: {
          maxWidth: 1920,
          maxHeight: 1080,
          minWidth: 1024,
          minHeight: 768,
        }
      },
      viewport: {
        width: 1920,
        height: 1080,
      },
      solveCaptchas: true,
    },
    proxies: true,
  });
  return {
    session
  };
}

async function endSession(sessionId: string) {
  const bb = new Browserbase({
    apiKey: process.env.BROWSERBASE_API_KEY!,
  });
  await bb.sessions.update(sessionId, {
    projectId: process.env.BROWSERBASE_PROJECT_ID!,
    status: "REQUEST_RELEASE",
  });
}

async function getDebugUrl(sessionId: string) {
  const bb = new Browserbase({
    apiKey: process.env.BROWSERBASE_API_KEY!,
  });
  const session = await bb.sessions.debug(sessionId);
  return session.debuggerFullscreenUrl;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const timezone = body.timezone as string;
    const { session } = await createSession(
      timezone
    );
    const browser = await chromium.connectOverCDP(session.connectUrl);
    const defaultContext = browser.contexts()[0];
    const page = defaultContext.pages()[0];
    await page.goto("https://www.google.com", { waitUntil: "domcontentloaded" });
    const liveUrl = await getDebugUrl(session.id);
    return NextResponse.json({
      success: true,
      sessionId: session.id,
      sessionUrl: liveUrl,
      connectUrl: session.connectUrl
    });
  } catch (error) {
    console.error("Error creating session:", error);
    return NextResponse.json(
      { success: false, error: "Failed to create session" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  const body = await request.json();
  const sessionId = body.sessionId as string;
  await endSession(sessionId);
  return NextResponse.json({ success: true });
}
