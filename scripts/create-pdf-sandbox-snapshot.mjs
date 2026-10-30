import { readFile } from "node:fs/promises";
import { config } from "dotenv";
import { Sandbox } from "@vercel/sandbox";

config({ path: ".env.local" });

const installPath = "/vercel/sandbox/pdf-worker";
const timeoutMs = 10 * 60 * 1000;
let sandbox;

try {
  sandbox = await Sandbox.create({
    resources: { vcpus: 1 },
    timeout: timeoutMs,
    networkPolicy: "allow-all",
    persistent: false,
  });

  const install = await sandbox.runCommand({
    cmd: "npm",
    args: [
      "install", "--prefix", installPath, "--no-save", "--package-lock=false",
      "pdf-parse@2.4.5", "pdfjs-dist@5.4.296", "@napi-rs/canvas@0.1.80",
    ],
  });
  if (install.exitCode !== 0) throw new Error("Pinned PDF dependencies could not be installed in the seed sandbox.");

  const extractor = await readFile(new URL("./pdf-sandbox-extract.mjs", import.meta.url));
  await sandbox.writeFiles([{ path: `${installPath}/extract.mjs`, content: extractor }]);
  const snapshot = await sandbox.snapshot({ expiration: 30 * 24 * 60 * 60 * 1000 });
  console.log(`Created clean PDF parser snapshot: ${snapshot.snapshotId}`);
} finally {
  if (sandbox) await sandbox.delete().catch(() => undefined);
}
