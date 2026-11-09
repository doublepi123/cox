import "vite-plus/test/config";
import { defineConfig, mergeConfig } from "vite-plus";
import baseConfig from "../../vite.config.ts";
import {
  isExternalCliDependency,
  shouldBundleCliDependency,
} from "../../scripts/lib/cli-external-packages.ts";
import { WeightedShardSequencer } from "./src/testUtils/weightedShardSequencer.ts";

export { shouldBundleCliDependency };
const { projects: _rootTestProjects, ...baseTestConfig } = baseConfig.test ?? {};
const { run: _rootRunConfig, ...basePackageConfig } = baseConfig;
export default mergeConfig(
  { ...basePackageConfig, test: baseTestConfig },
  defineConfig({
    run: {
      tasks: {
        build: {
          command: "node scripts/cli.ts build",
          dependsOn: ["@t3tools/web#build"],
          cache: false,
        },
      },
    },
    pack: {
      entry: [
        "src/bin.ts",
        "src/claude-history-worker.ts",
        "src/persistence/databaseMigrationHead.ts",
        "src/localServiceUpdate/activation.ts",
      ],
      outDir: "dist",
      sourcemap: true,
      clean: true,
      deps: {
        alwaysBundle: shouldBundleCliDependency,
        neverBundle: isExternalCliDependency,
        onlyBundle: false,
      },
      banner: { js: "#!/usr/bin/env node\n" },
      define: {
        __T3CODE_BUILD_CHANNEL__: JSON.stringify("dev"),
        __T3CODE_TELEMETRY_CHANNEL__: JSON.stringify("dev"),
      },
    },
    test: {
      fileParallelism: false,
      sequence: { sequencer: WeightedShardSequencer },
      setupFiles: ["./src/testUtils/gitConfig.setup.ts"],
      hookTimeout: 120000,
      testTimeout: 120000,
    },
  }),
);
