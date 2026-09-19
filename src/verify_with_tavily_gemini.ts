import dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("❌ Error: Set GEMINI_API_KEY or GOOGLE_API_KEY in .env");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

type McpStatus = "Native MCP Available" | "Third-Party MCP" | "No MCP ";

interface DatasetItem {
  id: number | string;
  human_verification: string | undefined;
  app: string;
  url: string;
  mcp_status: McpStatus | string;
  search_evidence?: string[];
  mcp_server_url: string | undefined;
  [key: string]: any;
}

interface AuditMismatch {
  id: number | string;
  human_verification: string | undefined;
  app: string;
  original_mcp_status: string;
  verified_mcp_status: McpStatus;
  search_evidence: string[] | undefined;
  mcp_server_url: string | undefined;
  reason: string;
  timestamp: string;
}

const inputFilePath = path.join(__dirname, "..", "data", "research.json");
const rawDataset: DatasetItem[] = JSON.parse(
  fs.readFileSync(inputFilePath, "utf-8"),
);

// 1. Fetch web search snippets AND URLs from Tavily
async function getTop5UrlsFromTavily(appName: string): Promise<string[]> {
  const appSlug = appName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const query = `${appName} Native MCP server`;
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: query,
        search_depth: "advanced",
        max_results: 7,
      }),
    });

    const data = await res.json();
    const result = (data.results || []).map((r: any) => r.url).filter(Boolean);

    return result;
  } catch (err) {
    console.error(`⚠️ Tavily error for ${appName}:`, err);
    return [];
  }
}

// 2. Query Gemini model using structured JSON Schema output
async function getGeminiResponse(prompt: string, retries = 3): Promise<string> {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-3.5-flash-lite",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
          type: SchemaType.OBJECT,
          properties: {
            results: {
              type: SchemaType.ARRAY,
              items: {
                type: SchemaType.OBJECT,
                properties: {
                  id: { type: SchemaType.STRING },
                  app: { type: SchemaType.STRING },
                  verified_status: {
                    type: SchemaType.STRING,
                    format: "enum",
                    enum: [
                      "Native MCP Available",
                      "Third-Party MCP",
                      "No MCP / Custom Wrapper Needed",
                    ],
                  },
                  mcp_server_url: { type: SchemaType.STRING },
                  reason: { type: SchemaType.STRING },
                },
                required: ["id", "app", "verified_status", "reason"],
              },
            },
          },
          required: ["results"],
        },
      },
    });

    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (error: any) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 3000));
      return getGeminiResponse(prompt, retries - 1);
    }
    console.error("⚠️ Gemini API Error:", error);
    return "";
  }
}

// 3. Process batch without sending mcp_status (removes bias & injects input data)
async function verifyBatch(batch: DatasetItem[]) {
  await Promise.all(
    batch.map(async (item) => {
      item.search_evidence = await getTop5UrlsFromTavily(item.app);
    }),
  );

  // ✅ FIXED
  const batchInputPayload = batch.map((item) => ({
    id: String(item.id),
    app: item.app,
    url: item.url || "",
    search_evidence: item.search_evidence || [],
  }));

  console.log(" ==== batchInputPayload === ", batchInputPayload);
  const prompt = `
  You are an objective integration auditor. Your job is to verify whether an application supports Model Context Protocol (MCP).

  INPUT DATA (Contains target apps and their official website URLs):
  ${JSON.stringify(batchInputPayload, null, 2)}

  CLASSIFICATION RULES FOR "mcp_status":
  1. "Native MCP Available":
       - An MCP server is considered official/native ONLY IF the search evidence contains an MCP server link hosted directly on the app's official domain or official vendor GitHub organization.
       - Set "mcp_server_url" to that official URL.

    2. "Third-Party MCP":
       - An MCP server exists, BUT the URL points to a personal/community GitHub user account or third-party aggregators/directories (e.g., Composio, Glama, Obot, PulseMCP, MCPLists, Smithery, Smithery.ai).
       - Set "mcp_server_url" to that third-party repository or listing URL.

    3. "No MCP / Custom Wrapper Needed":
       - No MCP server implementation is found.
       - Set "mcp_server_url" to an empty string ("").

  Provide your audit decisions for each item following the schema.
  `;

  const rawResponse = await getGeminiResponse(prompt);
  try {
    const parsed = JSON.parse(rawResponse);
    return parsed.results || [];
  } catch (err) {
    return [];
  }
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// 4. Main Execution Loop
async function runFullAudit() {
  const verifiedDataset: DatasetItem[] = [];
  const falseDataList: AuditMismatch[] = [];

  const alreadyNativeItems = rawDataset.filter(
    (item) => String(item.mcp_status).trim() === "Official MCP Available",
  );

  console.log(`📊 Total Items: ${rawDataset.length}`);
  console.log(`⏩ Skipping ${alreadyNativeItems.length} Official MCP items`);
  console.log(`🔍 Auditing ${rawDataset.length} Non-Official items`);

  const batches = chunkArray(rawDataset, 20);

  for (let i = 0; i < batches.length; i++) {
    console.log(`⏳ Processing Batch ${i + 1} of ${batches.length}...`);
    const currentBatch = batches[i];
    const batchResults = await verifyBatch(currentBatch);

    for (const item of currentBatch) {
      const match = batchResults.find(
        (r: any) => String(r.id) === String(item.id) || r.app === item.app,
      );

      const verifiedStatus: McpStatus = match
        ? match.verified_status
        : (item.mcp_status as McpStatus);

      // 👇 CHANGE 4: Capture extracted URL and assign it
      const verifiedMcpUrl = match
        ? match.mcp_server_url
        : item.mcp_server_url || "";
      const reason = match ? match.reason : "Fallback to original";
      const searchEvidence = match ? match.search_evidence : [];
      const currentStatusStr = String(item.mcp_status).trim();
      const verifiedStatusStr = String(verifiedStatus).trim();

      const humanCheckValue = "check mcp server url";

      // 👇 CHANGE 4: Update item properties (Add mcp_server_url, remove search_evidence)
      item.mcp_server_url = verifiedMcpUrl;
      // delete item.search_evidence;

      if (currentStatusStr !== verifiedStatusStr) {
        console.log(
          `🚨 Mismatch [${item.app}]: "${currentStatusStr}" -> "${verifiedStatusStr}"`,
        );
        falseDataList.push({
          id: item.id,
          app: item.app,
          original_mcp_status: currentStatusStr,
          verified_mcp_status: verifiedStatus,
          mcp_server_url: verifiedMcpUrl, // 👈 Added to audit log too
          human_verification: humanCheckValue,
          search_evidence: item.search_evidence,
          reason: reason,
          timestamp: new Date().toISOString(),
        });

        item.mcp_status = verifiedStatus;
        item.human_verification = humanCheckValue;
      }

      verifiedDataset.push(item);
    }
  }

  const finalDataset = [...verifiedDataset, ...alreadyNativeItems];
  const outputDir = path.join(__dirname, "..", "data");

  // 👇 Strip search_evidence from every item specifically for the final verified dataset file
  const cleanedFinalDataset = finalDataset.map((item) => {
    const copy = { ...item };
    delete copy.search_evidence;
    return copy;
  });

  fs.writeFileSync(
    path.join(outputDir, "dataset_verified.json"),
    JSON.stringify(cleanedFinalDataset, null, 2), // 👈 Using cleanedFinalDataset here
  );
  fs.writeFileSync(
    path.join(outputDir, "dataset_audit_log.json"),
    JSON.stringify(
      {
        total_checked: rawDataset.length,
        skipped_already_native: alreadyNativeItems.length,
        false_count: falseDataList.length,
        mismatches: falseDataList,
      },
      null,
      2,
    ),
  );

  console.log(`🎉 Complete! Corrected ${falseDataList.length} mismatches.`);
}

runFullAudit();
