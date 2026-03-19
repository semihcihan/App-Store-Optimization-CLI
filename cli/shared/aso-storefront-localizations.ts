import { DEFAULT_ASO_COUNTRY } from "../domain/keywords/policy";

export type StorefrontLanguageConfig = {
  defaultLanguage: string;
  additionalLanguages?: string[];
};

type NormalizedStorefrontLanguageConfig = {
  defaultLanguage: string;
  additionalLanguages: string[];
};

export const ASO_STOREFRONT_LANGUAGES_BY_COUNTRY: Record<
  string,
  StorefrontLanguageConfig
> = {
  US: {
    defaultLanguage: "en-US",
    additionalLanguages: [
      "ar",
      "zh-Hans",
      "zh-Hant",
      "fr-FR",
      "ko-KR",
      "pt-BR",
      "ru-RU",
      "es-MX",
      "vi",
    ],
  },
};

export function getStorefrontLanguageConfig(
  country: string
): NormalizedStorefrontLanguageConfig {
  const normalizedCountry = country.toUpperCase();
  const config =
    ASO_STOREFRONT_LANGUAGES_BY_COUNTRY[normalizedCountry] ??
    ASO_STOREFRONT_LANGUAGES_BY_COUNTRY[DEFAULT_ASO_COUNTRY];
  return {
    defaultLanguage: config.defaultLanguage,
    additionalLanguages: Array.isArray(config.additionalLanguages)
      ? config.additionalLanguages
      : [],
  };
}

export function getStorefrontDefaultLanguage(country: string): string {
  return getStorefrontLanguageConfig(country).defaultLanguage;
}

export function getStorefrontAdditionalLanguages(country: string): string[] {
  return [...getStorefrontLanguageConfig(country).additionalLanguages];
}

export function getStorefrontLanguages(country: string): string[] {
  const config = getStorefrontLanguageConfig(country);
  return [config.defaultLanguage, ...config.additionalLanguages];
}
