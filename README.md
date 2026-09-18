```markdown
# Multi-Pass Dataset Research & Verification Pipeline

An automated data research and verification pipeline designed to discover, classify, and audit software integration data (such as Model Context Protocol / MCP implementations). Built with Node.js, TypeScript, and the Gemini API, this repository utilizes a two-pass architecture: schema-enforced AI generation followed by targeted, search-augmented verification using Tavily and Gemini.

---

## Key Features

* **Schema-Enforced Generation:** Employs structured JSON schema output with Gemini to guarantee deterministic, well-formed initial data structures.
* **Resilient State Management:** Tracks processed records locally to support automatic resume-on-failure across rate limits ($429$) and runtime interruptions.
* **Targeted Search Audit:** Replaces manual overhead with automated Tavily Search API queries paired with Gemini Flash for real-time verification of hallucination-prone fields.
* **Audit Logging & Provenance:** Maintains an explicit audit log (`dataset_audit_log.json`) tracking state transitions, changes, and verification rationales.

---

## Architecture Overview

```text
[ Primary Generation Script ]
        │
        ▼
   research.json (Initial Dataset)
        │
        ▼
[ Targeted Audit Engine (Tavily + Gemini) ]
        │
        ├──► verified_research.json (Final Dataset)
        └──► dataset_audit_log.json (Audit Trail)

```

---

## Getting Started

### Prerequisites

* Node.js v18 or higher
* npm / yarn / pnpm

### Installation

1. Clone the repository:
```bash
git clone [https://github.com/NiraliNavadiya/Composio-Assignment.git](https://github.com/NiraliNavadiya/Composio-Assignment.git)
cd Composio-Assignment

```


2. Install dependencies:
```bash
npm install

```


3. Set up environment variables:
Create a `.env` file in the root directory:
```env
GEMINI_API_KEY=your_gemini_api_key_here
TAVILY_API_KEY=your_tavily_api_key_here

```



---

## Execution Pipeline

### Step 1: Initial Dataset Generation

Run the primary research script to extract and classify initial records:

```bash
npx ts-node generate-research.ts

```

### Step 2: Verification & Search Audit

Run the targeted verification pass to validate status fields and official repository references:

```bash
npx ts-node verify_with_tavily_gemini.ts

```

---

## Output Files

| File | Description |
| --- | --- |
| `research.json` | Raw, unverified initial research records. |
| `verified_research.json` | Fully audited dataset with search-backed classifications. |
| `dataset_audit_log.json` | Granular log of all modified status fields and search evidence. |

```

```
