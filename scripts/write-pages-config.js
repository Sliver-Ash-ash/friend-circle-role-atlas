const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "public", "config.js");
const supabaseUrl = String(process.env.SUPABASE_URL || "").trim();
const supabaseAnonKey = String(process.env.SUPABASE_ANON_KEY || "").trim();

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_ANON_KEY are required to build the public site.",
  );
}

const parsedUrl = new URL(supabaseUrl);
if (!["http:", "https:"].includes(parsedUrl.protocol)) {
  throw new Error("SUPABASE_URL must use http or https.");
}

const config = {
  backend: "supabase",
  supabaseUrl: supabaseUrl.replace(/\/+$/, ""),
  supabaseAnonKey,
  functionName: "app-api",
};

fs.writeFileSync(
  configPath,
  `window.FRIEND_CIRCLE_CONFIG = ${JSON.stringify(config)};\n`,
  "utf8",
);
console.log(`Wrote ${configPath} for ${config.supabaseUrl}`);
