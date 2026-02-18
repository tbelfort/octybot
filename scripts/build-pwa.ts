const result = await Bun.build({
  entrypoints: ["src/pwa/main.ts"],
  outdir: "src/pwa/dist",
  naming: "app.js",
  target: "browser",
  format: "esm",
  minify: process.argv.includes("--minify"),
  sourcemap: process.argv.includes("--sourcemap") ? "external" : "none",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const out = result.outputs[0];
console.log(`PWA built -> src/pwa/dist/app.js (${(out.size / 1024).toFixed(1)} KB)`);
