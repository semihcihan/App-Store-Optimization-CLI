process.env.DOTENV_CONFIG_SILENT = "true";
process.env.LOG_LEVEL = "error";

console.log = () => {};
console.warn = () => {};
console.error = () => {};
console.info = () => {};
console.debug = () => {};

jest.mock("@bugsnag/js", () => ({
  notify: jest.fn(),
  start: jest.fn(),
  addMetadata: jest.fn(),
  addOnError: jest.fn(),
}));

jest.mock("ora", () => {
  return jest.fn(() => ({
    start: jest.fn().mockReturnThis(),
    succeed: jest.fn().mockReturnThis(),
    fail: jest.fn().mockReturnThis(),
    warn: jest.fn().mockReturnThis(),
    info: jest.fn().mockReturnThis(),
    stop: jest.fn().mockReturnThis(),
    text: "",
    color: "cyan",
    spinner: "dots",
  }));
});
