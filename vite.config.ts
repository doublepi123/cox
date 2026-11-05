import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeURL from "node:url";

const excluded = ["**/.cox/**", "**/node_modules/**", "**/dist/**", "**/.git/**", "**/release/**"];
const packageProjects = ["apps/server", "apps/web", "packages/client-runtime"];
const isRootRun = process.cwd() === import.meta.dirname;

export default defineConfig({
  run: { cache: { scripts: false } },
  resolve: {
    alias: { "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)) },
  },
  test: {
    environment: "node",
    exclude: excluded,
    hookTimeout: 60_000,
    testTimeout: 60_000,
    allowOnly: !process.env.CI,
    retry: 0,
    fakeTimers: {
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
        "Date",
        "performance",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "requestIdleCallback",
        "cancelIdleCallback",
      ],
    },
    setupFiles: [
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/longTempDir.ts", import.meta.url),
      ),
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/providerEnv.ts", import.meta.url),
      ),
    ],
    ...(isRootRun
      ? {
          projects: [
            ...packageProjects,
            {
              extends: true,
              test: {
                name: "root",
                exclude: [...excluded, ...packageProjects.map((directory) => `${directory}/**`)],
              },
            },
          ],
        }
      : {}),
  },
  staged: {
    "*": ["vp fmt --no-error-on-unmatched-pattern", "vp lint --no-error-on-unmatched-pattern"],
  },
  fmt: {
    ignorePatterns: [
      "**/dist/**",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "**/*.graphql.ts",
      "packages/source-control-github/schema/**",
      "apps/server/schema/**",
    ],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: [
      "**/dist/**",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "**/*.graphql.ts",
      "packages/source-control-github/schema/**",
      "apps/server/schema/**",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-t3code/index.ts", "@shadcn/lint"],
    settings: { shadcn: { ui: "~/components/ui" } },
    categories: { correctness: "warn", suspicious: "warn", perf: "warn" },
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "oxc/no-accumulating-spread": "error",
      "eslint/no-control-regex": "off",
      "typescript/no-this-alias": "off",
      "unicorn/prefer-add-event-listener": "off",
      "unicorn/prefer-string-starts-ends-with": "off",
      "unicorn/prefer-set-has": "off",
      "unicorn/prefer-array-find": "off",
      "unicorn/no-new-array": "off",
      "unicorn/no-array-reverse": "off",
      "unicorn/no-useless-spread": "error",
      "react/no-object-type-as-default-prop": "off",
      "react/jsx-no-constructed-context-values": "off",
      "react/no-array-index-key": "error",
      "react/no-unstable-nested-components": "error",
      "eslint/no-empty-pattern": "error",
      "eslint/no-new": "error",
      "t3code/no-inline-schema-compile": "error",
      "t3code/no-polling-loop-in-tests": "error",
      "t3code/no-real-time-wait-in-tests": "error",
      "t3code/no-wall-clock-in-tests": "error",
      "t3code/no-test-timeout-or-unreasoned-skip": "error",
    },
    overrides: [
      {
        files: ["apps/web/src/**/*.browser.test.{ts,tsx}"],
        rules: { "t3code/require-disposable-render": "error" },
      },
      { files: ["apps/web/src/**"], rules: { "shadcn/no-restyle": "error" } },
    ],
  },
});
