import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";

// Navigate up one directory to reach D:\Apps\Composio Assignment\.env
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// CONFIGURATION: Set your dynamic batch size here
const BATCH_SIZE = 5;

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error(
    " Error: Set GEMINI_API_KEY environment variable before running.",
  );
  process.exit(1);
}

console.log(" -- apiKey -- ", apiKey);

const genAI = new GoogleGenerativeAI(apiKey);

const appsPath = path.join(__dirname, "../data/apps.json");
const researchPath = path.join(__dirname, "../data/research.json");

const allApps = JSON.parse(fs.readFileSync(appsPath, "utf-8"));

// Enforce structured output schema for each app item
const appSchema = {
  type: SchemaType.OBJECT,
  properties: {
    id: {
      type: SchemaType.INTEGER,
      description: "Matches original app ID from apps.json",
    },
    app: { type: SchemaType.STRING, description: "Official application name" },
    category: {
      type: SchemaType.STRING,
      description: "Assigned category from apps.json",
    },
    one_liner: {
      type: SchemaType.STRING,
      description: "Single line explanation of what the app does",
    },
    auth_methods: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
      description:
        "Array of: OAuth2, API Key, Basic, Bearer Token, Custom/None",
    },
    access_model: {
      type: SchemaType.STRING,
      description:
        "Allowed: Self-serve (Free/Trial), Paid-Gated, Admin Approval, Contact Sales / Partner-Gated",
    },
    api_surface: {
      type: SchemaType.OBJECT,
      properties: {
        type: {
          type: SchemaType.STRING,
          description: "REST, GraphQL, gRPC, Hybrid, or None/Scrape-Only",
        },
        breadth: {
          type: SchemaType.STRING,
          description:
            "Narrow (<10 endpoints), Moderate (10-50), or Extensive (>50)",
        },
      },
      required: ["type", "breadth"],
    },
    mcp_status: {
      type: SchemaType.STRING,
      description:
        "Native MCP Available, Third-Party MCP, or No MCP / Custom Wrapper Needed",
    },
    buildability_verdict: {
      type: SchemaType.STRING,
      description:
        "Instant Win (Ready), Possible with Workaround, or Blocked / High Friction",
    },
    primary_blocker: {
      type: SchemaType.STRING,
      description: "Friction point or 'None'",
    },
    docs_url: {
      type: SchemaType.STRING,
      description: "Direct developer documentation or API reference link",
    },
  },
  required: [
    "id",
    "app",
    "category",
    "one_liner",
    "auth_methods",
    "access_model",
    "api_surface",
    "mcp_status",
    "buildability_verdict",
    "primary_blocker",
    "docs_url",
  ],
};

const outputSchema = {
  type: SchemaType.ARRAY,
  items: appSchema,
  description:
    "Array of research results for the requested batch of integrations.",
};

const model = genAI.getGenerativeModel({
  model: "gemini-3.5-flash-lite",
  // tools: [{ googleSearch: {} }],
  generationConfig: {
    responseMimeType: "application/json",
    responseSchema: outputSchema,
    temperature: 0.1,
  },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function processAllInBatches(batchSize: number) {
  let currentResearch: any[] = fs.existsSync(researchPath)
    ? JSON.parse(fs.readFileSync(researchPath, "utf-8"))
    : [];

  const completedIds = new Set(currentResearch.map((r) => r.id));
  const remainingApps = allApps.filter((a: any) => !completedIds.has(a.id));

  console.log(`\n Total Apps in Input: ${allApps.length}`);
  console.log(` Already Completed: ${completedIds.size}`);
  console.log(` Remaining to Process: ${remainingApps.length}`);
  console.log(` Configured Batch Size: ${batchSize}\n`);

  if (remainingApps.length === 0) {
    console.log(
      " All apps have already been researched and saved to data/research.json!",
    );
    return;
  }

  // Loop dynamically through dataset using the batchSize variable
  for (let i = 0; i < remainingApps.length; i += batchSize) {
    const currentBatch = remainingApps.slice(i, i + batchSize);
    const batchRange = `[${i + 1} to ${Math.min(i + batchSize, remainingApps.length)}]`;

    console.log(
      ` Sending API Request for Batch ${batchRange} (${currentBatch.length} apps)...`,
    );

    const prompt = `
    Conduct an API accessibility audit for Composio AI Tooling on the following ${currentBatch.length} applications.

    Target Applications:
    ${JSON.stringify(currentBatch, null, 2)}

    STRICT AUDIT INSTRUCTIONS:
    1. Perform web search verification on official documentation (docs.*, developer.*, api.*) for each app.
    2. Maintain the exact numeric "id" provided in the input list for each app.
    3. Return a JSON array containing exactly ${currentBatch.length} research objects following the output schema.
    `;

    try {
      const result = await model.generateContent(prompt);
      const parsedBatch: any[] = JSON.parse(result.response.text());

      parsedBatch.forEach((item) => {
        item.id = Number(item.id);
      });

      currentResearch = currentResearch
        .filter(
          (existing) =>
            !parsedBatch.some((newRes) => newRes.id === existing.id),
        )
        .concat(parsedBatch);

      currentResearch.sort((a, b) => a.id - b.id);

      fs.writeFileSync(researchPath, JSON.stringify(currentResearch, null, 2));

      console.log(
        ` Batch ${batchRange} complete and saved! Total progress: ${currentResearch.length}/${allApps.length}\n`,
      );
    } catch (err) {
      console.error(` Batch ${batchRange} failed:`, err);
      console.log(
        " You can re-run the script anytime; it will automatically retry uncompleted apps.",
      );
    }

    if (i + batchSize < remainingApps.length) {
      console.log(" Waiting 5 seconds before next request...");
      await sleep(5000);
    }
  }

  console.log(
    ` Finished processing! All records updated in data/research.json.`,
  );
}

// Pass the declared BATCH_SIZE variable into execution function
processAllInBatches(BATCH_SIZE);
