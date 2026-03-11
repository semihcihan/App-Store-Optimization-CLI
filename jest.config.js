const nodeTransform = {
  "^.+\\.(t|j)sx?$": [
    "ts-jest",
    {
      useESM: false,
      tsconfig: {
        ...require("./tsconfig.json").compilerOptions,
        jsx: "react-jsx",
        types: ["jest", "node"],
        noEmit: true,
      },
    },
  ],
};

const jsdomTransform = {
  "^.+\\.(t|j)sx?$": [
    "ts-jest",
    {
      useESM: false,
      tsconfig: {
        ...require("./tsconfig.json").compilerOptions,
        jsx: "react-jsx",
        lib: ["ES2020", "DOM", "DOM.Iterable"],
        types: ["jest", "node"],
        noEmit: true,
      },
    },
  ],
};

module.exports = {
  projects: [
    {
      displayName: "node",
      preset: "ts-jest",
      testEnvironment: "node",
      testMatch: [
        "<rootDir>/cli/**/*.test.ts"
      ],
      transform: nodeTransform,
      transformIgnorePatterns: ["node_modules/(?!(inquirer)/)"],
      setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
      cache: true,
      cacheDirectory: "<rootDir>/.jest-cache",
      testPathIgnorePatterns: [".*\\.integration\\.test\\.[jt]s$", ".*\\.e2e\\.test\\.[jt]s$"]
    },
    {
      displayName: "jsdom",
      preset: "ts-jest",
      testEnvironment: "jsdom",
      testMatch: ["<rootDir>/cli/**/*.test.tsx"],
      transform: jsdomTransform,
      setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
      cache: true,
      cacheDirectory: "<rootDir>/.jest-cache"
    }
  ],
  collectCoverageFrom: [
    "cli/**/*.{js,ts,tsx}",
    "!**/*.test.{js,ts,tsx}",
    "!**/*.spec.{js,ts,tsx}",
    "!**/generated/**/*"
  ],
  coverageReporters: ["text"]
};
