#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const {
  buildLaunchFileSelectionTree,
  createLaunchFileSelectionRequest,
  formatLaunchFileSelectionJson,
  requestOllamaCompletionText,
} = require("../server");

const DEFAULT_CASES_PATH = path.join(__dirname, "..", "test", "test-cases.txt");
const DEFAULT_OLLAMA_URL =
  process.env.OLLAMA_CHAT_COMPLETIONS_URL ||
  "http://localhost:11434/v1/chat/completions";

const quietLogger = {
  log() {},
};

function parseArgs(argv) {
  const args = {
    casesPath: DEFAULT_CASES_PATH,
    only: null,
    url: DEFAULT_OLLAMA_URL,
    verbose: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--cases") {
      args.casesPath = path.resolve(argv[++index] || "");
    } else if (arg === "--only") {
      args.only = new Set(
        String(argv[++index] || "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
          .map((value) => value.replace(/^TEST_/i, "")),
      );
    } else if (arg === "--url") {
      args.url = argv[++index] || "";
    } else if (arg === "--verbose") {
      args.verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.url) {
    throw new Error("--url cannot be empty");
  }

  return args;
}

function usage() {
  return [
    "Usage: node scripts/llm-launch-file-harness.js [options]",
    "",
    "Options:",
    "  --cases <path>   Test case fixture path",
    "  --only <ids>     Comma-separated case ids, e.g. 1,3,TEST_9",
    "  --url <url>      Ollama OpenAI-compatible chat completions URL",
    "  --verbose        Print server Ollama request/response logging",
  ].join("\n");
}

function formatError(error) {
  const parts = [error.message];

  if (error.cause?.code) {
    parts.push(error.cause.code);
  }

  if (error.cause?.address || error.cause?.port) {
    parts.push(
      [error.cause.address, error.cause.port].filter(Boolean).join(":"),
    );
  } else if (error.cause?.message) {
    parts.push(error.cause.message);
  }

  return parts.join(" - ");
}

function readLlmTestCases(casesPath) {
  const text = fs.readFileSync(casesPath, "utf8");
  const headerPattern = /^###\s+(TEST|EXPECTED)_(\d+)\s*$/gm;
  const headers = [];
  let match;

  while ((match = headerPattern.exec(text)) !== null) {
    headers.push({
      kind: match[1],
      id: match[2],
      index: match.index,
      contentStart: headerPattern.lastIndex,
    });
  }

  if (headers.length === 0) {
    throw new Error(`No TEST/EXPECTED sections found in ${casesPath}`);
  }

  const byId = new Map();

  headers.forEach((header, index) => {
    const nextHeader = headers[index + 1];
    const content = text
      .slice(header.contentStart, nextHeader ? nextHeader.index : text.length)
      .trim();
    const testCase = byId.get(header.id) || { id: header.id };
    const property = header.kind === "TEST" ? "directoryListing" : "expected";

    if (testCase[property] !== undefined) {
      throw new Error(`Duplicate ${header.kind}_${header.id} section`);
    }

    testCase[property] = content;
    byId.set(header.id, testCase);
  });

  return Array.from(byId.values())
    .sort((left, right) => Number(left.id) - Number(right.id))
    .map((testCase) => {
      if (!testCase.directoryListing) {
        throw new Error(`TEST_${testCase.id} is missing or empty`);
      }

      if (!testCase.expected) {
        throw new Error(`EXPECTED_${testCase.id} is missing or empty`);
      }

      return testCase;
    });
}

async function runCase(testCase, { url, logger }) {
  const tree = buildLaunchFileSelectionTree(testCase.directoryListing);
  const request = createLaunchFileSelectionRequest(tree);
  const rawResponse = await requestOllamaCompletionText(request, {
    url,
    logger,
  });
  const actual = formatLaunchFileSelectionJson(rawResponse);
  const expected = formatLaunchFileSelectionJson(testCase.expected);

  return {
    actual,
    expected,
    passed: actual === expected,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(usage());
    return;
  }

  const allCases = readLlmTestCases(args.casesPath);
  const cases = args.only
    ? allCases.filter((testCase) => args.only.has(testCase.id))
    : allCases;

  if (cases.length === 0) {
    throw new Error("No test cases selected");
  }

  console.log(
    `Running ${cases.length} LLM launch-file case(s) against ${args.url}`,
  );

  const failures = [];

  for (const testCase of cases) {
    try {
      const result = await runCase(testCase, {
        url: args.url,
        logger: args.verbose ? console : quietLogger,
      });

      if (result.passed) {
        console.log(`PASS TEST_${testCase.id}`);
      } else {
        failures.push({ testCase, result });
        console.log(`FAIL TEST_${testCase.id}`);
        console.log("Expected:");
        console.log(result.expected);
        console.log("Actual:");
        console.log(result.actual);
      }
    } catch (error) {
      failures.push({ testCase, error });
      console.log(`ERROR TEST_${testCase.id}: ${formatError(error)}`);
    }
  }

  if (failures.length > 0) {
    console.error(`${failures.length} case(s) failed`);
    process.exitCode = 1;
    return;
  }

  console.log("All LLM launch-file cases passed");
}

main().catch((error) => {
  console.error(formatError(error));
  process.exitCode = 1;
});
