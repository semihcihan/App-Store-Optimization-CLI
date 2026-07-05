export type AsoStorefront = {
  countryCode: string;
  name: string;
  id: number;
  defaultLanguage: string;
};

export const ASO_STOREFRONTS: AsoStorefront[] = [
  { countryCode: "US", name: "United States", id: 143441, defaultLanguage: "en-US" },
  { countryCode: "CA", name: "Canada", id: 143455, defaultLanguage: "en-CA" },
  { countryCode: "GB", name: "United Kingdom", id: 143444, defaultLanguage: "en-GB" },
  { countryCode: "AU", name: "Australia", id: 143460, defaultLanguage: "en-AU" },
  { countryCode: "DE", name: "Germany", id: 143443, defaultLanguage: "de-DE" },
  { countryCode: "FR", name: "France", id: 143442, defaultLanguage: "fr-FR" },
  { countryCode: "ES", name: "Spain", id: 143454, defaultLanguage: "es-ES" },
  { countryCode: "IT", name: "Italy", id: 143450, defaultLanguage: "it" },
  { countryCode: "NL", name: "Netherlands", id: 143452, defaultLanguage: "nl-NL" },
  { countryCode: "BE", name: "Belgium", id: 143446, defaultLanguage: "nl-BE" },
  { countryCode: "AT", name: "Austria", id: 143445, defaultLanguage: "de-AT" },
  { countryCode: "CH", name: "Switzerland", id: 143459, defaultLanguage: "de-CH" },
  { countryCode: "SE", name: "Sweden", id: 143456, defaultLanguage: "sv" },
  { countryCode: "NO", name: "Norway", id: 143457, defaultLanguage: "no" },
  { countryCode: "DK", name: "Denmark", id: 143458, defaultLanguage: "da" },
  { countryCode: "FI", name: "Finland", id: 143447, defaultLanguage: "fi" },
  { countryCode: "IE", name: "Ireland", id: 143449, defaultLanguage: "en-IE" },
  { countryCode: "PT", name: "Portugal", id: 143453, defaultLanguage: "pt-PT" },
  { countryCode: "GR", name: "Greece", id: 143448, defaultLanguage: "el" },
  { countryCode: "PL", name: "Poland", id: 143478, defaultLanguage: "pl" },
  { countryCode: "CZ", name: "Czech Republic", id: 143489, defaultLanguage: "cs" },
  { countryCode: "HU", name: "Hungary", id: 143482, defaultLanguage: "hu" },
  { countryCode: "RO", name: "Romania", id: 143487, defaultLanguage: "ro" },
  { countryCode: "BG", name: "Bulgaria", id: 143526, defaultLanguage: "bg" },
  { countryCode: "HR", name: "Croatia", id: 143494, defaultLanguage: "hr" },
  { countryCode: "SK", name: "Slovakia", id: 143496, defaultLanguage: "sk" },
  { countryCode: "SI", name: "Slovenia", id: 143499, defaultLanguage: "sl-SI" },
  { countryCode: "JP", name: "Japan", id: 143462, defaultLanguage: "ja" },
  { countryCode: "CN", name: "China", id: 143465, defaultLanguage: "zh-Hans" },
  { countryCode: "KR", name: "South Korea", id: 143466, defaultLanguage: "ko" },
  { countryCode: "HK", name: "Hong Kong", id: 143463, defaultLanguage: "zh-Hant" },
  { countryCode: "TW", name: "Taiwan", id: 143470, defaultLanguage: "zh-Hant" },
  { countryCode: "SG", name: "Singapore", id: 143464, defaultLanguage: "en-SG" },
  { countryCode: "TH", name: "Thailand", id: 143475, defaultLanguage: "th" },
  { countryCode: "MY", name: "Malaysia", id: 143473, defaultLanguage: "ms" },
  { countryCode: "ID", name: "Indonesia", id: 143476, defaultLanguage: "id" },
  { countryCode: "PH", name: "Philippines", id: 143474, defaultLanguage: "en-PH" },
  { countryCode: "VN", name: "Vietnam", id: 143471, defaultLanguage: "vi" },
  { countryCode: "IN", name: "India", id: 143467, defaultLanguage: "en-IN" },
  { countryCode: "BR", name: "Brazil", id: 143503, defaultLanguage: "pt-BR" },
  { countryCode: "MX", name: "Mexico", id: 143468, defaultLanguage: "es-MX" },
  { countryCode: "AR", name: "Argentina", id: 143505, defaultLanguage: "es-AR" },
  { countryCode: "CL", name: "Chile", id: 143483, defaultLanguage: "es-CL" },
  { countryCode: "CO", name: "Colombia", id: 143501, defaultLanguage: "es-CO" },
  { countryCode: "PE", name: "Peru", id: 143507, defaultLanguage: "es-PE" },
  { countryCode: "ZA", name: "South Africa", id: 143472, defaultLanguage: "en-ZA" },
  { countryCode: "AE", name: "United Arab Emirates", id: 143481, defaultLanguage: "en-AE" },
  { countryCode: "TR", name: "Türkiye", id: 143480, defaultLanguage: "tr" },
  { countryCode: "IL", name: "Israel", id: 143491, defaultLanguage: "he" },
  { countryCode: "SA", name: "Saudi Arabia", id: 143479, defaultLanguage: "ar-SA" },
  { countryCode: "NZ", name: "New Zealand", id: 143461, defaultLanguage: "en-NZ" },
  { countryCode: "RU", name: "Russia", id: 143469, defaultLanguage: "ru" },
];

export const ASO_STOREFRONTS_BY_COUNTRY: Record<string, AsoStorefront> =
  Object.fromEntries(
    ASO_STOREFRONTS.map((storefront) => [storefront.countryCode, storefront])
  );

export function getSupportedAsoCountryCodes(): string[] {
  return ASO_STOREFRONTS.map((storefront) => storefront.countryCode);
}

export function getAsoStorefront(country: string): AsoStorefront | null {
  return ASO_STOREFRONTS_BY_COUNTRY[country.toUpperCase()] ?? null;
}

export function isSupportedAsoCountry(country: string): boolean {
  return getAsoStorefront(country) != null;
}

export function getAsoStorefrontId(country: string): number {
  return getAsoStorefront(country)?.id ?? ASO_STOREFRONTS_BY_COUNTRY.US.id;
}

export function getAsoStorefrontPath(country: string): string {
  return country.toLowerCase();
}

export function getAppleStoreFrontHeader(country: string): string {
  return `${getAsoStorefrontId(country)}-1,29`;
}

export function getSearchAdsStorefronts(country: string): string[] {
  return [country.toUpperCase()];
}
