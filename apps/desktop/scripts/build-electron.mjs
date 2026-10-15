import { access, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const scriptPath = fileURLToPath(import.meta.url);
const desktopRoot = resolve(dirname(scriptPath), "..");
const repositoryRoot = resolve(desktopRoot, "..", "..");

function absoluteOutputPath(outputPath) {
  return isAbsolute(outputPath) ? outputPath : resolve(desktopRoot, outputPath);
}

function outputKeyForPath(outputs, outputPath) {
  const wanted = resolve(outputPath);
  return Object.keys(outputs).find((key) => resolve(absoluteOutputPath(key)) === wanted);
}

function reachableOutputKeys(outputs, entryPath) {
  const entryKey = Object.keys(outputs).find((key) => {
    const source = outputs[key].entryPoint;
    return source && resolve(absoluteOutputPath(source)) === resolve(entryPath);
  });
  if (!entryKey) throw new Error("voice_bundle_entry_output_missing");

  const reachable = new Set([entryKey]);
  const pending = [entryKey];
  while (pending.length) {
    const output = outputs[pending.pop()];
    for (const imported of output.imports) {
      if (imported.external) continue;
      const importedKey = outputKeyForPath(outputs, absoluteOutputPath(imported.path));
      if (!importedKey) throw new Error(`voice_bundle_output_unresolved:${imported.path}`);
      if (!reachable.has(importedKey)) {
        reachable.add(importedKey);
        pending.push(importedKey);
      }
    }
  }
  return reachable;
}

function verifyVoiceBundleOutputs(outputs, reachable) {
  const forbiddenInput = /(?:^|[/\\])(?:playwright(?:-core)?|koffi)(?:[/\\]|$)|(?:^|[/\\])src[/\\]speech[/\\]/iu;
  const forbiddenExternal = /^(?:chromium-bidi|openai|playwright(?:-core)?|koffi)(?:\/|$)/u;
  for (const key of reachable) {
    const output = outputs[key];
    for (const input of Object.keys(output.inputs)) {
      if (forbiddenInput.test(input)) throw new Error(`unrelated_voice_runtime_input:${input}`);
    }
    for (const imported of output.imports) {
      if (imported.external && (!imported.path.startsWith("node:") || forbiddenExternal.test(imported.path))) {
        throw new Error(`voice_runtime_dependency_not_bundled:${imported.path}`);
      }
    }
  }
}

async function writeGeneratedOutput(outputPath, contents) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, contents);
  try {
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function buildElectron({ outputRoot = resolve(desktopRoot, "dist-electron"), logLevel = "info" } = {}) {
  const electronOutput = resolve(outputRoot);
  const mainOutput = resolve(electronOutput, "main", "main.js");
  const preloadOutput = resolve(electronOutput, "preload.cjs");
  const voiceOutputRoot = resolve(electronOutput, "voice");
  const voiceOutput = resolve(voiceOutputRoot, "index.js");
  const emailIdentityAsset = resolve(repositoryRoot, "src", "communications", "signature", "assets", "lifeguard-costa-rica.jpg");
  const microsoftDpapiBinary = resolve(repositoryRoot, "node_modules", "@azure", "msal-node-extensions", "bin", process.arch, "dpapi.node");
  const temporaryEntryRoot = await mkdtemp(resolve(tmpdir(), "nexa-voice-entry-"));

  await mkdir(dirname(mainOutput), { recursive: true });

  try {
    const mainBuild = await build({
      absWorkingDir: desktopRoot,
      entryPoints: [resolve(desktopRoot, "src", "main", "main.ts")],
      outfile: mainOutput,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      // Bundled CommonJS dependencies can contain dynamic require() calls for
      // Node built-ins (for example safe-buffer -> buffer). ESM has no native
      // require, so provide a Main-local resolver anchored to this bundle.
      banner: {
        js: 'import { createRequire as __nexaCreateRequire } from "node:module"; const require = __nexaCreateRequire(import.meta.url);',
      },
      // Runtime's lazily-used browser/system adapters include native and optional
      // packages. Keep those Node-resolved in the monorepo; Runtime remains bundled.
      external: ["electron", "keytar", "playwright-core", "chromium-bidi/*", "loudness"],
      sourcemap: false,
      write: false,
      logLevel,
    });
    const mainBundle = mainBuild.outputFiles.find((file) => resolve(file.path) === mainOutput) ?? mainBuild.outputFiles[0];
    if (!mainBundle) throw new Error("electron_main_output_missing");
    await writeGeneratedOutput(mainOutput, mainBundle.contents);

    // The bundled communications identity resolves its logo relative to
    // import.meta.url; preserve that runtime-relative asset beside Main.
    const mainAssetDirectory = resolve(dirname(mainOutput), "assets");
    await mkdir(mainAssetDirectory, { recursive: true });
    await copyFile(emailIdentityAsset, resolve(mainAssetDirectory, "lifeguard-costa-rica.jpg"));

    // MSAL extensions resolves its Windows DPAPI binding relative to import.meta.url.
    // Since the package is bundled into Main, preserve that expected relative path.
    if (process.platform === "win32") {
      const dpapiOutput = resolve(electronOutput, "bin", process.arch, "dpapi.node");
      await mkdir(dirname(dpapiOutput), { recursive: true });
      try {
        await access(dpapiOutput);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await copyFile(microsoftDpapiBinary, dpapiOutput, constants.COPYFILE_EXCL);
      }
    }

    const preloadBuild = await build({
      absWorkingDir: desktopRoot,
      entryPoints: [resolve(desktopRoot, "src", "preload.ts")],
      outfile: preloadOutput,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      external: ["electron"],
      sourcemap: false,
      write: false,
      logLevel,
    });
    const preloadBundle = preloadBuild.outputFiles.find((file) => resolve(file.path) === preloadOutput) ?? preloadBuild.outputFiles[0];
    if (!preloadBundle) throw new Error("electron_preload_output_missing");
    await writeGeneratedOutput(preloadOutput, preloadBundle.contents);

    const publicVoiceIndex = resolve(repositoryRoot, "src", "voice", "index.js");
    const temporaryEntry = resolve(temporaryEntryRoot, "voice-api-entry.mjs");
    await writeFile(temporaryEntry,
      `export { createPttVoiceController, createSpeechRecognizer, createVoiceSpeaker } from ${JSON.stringify(publicVoiceIndex)};\n`,
      "utf8",
    );

    const voiceBuild = await build({
      absWorkingDir: desktopRoot,
      entryPoints: [temporaryEntry],
      outdir: voiceOutputRoot,
      entryNames: "index",
      chunkNames: "chunks/[name]-[hash]",
      bundle: true,
      splitting: true,
      platform: "node",
      format: "esm",
      target: "node22",
      metafile: true,
      write: false,
      // Esbuild walks the unused public Speaker export while discovering split chunks; those chunks are pruned below.
      external: ["chromium-bidi/*"],
      plugins: [{
        name: "remove-unused-public-voice-exports",
        setup(buildContext) {
          buildContext.onResolve({ filter: /^\.\/speaker\.js$/ }, (args) => ({
            path: resolve(args.resolveDir, args.path),
            sideEffects: false,
          }));
        },
      }],
      logLevel: "silent",
    });

    const outputs = voiceBuild.metafile.outputs;
    const reachable = reachableOutputKeys(outputs, temporaryEntry);
    verifyVoiceBundleOutputs(outputs, reachable);

    for (const key of reachable) {
      const outputPath = absoluteOutputPath(key);
      const outputFile = voiceBuild.outputFiles.find((file) => resolve(file.path) === resolve(outputPath));
      if (!outputFile) throw new Error(`voice_bundle_output_file_missing:${relative(desktopRoot, outputPath)}`);
      const contents = outputFile.text;
      if (contents.includes(repositoryRoot) || contents.includes(repositoryRoot.replaceAll("\\", "/"))) {
        throw new Error("voice_bundle_contains_checkout_path");
      }
      await mkdir(dirname(outputPath), { recursive: true });
      await writeGeneratedOutput(outputPath, outputFile.contents);
    }

    const voiceFiles = [...reachable].map((key) => absoluteOutputPath(key));
    if (!voiceFiles.includes(voiceOutput)) throw new Error("voice_bundle_index_missing");
    return { mainOutput, preloadOutput, voiceOutput, voiceFiles };
  } finally {
    await rm(temporaryEntryRoot, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  try {
    const result = await buildElectron();
    console.info(`[nexa-desktop] bundled Main, preload and Voice (${result.voiceFiles.length} Voice files)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
