import { createECDH, randomBytes } from "node:crypto";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
const subject = process.argv[2];
if (!subject || !/^(mailto:|https:\/\/)/.test(subject))
  throw new Error(
    "Usage: node scripts/generate-push-keys.mjs mailto:votre-adresse@example.com",
  );
if (existsSync(".env.push.local"))
  throw new Error(
    ".env.push.local existe déjà. Ne remplacez pas les clés d’une installation active.",
  );
const pair = createECDH("prime256v1");
pair.generateKeys();
const pub = pair.getPublicKey().toString("base64url");
writeFileSync(
  ".env.push.local",
  `VAPID_PUBLIC_KEY=${pub}\nVAPID_PRIVATE_KEY=${pair.getPrivateKey().toString("base64url")}\nVAPID_SUBJECT=${subject}\nPUSH_CRON_SECRET=${randomBytes(32).toString("hex")}\nAPP_ORIGIN=https://VOTRE-APPLICATION.vercel.app\n`,
  { mode: 0o600 },
);
if (!existsSync(".env.local"))
  writeFileSync(
    ".env.local",
    readFileSync(".env.example", "utf8").replace("YOUR_PUBLIC_VAPID_KEY", pub),
    { mode: 0o600 },
  );
console.log(
  "Clés créées dans .env.push.local (secret, exclu de Git). Complétez APP_ORIGIN et les valeurs de .env.local.",
);
