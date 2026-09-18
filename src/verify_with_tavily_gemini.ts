// import * as fs from "fs";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const apiKey = process.env.GEMINI_API_KEY;
console.log(" ----- apiKey ------", apiKey);
if (!apiKey) {
  console.error(
    " Error: Set GEMINI_API_KEY environment variable before running.",
  );
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
console.log(" -- TAVILY_API_KEY -- ", TAVILY_API_KEY);

type McpStatus =
  | "Native MCP Available"
  | "Composio/Third-Party MCP"
  | "No MCP / Custom Wrapper Needed";

interface DatasetItem {
  id: number | string;
  app: string;
  mcp_status: McpStatus | string;
  [key: string]: any;
}

interface AuditMismatch {
  id: number | string;
  app: string;
  original_mcp_status: string;
  verified_mcp_status: McpStatus;
  urls_checked: string[];
  reason: string;
  timestamp: string;
}

const inputFilePath = path.join(__dirname, "..", "data", "research copy.json");
if (!fs.existsSync(inputFilePath)) {
  console.error(`❌ Input file not found: ${inputFilePath}`);
  process.exit(1);
}

const rawDataset: DatasetItem[] = JSON.parse(
  fs.readFileSync(inputFilePath, "utf-8"),
);

// Helper: Get TOP 5 URLs ONLY from Tavily
async function getTop5UrlsFromTavily(appName: string): Promise<string[]> {
  const appSlug = appName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const query = `"${appName}"'s official ("Model Context Protocol" OR MCP server) `;
  console.log(" -- query ", query);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: query,
        search_depth: "advanced",
        max_results: 5,
      }),
    });

    const data = await res.json();
    console.log(" -- data ", data);

    // Slice top 5 URLs ONLY, discard snippets/contents/titles
    return (data.results || []).map((r: any) => r.url).slice(0, 5);
  } catch (err) {
    console.error(`⚠️ Tavily error for ${appName}:`, err);
    return [];
  }
}

// Process 20 apps at once inside a single Gemini prompt
async function verifyBatchOf20(batch: DatasetItem[]) {
  console.log(`\n==================================================`);
  console.log(`🚀 Gathering Tavily URLs for Batch of ${batch.length} apps...`);
  console.log(`==================================================`);

  // Step 1: Run Tavily in parallel for all 20 apps
  const tavilyMap: { [app: string]: string[] } = {};
  await Promise.all(
    batch.map(async (item) => {
      const urls = await getTop5UrlsFromTavily(item.app);

      console.log(" \n\n\n--- urls --- ", urls);

      tavilyMap[item.app] = urls;
      console.log(`📡 [${item.app}] extracted ${urls.length} URLs`);
    }),
  );

  // Step 2: Build batch payload containing ONLY app names and their top 5 URLs
  const batchInputPayload = batch.map((item) => ({
    id: item.id,
    app: item.app,
    current_status: item.mcp_status,
    top_5_urls: tavilyMap[item.app] || [],
  }));

  const prompt = `
    You are an integration auditor verifying software metadata for a batch of 20 applications.

    INPUT DATA (Apps & Top 5 Discovered Documentation URLs):
    ${JSON.stringify(batchInputPayload, null, 2)}

    TASK:
    Analyze each app's provided URLs (and perform a live search if URLs are empty) to verify if it supports an official Native MCP server.

    CATEGORIZATION RULES:
    1. "Native MCP Available": Official vendor docs or official GitHub repos confirm a first-party native MCP server.
    2. "Composio/Third-Party MCP": Server is available ONLY via third-party wrappers (Composio, Pipedream, Glama, Obot).
    3. "No MCP / Custom Wrapper Needed": No MCP server exists.

    OUTPUT REQUIREMENT:
    Return strictly a JSON array of objects for all items in the batch:
    [
      {
        "id": 1,
        "app": "AppName",
        "verified_status": "Native MCP Available" | "Composio/Third-Party MCP" | "No MCP / Custom Wrapper Needed",
        "reason": "1-sentence explanation"
      }
    ]
  `;

  console.log(`🤖 Sending Batch of ${batch.length} apps to Gemini...`);

  const geminiResponse = await ai.models.generateContent({
    model: "gemini-3.5-flash",
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
    },
  });

  const responseText = geminiResponse.text || "";
  const cleanText = responseText.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(cleanText);
  } catch (err) {
    console.error("❌ Batch JSON parse error from Gemini output:", err);
    return [];
  }
}

// Chunk helper function
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Execution Loop
// async function runFullAudit() {
//   const verifiedDataset: DatasetItem[] = [];
//   const falseDataList: AuditMismatch[] = [];

//   // Filter items: skip already native items to save credits & time
//   const itemsToVerify = rawDataset.filter((item) => {
//     const status = String(item.mcp_status).trim();
//     return status !== "Native MCP Available";
//   });

//   const alreadyNativeItems = rawDataset.filter((item) => {
//     const status = String(item.mcp_status).trim();
//     return status === "Native MCP Available";
//   });

//   console.log(`\n==================================================`);
//   console.log(`📊 Total Items in Input File: ${rawDataset.length}`);
//   console.log(
//     `⏩ Skipping ${alreadyNativeItems.length} items ("Native MCP Available")`,
//   );
//   console.log(`🔍 Auditing ${itemsToVerify.length} non-native items`);
//   console.log(`==================================================\n`);

//   // Split entire dataset into chunks of 20 apps
//   const batches = chunkArray(itemsToVerify, 20);

//   for (let i = 0; i < batches.length; i++) {
//     const currentBatch = batches[i];
//     console.log(
//       `\n📦 Processing Chunk ${i + 1}/${batches.length} (${currentBatch.length} apps)`,
//     );

//     const batchResults = await verifyBatchOf20(currentBatch);

//     // Reconcile Gemini batch evaluations against initial dataset
//     for (const item of currentBatch) {
//       const match = batchResults.find(
//         (r: any) => String(r.id) === String(item.id) || r.app === item.app,
//       );
//       const verifiedStatus: McpStatus = match
//         ? match.verified_status
//         : (item.mcp_status as McpStatus);
//       const reason: string = match ? match.reason : "Batch evaluation fallback";

//       const currentStatusStr = String(item.mcp_status).trim();
//       const verifiedStatusStr = String(verifiedStatus).trim();

//       if (currentStatusStr !== verifiedStatusStr) {
//         console.log(
//           `🚨 Error Caught on [${item.app}]: "${currentStatusStr}" -> "${verifiedStatusStr}"`,
//         );

//         falseDataList.push({
//           id: item.id,
//           app: item.app,
//           original_mcp_status: currentStatusStr,
//           verified_mcp_status: verifiedStatus,
//           urls_checked: item.top_5_urls || [],
//           reason: reason,
//           timestamp: new Date().toISOString(),
//         });

//         item.mcp_status = verifiedStatus;
//       } else {
//         console.log(`✅ [${item.app}] verified: "${verifiedStatusStr}"`);
//       }

//       verifiedDataset.push(item);
//     }
//   }

//   // Save outputs
//   const outputDir = path.join(__dirname, "..", "data");
//   fs.writeFileSync(
//     path.join(outputDir, "dataset_verified.json"),
//     JSON.stringify(verifiedDataset, null, 2),
//   );
//   fs.writeFileSync(
//     path.join(outputDir, "dataset_audit_log.json"),
//     JSON.stringify(
//       {
//         total_checked: rawDataset.length,
//         false_count: falseDataList.length,
//         mismatches: falseDataList,
//       },
//       null,
//       2,
//     ),
//   );

//   console.log(`\n==================================================`);
//   console.log(
//     `🎉 Batch Audit Complete! Corrected ${falseDataList.length} total entries.`,
//   );
//   console.log(`==================================================`);
// }

async function runFullAudit() {
  const verifiedDataset: DatasetItem[] = [];
  const falseDataList: AuditMismatch[] = [];

  // Skip items that are already marked as Native MCP Available
  const itemsToVerify = rawDataset.filter((item) => {
    const status = String(item.mcp_status).trim();
    return status !== "Native MCP Available";
  });

  // Keep already-native items so they can be added back to the final dataset
  const alreadyNativeItems = rawDataset.filter((item) => {
    const status = String(item.mcp_status).trim();
    return status === "Native MCP Available";
  });

  console.log(`\n==================================================`);
  console.log(`📊 Total Items in Input File: ${rawDataset.length}`);
  console.log(
    `⏩ Skipping ${alreadyNativeItems.length} items ("Native MCP Available")`,
  );
  console.log(`🔍 Auditing ${itemsToVerify.length} non-native items`);
  console.log(`==================================================\n`);

  // Only create batches from items that need verification
  const batches = chunkArray(itemsToVerify, 20);

  for (let i = 0; i < batches.length; i++) {
    const currentBatch = batches[i];

    console.log(
      `\n📦 Processing Chunk ${i + 1}/${batches.length} (${currentBatch.length} apps)`,
    );

    const batchResults = await verifyBatchOf20(currentBatch);

    for (const item of currentBatch) {
      const match = Array.isArray(batchResults)
        ? batchResults.find(
            (r: any) => String(r.id) === String(item.id) || r.app === item.app,
          )
        : undefined;

      const verifiedStatus: McpStatus = match
        ? match.verified_status
        : (item.mcp_status as McpStatus);

      const reason: string = match ? match.reason : "Batch evaluation fallback";

      const currentStatusStr = String(item.mcp_status).trim();
      const verifiedStatusStr = String(verifiedStatus).trim();

      if (currentStatusStr !== verifiedStatusStr) {
        console.log(
          `🚨 Mismatch Found [${item.app}]: "${currentStatusStr}" -> "${verifiedStatusStr}"`,
        );

        falseDataList.push({
          id: item.id,
          app: item.app,
          original_mcp_status: currentStatusStr,
          verified_mcp_status: verifiedStatus,
          urls_checked: item.top_5_urls || [],
          reason: reason,
          timestamp: new Date().toISOString(),
        });

        item.mcp_status = verifiedStatus;
      } else {
        console.log(
          `✅ [${item.app}] verified unchanged: "${verifiedStatusStr}"`,
        );
      }

      verifiedDataset.push(item);
    }

    // Pause between batches
    if (i < batches.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  // Add skipped Native MCP items back
  const finalDataset = [...verifiedDataset, ...alreadyNativeItems];

  const outputDir = path.join(__dirname, "..", "data");

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(outputDir, "dataset_verified.json"),
    JSON.stringify(finalDataset, null, 2),
  );

  fs.writeFileSync(
    path.join(outputDir, "dataset_audit_log.json"),
    JSON.stringify(
      {
        total_items: rawDataset.length,
        total_checked: itemsToVerify.length,
        skipped_already_native: alreadyNativeItems.length,
        false_count: falseDataList.length,
        mismatches: falseDataList,
      },
      null,
      2,
    ),
  );

  console.log(`\n==================================================`);
  console.log(
    `🎉 Batch Audit Complete! Updated ${falseDataList.length} entry mismatches.`,
  );
  console.log(`⏩ Skipped ${alreadyNativeItems.length} already-native items.`);
  console.log(`🔍 Verified ${itemsToVerify.length} non-native items.`);
  console.log(`==================================================`);
}

runFullAudit();
