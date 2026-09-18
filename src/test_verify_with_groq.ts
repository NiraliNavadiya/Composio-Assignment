import dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import Groq from "groq-sdk";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

if (!GROQ_API_KEY) {
  console.error(
    "❌ Error: Set GROQ_API_KEY environment variable in .env file.",
  );
  process.exit(1);
}

// Initialize Groq client
const groq = new Groq({ apiKey: GROQ_API_KEY });

type McpStatus =
  | "Native MCP Available"
  | "Composio/Third-Party MCP"
  | "No MCP / Custom Wrapper Needed";

interface DatasetItem {
  id: number | string;
  app: string;
  mcp_status: McpStatus | string;
  top_5_urls?: string[];
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

const inputFilePath = path.join(__dirname, "..", "data", "research.json");
if (!fs.existsSync(inputFilePath)) {
  console.error(`❌ Input file not found: ${inputFilePath}`);
  process.exit(1);
}

const rawDataset: DatasetItem[] = JSON.parse(
  fs.readFileSync(inputFilePath, "utf-8"),
);

// Helper: Get TOP 5 URLs ONLY from Tavily
async function getTop5UrlsFromTavily(appName: string): Promise<string[]> {
  const query = `"${appName}"'s official ("Model Context Protocol" OR MCP server)`;
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
    return (data.results || []).map((r: any) => r.url).slice(0, 5);
  } catch (err) {
    console.error(`⚠️ Tavily error for ${appName}:`, err);
    return [];
  }
}

// Call Groq API with retries
async function getGroqResponse(prompt: string, retries = 3): Promise<string> {
  try {
    const groqResponse = await groq.chat.completions.create({
      model: "openai/gpt-oss-20b",
      // response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a software integration auditor. Return output strictly as a valid JSON object with a single key 'results' containing an array of objects.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "mcp_audit",
          strict: true,
          schema: {
            type: "object",
            properties: {
              results: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: {
                      type: ["string", "number"],
                    },
                    app: {
                      type: "string",
                    },
                    verified_status: {
                      type: "string",
                      enum: [
                        "Native MCP Available",
                        "Composio/Third-Party MCP",
                        "No MCP / Custom Wrapper Needed",
                      ],
                    },
                    reason: {
                      type: "string",
                    },
                  },
                  required: ["id", "app", "verified_status", "reason"],
                  additionalProperties: false,
                },
              },
            },
            required: ["results"],
            additionalProperties: false,
          },
        },
      },
    });

    return groqResponse.choices[0]?.message?.content || "";
  } catch (error: any) {
    if (error?.status === 429 && retries > 0) {
      console.warn("⚠️ Rate limited by Groq. Retrying in 3 seconds...");
      await new Promise((r) => setTimeout(r, 3000));
      return getGroqResponse(prompt, retries - 1);
    }
    console.error("⚠️ Groq API Request failed:", error);
    return "";
  }
}

// Process apps inside a single batch prompt
async function verifyBatchOf20(batch: DatasetItem[]): Promise<any[]> {
  console.log(`\n==================================================`);
  console.log(`🚀 Gathering Tavily URLs for Batch of ${batch.length} apps...`);
  console.log(`==================================================`);

  // Step 1: Run Tavily in parallel for all apps in the batch
  await Promise.all(
    batch.map(async (item) => {
      const urls = await getTop5UrlsFromTavily(item.app);
      item.top_5_urls = urls;
      console.log(`📡 [${item.app}] extracted ${urls.length} URLs`);
    }),
  );

  // Step 2: Build batch payload
  const batchInputPayload = batch.map((item) => ({
    id: item.id,
    app: item.app,
    current_status: item.mcp_status,
    top_5_urls: item.top_5_urls || [],
  }));

  const prompt = `
    Analyze each app's provided URLs to verify its MCP support category.

    INPUT DATA:
    ${JSON.stringify(batchInputPayload, null, 2)}

    STRICT CATEGORIZATION RULES:
    1. "Native MCP Available": Vendor's official docs or official GitHub repo confirms a FIRST-PARTY native MCP server.
    2. "Composio/Third-Party MCP": Server exists ONLY via third-party wrappers or aggregators (Composio, Pipedream, Glama, Obot, or community repos).
    3. "No MCP / Custom Wrapper Needed": No MCP server exists anywhere.

    CRITICAL CONSTRAINTS:
    - Return strictly one of the three exact strings above for "verified_status".
    - Personal or community GitHub repos DO NOT count as "Native MCP Available".

    OUTPUT FORMAT REQUIREMENT:
    Return a JSON object containing a "results" array:
    {
      "results": [
        {
          "id": 1,
          "app": "AppName",
          "verified_status": "Native MCP Available" | "Composio/Third-Party MCP" | "No MCP / Custom Wrapper Needed",
          "reason": "1 concise sentence citing the exact domain or source verified"
        }
      ]
    }
  `;

  console.log(`🤖 Sending Batch of ${batch.length} apps to Groq...`);

  const rawResponseText = await getGroqResponse(prompt);

  console.log(
    "\n --------------------- Groq prompt --------------------- ",
    prompt,
  );
  console.log(
    "\n\n\n\n --------------------- Groq response --------------------- ",
    rawResponseText,
  );

  const cleanText = rawResponseText
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  if (!cleanText) {
    console.error("❌ Received empty response from Groq");
    return [];
  }

  try {
    const parsed = JSON.parse(cleanText);

    if (Array.isArray(parsed)) {
      return parsed;
    } else if (parsed && typeof parsed === "object") {
      if (Array.isArray(parsed.results)) return parsed.results;
      if (Array.isArray(parsed.data)) return parsed.data;
      if (Array.isArray(parsed.apps)) return parsed.apps;

      const keyWithArray = Object.keys(parsed).find((k) =>
        Array.isArray(parsed[k]),
      );
      if (keyWithArray) return parsed[keyWithArray];
    }

    console.error("❌ Groq output did not contain an array:", parsed);
    return [];
  } catch (err) {
    console.error("❌ Batch JSON parse error from Groq output:", err);
    console.error("Raw Text Was:", cleanText);
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

// Main Execution Loop
async function runFullAudit() {
  const verifiedDataset: DatasetItem[] = [];
  const falseDataList: AuditMismatch[] = [];

  // Filter items: skip already native items to save credits & time
  const sitemsToVerify = rawDataset.filter((item) => {
    const status = String(item.mcp_status).trim();
    return status !== "Native MCP Available";
  });

  const salreadyNativeItems = rawDataset.filter((item) => {
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

  // Split ONLY items that need verification into chunks of 20
  const batches = chunkArray(itemsToVerify, 20);

  for (let i = 0; i < batches.length; i++) {
    const currentBatch = batches[i];
    console.log(
      `\n📦 Processing Chunk ${i + 1}/${batches.length} (${currentBatch.length} apps)`,
    );

    const batchResults = await verifyBatchOf20(currentBatch);

    // Reconcile Groq evaluations
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

    // Rate-limit buffer between batches
    if (i < batches.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }

  // Merge audited non-native items back with skipped native items
  const finalDataset = [...verifiedDataset, ...alreadyNativeItems];

  // Save outputs
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
  console.log(`==================================================`);
}

runFullAudit();
//

// (async () => {
//   const response = await getGroqResponse("hi groq");

//   const cleanText = response
//     .replace(/```json\s*/gi, "")
//     .replace(/```\s*/g, "")
//     .trim();

//   console.log(" -- response -- ", response);
//   console.log(" -- cleanText -- ", cleanText);
// })();
