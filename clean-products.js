#!/usr/bin/env node
// clean-products.js — reads products.csv, normalizes it, and fills in any
// missing description by asking Claude. Node 20+, ESM.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

// Resolve products.csv and .env next to this script, not against the cwd, so
// the script works from any directory (__dirname is not defined in ESM).
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.join(scriptDir, ".env"), quiet: true });

const CSV_PATH = process.argv[2] ?? path.join(scriptDir, "products.csv");
const MODEL = "claude-opus-5";

// Exact system prompt for the description-generation call. Do not reword.
const SYSTEM_PROMPT = `You are a product copywriter for an outdoor gear store.
Always respond with only a single valid JSON object, no markdown fences,
no text outside the object, matching exactly:
{ title: string, description: string, seo_keywords: string[] }
If no product information is given, respond with
{ "title": "", "description": "", "seo_keywords": [] } — do not invent a product.
Strip any HTML tags from the input before use.
Escape any double quotes inside string values so the JSON stays valid.
Always respond in English regardless of the input product name's language.
Example:
Input: "Insulated Water Bottle 1L, keeps drinks cold 24h"
Output: {"title":"Insulated Water Bottle 1L","description":"Stay refreshed all day — this insulated bottle keeps drinks cold for a full 24 hours.","seo_keywords":["insulated water bottle","cold drinks","1L bottle","hydration"]}`;

// --- CSV parsing -----------------------------------------------------------

// Minimal RFC 4180 parser: handles quoted fields, escaped quotes ("") and CRLF.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  // Final field/row (file may not end with a newline).
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

const isBlankRow = (row) => row.every((cell) => cell.trim() === "");

// A leading byte-order mark would otherwise become part of the first header name.
const stripBom = (text) =>
  text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

// --- Normalization ---------------------------------------------------------

function toTitleCase(name) {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((word) =>
      word
        .split("-")
        // Leave tokens that contain digits alone so "40L" / "1L" survive.
        .map((part) =>
          /\d/.test(part)
            ? part
            : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase(),
        )
        .join("-"),
    )
    .join(" ");
}

// Returns a 2-decimal string, "" for a blank price, or null if it isn't a number.
function formatPrice(raw) {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const value = Number(trimmed.replace(/[$,\s]/g, ""));
  return Number.isFinite(value) ? value.toFixed(2) : null;
}

const isNumericPrice = (price) => /^-?\d+\.\d{2}$/.test(price);

// --- Claude call -----------------------------------------------------------

function extractJson(text) {
  // Be forgiving: strip markdown fences and any stray prose around the object.
  const unfenced = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

async function generateDescription(client, product) {
  const input = isNumericPrice(product.price)
    ? `${product.name}, priced at $${product.price}`
    : product.name;

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    // Server-side refusal fallback: if a safety classifier declines, the API
    // re-runs the same request on a fallback model within the same call.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Input: "${input}"` }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(
      `model declined (${response.stop_details?.category ?? "unknown"})`,
    );
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const parsed = extractJson(text);
  if (!parsed || typeof parsed.description !== "string") {
    throw new Error("response was not JSON with a string \"description\" field");
  }

  return parsed.description.trim();
}

// --- Main ------------------------------------------------------------------

let raw;
try {
  raw = fs.readFileSync(CSV_PATH, "utf8");
} catch (error) {
  console.error(`Could not read ${CSV_PATH}: ${error.message}`);
  process.exit(1);
}

const rows = parseCsv(stripBom(raw)).filter((row) => !isBlankRow(row));

if (rows.length === 0) {
  console.error(`${CSV_PATH} is empty — nothing to clean.`);
  process.exit(1);
}

const header = rows[0].map((cell) => cell.trim().toLowerCase());
const columns = {
  name: header.indexOf("name"),
  description: header.indexOf("description"),
  price: header.indexOf("price"),
};

const missingColumns = Object.entries(columns)
  .filter(([, index]) => index === -1)
  .map(([key]) => key);

if (missingColumns.length > 0) {
  console.error(
    `${CSV_PATH} is missing required column(s): ${missingColumns.join(", ")}`,
  );
  process.exit(1);
}

const warnings = [];
const products = [];

rows.slice(1).forEach((row, index) => {
  const lineNumber = index + 2; // 1-based, +1 for the header row
  const cell = (columnIndex) => (row[columnIndex] ?? "").trim();

  if (row.length !== header.length) {
    warnings.push(
      `line ${lineNumber}: expected ${header.length} columns, found ${row.length} — parsed what was there`,
    );
  }

  const name = cell(columns.name);
  if (name === "") {
    warnings.push(`line ${lineNumber}: no product name — row skipped`);
    return;
  }

  const priceRaw = cell(columns.price);
  const price = formatPrice(priceRaw);
  if (price === null) {
    warnings.push(
      `line ${lineNumber}: price "${priceRaw}" is not a number — kept as-is`,
    );
  }

  products.push({
    lineNumber,
    name: toTitleCase(name),
    description: cell(columns.description),
    price: price ?? priceRaw,
  });
});

const needDescription = products.filter((p) => p.description === "");

if (needDescription.length > 0) {
  if (!process.env.ANTHROPIC_API_KEY) {
    warnings.push(
      `ANTHROPIC_API_KEY is not set — left ${needDescription.length} description(s) blank`,
    );
  } else {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    console.error(
      `Generating ${needDescription.length} missing description(s)...`,
    );

    await Promise.all(
      needDescription.map(async (product) => {
        try {
          product.description = await generateDescription(client, product);
        } catch (error) {
          const detail =
            error instanceof Anthropic.APIError
              ? `API error ${error.status ?? ""}: ${error.message}`
              : error.message;
          warnings.push(
            `line ${product.lineNumber}: could not generate a description — ${detail}`,
          );
        }
      }),
    );
  }
}

console.table(
  products.map((p) => ({
    name: p.name,
    description: p.description,
    price: p.price,
  })),
);

if (warnings.length > 0) {
  console.error(`\n${warnings.length} issue(s):`);
  for (const warning of warnings) console.error(`  - ${warning}`);
}
