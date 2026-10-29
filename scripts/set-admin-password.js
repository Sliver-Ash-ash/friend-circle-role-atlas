const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = process.env.ADMIN_CONFIG_PATH
  ? path.resolve(process.env.ADMIN_CONFIG_PATH)
  : path.join(ROOT, "data", "admin.json");
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generatePassword() {
  const groups = [];
  for (let group = 0; group < 4; group += 1) {
    let value = "";
    for (let index = 0; index < 4; index += 1) {
      value += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
    }
    groups.push(value);
  }
  return `ADM-${groups.join("-")}`;
}

function readPasswordArgument() {
  const args = process.argv.slice(2);
  if (args.includes("--generate")) {
    return { password: generatePassword(), generated: true };
  }
  const passwordIndex = args.indexOf("--password");
  if (passwordIndex >= 0) {
    return {
      password: args[passwordIndex + 1] || "",
      generated: false,
    };
  }
  return {
    password: process.env.ADMIN_PASSWORD || "",
    generated: false,
  };
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey.toString("hex"));
    });
  });
}

async function main() {
  const { password, generated } = readPasswordArgument();
  if (password.length < 12) {
    throw new Error(
      "Provide --generate, --password, or ADMIN_PASSWORD with at least 12 characters.",
    );
  }

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = await scrypt(password, salt);
  const now = new Date().toISOString();
  const config = {
    version: 1,
    salt,
    passwordHash,
    tokenSecret: crypto.randomBytes(32).toString("hex"),
    createdAt: now,
    updatedAt: now,
  };

  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  const temporaryPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryPath, CONFIG_PATH);

  console.log(`ADMIN_CONFIG_PATH=${CONFIG_PATH}`);
  if (generated) {
    console.log("ADMIN_PASSWORD_BEGIN");
    console.log(password);
    console.log("ADMIN_PASSWORD_END");
  } else {
    console.log("ADMIN_PASSWORD_UPDATED");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
