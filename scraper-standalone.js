#!/usr/bin/env node

/**
 * VW of West Islip Inventory Scraper (CarGurus Source)
 * 
 * Standalone script that uses Playwright to scrape CarGurus for VW of West Islip inventory
 * and push inventory data to the mobile app API.
 * 
 * Usage:
 *   node scraper-standalone.js --api-url https://your-app-url.com --api-key YOUR_KEY
 * 
 * Or set environment variables:
 *   API_URL=https://your-app-url.com API_KEY=YOUR_KEY node scraper-standalone.js
 */

const playwright = require("playwright");
const https = require("https");
const http = require("http");

const INVENTORY_URL = "https://www.cargurus.com/Cars/m-Volkswagen-of-West-Islip-sp285330";
const API_URL = process.env.API_URL || "http://localhost:3000";
const API_KEY = process.env.API_KEY || "";

async function scrapeInventory() {
  console.log(`[${new Date().toISOString()}] Starting inventory scrape from CarGurus...`);

  let browser;
  try {
    // Launch browser with headless mode
    browser = await playwright.chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    const context = await browser.createBrowserContext();
    const page = await context.newPage();

    // Set a realistic user agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    );

    console.log(`[${new Date().toISOString()}] Navigating to ${INVENTORY_URL}...`);
    await page.goto(INVENTORY_URL, { waitUntil: "networkidle", timeout: 60000 });

    // Wait for vehicle listings to load
    console.log(`[${new Date().toISOString()}] Waiting for vehicle listings...`);
    await page.waitForSelector('[class*="ListingCard"], [class*="listing-card"], [class*="vehicle"]', {
      timeout: 30000,
    }).catch(() => {
      console.log("[INFO] Vehicle selector not found, trying alternative selectors...");
    });

    // Scroll to load more listings
    console.log(`[${new Date().toISOString()}] Scrolling to load more listings...`);
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(1000);
    }

    // Extract vehicle data from CarGurus
    const vehicles = await page.evaluate(() => {
      const results = [];

      // CarGurus uses specific classes for listings
      document.querySelectorAll('[class*="ListingCard"], [class*="listing-card"], [class*="vehicle-card"], article, [role="article"]').forEach((el) => {
        try {
          // Get title (year make model)
          const titleEl = el.querySelector('h2, h3, [class*="title"], [class*="heading"], [class*="Name"]');
          const title = titleEl?.textContent?.trim() || "";

          // Get price
          const priceEl = el.querySelector('[class*="price"], [class*="Price"], [class*="PRICE"]');
          const price = priceEl?.textContent?.trim() || "";

          // Get mileage
          const mileageEl = el.querySelector('[class*="mileage"], [class*="Mileage"], [class*="miles"]');
          const mileage = mileageEl?.textContent?.trim() || "";

          // Get image
          const imageEl = el.querySelector('img');
          const imageUrl = imageEl?.src || imageEl?.getAttribute('data-src') || "";

          // Get detail link
          const linkEl = el.querySelector('a[href*="/Cars/"], a[href*="cargurus"]');
          const detailUrl = linkEl?.href || "";

          // Extract year, make, model from title
          const titleMatch = title.match(/(\d{4})\s+(\w+)\s+(.+)/);
          const year = titleMatch ? parseInt(titleMatch[1]) : null;
          const make = titleMatch ? titleMatch[2] : null;
          const model = titleMatch ? titleMatch[3].split(/\s+/)[0] : null;

          if (title && (price || mileage)) {
            results.push({
              title,
              year,
              make,
              model,
              price,
              mileage,
              imageUrl,
              detailUrl,
            });
          }
        } catch (e) {
          // Skip elements that error
        }
      });

      return results;
    });

    console.log(`[${new Date().toISOString()}] Found ${vehicles.length} vehicles`);

    if (vehicles.length === 0) {
      console.warn("[WARNING] No vehicles found. The page structure may have changed.");
      console.log("[INFO] Dumping page title and URL for debugging...");
      const title = await page.title();
      const url = page.url();
      console.log(`Page title: ${title}`);
      console.log(`Page URL: ${url}`);
    }

    // Parse vehicle data
    const parsedVehicles = vehicles.map((v) => parseVehicle(v)).filter(Boolean);

    console.log(`[${new Date().toISOString()}] Parsed ${parsedVehicles.length} vehicles`);

    // Send to API
    if (parsedVehicles.length > 0) {
      await sendToAPI(parsedVehicles);
    } else {
      console.warn("[WARNING] No vehicles to send to API");
    }

    await context.close();
    await browser.close();

    console.log(`[${new Date().toISOString()}] Scrape completed successfully`);
  } catch (error) {
    console.error(`[ERROR] Scrape failed: ${error.message}`);
    if (browser) {
      await browser.close();
    }
    process.exit(1);
  }
}

function parseVehicle(raw) {
  try {
    // Parse title: "2021 Volkswagen Jetta SE"
    const titleMatch = raw.title.match(/(\d{4})\s+(\w+)\s+(.+)/);
    const year = titleMatch ? parseInt(titleMatch[1]) : raw.year;
    const make = titleMatch ? titleMatch[2] : raw.make;
    const modelTrim = titleMatch ? titleMatch[3] : raw.model;

    // Parse price: "$24,999" or "24999"
    const priceMatch = raw.price.match(/[\d,]+/);
    const price = priceMatch ? parseInt(priceMatch[0].replace(/,/g, "")) : null;

    // Parse mileage: "151,064 Miles" or "151064"
    const mileageMatch = raw.mileage.match(/[\d,]+/);
    const mileage = mileageMatch ? parseInt(mileageMatch[0].replace(/,/g, "")) : null;

    // Generate a unique VIN-like identifier from the detail URL
    const vinMatch = raw.detailUrl.match(/\/(\d+)\/?$/);
    const vin = vinMatch ? `CGU-${vinMatch[1]}` : `CGU-${Date.now()}`;

    return {
      vin,
      year,
      make,
      model: modelTrim?.split(/\s+/)[0] || null,
      trim: modelTrim?.split(/\s+/).slice(1).join(" ") || null,
      price,
      mileage,
      imageUrl: raw.imageUrl,
      detailUrl: raw.detailUrl,
      stockNumber: null,
      exteriorColor: null,
      interiorColor: null,
    };
  } catch (error) {
    console.error(`[ERROR] Failed to parse vehicle: ${error.message}`);
    return null;
  }
}

async function sendToAPI(vehicles) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      vehicles,
    });

    const url = new URL(`${API_URL}/api/trpc/inventory.sync`);
    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    if (API_KEY) {
      options.headers["Authorization"] = `Bearer ${API_KEY}`;
    }

    console.log(`[${new Date().toISOString()}] Sending ${vehicles.length} vehicles to ${API_URL}...`);

    const req = client.request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[${new Date().toISOString()}] API response: ${data}`);
          resolve();
        } else {
          reject(new Error(`API returned ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// Run scraper
scrapeInventory().catch((error) => {
  console.error("[FATAL]", error);
  process.exit(1);
});
