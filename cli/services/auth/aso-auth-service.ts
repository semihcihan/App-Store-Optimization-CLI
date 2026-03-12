import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios";
import inquirer from "inquirer";
import ora from "ora";
import type { Ora } from "ora";
import { logger } from "../../utils/logger";
import { createHash, pbkdf2Sync, randomBytes, randomUUID } from "crypto";
import { execFileSync } from "child_process";
import {
  asoCookieStoreService,
  type StoredCookie,
} from "./aso-cookie-store-service";
import {
  asoKeychainService,
  type AppleLoginCredentials,
} from "./aso-keychain-service";
import {
  attachAppleHttpTracing,
  withAppleHttpTraceContext,
} from "../keywords/apple-http-trace";

const APPLE_APP_ADS_URL = "https://app-ads.apple.com/cm/app";
const APPLE_SEARCH_ADS_URL = "https://app.searchads.apple.com/cm/app";
const APPLE_IDMSA_BASE_URL = "https://idmsa.apple.com/appleauth/auth";
const APPLE_IDMS_WEB_AUTH_SIGNIN_POST_URL =
  "https://idmsa.apple.com/IDMSWebAuth/signin";
const APPLE_IDMS_WEB_AUTH_SIGNIN_URL =
  "https://idmsa.apple.com/IDMSWebAuth/signin?appIdKey=a01459d797984726ee0914a7097e53fad42b70e1f08d09294d14523a1d4f61e1&rv=1&path=%2Fcm%2Fapp";
const APPLE_AUTH_APP_ID = "4146";
const APPLE_AUTH_CLIENT_ID =
  "a01459d797984726ee0914a7097e53fad42b70e1f08d09294d14523a1d4f61e1";
const APPLE_AUTH_LANGUAGE = "US-EN";
const APPLE_AUTH_PATH = "/cm/app";
const APPLE_WIDGET_KEY_FALLBACK =
  process.env.ASO_APPLE_WIDGET_KEY ||
  "a01459d797984726ee0914a7097e53fad42b70e1f08d09294d14523a1d4f61e1";
const APPLE_WIDGET_CONFIG_URL =
  "https://appstoreconnect.apple.com/olympus/v1/app/config?hostname=itunesconnect.apple.com";

export type AsoAuthMode = "auto" | "sirp" | "legacy";
type AppleAuthFailureReason =
  | "invalid_credentials"
  | "two_factor_required"
  | "upgrade_required"
  | "unknown";

export class AppleAuthResponseError extends Error {
  readonly status: number;
  readonly payload: unknown;
  readonly reason: AppleAuthFailureReason;

  constructor(params: {
    message: string;
    status: number;
    payload: unknown;
    reason: AppleAuthFailureReason;
  }) {
    super(params.message);
    this.name = "AppleAuthResponseError";
    this.status = params.status;
    this.payload = params.payload;
    this.reason = params.reason;
  }
}
export type ReauthUserActionReason =
  | "credentials"
  | "remember_credentials"
  | "two_factor";

type ReAuthenticateOptions = {
  onUserActionRequired?: (reason: ReauthUserActionReason) => void;
  forcePromptCredentials?: boolean;
  resetStoredCredentials?: boolean;
};

interface AppleAuthSessionHeaders {
  scnt: string;
  xAppleIdSessionId: string;
}
interface AppleAuthRequestContext {
  frameId: string;
  state: string;
  authAttributes?: string;
}

interface AppleAuthChallengeResponse {
  noTrustedDevices?: boolean;
  trustedDevices?: Array<Record<string, unknown>>;
  securityCode?: {
    length?: number;
    tooManyCodesSent?: boolean;
    tooManyCodesValidated?: boolean;
    securityCodeLocked?: boolean;
  };
  trustedPhoneNumbers?: Array<{
    id: number;
    numberWithDialCode: string;
    pushMode?: string;
  }>;
}
type AppleTrustedPhoneNumber = NonNullable<
  AppleAuthChallengeResponse["trustedPhoneNumbers"]
>[number];

interface AppleSirpInitResponse {
  iteration: number;
  salt: string;
  b: string;
  c: string;
  protocol: "s2k" | "s2k_fo" | string;
  serviceErrors?: unknown;
}

interface AppleWidgetConfigResponse {
  authServiceKey?: string;
}

interface AppleAuthErrorPayload {
  serviceErrors?: Array<{ code?: string; title?: string; message?: string }>;
  service_errors?: Array<{ code?: string; title?: string; message?: string }>;
  validationErrors?: Array<{ code?: string; title?: string; message?: string }>;
  authType?: string;
  hasError?: boolean;
  [key: string]: unknown;
}

const SUPPORTED_AUTH_TYPES = new Set(["sa", "hsa", "non-sa", "hsa2"]);

interface RubySirpResult {
  ok: boolean;
  error?: string;
  m1_hex?: string;
  m2_hex?: string;
  a_public_hex?: string;
}

interface ParsedSetCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

function normalizeSameSite(
  value: string | undefined
): "Strict" | "Lax" | "None" | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "strict") return "Strict";
  if (normalized === "lax") return "Lax";
  if (normalized === "none") return "None";
  return undefined;
}

function parseExpiresToUnixSeconds(value: string | undefined): number {
  if (!value) return -1;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return -1;
  return Math.floor(parsed / 1000);
}

function parseSetCookieHeader(
  rawSetCookie: string,
  requestHost: string
): ParsedSetCookie | null {
  const parts = rawSetCookie.split(";").map((part) => part.trim());
  const [nameValue, ...attributes] = parts;
  if (!nameValue || !nameValue.includes("=")) return null;

  const separatorIndex = nameValue.indexOf("=");
  const name = nameValue.slice(0, separatorIndex).trim();
  const value = nameValue.slice(separatorIndex + 1).trim();
  if (!name) return null;

  let domain = requestHost;
  let path = "/";
  let expires = -1;
  let httpOnly = false;
  let secure = false;
  let sameSite: "Strict" | "Lax" | "None" | undefined;

  for (const attribute of attributes) {
    const lowerAttribute = attribute.toLowerCase();
    if (lowerAttribute === "httponly") {
      httpOnly = true;
      continue;
    }
    if (lowerAttribute === "secure") {
      secure = true;
      continue;
    }

    const attributeSeparatorIndex = attribute.indexOf("=");
    if (attributeSeparatorIndex < 0) continue;
    const key = attribute
      .slice(0, attributeSeparatorIndex)
      .trim()
      .toLowerCase();
    const rawAttributeValue = attribute
      .slice(attributeSeparatorIndex + 1)
      .trim();

    if (key === "domain" && rawAttributeValue) {
      domain = rawAttributeValue.startsWith(".")
        ? rawAttributeValue.slice(1)
        : rawAttributeValue;
      continue;
    }
    if (key === "path" && rawAttributeValue) {
      path = rawAttributeValue;
      continue;
    }
    if (key === "expires") {
      expires = parseExpiresToUnixSeconds(rawAttributeValue);
      continue;
    }
    if (key === "samesite") {
      sameSite = normalizeSameSite(rawAttributeValue);
    }
  }

  return { name, value, domain, path, expires, httpOnly, secure, sameSite };
}

function hostMatchesDomain(host: string, cookieDomain: string): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedDomain = cookieDomain.toLowerCase();
  return (
    normalizedHost === normalizedDomain ||
    normalizedHost.endsWith(`.${normalizedDomain}`)
  );
}

function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toCookieHeader(cookies: StoredCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function buildAuthHashcash(bits: number, challenge: string): string {
  const version = 1;
  const date = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  let counter = 0;
  while (true) {
    const hc = `${version}:${bits}:${date}:${challenge}::${counter}`;
    const digest = createHash("sha1").update(hc).digest();
    const binary = Array.from(digest)
      .map((byte) => byte.toString(2).padStart(8, "0"))
      .join("");
    const prefix = binary.slice(0, bits);
    if (!prefix.includes("1")) return hc;
    counter += 1;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSirpDerivedPassword(
  rawPassword: string,
  salt: Buffer,
  iterations: number,
  protocol: string
): Buffer {
  if (protocol !== "s2k" && protocol !== "s2k_fo") {
    throw new Error(`Unsupported SIRP protocol '${protocol}'`);
  }
  const sha = createHash("sha256").update(rawPassword).digest();
  const input =
    protocol === "s2k_fo" ? Buffer.from(sha.toString("hex"), "utf8") : sha;
  return pbkdf2Sync(input, salt, iterations, 32, "sha256");
}

function hexToBase64(hexValue: string): string {
  return Buffer.from(hexValue, "hex").toString("base64");
}

function base64ToHex(base64Value: string): string {
  return Buffer.from(base64Value, "base64").toString("hex");
}

function normalizeHex(hex: string): string {
  const normalized = hex.toLowerCase();
  return normalized.length % 2 === 1 ? `0${normalized}` : normalized;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function hexToBigInt(hex: string): bigint {
  const normalized = hex.replace(/\s+/g, "");
  return BigInt(`0x${normalized}`);
}

function bigIntToHex(value: bigint): string {
  return normalizeHex(value.toString(16));
}

function positiveModulo(value: bigint, mod: bigint): bigint {
  const remainder = value % mod;
  return remainder >= 0n ? remainder : remainder + mod;
}

function modPow(base: bigint, exponent: bigint, mod: bigint): bigint {
  let result = 1n;
  let current = positiveModulo(base, mod);
  let exp = exponent;
  while (exp > 0n) {
    if ((exp & 1n) === 1n) {
      result = positiveModulo(result * current, mod);
    }
    exp >>= 1n;
    current = positiveModulo(current * current, mod);
  }
  return result;
}

const SRP_N_2048 = hexToBigInt(
  "AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050" +
    "A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50" +
    "E8083969EDB767B0CF6095179A163AB3661A05FBD5FAAAE82918A9962F0B93B8" +
    "55F97993EC975EEAA80D740ADBF4FF747359D041D5C33EA71D281E446B14773B" +
    "CA97B43A23FB801676BD207A436C6481F1D2B9078717461A5B9D32E688F87748" +
    "544523B524B0D57D5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6" +
    "AF874E7303CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB6" +
    "94B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111F9E4AFF73"
);
const SRP_G_2048 = 2n;

function srpShaHex(hexInput: string): string {
  return createHash("sha256")
    .update(Buffer.from(hexInput, "hex"))
    .digest("hex");
}

function srpShaString(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function srpH(
  n: bigint,
  ...parts: Array<bigint | string | undefined>
): bigint {
  const nHexLength = bigIntToHex(n).length;
  const nlen = 2 * Math.floor((nHexLength * 4 + 7) / 8);

  const combined = parts
    .filter((part): part is bigint | string => part !== undefined)
    .map((part) => {
      const hex =
        typeof part === "string" ? normalizeHex(part) : bigIntToHex(part);
      if (hex.length > nlen) {
        throw new Error(
          "Bit width does not match - client uses different prime"
        );
      }
      return `${"0".repeat(nlen - hex.length)}${hex}`;
    })
    .join("");

  const digestHex = srpShaHex(combined);
  return hexToBigInt(digestHex) % n;
}

function srpCalcK(n: bigint, g: bigint): bigint {
  return srpH(n, n, g);
}

function srpCalcXHex(
  encryptedPasswordHex: string,
  saltHex: string
): bigint {
  const inner = srpShaHex(`3a${normalizeHex(encryptedPasswordHex)}`);
  const outer = srpShaHex(`${normalizeHex(saltHex)}${inner}`);
  return hexToBigInt(outer);
}

function srpCalcU(aHex: string, bHex: string, n: bigint): bigint {
  return srpH(n, aHex, bHex);
}

function srpCalcClientS(
  b: bigint,
  a: bigint,
  k: bigint,
  x: bigint,
  u: bigint,
  n: bigint,
  g: bigint
): bigint {
  const gx = modPow(g, x, n);
  const base = positiveModulo(b - k * gx, n);
  const exponent = a + x * u;
  return modPow(base, exponent, n);
}

function srpCalcM(
  n: bigint,
  g: bigint,
  username: string,
  saltHex: string,
  aHex: string,
  bHex: string,
  kHex: string
): string {
  const hxor = srpH(n, n) ^ srpH(n, g);
  const payloadHex =
    bigIntToHex(hxor) +
    srpShaString(username) +
    normalizeHex(saltHex) +
    normalizeHex(aHex) +
    normalizeHex(bHex) +
    normalizeHex(kHex);
  return createHash("sha256")
    .update(Buffer.from(payloadHex, "hex"))
    .digest("hex");
}

function srpCalcHamk(aHex: string, mHex: string, kHex: string): string {
  const payload = Buffer.from(
    `${normalizeHex(aHex)}${normalizeHex(mHex)}${normalizeHex(kHex)}`,
    "hex"
  );
  const digestHex = createHash("sha256").update(payload).digest("hex");
  return bigIntToHex(hexToBigInt(digestHex));
}

function computeSirpWithRubyOracle(params: {
  aHex: string;
  username: string;
  encryptedPasswordHex: string;
  saltHex: string;
  bHex: string;
}): RubySirpResult {
const rubyScript = `
require "json"
gem_name = ENV.fetch("ASO_SIRP_RUBY_GEM", ["f", "a", "s", "t", "l", "a", "n", "e", "-", "s", "i", "r", "p"].join)
require gem_name

input = JSON.parse(STDIN.read)
client = SIRP::Client.new(2048)
a = input.fetch("a_hex").to_i(16)
client.instance_variable_set(:@a, a)
n = client.N
g = client.g
a_public_hex = client.send(:num_to_hex, client.send(:calc_A, a, n, g))
client.instance_variable_set(:@A, a_public_hex)

m1 = client.process_challenge(
  input.fetch("username"),
  input.fetch("encrypted_password_hex"),
  input.fetch("salt_hex"),
  input.fetch("b_hex"),
  is_password_encrypted: true
)

if m1 == false
  puts({ ok: false, error: "process_challenge_false", a_public_hex: a_public_hex }.to_json)
  exit 0
end

puts({
  ok: true,
  a_public_hex: a_public_hex,
  m1_hex: m1,
  m2_hex: client.H_AMK
}.to_json)
`;

  const stdout = execFileSync("ruby", ["-e", rubyScript], {
    encoding: "utf8",
    input: JSON.stringify({
      a_hex: params.aHex,
      username: params.username,
      encrypted_password_hex: params.encryptedPasswordHex,
      salt_hex: params.saltHex,
      b_hex: params.bHex,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  return JSON.parse(stdout) as RubySirpResult;
}

function collectAppleServiceErrors(
  payload: unknown
): Array<{ code?: string; title?: string; message?: string }> {
  if (!payload || typeof payload !== "object") return [];
  const typed = payload as AppleAuthErrorPayload;
  const buckets = [
    typed.serviceErrors,
    typed.service_errors,
    typed.validationErrors,
  ];
  return buckets.flatMap((bucket) => (Array.isArray(bucket) ? bucket : []));
}

export function summarizeAppleErrorPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return String(payload);
  }
  const typed = payload as AppleAuthErrorPayload;
  const firstError = collectAppleServiceErrors(payload)[0];
  const code = firstError?.code || "unknown";
  const title = firstError?.title || "unknown";
  const message = firstError?.message || "unknown";
  const hasError = typed.hasError === true ? "true" : "false";
  const authType =
    typeof typed.authType === "string" ? typed.authType : "unknown";
  return `hasError=${hasError} authType=${authType} code=${code} title=${title} message=${message}`;
}

function getFirstAppleServiceError(
  payload: unknown
): { code?: string; title?: string; message?: string } | undefined {
  return collectAppleServiceErrors(payload)[0];
}

function tryParseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return value;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function payloadIncludesInvalidTrue(payload: unknown): boolean {
  if (
    typeof payload === "string" &&
    /invalid\s*=\s*["']true["']/i.test(payload)
  ) {
    return true;
  }
  const parsed =
    typeof payload === "string" ? tryParseJsonString(payload) : payload;
  if (!parsed || typeof parsed !== "object") return false;
  const typed = parsed as Record<string, unknown>;
  if (typed.invalid === true) return true;
  if (typeof typed.invalid === "string") {
    return typed.invalid.toLowerCase() === "true";
  }
  return false;
}

function payloadAuthType(payload: unknown): string | null {
  const parsed =
    typeof payload === "string" ? tryParseJsonString(payload) : payload;
  if (!parsed || typeof parsed !== "object") return null;
  const authType = (parsed as Record<string, unknown>).authType;
  if (typeof authType !== "string") return null;
  return authType.trim().toLowerCase() || null;
}

function responseHasItctxCookie(response: AxiosResponse): boolean {
  const setCookie = (response.headers as Record<string, unknown> | undefined)?.[
    "set-cookie"
  ];
  if (Array.isArray(setCookie)) {
    return setCookie.some((entry) =>
      String(entry).toLowerCase().includes("itctx")
    );
  }
  if (setCookie !== undefined && setCookie !== null) {
    return String(setCookie).toLowerCase().includes("itctx");
  }
  return false;
}

function quoteDesCookieValue(cookieHeader: string): string {
  return cookieHeader.replace(
    /(^|;\s*)(DES[^=;]*)=([^;]*)/g,
    (match, prefix: string, name: string, value: string) => {
      const trimmedValue = value.trim();
      if (!trimmedValue || /^".*"$/.test(trimmedValue)) return match;
      return `${prefix}${name}="${trimmedValue}"`;
    }
  );
}

function payloadIndicatesInvalidCredentials(payload: unknown): boolean {
  const errors = collectAppleServiceErrors(payload);
  if (errors.length === 0) return false;
  const combinedText = errors
    .flatMap((error) => [error.title || "", error.message || ""])
    .join(" ")
    .toLowerCase();
  return (
    (combinedText.includes("invalid") &&
      (combinedText.includes("password") ||
        combinedText.includes("credential") ||
        combinedText.includes("apple id") ||
        combinedText.includes("account"))) ||
    combinedText.includes("incorrect password") ||
    combinedText.includes("account name or password")
  );
}

function inferAppleAuthFailureReason(
  status: number,
  payload: unknown
): AppleAuthFailureReason {
  if (status === 403) return "invalid_credentials";
  if (status === 409) return "two_factor_required";
  if (status === 412) return "upgrade_required";
  if (payloadIndicatesInvalidCredentials(payload)) return "invalid_credentials";
  return "unknown";
}

export function getTwoFactorVerificationErrorMessage(payload: unknown): string {
  const error = getFirstAppleServiceError(payload);
  if (!error) return "Verification failed. Please try again.";
  if (error.message?.trim()) return error.message.trim();
  if (error.title?.trim()) return error.title.trim();
  return "Verification failed. Please try again.";
}

export function isRetryableTwoFactorCodeError(payload: unknown): boolean {
  const errors = collectAppleServiceErrors(payload);
  if (errors.length === 0) return false;

  const combinedText = errors
    .flatMap((error) => [error.title || "", error.message || ""])
    .join(" ")
    .toLowerCase();

  if (
    combinedText.includes("too many") ||
    combinedText.includes("locked") ||
    combinedText.includes("try again later") ||
    combinedText.includes("expired") ||
    combinedText.includes("rate limit")
  ) {
    return false;
  }
  return (
    combinedText.includes("verification code") ||
    combinedText.includes("security code")
  );
}

export function isInvalidAppleCredentialsError(error: unknown): boolean {
  if (error instanceof AppleAuthResponseError) {
    return error.reason === "invalid_credentials";
  }
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("invalid apple id credentials") ||
    message.includes("invalid credentials")
  );
}

function logWithSpinnerPause(
  spinner: Ora | undefined,
  level: "warn" | "info",
  message: string
): void {
  const wasSpinning = spinner?.isSpinning === true;
  if (wasSpinning) spinner.stop();
  if (level === "warn") logger.warn(message);
  else logger.info(message);
  if (wasSpinning) spinner.start();
}

async function askForCredentials(): Promise<AppleLoginCredentials> {
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "appleId",
      message: "Apple ID (email):",
      validate: (value: string) =>
        value.trim() ? true : "Apple ID is required",
    },
    {
      type: "password",
      name: "password",
      message: "Password:",
      mask: "*",
      validate: (value: string) =>
        value.trim() ? true : "Password is required",
    },
  ]);

  return { appleId: answers.appleId.trim(), password: answers.password };
}

async function askWhetherToRememberCredentials(): Promise<boolean> {
  const { remember } = await inquirer.prompt([
    {
      type: "confirm",
      name: "remember",
      default: false,
      message: "Remember Apple credentials in macOS Keychain?",
    },
  ]);
  return remember;
}

async function askForSixDigitCode(message: string): Promise<string> {
  const { code } = await inquirer.prompt([
    {
      type: "input",
      name: "code",
      message,
      validate: (value: string) =>
        /^\d{6}$/.test(value.trim()) ? true : "Please enter exactly 6 digits",
    },
  ]);
  return code.trim();
}

async function askForVerificationCode(
  message: string,
  digits: number
): Promise<string> {
  const normalizedDigits = Number.isFinite(digits) ? Math.max(1, digits) : 6;
  const regex = new RegExp(`^\\d{${normalizedDigits}}$`);
  const { code } = await inquirer.prompt([
    {
      type: "input",
      name: "code",
      message,
      validate: (value: string) =>
        regex.test(value.trim())
          ? true
          : `Please enter exactly ${normalizedDigits} digits`,
    },
  ]);
  return code.trim();
}

function hasInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function promptWithSpinnerPause<T>(
  spinner: Ora | undefined,
  runPrompt: () => Promise<T>
): Promise<T> {
  const wasSpinning = spinner?.isSpinning === true;
  if (wasSpinning) spinner.stop();
  try {
    return await runPrompt();
  } finally {
    if (wasSpinning) spinner.start();
  }
}

class CookieJar {
  private readonly byKey = new Map<string, StoredCookie>();

  private cookieKey(
    cookie: Pick<StoredCookie, "name" | "domain" | "path">
  ): string {
    return `${cookie.name}|${cookie.domain.toLowerCase()}|${cookie.path || "/"}`;
  }

  constructor(seed: StoredCookie[] = []) {
    for (const cookie of seed) this.byKey.set(this.cookieKey(cookie), cookie);
  }

  updateFromResponse(url: string, response: AxiosResponse): void {
    const host = new URL(url).hostname;
    const setCookieHeader = response.headers["set-cookie"];
    if (!Array.isArray(setCookieHeader)) return;
    for (const rawCookie of setCookieHeader) {
      const parsed = parseSetCookieHeader(rawCookie, host);
      if (parsed) this.byKey.set(this.cookieKey(parsed), parsed);
    }
  }

  toCookieHeaderFor(url: string): string {
    const target = new URL(url);
    const targetHost = target.hostname.toLowerCase();
    const targetPath = target.pathname || "/";
    const isHttps = target.protocol === "https:";
    const now = nowInSeconds();

    const validCookies = Array.from(this.byKey.values()).filter((cookie) => {
      if (cookie.expires > 0 && cookie.expires < now) return false;
      if (!hostMatchesDomain(targetHost, cookie.domain)) return false;
      if (!targetPath.startsWith(cookie.path || "/")) return false;
      if (cookie.secure && !isHttps) return false;
      return true;
    });

    return validCookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  toStoredCookies(): StoredCookie[] {
    return Array.from(this.byKey.values());
  }
}

const appleAuthHttpClient = axios.create();
attachAppleHttpTracing(appleAuthHttpClient, "apple-auth");

class AsoAuthHttpClient {
  constructor(private readonly jar: CookieJar) {}

  async request<T = unknown>(
    config: AxiosRequestConfig & {
      cookieHeaderMutator?: (cookieHeader: string) => string;
    }
  ): Promise<AxiosResponse<T>> {
    const headers = { ...(config.headers || {}) } as Record<string, string>;
    const rawCookieHeader = config.url
      ? this.jar.toCookieHeaderFor(config.url)
      : "";
    const cookieHeader = config.cookieHeaderMutator
      ? config.cookieHeaderMutator(rawCookieHeader)
      : rawCookieHeader;
    if (cookieHeader) headers.Cookie = cookieHeader;
    const requestConfig: AxiosRequestConfig = {
      ...config,
      headers,
      timeout: config.timeout ?? 30000,
      validateStatus: () => true,
    };

    try {
      const response = await appleAuthHttpClient.request<T>(requestConfig);
      if (config.url) this.jar.updateFromResponse(config.url, response);
      return response;
    } catch (error) {
      throw withAppleHttpTraceContext(error, {
        provider: "apple-auth",
        operation: "request",
        context: {
          method: String(requestConfig.method || "get").toUpperCase(),
          url: requestConfig.url || "",
        },
      });
    }
  }
}

export class AsoAuthEngine {
  private widgetKey: string | null = null;
  private authRequestContext: AppleAuthRequestContext | null = null;

  constructor(
    private readonly client: AsoAuthHttpClient,
    private readonly mode: AsoAuthMode = "auto",
    private readonly spinner?: Ora,
    private readonly onUserActionRequired?: (
      reason: ReauthUserActionReason
    ) => void
  ) {}

  private markUserActionRequired(reason: ReauthUserActionReason): void {
    this.onUserActionRequired?.(reason);
  }

  private withAppleAuthTrace(
    error: unknown,
    operation: string,
    context: Record<string, unknown> = {}
  ): Error {
    return withAppleHttpTraceContext(error, {
      provider: "apple-auth",
      operation,
      context,
    });
  }

  private shouldFallbackToLegacyFromSirp(error: unknown): boolean {
    if (!(error instanceof AppleAuthResponseError)) return true;
    return error.reason === "unknown";
  }

  async ensureAuthenticated(credentials: AppleLoginCredentials): Promise<void> {
    this.widgetKey = await this.resolveWidgetKey();
    this.authRequestContext = await this.bootstrapAuthRequestContext();

    if (this.mode === "sirp") {
      await this.loginWithSirp(credentials);
      return;
    }
    if (this.mode === "legacy") {
      await this.loginWithLegacy(credentials);
      return;
    }

    try {
      await this.loginWithSirp(credentials);
    } catch (error) {
      if (!this.shouldFallbackToLegacyFromSirp(error)) {
        throw error;
      }
      logger.warn(
        `[aso-auth] SIRP failed, falling back to legacy: ${String(error)}`
      );
      await this.loginWithLegacy(credentials, { maxAttempts: 1 });
    }
  }

  private async loginWithSirp(
    credentials: AppleLoginCredentials
  ): Promise<void> {
    logger.debug("[aso-auth] Starting SIRP login");
    const aBytes = randomBytes(256);
    const a = hexToBigInt(bytesToHex(aBytes));
    const aPublic = modPow(SRP_G_2048, a, SRP_N_2048);
    const aPublicHex = bigIntToHex(aPublic);

    const initResponse = await this.client.request<AppleSirpInitResponse>({
      method: "post",
      url: `${APPLE_IDMSA_BASE_URL}/signin/init`,
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        ...this.buildAuthContextHeaders(),
        Accept: "application/json, text/javascript",
      },
      data: {
        a: hexToBase64(aPublicHex),
        accountName: credentials.appleId,
        protocols: ["s2k", "s2k_fo"],
      },
      cookieHeaderMutator: quoteDesCookieValue,
    });
    if (initResponse.status !== 200) {
      throw this.withAppleAuthTrace(
        new Error(`SIRP init failed with status ${initResponse.status}`),
        "sirp-init",
        {
          status: initResponse.status,
        }
      );
    }
    const body = initResponse.data;
    logger.debug(
      `[aso-auth] SIRP init succeeded with protocol=${body?.protocol ?? "unknown"} iteration=${body?.iteration ?? "unknown"}`
    );
    if (!body || body.serviceErrors) {
      const reason = inferAppleAuthFailureReason(initResponse.status, body);
      throw this.withAppleAuthTrace(
        new AppleAuthResponseError({
          message: "SIRP init returned service errors",
          status: initResponse.status,
          payload: body,
          reason,
        }),
        "sirp-init",
        {
          status: initResponse.status,
        }
      );
    }

    const salt = Buffer.from(body.salt, "base64");
    const saltHex = salt.toString("hex");
    const bHex = base64ToHex(body.b);
    const encryptedPassword = buildSirpDerivedPassword(
      credentials.password,
      salt,
      body.iteration,
      body.protocol
    );
    const encryptedPasswordHex = encryptedPassword.toString("hex");
    const b = hexToBigInt(bHex);
    const k = srpCalcK(SRP_N_2048, SRP_G_2048);
    const x = srpCalcXHex(encryptedPasswordHex, saltHex);
    const u = srpCalcU(aPublicHex, bHex, SRP_N_2048);
    if (u === 0n) {
      throw new Error("SIRP invalid scramble parameter u=0");
    }

    const s = srpCalcClientS(b, a, k, x, u, SRP_N_2048, SRP_G_2048);
    const sHex = bigIntToHex(s);
    const kHex = srpShaHex(sHex);
    const mHex = srpCalcM(
      SRP_N_2048,
      SRP_G_2048,
      credentials.appleId,
      saltHex,
      aPublicHex,
      bHex,
      kHex
    );
    const m1Base64 = hexToBase64(mHex);
    const m2Hex = srpCalcHamk(aPublicHex, mHex, kHex);
    const m2Base64 = hexToBase64(m2Hex);

    let finalM1Base64 = m1Base64;
    let finalM2Base64 = m2Base64;
    if (process.env.ASO_SIRP_RUBY_ORACLE === "1") {
      try {
        const ruby = computeSirpWithRubyOracle({
          aHex: bigIntToHex(a),
          username: credentials.appleId,
          encryptedPasswordHex,
          saltHex,
          bHex,
        });
        if (!ruby.ok || !ruby.m1_hex || !ruby.m2_hex) {
          logger.warn(
            `[aso-auth] Ruby SIRP oracle failed: ${ruby.error || "unknown"}`
          );
        } else {
          const sameM1 = normalizeHex(ruby.m1_hex) === normalizeHex(mHex);
          const sameM2 = normalizeHex(ruby.m2_hex) === normalizeHex(m2Hex);
          const sameA =
            normalizeHex(ruby.a_public_hex || "") === normalizeHex(aPublicHex);
          logger.debug(
            `[aso-auth] Ruby oracle compare: sameA=${sameA} sameM1=${sameM1} sameM2=${sameM2}`
          );
          if (process.env.ASO_SIRP_USE_RUBY_PROOF === "1") {
            finalM1Base64 = hexToBase64(normalizeHex(ruby.m1_hex));
            finalM2Base64 = hexToBase64(normalizeHex(ruby.m2_hex));
            logger.debug("[aso-auth] Using Ruby oracle m1/m2 proofs");
          }
        }
      } catch (error) {
        logger.warn(`[aso-auth] Ruby oracle exception: ${String(error)}`);
      }
    }

    const hashcash = await this.fetchHashcash();
    const completeResponse = await this.client.request({
      method: "post",
      url: `${APPLE_IDMSA_BASE_URL}/signin/complete?isRememberMeEnabled=true`,
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
        ...this.buildAuthContextHeaders(),
        Accept: "application/json, text/javascript",
        ...(hashcash ? { "X-Apple-HC": hashcash } : {}),
      },
      data: {
        accountName: credentials.appleId,
        c: body.c,
        m1: finalM1Base64,
        m2: finalM2Base64,
        rememberMe: true,
      },
      cookieHeaderMutator: quoteDesCookieValue,
    });
    logger.debug(`[aso-auth] SIRP complete status=${completeResponse.status}`);
    if (completeResponse.status >= 400) {
      logger.warn(
        `[aso-auth] SIRP complete error payload: ${summarizeAppleErrorPayload(
          completeResponse.data
        )}`
      );
    }

    await this.handlePostLoginResponse(completeResponse);
  }

  private async loginWithLegacy(
    credentials: AppleLoginCredentials,
    options?: { maxAttempts?: number }
  ): Promise<void> {
    logger.debug("[aso-auth] Starting legacy login");
    const response = await this.requestLegacyWithRetry(
      credentials,
      options?.maxAttempts ?? 3
    );

    await this.handlePostLoginResponse(response);
  }

  private async requestLegacyWithRetry(
    credentials: AppleLoginCredentials,
    maxAttempts: number
  ): Promise<AxiosResponse> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const hashcash = await this.fetchHashcash();
      const response = await this.client.request({
        method: "post",
        url: `${APPLE_IDMSA_BASE_URL}/signin`,
        headers: {
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          "X-Apple-Widget-Key": this.requireWidgetKey(),
          Accept: "application/json, text/javascript",
          ...(hashcash ? { "X-Apple-HC": hashcash } : {}),
        },
        cookieHeaderMutator: quoteDesCookieValue,
        data: {
          accountName: credentials.appleId,
          password: credentials.password,
          rememberMe: true,
        },
      });

      const authType = payloadAuthType(response.data);
      const isDeterministicFailure =
        payloadIncludesInvalidTrue(response.data) ||
        (response.status === 412 &&
          authType !== null &&
          SUPPORTED_AUTH_TYPES.has(authType)) ||
        responseHasItctxCookie(response);
      const shouldRetry =
        !isDeterministicFailure &&
        (response.status === 429 ||
          response.status === 500 ||
          response.status === 502 ||
          response.status === 503 ||
          response.status === 504);
      if (!shouldRetry || attempt === maxAttempts) {
        if (response.status >= 400) {
          logger.warn(
            `[aso-auth] Legacy login error payload: ${summarizeAppleErrorPayload(
              response.data
            )}`
          );
        }
        return response;
      }

      const backoffMs = 1000 * 2 ** (attempt - 1);
      logger.warn(
        `[aso-auth] Legacy login transient status=${response.status}; retrying in ${backoffMs}ms (attempt ${attempt}/${maxAttempts})`
      );
      await sleep(backoffMs);
    }

    throw new Error("Legacy login retry exhausted");
  }

  private async handlePostLoginResponse(
    response: AxiosResponse
  ): Promise<void> {
    if (response.status === 403) {
      throw this.withAppleAuthTrace(
        new AppleAuthResponseError({
          message: "Invalid Apple ID credentials",
          status: response.status,
          payload: response.data,
          reason: "invalid_credentials",
        }),
        "signin-complete",
        {
          status: response.status,
        }
      );
    }
    if (response.status === 409) {
      const headers = this.extractSessionHeaders(response);
      const latestHeaders = await this.handleTwoFactor(headers);
      await this.establishAppAdsSession(latestHeaders);
      return;
    }
    if (response.status === 200) {
      await this.establishAppAdsSession();
      return;
    }

    if (payloadIncludesInvalidTrue(response.data)) {
      throw this.withAppleAuthTrace(
        new AppleAuthResponseError({
          message: "Invalid Apple ID credentials",
          status: response.status,
          payload: response.data,
          reason: "invalid_credentials",
        }),
        "signin-complete",
        {
          status: response.status,
        }
      );
    }

    const authType = payloadAuthType(response.data);
    if (response.status === 412 && authType && SUPPORTED_AUTH_TYPES.has(authType)) {
      throw this.withAppleAuthTrace(
        new AppleAuthResponseError({
          message:
            "Apple ID requires acknowledging privacy statement or 2FA upgrade in the web UI",
          status: response.status,
          payload: response.data,
          reason: "upgrade_required",
        }),
        "signin-complete",
        {
          status: response.status,
          authType,
        }
      );
    }

    if (responseHasItctxCookie(response)) {
      throw this.withAppleAuthTrace(
        new AppleAuthResponseError({
          message:
            "Apple ID is not enabled for App Store Connect. Sign in on the web once and verify account access.",
          status: response.status,
          payload: response.data,
          reason: "unknown",
        }),
        "signin-complete",
        {
          status: response.status,
        }
      );
    }

    const bodyType = typeof response.data;
    const reason = inferAppleAuthFailureReason(response.status, response.data);
    throw this.withAppleAuthTrace(
      new AppleAuthResponseError({
        message: `Apple login failed with status ${response.status} (responseType=${bodyType})`,
        status: response.status,
        payload: response.data,
        reason,
      }),
      "signin-complete",
      {
        status: response.status,
      }
    );
  }

  private async fetchHashcash(): Promise<string | undefined> {
    const response = await this.client.request({
      method: "get",
      url: `${APPLE_IDMSA_BASE_URL}/signin`,
      params: { widgetKey: this.requireWidgetKey() },
    });

    const bitsValue = response.headers["x-apple-hc-bits"];
    const challenge = response.headers["x-apple-hc-challenge"];
    const bits = typeof bitsValue === "string" ? Number(bitsValue) : Number.NaN;

    if (!challenge || Number.isNaN(bits) || bits <= 0) {
      return undefined;
    }
    return buildAuthHashcash(bits, challenge);
  }

  private extractSessionHeaders(
    response: AxiosResponse
  ): AppleAuthSessionHeaders {
    const scnt = response.headers.scnt;
    const xAppleIdSessionId = response.headers["x-apple-id-session-id"];
    if (!scnt || !xAppleIdSessionId) {
      throw new Error("Missing Apple session headers required for 2FA");
    }
    return {
      scnt: String(scnt),
      xAppleIdSessionId: String(xAppleIdSessionId),
    };
  }

  private twoFactorHeaders(
    sessionHeaders: AppleAuthSessionHeaders
  ): Record<string, string> {
    return {
      "X-Apple-Id-Session-Id": sessionHeaders.xAppleIdSessionId,
      ...this.buildAuthContextHeaders(),
      Accept: "application/json",
      scnt: sessionHeaders.scnt,
    };
  }

  private twoFactorHeadersMinimal(
    sessionHeaders: AppleAuthSessionHeaders
  ): Record<string, string> {
    return {
      "X-Apple-Id-Session-Id": sessionHeaders.xAppleIdSessionId,
      ...this.buildAuthContextHeaders(),
      Accept: "application/json",
      scnt: sessionHeaders.scnt,
    };
  }

  private buildAuthContextHeaders(): Record<string, string> {
    const context = this.authRequestContext;
    return {
      "X-Apple-App-Id": APPLE_AUTH_APP_ID,
      "X-Apple-Locale": APPLE_AUTH_LANGUAGE,
      "X-Apple-OAuth-Client-Id": APPLE_AUTH_CLIENT_ID,
      "X-Apple-OAuth-Client-Type": "firstPartyAuth",
      "X-Apple-OAuth-Redirect-URI": "https://idmsa.apple.com",
      "X-Apple-OAuth-Response-Mode": "web_message",
      "X-Apple-OAuth-Response-Type": "code",
      "X-Apple-OAuth-State": context?.state || "",
      "X-Apple-Frame-Id": context?.frameId || "",
      "X-Apple-Trusted-Domain": "https://idmsa.apple.com",
      "X-Apple-Privacy-Consent": "true",
      "X-Apple-Privacy-Consent-Accepted": "true",
      ...(context?.authAttributes
        ? { "X-Apple-Auth-Attributes": context.authAttributes }
        : {}),
      "X-Apple-Widget-Key": this.requireWidgetKey(),
    };
  }

  private requireWidgetKey(): string {
    return this.widgetKey || APPLE_WIDGET_KEY_FALLBACK;
  }

  private async bootstrapAuthRequestContext(): Promise<AppleAuthRequestContext> {
    const frameId = `daw-${randomUUID()}`;
    const response = await this.client.request({
      method: "get",
      url: `${APPLE_IDMSA_BASE_URL}/authorize/signin`,
      params: {
        frame_id: frameId,
        language: APPLE_AUTH_LANGUAGE,
        skVersion: "7",
        iframeId: frameId,
        client_id: APPLE_AUTH_CLIENT_ID,
        redirect_uri: "https://idmsa.apple.com",
        response_type: "code",
        response_mode: "web_message",
        state: frameId,
        authVersion: "latest",
      },
      headers: {
        Referer: APPLE_IDMS_WEB_AUTH_SIGNIN_URL,
      },
    });
    const authAttributes = response.headers["x-apple-auth-attributes"];
    logger.debug(
      `[aso-auth] Auth context bootstrap status=${response.status} authAttributes=${authAttributes ? "yes" : "no"}`
    );
    return {
      frameId,
      state: frameId,
      authAttributes:
        typeof authAttributes === "string" ? authAttributes : undefined,
    };
  }

  private async resolveWidgetKey(): Promise<string> {
    if (process.env.ASO_APPLE_WIDGET_KEY) {
      logger.debug("[aso-auth] Using widget key from ASO_APPLE_WIDGET_KEY");
      return process.env.ASO_APPLE_WIDGET_KEY;
    }

    try {
      const response = await this.client.request<AppleWidgetConfigResponse>({
        method: "get",
        url: APPLE_WIDGET_CONFIG_URL,
        headers: {
          Accept: "application/json",
        },
      });

      const authServiceKey = response.data?.authServiceKey?.trim();
      if (response.status === 200 && authServiceKey) {
        logger.debug(
          "[aso-auth] Loaded widget key from App Store Connect config"
        );
        return authServiceKey;
      }

      logger.warn(
        `[aso-auth] Failed to load widget key dynamically (status=${response.status}); using fallback`
      );
      return APPLE_WIDGET_KEY_FALLBACK;
    } catch (error) {
      logger.warn(
        `[aso-auth] Widget key lookup failed; using fallback. error=${String(error)}`
      );
      return APPLE_WIDGET_KEY_FALLBACK;
    }
  }

  private mergeSessionHeaders(
    sessionHeaders: AppleAuthSessionHeaders,
    response: AxiosResponse
  ): AppleAuthSessionHeaders {
    const scnt = response.headers.scnt;
    const xAppleIdSessionId = response.headers["x-apple-id-session-id"];
    return {
      scnt: scnt ? String(scnt) : sessionHeaders.scnt,
      xAppleIdSessionId: xAppleIdSessionId
        ? String(xAppleIdSessionId)
        : sessionHeaders.xAppleIdSessionId,
    };
  }

  private mergeTrustedPhoneNumbers(
    ...sources: Array<AppleAuthChallengeResponse | undefined>
  ): AppleTrustedPhoneNumber[] {
    const merged = new Map<number, AppleTrustedPhoneNumber>();
    for (const source of sources) {
      const numbers = source?.trustedPhoneNumbers || [];
      for (const phone of numbers) merged.set(phone.id, phone);
    }
    return Array.from(merged.values());
  }

  private async handleTwoFactor(
    sessionHeaders: AppleAuthSessionHeaders
  ): Promise<AppleAuthSessionHeaders> {
    this.markUserActionRequired("two_factor");
    if (!hasInteractiveTerminal()) {
      throw new Error(
        "Interactive terminal is required to complete Apple two-factor authentication. Run 'aso auth' in a terminal and retry."
      );
    }
    logger.debug("[aso-auth] 2FA challenge detected");
    if (this.spinner)
      this.spinner.text = "Fetching 2FA verification methods...";
    const challengeResponse =
      await this.client.request<AppleAuthChallengeResponse>({
        method: "get",
        url: APPLE_IDMSA_BASE_URL,
        headers: this.twoFactorHeadersMinimal(sessionHeaders),
      });
    const latestHeadersFromChallenge = this.mergeSessionHeaders(
      sessionHeaders,
      challengeResponse
    );

    let body = challengeResponse.data || {};
    let phoneNumbers = body.trustedPhoneNumbers || [];
    if (phoneNumbers.length === 0) {
      const challengeRetry =
        await this.client.request<AppleAuthChallengeResponse>({
          method: "get",
          url: APPLE_IDMSA_BASE_URL,
          headers: this.twoFactorHeaders(latestHeadersFromChallenge),
        });
      body = challengeRetry.data || body;
      phoneNumbers = this.mergeTrustedPhoneNumbers(
        challengeResponse.data || {},
        challengeRetry.data || {}
      );
    }
    const noTrustedDevices = body.noTrustedDevices === true;
    const hasTrustedDevices =
      Array.isArray(body.trustedDevices) && body.trustedDevices.length > 0;
    const codeLength =
      typeof body.securityCode?.length === "number" &&
      Number.isFinite(body.securityCode.length) &&
      body.securityCode.length > 0
        ? body.securityCode.length
        : 6;
    logger.debug(
      `[aso-auth] 2FA methods: trusted-device + ${
        phoneNumbers.length > 0 ? `sms(${phoneNumbers.length})` : "no-sms"
      }`
    );
    let method: "trusteddevice" | "phone" = "trusteddevice";
    let selectedPhone:
      | Pick<AppleTrustedPhoneNumber, "id" | "numberWithDialCode">
      | undefined;
    let shouldRequestPhoneCode = true;

    if (noTrustedDevices && phoneNumbers.length === 1) {
      method = "phone";
      selectedPhone = phoneNumbers[0];
      shouldRequestPhoneCode = false;
    } else if (noTrustedDevices && phoneNumbers.length > 1) {
      method = "phone";
    } else {
      const methodChoices: Array<{
        name: string;
        value: "trusteddevice" | "phone";
      }> = [];
      if (hasTrustedDevices || !noTrustedDevices) {
        methodChoices.push({
          name: "Trusted device code (default)",
          value: "trusteddevice",
        });
      }
      if (phoneNumbers.length > 0) {
        methodChoices.push({
          name: "SMS / phone verification",
          value: "phone",
        });
      }
      if (methodChoices.length === 0) {
        throw this.withAppleAuthTrace(
          new Error("No supported 2FA verification methods were returned."),
          "2fa-method-selection"
        );
      }
      if (methodChoices.length === 1) {
        method = methodChoices[0].value;
      } else {
        const promptResult = await promptWithSpinnerPause(this.spinner, () =>
          inquirer.prompt([
            {
              type: "list",
              name: "method",
              message: "Choose 2FA verification method:",
              choices: methodChoices,
            },
          ])
        );
        method = promptResult.method as "trusteddevice" | "phone";
      }
    }

    let verifyPath = "/verify/trusteddevice/securitycode";
    let codePromptMessage = `Enter ${codeLength}-digit trusted-device code:`;
    if (method === "phone") {
      if (!selectedPhone) {
        const phonePromptResult = await promptWithSpinnerPause(this.spinner, () =>
          inquirer.prompt([
            {
              type: "list",
              name: "selectedPhone",
              message: "Send verification code to:",
              choices: phoneNumbers.map((phone) => ({
                name: phone.numberWithDialCode,
                value: phone,
              })),
            },
          ])
        );
        selectedPhone = phonePromptResult.selectedPhone as Pick<
          AppleTrustedPhoneNumber,
          "id" | "numberWithDialCode"
        >;
      }

      const phoneId = selectedPhone.id as number;
      const mode = "sms";
      if (shouldRequestPhoneCode) {
        if (this.spinner)
          this.spinner.text = "Requesting SMS verification code...";
        const sendCodeResponse = await this.client.request({
          method: "put",
          url: `${APPLE_IDMSA_BASE_URL}/verify/phone`,
          headers: {
            ...this.twoFactorHeaders(latestHeadersFromChallenge),
            "Content-Type": "application/json",
          },
          data: { phoneNumber: { id: phoneId }, mode },
        });
        if (sendCodeResponse.status < 200 || sendCodeResponse.status >= 300) {
          logger.warn(
            `[aso-auth] 2FA SMS send error payload: ${summarizeAppleErrorPayload(
              sendCodeResponse.data
            )}`
          );
          throw this.withAppleAuthTrace(
            new Error(
              `2FA SMS send failed with status ${sendCodeResponse.status}`
            ),
            "2fa-send-code",
            {
              status: sendCodeResponse.status,
            }
          );
        }
        logger.debug(
          `[aso-auth] 2FA SMS requested for phoneId=${phoneId} status=${sendCodeResponse.status}`
        );
      }

      verifyPath = "/verify/phone/securitycode";
      codePromptMessage = `Enter ${codeLength}-digit code sent to ${selectedPhone.numberWithDialCode}:`;
    }
    let verifyResponse: AxiosResponse | undefined;
    while (true) {
      const code = await promptWithSpinnerPause(this.spinner, () =>
        askForVerificationCode(codePromptMessage, codeLength)
      );
      const verifyBody =
        method === "phone"
          ? {
              securityCode: { code },
              phoneNumber: { id: selectedPhone?.id as number },
              mode: "sms",
            }
          : {
              securityCode: { code },
            };

      if (this.spinner) this.spinner.text = "Verifying 2FA code...";
      verifyResponse = await this.client.request({
        method: "post",
        url: `${APPLE_IDMSA_BASE_URL}${verifyPath}`,
        headers: {
          ...this.twoFactorHeaders(latestHeadersFromChallenge),
          "Content-Type": "application/json",
        },
        data: verifyBody,
      });

      if (verifyResponse.status >= 200 && verifyResponse.status < 300) {
        break;
      }

      const isRetryableCodeError = isRetryableTwoFactorCodeError(
        verifyResponse.data
      );
      const verifyErrorMessage = getTwoFactorVerificationErrorMessage(
        verifyResponse.data
      );
      if (isRetryableCodeError) {
        logger.warn(
          `[aso-auth] 2FA verify error payload: ${summarizeAppleErrorPayload(
            verifyResponse.data
          )}`
        );
        logWithSpinnerPause(
          this.spinner,
          "warn",
          `${verifyErrorMessage} Please try again.`
        );
        continue;
      }

      logger.warn(
        `[aso-auth] 2FA verify error payload: ${summarizeAppleErrorPayload(
          verifyResponse.data
        )}`
      );
      throw this.withAppleAuthTrace(
        new Error(
          `2FA verification failed with status ${verifyResponse.status}: ${verifyErrorMessage}`
        ),
        "2fa-verify-code",
        {
          status: verifyResponse.status,
        }
      );
    }

    if (
      !verifyResponse ||
      verifyResponse.status < 200 ||
      verifyResponse.status >= 300
    ) {
      throw this.withAppleAuthTrace(
        new Error("2FA verification failed"),
        "2fa-verify-code",
        {
          status: verifyResponse?.status,
        }
      );
    }

    if (this.spinner)
      this.spinner.text = "Establishing trusted Apple session...";
    const trustResponse = await this.client.request({
      method: "get",
      url: `${APPLE_IDMSA_BASE_URL}/2sv/trust`,
      headers: this.twoFactorHeaders(latestHeadersFromChallenge),
    });
    if (trustResponse.status < 200 || trustResponse.status >= 300) {
      logger.warn(
        `[aso-auth] 2FA trust error payload: ${summarizeAppleErrorPayload(
          trustResponse.data
        )}`
      );
      throw this.withAppleAuthTrace(
        new Error(`2FA trust failed with status ${trustResponse.status}`),
        "2fa-trust",
        {
          status: trustResponse.status,
        }
      );
    }
    if (this.spinner) this.spinner.text = "2FA verification successful.";
    return this.mergeSessionHeaders(
      this.mergeSessionHeaders(latestHeadersFromChallenge, verifyResponse),
      trustResponse
    );
  }

  private async followSingleRedirectHop(url: string): Promise<{
    status: number;
    nextUrl?: string;
    responseUrl: string;
  }> {
    const response = await this.client.request({
      method: "get",
      url,
      maxRedirects: 0,
    });
    const locationHeader = response.headers.location;
    const nextUrl =
      typeof locationHeader === "string"
        ? new URL(locationHeader, url).toString()
        : undefined;
    const responseUrl =
      (response.request?.res?.responseUrl as string | undefined) || url;
    return {
      status: response.status,
      nextUrl,
      responseUrl,
    };
  }

  private async performWebAuthHandoff(
    sessionHeaders: AppleAuthSessionHeaders
  ): Promise<{ sessionHeaders: AppleAuthSessionHeaders; nextUrl: string }> {
    const iframeId = this.authRequestContext?.frameId || `daw-${randomUUID()}`;

    const signinPageResponse = await this.client.request({
      method: "get",
      url: APPLE_IDMS_WEB_AUTH_SIGNIN_URL,
      maxRedirects: 0,
    });
    const latestSessionHeaders = this.mergeSessionHeaders(
      sessionHeaders,
      signinPageResponse
    );
    const formBody = new URLSearchParams({
      rememberMe: "false",
      grantCode: "",
      iframeId,
      requestUri: "/signin",
      appIdKey: APPLE_AUTH_CLIENT_ID,
      language: APPLE_AUTH_LANGUAGE,
      path: APPLE_AUTH_PATH,
      rv: "1",
      scnt: latestSessionHeaders.scnt,
    }).toString();

    const webAuthResponse = await this.client.request({
      method: "post",
      url: APPLE_IDMS_WEB_AUTH_SIGNIN_POST_URL,
      maxRedirects: 0,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://idmsa.apple.com",
        Referer: "https://idmsa.apple.com/",
      },
      data: formBody,
    });
    logger.debug(
      `[aso-auth] WebAuth handoff status=${webAuthResponse.status} location=${String(
        webAuthResponse.headers.location || "unknown"
      )}`
    );
    if (webAuthResponse.status < 300 || webAuthResponse.status >= 400) {
      throw this.withAppleAuthTrace(
        new Error(
          `WebAuth handoff failed with status ${webAuthResponse.status}`
        ),
        "webauth-handoff",
        {
          status: webAuthResponse.status,
        }
      );
    }

    const location = String(webAuthResponse.headers.location || "");
    if (!location.includes("searchads.apple.com")) {
      throw this.withAppleAuthTrace(
        new Error(
          `WebAuth handoff redirected to unexpected location: ${location || "unknown"}`
        ),
        "webauth-handoff",
        {
          status: webAuthResponse.status,
          location: location || "unknown",
        }
      );
    }
    return {
      sessionHeaders: this.mergeSessionHeaders(
        latestSessionHeaders,
        webAuthResponse
      ),
      nextUrl: location,
    };
  }

  async establishAppAdsSession(
    sessionHeaders?: AppleAuthSessionHeaders
  ): Promise<void> {
    let lastFinalUrl = "";
    let latestSessionHeaders = sessionHeaders;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      let startUrl = APPLE_APP_ADS_URL;
      if (latestSessionHeaders) {
        const handoff = await this.performWebAuthHandoff(latestSessionHeaders);
        latestSessionHeaders = handoff.sessionHeaders;
        startUrl = handoff.nextUrl;
      } else {
        await this.client.request({
          method: "get",
          url: APPLE_IDMS_WEB_AUTH_SIGNIN_URL,
          maxRedirects: 10,
        });
      }

      let currentUrl = startUrl;
      let resolved = false;
      for (let hop = 1; hop <= 6; hop += 1) {
        const hopResult = await this.followSingleRedirectHop(currentUrl);
        logger.debug(
          `[aso-auth] App Ads hop ${hop}: status=${hopResult.status} url=${currentUrl} next=${hopResult.nextUrl || "none"}`
        );
        if (
          hopResult.status >= 200 &&
          hopResult.status < 300 &&
          hopResult.responseUrl.includes("app-ads.apple.com")
        ) {
          lastFinalUrl = hopResult.responseUrl;
          resolved = true;
          break;
        }
        if (!hopResult.nextUrl) {
          lastFinalUrl = hopResult.responseUrl;
          break;
        }
        currentUrl = hopResult.nextUrl;
        lastFinalUrl = currentUrl;
      }
      if (resolved) {
        return;
      }

      logger.warn(
        `[aso-auth] App Ads session not ready yet (attempt ${attempt}/5). finalUrl=${lastFinalUrl || "unknown"}`
      );
      await sleep(1000);
    }

    throw this.withAppleAuthTrace(
      new Error(
        `Session redirected to Apple login, app-ads auth is not established (finalUrl=${lastFinalUrl || "unknown"})`
      ),
      "establish-app-ads-session",
      {
        finalUrl: lastFinalUrl || "unknown",
      }
    );
  }
}

export class AsoAuthService {
  getCookieHeader(targetUrl = APPLE_SEARCH_ADS_URL): string {
    const jar = new CookieJar(asoCookieStoreService.loadCookies());
    return jar.toCookieHeaderFor(targetUrl);
  }

  async reAuthenticate(options?: ReAuthenticateOptions): Promise<string> {
    const spinner = ora("Authenticating with Apple Search Ads...").start();
    try {
      const authenticateWith = async (
        credentials: AppleLoginCredentials
      ): Promise<string> => {
        const jar = new CookieJar(asoCookieStoreService.loadCookies());
        const client = new AsoAuthHttpClient(jar);
        const mode =
          (process.env.ASO_AUTH_MODE as AsoAuthMode | undefined) || "auto";
        const engine = new AsoAuthEngine(
          client,
          mode,
          spinner,
          options?.onUserActionRequired
        );
        await engine.ensureAuthenticated(credentials);

        spinner.text = "Saving refreshed Apple session...";
        const storedCookies = jar.toStoredCookies();
        asoCookieStoreService.saveCookies(storedCookies);
        logger.debug(
          `[aso-auth] Saved ${storedCookies.length} cookies using mode=${mode}`
        );
        spinner.succeed("Apple authentication successful.");
        return toCookieHeader(storedCookies);
      };

      const tryReuseExistingSession = async (): Promise<string | null> => {
        if (options?.forcePromptCredentials || options?.resetStoredCredentials) {
          return null;
        }
        const existingCookies = asoCookieStoreService.loadCookies();
        if (existingCookies.length === 0) return null;

        const jar = new CookieJar(existingCookies);
        const client = new AsoAuthHttpClient(jar);
        const mode =
          (process.env.ASO_AUTH_MODE as AsoAuthMode | undefined) || "auto";
        const engine = new AsoAuthEngine(client, mode, spinner);
        spinner.text = "Checking existing Apple session...";
        try {
          await engine.establishAppAdsSession();
          spinner.text = "Saving refreshed Apple session...";
          const storedCookies = jar.toStoredCookies();
          asoCookieStoreService.saveCookies(storedCookies);
          logger.debug(
            `[aso-auth] Reused existing session with ${storedCookies.length} cookies using mode=${mode}`
          );
          spinner.succeed("Apple authentication successful.");
          return jar.toCookieHeaderFor(APPLE_SEARCH_ADS_URL);
        } catch (error) {
          logger.debug(
            `[aso-auth] Existing session reuse failed; continuing with credential login. error=${String(error)}`
          );
          return null;
        }
      };

      const promptForCredentials = async (): Promise<{
        credentials: AppleLoginCredentials;
        shouldRememberCredentials: boolean;
      }> => {
        options?.onUserActionRequired?.("credentials");
        if (!hasInteractiveTerminal()) {
          throw new Error(
            "Interactive terminal is required to enter Apple credentials. Run 'aso auth' in a terminal and retry."
          );
        }
        const promptedCredentials = await promptWithSpinnerPause(spinner, () =>
          askForCredentials()
        );
        options?.onUserActionRequired?.("remember_credentials");
        const shouldRememberCredentials = await promptWithSpinnerPause(
          spinner,
          () => askWhetherToRememberCredentials()
        );
        return { credentials: promptedCredentials, shouldRememberCredentials };
      };

      if (options?.resetStoredCredentials) {
        asoKeychainService.clearCredentials();
      }

      const reusedSessionHeader = await tryReuseExistingSession();
      if (reusedSessionHeader) return reusedSessionHeader;

      const keychainCredentials = options?.forcePromptCredentials
        ? null
        : asoKeychainService.loadCredentials();
      const promptedCredentials = keychainCredentials
        ? null
        : await promptForCredentials();
      const credentials =
        keychainCredentials ?? promptedCredentials?.credentials;
      if (!credentials) {
        throw new Error("Missing Apple credentials.");
      }

      try {
        const cookieHeader = await authenticateWith(credentials);
        if (promptedCredentials?.shouldRememberCredentials) {
          asoKeychainService.saveCredentials(promptedCredentials.credentials);
        }
        return cookieHeader;
      } catch (error) {
        if (!keychainCredentials || !isInvalidAppleCredentialsError(error)) {
          throw error;
        }

        logger.warn(
          "[aso-auth] Stored keychain credentials were rejected by Apple. Clearing and prompting again."
        );
        asoKeychainService.clearCredentials();
        const fallbackPromptedCredentials = await promptForCredentials();
        const cookieHeader = await authenticateWith(
          fallbackPromptedCredentials.credentials
        );
        if (fallbackPromptedCredentials.shouldRememberCredentials) {
          asoKeychainService.saveCredentials(
            fallbackPromptedCredentials.credentials
          );
        }
        return cookieHeader;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      spinner.fail(`Apple authentication failed: ${message}`);
      throw error;
    }
  }
}

export const asoAuthService = new AsoAuthService();
